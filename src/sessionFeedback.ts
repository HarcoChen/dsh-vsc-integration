import { isRecord } from "./guards";
import type {
    DshSessionFeedbackError,
    DshSessionFeedbackRecordResult,
} from "./types";

function nonEmptyString(value: unknown, maxLength = Number.MAX_SAFE_INTEGER): value is string {
    return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

/** Parse the discriminated result returned by sessionFeedback/record. */
export function normalizeSessionFeedbackRecordResult(
    value: unknown,
): DshSessionFeedbackRecordResult | undefined {
    if (!isRecord(value) || typeof value.ok !== "boolean") return undefined;
    if (value.ok) {
        return isRecord(value.value) && value.value.recorded === true
            ? { ok: true, value: { recorded: true } }
            : undefined;
    }
    if (!isRecord(value.error) || !nonEmptyString(value.error.code, 128)) return undefined;
    if (value.error.sessionId !== undefined && !nonEmptyString(value.error.sessionId, 512)) return undefined;
    const error: DshSessionFeedbackError = {
        code: value.error.code,
        ...(value.error.sessionId === undefined
            ? {}
            : { sessionId: value.error.sessionId }),
    };
    return { ok: false, error };
}
