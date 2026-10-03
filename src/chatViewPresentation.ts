import { t } from "./localize";
import {
    ChatImageView,
    DshImageLimitsView,
    DshImageUpload,
    DshPlanProjection,
    DshSessionModelsResult,
    DshScheduleDeliveryView,
    DshScheduleCatalogEntry,
    DshScheduleHistoryResult,
    DshSettingFieldType,
    DshSettingFieldView,
    DshSettingsNamespaceView,
    DshSettingsPanelView,
    DshSettingsPathOperation,
    DshScheduleItem,
    DshTodoItemView,
    PermissionProjectionView,
    DshPermissionCatalog,
    SessionStatsView,
} from "./types";
import { isImageMediaType, isRecord } from "./guards";

export function valueAtPath(value: unknown, path: readonly string[]): unknown {
    let current = value;
    for (const segment of path) {
        if (!isRecord(current)) return undefined;
        current = current[segment];
    }
    return current;
}

export function hasPath(value: unknown, path: readonly string[]): boolean {
    let current = value;
    for (const segment of path) {
        if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return false;
        current = current[segment];
    }
    return true;
}

interface SettingsSchemaNode {
    type?: string;
    dict?: Record<string, SettingsSchemaNode>;
    inner?: SettingsSchemaNode;
    meta?: Record<string, unknown>;
    description?: string;
}

function settingsSchemaNode(value: unknown): SettingsSchemaNode | undefined {
    if (!isRecord(value)) return undefined;
    return {
        ...(typeof value.type === "string" ? { type: value.type } : {}),
        ...(isRecord(value.dict) ? { dict: value.dict as Record<string, SettingsSchemaNode> } : {}),
        ...(isRecord(value.inner) ? { inner: value.inner as SettingsSchemaNode } : {}),
        ...(isRecord(value.meta) ? { meta: value.meta } : {}),
        ...(typeof value.description === "string" ? { description: value.description } : {}),
    };
}

function settingsSchemaRoot(value: unknown): SettingsSchemaNode | undefined {
    if (!isRecord(value)) return undefined;
    if (typeof value.uid === "number" && isRecord(value.refs)) {
        return settingsSchemaNode(value.refs[String(value.uid)]);
    }
    return settingsSchemaNode(value);
}

function settingLabel(path: readonly string[]): string {
    const leaf = path[path.length - 1] ?? "Setting";
    return leaf
        .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
        .replace(/[_-]+/gu, " ")
        .replace(/^./u, (character) => character.toLocaleUpperCase());
}

function settingDescription(node: SettingsSchemaNode | undefined): string | undefined {
    const value = node?.description ?? node?.meta?.description;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function settingType(value: unknown, node: SettingsSchemaNode | undefined): DshSettingFieldType {
    if (typeof value === "boolean" || node?.type === "boolean") return "boolean";
    if (typeof value === "number" || node?.type === "number" || node?.type === "integer") return "number";
    if (typeof value === "string" || node?.type === "string") return "string";
    return "json";
}

function settingText(value: unknown): string {
    if (value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
        return JSON.stringify(value) ?? "";
    } catch {
        return "";
    }
}

function sensitiveSettingPath(path: readonly string[]): boolean {
    const leaf = path[path.length - 1] ?? "";
    return /(?:api[_-]?key|token|password|secret|credential|private[_-]?key)$/iu.test(leaf);
}

function presentSettingsFields(namespace: DshSettingsNamespaceView): DshSettingFieldView[] {
    const fields = new Map<string, DshSettingFieldView>();
    const secrets = new Map(namespace.secrets.map((secret) => [secret.path.join("\0"), secret]));
    const schema = settingsSchemaRoot(namespace.schema);
    const add = (path: string[], node?: SettingsSchemaNode): void => {
        if (path.length === 0) return;
        const key = path.join("\0");
        const secretEntry = secrets.get(key);
        const value = valueAtPath(namespace.value, path);
        const base = valueAtPath(namespace.base, path);
        const user = valueAtPath(namespace.user, path);
        const secret = secretEntry !== undefined || sensitiveSettingPath(path);
        if (fields.has(key)) return;
        const description = settingDescription(node);
        fields.set(key, {
            path,
            label: settingLabel(path),
            ...(description === undefined ? {} : { description }),
            type: settingType(secret ? undefined : value ?? base ?? user, node),
            value: secret ? "" : settingText(value),
            overridden: hasPath(namespace.user, path),
            secret,
            secretSet: secretEntry?.set === true || (secret && value !== undefined),
        });
    };
    const visitSchema = (node: SettingsSchemaNode | undefined, path: string[], depth: number): void => {
        if (depth > 8) return;
        if (secrets.has(path.join("\0"))) {
            add(path, node);
            return;
        }
        const dictValue = valueAtPath(namespace.value, path);
        const children = node?.type === "object" && node.dict
            ? Object.entries(node.dict)
            : node?.type === "dict" && node.inner
              ? Object.keys(isRecord(dictValue) ? dictValue : {}).map((key) => [key, node.inner] as const)
              : [];
        if (children.length > 0) {
            for (const [key, child] of children) visitSchema(child, [...path, key], depth + 1);
            return;
        }
        add(path, node);
    };
    const visitValue = (value: unknown, path: string[], depth: number): void => {
        if (depth > 8 || value === undefined) return;
        if (isRecord(value)) {
            for (const [key, child] of Object.entries(value)) visitValue(child, [...path, key], depth + 1);
            return;
        }
        add(path);
    };
    visitSchema(schema, [], 0);
    visitValue(namespace.value, [], 0);
    visitValue(namespace.base, [], 0);
    visitValue(namespace.user, [], 0);
    for (const secret of namespace.secrets) add([...secret.path]);
    return [...fields.values()].sort((left, right) => left.path.join(".").localeCompare(right.path.join(".")));
}

export function presentSettingsPanel(
    result: { writable: boolean; hasDocument: boolean; namespaces: DshSettingsNamespaceView[] },
): DshSettingsPanelView {
    return {
        open: true,
        writable: result.writable,
        hasDocument: result.hasDocument,
        cards: result.namespaces.map((namespace) => ({
            ns: namespace.ns,
            title: namespace.ns.replace(/[-_]+/gu, " ").replace(/^./u, (character) => character.toLocaleUpperCase()),
            applies: namespace.applies,
            writable: result.writable,
            revision: namespace.revision,
            fields: presentSettingsFields(namespace),
        })),
    };
}

/**
 * Coerces webview-supplied settings edits into Harness path operations.
 *
 * Every value arrives as a string from the form, so the declared field type
 * decides how it is parsed, and a value that does not parse is rejected rather
 * than silently coerced. Changes naming an unknown field are dropped, and secret
 * fields are never written here — they stay with the credential provider.
 *
 * @param fields - the card's fields, authoritative for type and secrecy.
 * @param changes - the edits as posted by the webview.
 * @returns the operations to send, empty when nothing survives filtering.
 * @throws when a value does not parse as its declared type.
 */
export function settingsMutationOps(
    fields: readonly DshSettingFieldView[],
    changes: ReadonlyArray<{ path: string[]; value: string; clear: boolean }>,
): DshSettingsPathOperation[] {
    const byPath = new Map(fields.map((field) => [field.path.join("\0"), field]));
    const ops: DshSettingsPathOperation[] = [];
    for (const change of changes) {
        const field = byPath.get(change.path.join("\0"));
        if (!field || field.secret) continue;
        if (change.clear) {
            ops.push({ op: "unset", path: [...field.path] });
            continue;
        }
        ops.push({ op: "set", path: [...field.path], value: coerceFieldValue(field.type, change.value) });
    }
    return ops;
}

function coerceFieldValue(type: DshSettingFieldType, raw: string): unknown {
    if (type === "boolean") {
        if (raw !== "true" && raw !== "false") {
            throw new Error(t("Boolean settings must be true or false."));
        }
        return raw === "true";
    }
    if (type === "number") {
        const value = Number(raw.trim());
        if (!Number.isFinite(value)) {
            throw new Error(t("Number settings must contain a finite number."));
        }
        return value;
    }
    if (type === "json") {
        try {
            return JSON.parse(raw);
        } catch {
            throw new Error(t("JSON settings must contain valid JSON."));
        }
    }
    return raw;
}

export function permissionProjection(
    value: unknown,
    catalog?: DshPermissionCatalog,
): PermissionProjectionView | undefined {
    if (!isRecord(value) || typeof value.currentValue !== "string") return undefined;
    const rawOptions = Array.isArray(value.options) ? value.options : catalog?.options;
    if (!rawOptions) return undefined;
    const options = rawOptions.flatMap((option): PermissionProjectionView["options"] => {
        if (!isRecord(option) || typeof option.value !== "string" || typeof option.name !== "string") return [];
        return [{
            value: option.value,
            label: option.name,
            ...(typeof option.description === "string" ? { description: option.description } : {}),
        }];
    });
    const current = options.find((option) => option.value === value.currentValue);
    return { currentValue: value.currentValue, currentLabel: current?.label ?? value.currentValue, options };
}

/** Narrow the optional plan-mode projection without inventing a default. */
export function planProjection(value: unknown): DshPlanProjection | undefined {
    if (!isRecord(value) || typeof value.active !== "boolean" || typeof value.pending !== "boolean") {
        return undefined;
    }
    return { active: value.active, pending: value.pending };
}

export function sessionStatsProjection(value: unknown): SessionStatsView | undefined {
    if (!isRecord(value)) return undefined;
    const fields = ["turns", "steps", "llmMs", "toolMs", "ttftMs", "ttftSteps", "decodeMs", "decodeTokens"] as const;
    if (!fields.every((field) => typeof value[field] === "number" && Number.isFinite(value[field]) && value[field] >= 0)) return undefined;
    return {
        turns: value.turns as number,
        steps: value.steps as number,
        llmMs: value.llmMs as number,
        toolMs: value.toolMs as number,
        ttftMs: value.ttftMs as number,
        ttftSteps: value.ttftSteps as number,
        decodeMs: value.decodeMs as number,
        decodeTokens: value.decodeTokens as number,
    };
}

export function todoProjection(value: unknown): DshTodoItemView[] | undefined {
    if (!Array.isArray(value) || value.length === 0 || value.length > 200) return undefined;
    const todos: DshTodoItemView[] = [];
    const seen = new Set<string>();
    for (const candidate of value) {
        if (!isRecord(candidate) || typeof candidate.content !== "string" || !candidate.content.trim() ||
            seen.has(candidate.content) ||
            (candidate.status !== "pending" && candidate.status !== "in_progress" && candidate.status !== "completed")) return undefined;
        seen.add(candidate.content);
        todos.push({ content: candidate.content, status: candidate.status });
    }
    return todos;
}

const SCHEDULE_UTC_INSTANT = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/u;
const MAX_SCHEDULE_ITEMS = 200;
const MAX_SCHEDULE_CATALOG_ITEMS = 5_000;

function scheduleInstant(value: unknown): string | undefined {
    if (typeof value !== "string" || !SCHEDULE_UTC_INSTANT.test(value)) return undefined;
    const epoch = Date.parse(value);
    if (!Number.isFinite(epoch)) return undefined;
    try {
        return new Date(epoch).toISOString() === value ? value : undefined;
    } catch {
        return undefined;
    }
}

function scheduleText(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 && value.trim() === value
        ? value
        : undefined;
}

function scheduleId(value: unknown): string | undefined {
    return scheduleText(value);
}

function scheduleSeconds(value: unknown, minimum: number): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum ? value : undefined;
}

function scheduleOptionalTitle(value: unknown): string | undefined | null {
    if (value === undefined) return undefined;
    const title = scheduleText(value);
    return title !== undefined && title.length <= 120 ? title : null;
}

function scheduleLocalTime(value: unknown): string | undefined {
    return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}$/u.test(value)
        ? value
        : undefined;
}

function scheduleWeekdays(value: unknown): number[] | undefined {
    if (!Array.isArray(value) || value.length === 0 || value.length > 7) return undefined;
    const weekdays = value as unknown[];
    if (weekdays.some((day) => typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 7)) {
        return undefined;
    }
    const normalized = [...weekdays] as number[];
    if (new Set(normalized).size !== normalized.length) return undefined;
    return normalized.sort((left, right) => left - right);
}

/** Narrow the Schedule projection while retaining the Runtime's active order. */
export function scheduleProjection(value: unknown): DshScheduleItem[] | undefined {
    if (!Array.isArray(value) || value.length > MAX_SCHEDULE_ITEMS) return undefined;
    const schedules: DshScheduleItem[] = [];
    const seenIds = new Set<string>();
    for (const candidate of value) {
        if (!isRecord(candidate)) return undefined;
        const id = scheduleId(candidate.id);
        const prompt = scheduleText(candidate.prompt);
        const scheduledAt = scheduleInstant(candidate.scheduledAt);
        const title = scheduleOptionalTitle(candidate.title);
        if (id === undefined || prompt === undefined || scheduledAt === undefined || title === null || seenIds.has(id)) {
            return undefined;
        }
        seenIds.add(id);
        const withTitle = title === undefined ? {} : { title };
        if (candidate.kind === "after") {
            const afterSeconds = scheduleSeconds(candidate.afterSeconds, 1);
            if (afterSeconds === undefined) return undefined;
            schedules.push({ id, kind: "after", ...withTitle, prompt, afterSeconds, scheduledAt });
        } else if (candidate.kind === "at") {
            schedules.push({ id, kind: "at", ...withTitle, prompt, scheduledAt });
        } else if (candidate.kind === "every") {
            const everySeconds = scheduleSeconds(candidate.everySeconds, 60);
            if (everySeconds === undefined) return undefined;
            schedules.push({ id, kind: "every", ...withTitle, prompt, everySeconds, scheduledAt });
        } else if (candidate.kind === "daily") {
            const time = scheduleLocalTime(candidate.time);
            const timeZone = scheduleText(candidate.timeZone);
            if (time === undefined || timeZone === undefined) return undefined;
            schedules.push({ id, kind: "daily", ...withTitle, prompt, time, timeZone, scheduledAt });
        } else if (candidate.kind === "weekly") {
            const time = scheduleLocalTime(candidate.time);
            const timeZone = scheduleText(candidate.timeZone);
            const weekdays = scheduleWeekdays(candidate.weekdays);
            if (time === undefined || timeZone === undefined || weekdays === undefined) return undefined;
            schedules.push({ id, kind: "weekly", ...withTitle, prompt, time, timeZone, weekdays, scheduledAt });
        } else if (candidate.kind === "cron") {
            const expression = scheduleText(candidate.expression);
            const timeZone = scheduleText(candidate.timeZone);
            if (expression === undefined || timeZone === undefined) return undefined;
            schedules.push({ id, kind: "cron", ...withTitle, prompt, expression, timeZone, scheduledAt });
        } else {
            return undefined;
        }
    }
    return schedules;
}

/** Narrow RC.2's host-wide retained catalog, including each reminder's owning session and status. */
export function scheduleCatalogProjection(value: unknown): DshScheduleCatalogEntry[] | undefined {
    if (!Array.isArray(value) || value.length > MAX_SCHEDULE_CATALOG_ITEMS) return undefined;
    const entries: DshScheduleCatalogEntry[] = [];
    const seenIds = new Set<string>();
    for (const candidate of value) {
        if (!isRecord(candidate)) return undefined;
        const sessionId = scheduleId(candidate.sessionId);
        if (
            sessionId === undefined ||
            (candidate.status !== "active" && candidate.status !== "inactive")
        ) return undefined;
        const [schedule] = scheduleProjection([candidate]) ?? [];
        if (!schedule?.title || seenIds.has(schedule.id)) return undefined;
        let lastDelivery: DshScheduleCatalogEntry["lastDelivery"];
        if (candidate.lastDelivery !== undefined) {
            if (!isRecord(candidate.lastDelivery)) return undefined;
            const scheduledAt = scheduleInstant(candidate.lastDelivery.scheduledAt);
            const deliveredAt = scheduleInstant(candidate.lastDelivery.deliveredAt);
            const messageId = scheduleText(candidate.lastDelivery.messageId);
            if (scheduledAt === undefined || deliveredAt === undefined || messageId === undefined) return undefined;
            lastDelivery = { scheduledAt, deliveredAt, messageId };
        }
        seenIds.add(schedule.id);
        entries.push({
            ...schedule,
            title: schedule.title,
            sessionId,
            status: candidate.status,
            ...(lastDelivery === undefined ? {} : { lastDelivery }),
        });
    }
    return entries;
}

/** Narrow one bounded RC.2 Schedule delivery-history page. */
export function scheduleHistoryProjection(value: unknown, scheduleId: string): DshScheduleHistoryResult | undefined {
    if (!isRecord(value) || value.id !== scheduleId) return undefined;
    if (value.code === "schedule_not_found" || value.code === "delivery_cursor_not_found") {
        return { id: scheduleId, code: value.code };
    }
    if (
        !Array.isArray(value.records) || value.records.length > 100 ||
        typeof value.earlierRecordsUnavailable !== "boolean" ||
        typeof value.earlierRecordsPruned !== "boolean" ||
        !isRecord(value.retention) ||
        !Number.isSafeInteger(value.retention.days) || (value.retention.days as number) < 1 ||
        !Number.isSafeInteger(value.retention.records) || (value.retention.records as number) < 1 ||
        (value.nextBefore !== undefined &&
            (typeof value.nextBefore !== "string" || value.nextBefore.length === 0 || value.nextBefore.length > 512))
    ) return undefined;
    const records: DshScheduleDeliveryView[] = [];
    for (const candidate of value.records) {
        if (!isRecord(candidate)) return undefined;
        const scheduledAt = scheduleInstant(candidate.scheduledAt);
        const deliveredAt = scheduleInstant(candidate.deliveredAt);
        const messageId = scheduleText(candidate.messageId);
        if (
            scheduledAt === undefined || deliveredAt === undefined || messageId === undefined ||
            (candidate.prompt !== undefined &&
                (typeof candidate.prompt !== "string" || candidate.prompt.length > 32_768))
        ) return undefined;
        records.push({
            scheduledAt,
            deliveredAt,
            messageId,
            ...(candidate.prompt === undefined ? {} : { prompt: candidate.prompt }),
        });
    }
    return {
        id: scheduleId,
        records,
        earlierRecordsUnavailable: value.earlierRecordsUnavailable,
        earlierRecordsPruned: value.earlierRecordsPruned,
        ...(value.nextBefore === undefined ? {} : { nextBefore: value.nextBefore }),
    };
}

export function imageLimitsProjection(value: unknown): DshImageLimitsView | undefined {
    if (!isRecord(value)) return undefined;
    const positiveInteger = (candidate: unknown): candidate is number =>
        typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0;
    if (!positiveInteger(value.maxImageBytes) || !positiveInteger(value.maxImagesPerMessage) ||
        !positiveInteger(value.maxMessageImageBytes) || !Array.isArray(value.mediaTypes)) return undefined;
    const mediaTypes = value.mediaTypes.filter(isImageMediaType);
    return mediaTypes.length ? {
        maxImageBytes: value.maxImageBytes,
        maxImagesPerMessage: value.maxImagesPerMessage,
        maxMessageImageBytes: value.maxMessageImageBytes,
        mediaTypes,
    } : undefined;
}

export function prepareImageUploads(
    images: readonly DshImageUpload[],
    limits: DshImageLimitsView,
): { uploads: DshImageUpload[]; views: ChatImageView[] } {
    if (images.length > limits.maxImagesPerMessage) {
        throw new Error(t("A message can contain at most {count} images.", { count: limits.maxImagesPerMessage }));
    }
    let totalBytes = 0;
    const uploads: DshImageUpload[] = [];
    const views: ChatImageView[] = [];
    for (const image of images) {
        if (!limits.mediaTypes.includes(image.mediaType)) {
            throw new Error(t("This image format is not supported: {type}.", { type: image.mediaType }));
        }
        const bytes = Buffer.from(image.data, "base64");
        if (!image.data || bytes.toString("base64") !== image.data) {
            throw new Error(t("An attached image is not valid Base64 data."));
        }
        if (bytes.byteLength > limits.maxImageBytes) {
            throw new Error(t("Image {name} exceeds the {size} byte limit.", {
                name: image.name || t("image"),
                size: limits.maxImageBytes.toLocaleString(),
            }));
        }
        totalBytes += bytes.byteLength;
        uploads.push({ ...image });
        views.push({
            mediaType: image.mediaType,
            bytes: bytes.byteLength,
            ...(image.name === undefined ? {} : { name: image.name }),
            src: `data:${image.mediaType};base64,${image.data}`,
        });
    }
    if (totalBytes > limits.maxMessageImageBytes) {
        throw new Error(t("Attached images exceed the {size} byte total limit.", { size: limits.maxMessageImageBytes.toLocaleString() }));
    }
    return { uploads, views };
}

export function reasoningEffortOptions(catalog: DshSessionModelsResult, provider: string, modelId: string) {
    const group = catalog.groups.find((candidate) => candidate.id === provider);
    const model = group?.models.find((candidate) => candidate.id === modelId);
    if (!model) return [];
    const seen = new Set<string>();
    return (model.reasoning?.efforts ?? []).flatMap((value) => {
        const id = value.id.trim();
        if (!id || id.length > 128 || seen.has(id)) return [];
        seen.add(id);
        return [{ id, label: value.name || id }];
    });
}
