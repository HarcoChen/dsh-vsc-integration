import { ProjectionCell, SessionStateSnapshot } from "./sessionStore";
import {
    DshModelSelection,
    DshReasoningEffortOption,
    HostBaselineView,
    TokenUsageView,
} from "./types";
import { isRecord } from "./guards";

interface UsageBuckets {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
}

export interface SelectedModelSnapshot {
    selection: DshModelSelection;
    asOfSeq: number;
    reasoningEfforts?: DshReasoningEffortOption[];
}

interface EventRoute {
    route: TokenUsageView["route"];
    seq: number;
}

function nonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
    return nonNegativeInteger(value) && value > 0;
}

function parseUsage(value: unknown): UsageBuckets | undefined {
    if (
        !isRecord(value) ||
        !nonNegativeInteger(value.inputTokens) ||
        !nonNegativeInteger(value.outputTokens)
    ) return undefined;
    return {
        inputTokens: value.inputTokens,
        outputTokens: value.outputTokens,
        ...(nonNegativeInteger(value.cacheReadTokens)
            ? { cacheReadTokens: value.cacheReadTokens }
            : {}),
        ...(nonNegativeInteger(value.cacheWriteTokens)
            ? { cacheWriteTokens: value.cacheWriteTokens }
            : {}),
        ...(nonNegativeInteger(value.reasoningTokens)
            ? { reasoningTokens: value.reasoningTokens }
            : {}),
    };
}

function projectionValue(
    snapshot: SessionStateSnapshot,
    key: string,
): unknown {
    return snapshot.projections.find((cell: ProjectionCell) => cell.key === key)?.value;
}

function billingUsage(snapshot: SessionStateSnapshot): TokenUsageView["billing"] {
    const value = projectionValue(snapshot, "tokenUsage");
    if (
        !isRecord(value) ||
        !nonNegativeInteger(value.uncachedInputTokens) ||
        !nonNegativeInteger(value.outputTokens) ||
        !nonNegativeInteger(value.cacheReadTokens) ||
        !nonNegativeInteger(value.cacheWriteTokens)
    ) return undefined;

    const samples = new Map<string, UsageBuckets>();
    for (const entry of [...snapshot.events].sort((left, right) =>
        left.event.seq - right.event.seq,
    )) {
        const data = isRecord(entry.event.data) ? entry.event.data : undefined;
        if (!data) continue;
        const turn = data?.turn;
        const step = data?.step;
        if (!nonNegativeInteger(turn) || !nonNegativeInteger(step)) continue;
        let usage: UsageBuckets | undefined;
        if (entry.event.type === "assistant/chunk") {
            const chunk = isRecord(data.chunk) ? data.chunk : undefined;
            if (chunk?.type === "usage") usage = parseUsage(chunk.usage);
        } else if (entry.event.type === "assistant/message") {
            usage = parseUsage(data.usage);
        }
        if (usage) samples.set(`${turn}:${step}`, usage);
    }
    const reportedReasoning = [...samples.values()]
        .map((sample) => sample.reasoningTokens)
        .filter((tokens): tokens is number => tokens !== undefined);

    return {
        uncachedInputTokens: value.uncachedInputTokens,
        outputTokens: value.outputTokens,
        cacheReadTokens: value.cacheReadTokens,
        cacheWriteTokens: value.cacheWriteTokens,
        ...(reportedReasoning.length === 0
            ? {}
            : { reasoningTokens: reportedReasoning.reduce((sum, tokens) => sum + tokens, 0) }),
    };
}

function contextPressure(snapshot: SessionStateSnapshot): TokenUsageView["context"] {
    const value = projectionValue(snapshot, "contextPressure");
    if (!isRecord(value)) return undefined;
    const pressureTokens = nonNegativeInteger(value.pressureTokens)
        ? value.pressureTokens
        : undefined;
    const projectedTokens = nonNegativeInteger(value.projectedTokens)
        ? value.projectedTokens
        : undefined;
    const contextWindow = positiveInteger(value.contextWindow)
        ? value.contextWindow
        : undefined;
    if (
        pressureTokens === undefined &&
        projectedTokens === undefined &&
        contextWindow === undefined
    ) return undefined;
    return {
        ...(pressureTokens === undefined ? {} : { pressureTokens }),
        ...(projectedTokens === undefined ? {} : { projectedTokens }),
        ...(contextWindow === undefined ? {} : { contextWindow }),
    };
}

function contextBreakdown(snapshot: SessionStateSnapshot): TokenUsageView["breakdown"] {
    const value = projectionValue(snapshot, "contextBreakdown");
    // The wire view is a strict triple of non-negative integers; a partial
    // payload means the projection is not the one this reader understands.
    if (
        !isRecord(value) ||
        !nonNegativeInteger(value.systemTokens) ||
        !nonNegativeInteger(value.toolsTokens) ||
        !nonNegativeInteger(value.messageTokens)
    ) return undefined;
    return {
        systemTokens: value.systemTokens,
        toolsTokens: value.toolsTokens,
        messageTokens: value.messageTokens,
    };
}

function eventRoute(snapshot: SessionStateSnapshot): EventRoute {
    let route: TokenUsageView["route"] = {};
    let seq = -1;
    for (const entry of [...snapshot.events].sort((left, right) =>
        left.event.seq - right.event.seq,
    )) {
        const data = isRecord(entry.event.data) ? entry.event.data : undefined;
        if (entry.event.type === "request/header") {
            const header = isRecord(data?.header) ? data.header : undefined;
            const config = isRecord(header?.config) ? header.config : undefined;
            if (typeof config?.provider === "string" && typeof config.model === "string") {
                route = {
                    provider: config.provider,
                    model: config.model,
                    ...(typeof config.reasoningEffort === "string"
                        ? { reasoningEffort: config.reasoningEffort }
                        : {}),
                };
                seq = entry.event.seq;
            }
        } else if (entry.event.type === "assistant/message") {
            const message = isRecord(data?.message) ? data.message : undefined;
            const source = isRecord(message?.source) ? message.source : undefined;
            if (typeof source?.provider === "string" && typeof source.model === "string") {
                route = {
                    ...route,
                    provider: source.provider,
                    model: source.model,
                };
                seq = entry.event.seq;
            }
        }
    }
    return { route, seq };
}

/** Presents only public session projections and public durable usage/request events. */
export function projectTokenUsage(
    snapshot: SessionStateSnapshot | undefined,
    selected: SelectedModelSnapshot | undefined,
    host: HostBaselineView | undefined,
): TokenUsageView | undefined {
    const fromEvents = snapshot ? eventRoute(snapshot) : { route: {}, seq: -1 };
    const route: TokenUsageView["route"] = selected && selected.asOfSeq >= fromEvents.seq
        ? {
              provider: selected.selection.provider,
              model: selected.selection.model,
              ...(selected.selection.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: selected.selection.reasoningEffort }),
          }
        : Object.keys(fromEvents.route).length > 0
          ? fromEvents.route
          : {
                ...(host?.provider === undefined ? {} : { provider: host.provider }),
                ...(host?.model === undefined ? {} : { model: host.model }),
            };
    const billing = snapshot ? billingUsage(snapshot) : undefined;
    const context = snapshot ? contextPressure(snapshot) : undefined;
    const breakdown = snapshot ? contextBreakdown(snapshot) : undefined;
    if (Object.keys(route).length === 0 && !billing && !context && !breakdown) return undefined;
    return {
        route,
        ...(billing === undefined ? {} : { billing }),
        ...(context === undefined ? {} : { context }),
        ...(breakdown === undefined ? {} : { breakdown }),
    };
}
