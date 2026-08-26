import {
    MAX_FILE_LOCATION_INDEX,
    MAX_FILE_LOCATION_PATH_CHARACTERS,
} from "./fileLocations";
import { isRecord } from "./guards";
import { TraceRowView, TraceSummaryField } from "./traceProjector";

export interface TraceLocation {
    sessionId: string;
    seq?: number;
    callId?: string;
    turn?: number;
    step?: number;
}

export type TraceTimelineMode = "sequence" | "duration";

export type TraceWebviewAction =
    | { type: "ready" }
    | { type: "selectRow"; rowId: string }
    | { type: "selectProjection"; key: string }
    | { type: "openFileLocation"; path: string; line: number; column?: number }
    | { type: "setQuery"; query: string }
    | { type: "page"; direction: "older" | "newer" | "latest" }
    | { type: "setTimelineMode"; mode: TraceTimelineMode }
    | { type: "clearSelection" };

export interface TracePanelStatus {
    running: boolean;
    attention: boolean;
    error?: string;
}

export interface TraceOverview {
    durationMs?: number;
    turns: number;
    calls: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}

export interface TraceTimelineItem {
    id: string;
    lane: "input" | "model" | "tools";
    slot: number;
    category: string;
    eventType: string;
    left: number;
    width: number;
    durationMs?: number;
    summary: string;
}

/**
 * The Trace panel wire contract.
 *
 * These types exist so both ends of the boundary are checked against one
 * declaration. The panel's client script is still an inline string, which tsc
 * does not see, so today only the host side is verified — but naming the shape
 * is what makes porting that script a mechanical translation instead of a
 * re-derivation of the fields it happens to read.
 *
 * `*Html` fields carry markup this host already escaped and linkified through
 * `renderFileLocationsHtml`; the client assigns them with `innerHTML` and must
 * not escape them again. Every other string is plain text.
 */
export interface TraceRowMessage extends TraceRowView {
    summaryHtml: string;
    errorHtml?: string;
}

export interface TraceProjectionMessage {
    id: string;
    key: string;
    seq: number;
    valuePreview: string;
    valueHtml: string;
}

export interface TracePanelState {
    sessionId: string;
    title: string;
    status: TracePanelStatus;
    query: string;
    rows: readonly TraceRowMessage[];
    totalEvents: number;
    totalRows: number;
    overview: TraceOverview;
    timeline: readonly TraceTimelineItem[];
    timelineMode: TraceTimelineMode;
    timelineStart?: number;
    timelineEnd?: number;
    filteredRows: number;
    offset: number;
    pageSize: number;
    hasOlder: boolean;
    hasNewer: boolean;
    followLatest: boolean;
    projections: readonly TraceProjectionMessage[];
    selectedId?: string;
    needsHistoryBaseline: boolean;
    error?: string;
}

export interface TraceDetailMessage {
    id: string;
    title: string;
    kind: "Event" | "Projection";
    summary: ReadonlyArray<TraceSummaryField & { valueHtml: string }>;
    raw: string;
    rawHtml: string;
}

export type TracePanelMessage =
    | { type: "state"; state: TracePanelState }
    | { type: "detail"; detail: TraceDetailMessage };

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
        case "setTimelineMode":
            return value.mode === "sequence" || value.mode === "duration"
                ? { type: "setTimelineMode", mode: value.mode }
                : undefined;
        case "clearSelection":
            return { type: "clearSelection" };
        default:
            return undefined;
    }
}
