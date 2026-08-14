import {
    MAX_FILE_LOCATION_INDEX,
    MAX_FILE_LOCATION_PATH_CHARACTERS,
} from "./fileLocations";

export interface TraceLocation {
    sessionId: string;
    seq?: number;
    callId?: string;
    turn?: number;
    step?: number;
}

export type TraceWebviewAction =
    | { type: "ready" }
    | { type: "selectRow"; rowId: string }
    | { type: "selectProjection"; key: string }
    | { type: "openFileLocation"; path: string; line: number; column?: number }
    | { type: "setQuery"; query: string }
    | { type: "page"; direction: "older" | "newer" | "latest" };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number, allowEmpty = false): value is string {
    return (
        typeof value === "string" &&
        value.length <= maximum &&
        (allowEmpty || value.length > 0) &&
        !value.includes("\0")
    );
}

function nonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Strict boundary for commands/deep links entering the extension host. */
export function parseTraceLocation(value: unknown): TraceLocation | undefined {
    if (!isRecord(value) || !boundedString(value.sessionId, 512)) return undefined;
    if (value.seq !== undefined && !nonNegativeInteger(value.seq)) return undefined;
    if (value.callId !== undefined && !boundedString(value.callId, 1_024)) return undefined;
    if (value.turn !== undefined && !nonNegativeInteger(value.turn)) return undefined;
    if (value.step !== undefined && !nonNegativeInteger(value.step)) return undefined;
    return {
        sessionId: value.sessionId,
        ...(value.seq === undefined ? {} : { seq: value.seq }),
        ...(value.callId === undefined ? {} : { callId: value.callId }),
        ...(value.turn === undefined ? {} : { turn: value.turn }),
        ...(value.step === undefined ? {} : { step: value.step }),
    };
}

/** Strict trust boundary for messages originating inside the Trace webview. */
export function parseTraceWebviewAction(value: unknown): TraceWebviewAction | undefined {
    if (!isRecord(value) || typeof value.type !== "string") return undefined;
    if ("sessionId" in value || "seq" in value || "callId" in value) return undefined;
    switch (value.type) {
        case "ready":
            return { type: "ready" };
        case "selectRow":
            return boundedString(value.rowId, 2_048)
                ? { type: "selectRow", rowId: value.rowId }
                : undefined;
        case "selectProjection":
            return boundedString(value.key, 1_024)
                ? { type: "selectProjection", key: value.key }
                : undefined;
        case "openFileLocation":
            if (
                Object.keys(value).some((key) =>
                    key !== "type" && key !== "path" && key !== "line" && key !== "column"
                ) ||
                !boundedString(value.path, MAX_FILE_LOCATION_PATH_CHARACTERS) ||
                !nonNegativeInteger(value.line) ||
                value.line === 0 ||
                value.line > MAX_FILE_LOCATION_INDEX ||
                (value.column !== undefined &&
                    (!nonNegativeInteger(value.column) ||
                        value.column === 0 ||
                        value.column > MAX_FILE_LOCATION_INDEX))
            ) return undefined;
            return {
                type: "openFileLocation",
                path: value.path,
                line: value.line,
                ...(value.column === undefined ? {} : { column: value.column }),
            };
        case "setQuery":
            return boundedString(value.query, 500, true)
                ? { type: "setQuery", query: value.query }
                : undefined;
        case "page":
            return value.direction === "older" ||
                value.direction === "newer" ||
                value.direction === "latest"
                ? { type: "page", direction: value.direction }
                : undefined;
        default:
            return undefined;
    }
}
