import { isRecord } from "./guards";
import {
    DshMessageFeedbackDeleteResult,
    DshMessageFeedbackError,
    DshMessageFeedbackItem,
    DshMessageFeedbackListResult,
    DshMessageFeedbackPutResult,
    DshMessageFeedbackRating,
} from "./types";

// `z.uuid()` is the upstream contract (not specifically UUID v4); accept any
// RFC 4122 version so previously persisted sidecar revisions remain readable.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_MESSAGE_ID_LENGTH = 512;
const MAX_NOTE_LENGTH = 1_000_000;

function nonEmptyString(value: unknown, maxLength = Number.MAX_SAFE_INTEGER): value is string {
    return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function safeTime(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function rating(value: unknown): value is DshMessageFeedbackRating {
    return value === "positive" || value === "negative";
}

/** Parse one Host-owned item without trusting any business value from the wire. */
export function normalizeMessageFeedbackItem(value: unknown): DshMessageFeedbackItem | undefined {
    if (!isRecord(value) ||
        !nonEmptyString(value.messageId, MAX_MESSAGE_ID_LENGTH) ||
        !rating(value.rating) ||
        !nonEmptyString(value.version, 128) ||
        !UUID_PATTERN.test(value.version) ||
        !safeTime(value.createdAt) ||
        !safeTime(value.updatedAt) ||
        value.updatedAt < value.createdAt ||
        (value.note !== undefined && !nonEmptyString(value.note, MAX_NOTE_LENGTH))) {
        return undefined;
    }
    return {
        messageId: value.messageId,
        rating: value.rating,
        ...(value.note === undefined ? {} : { note: value.note }),
        version: value.version,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
    };
}

function normalizeError(value: unknown): DshMessageFeedbackError | undefined {
    if (!isRecord(value) || !nonEmptyString(value.code, 128)) return undefined;
    switch (value.code) {
        case "session-not-found":
            return nonEmptyString(value.sessionId, MAX_MESSAGE_ID_LENGTH)
                ? { code: value.code, sessionId: value.sessionId }
                : undefined;
        case "target-not-found":
            return nonEmptyString(value.sessionId, MAX_MESSAGE_ID_LENGTH) &&
                nonEmptyString(value.messageId, MAX_MESSAGE_ID_LENGTH)
                ? { code: value.code, sessionId: value.sessionId, messageId: value.messageId }
                : undefined;
        case "version-conflict": {
            if (!("current" in value)) return undefined;
            const current = value.current === null
                ? null
                : normalizeMessageFeedbackItem(value.current);
            if (current === undefined && value.current !== null) {
                return undefined;
            }
            return { code: value.code, current };
        }
        case "note-blank":
            return { code: value.code };
        case "note-too-large":
            return safeTime(value.maxBytes) && safeTime(value.actualBytes)
                ? { code: value.code, maxBytes: value.maxBytes, actualBytes: value.actualBytes }
                : undefined;
        default:
            // Keep forward-compatible failure codes displayable while still
            // requiring the stable discriminator and dropping unknown fields.
            return { code: value.code };
    }
}

/** Parse the discriminated list result returned by messageFeedback/list. */
export function normalizeMessageFeedbackListResult(value: unknown): DshMessageFeedbackListResult | undefined {
    if (!isRecord(value) || typeof value.ok !== "boolean") return undefined;
    if (value.ok) {
        if (!isRecord(value.value) || !Array.isArray(value.value.items)) return undefined;
        const items: DshMessageFeedbackItem[] = [];
        const messageIds = new Set<string>();
        for (const candidate of value.value.items) {
            const item = normalizeMessageFeedbackItem(candidate);
            if (!item || messageIds.has(item.messageId)) return undefined;
            messageIds.add(item.messageId);
            items.push(item);
        }
        return { ok: true, value: { items } };
    }
    const error = normalizeError(value.error);
    return error ? { ok: false, error } : undefined;
}

/** Parse the discriminated put result returned by messageFeedback/put. */
export function normalizeMessageFeedbackPutResult(value: unknown): DshMessageFeedbackPutResult | undefined {
    if (!isRecord(value) || typeof value.ok !== "boolean") return undefined;
    if (value.ok) {
        const item = normalizeMessageFeedbackItem(value.value);
        return item ? { ok: true, value: item } : undefined;
    }
    const error = normalizeError(value.error);
    return error ? { ok: false, error } : undefined;
}

/** Parse the discriminated delete result returned by messageFeedback/delete. */
export function normalizeMessageFeedbackDeleteResult(value: unknown): DshMessageFeedbackDeleteResult | undefined {
    if (!isRecord(value) || typeof value.ok !== "boolean") return undefined;
    if (value.ok) {
        return isRecord(value.value) && value.value.absent === true
            ? { ok: true, value: { absent: true } }
            : undefined;
    }
    const error = normalizeError(value.error);
    return error ? { ok: false, error } : undefined;
}
