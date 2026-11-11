import type { SessionStateSnapshot } from "./sessionStore";
import { isRecord } from "./guards";

export interface ModelRate {
    provider: string;
    model: string;
    currency: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}
export interface SessionCostView {
    totals: Array<{ currency: string; input: number; output: number; cache: number; total: number }>;
    pricedRequests: number;
    unpricedRequests: number;
}
export function modelRates(value: unknown): ModelRate[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter(isRecord)
        .filter(
            (rate) =>
                typeof rate.provider === "string" &&
                typeof rate.model === "string" &&
                typeof rate.currency === "string" &&
                /^[A-Z]{3}$/u.test(rate.currency) &&
                [rate.input, rate.output, rate.cacheRead, rate.cacheWrite].every(
                    (n) => typeof n === "number" && Number.isFinite(n) && n >= 0
                )
        ) as unknown as ModelRate[];
}

/** Current user rates apply to each request's own route. Usage echoes replace their request's prior sample. */
export function estimateSessionCost(
    snapshot: SessionStateSnapshot | undefined,
    rates: readonly ModelRate[]
): SessionCostView | undefined {
    if (!snapshot || !rates.length) return undefined;
    const requests = new Map<string, { provider?: string; model?: string; usage?: Record<string, unknown> }>();
    const active = new Map<string, string>();
    for (const stored of snapshot.events) {
        const event = stored.event;
        const data = isRecord(event.data) ? event.data : undefined;
        if (!data) continue;
        const step = `${data.turn}:${data.step}`;
        if (event.type === "request/header" && isRecord(data.header) && isRecord(data.header.config)) {
            const key = `request:${event.seq}`;
            active.set(step, key);
            requests.set(key, {
                provider: typeof data.header.config.provider === "string" ? data.header.config.provider : undefined,
                model: typeof data.header.config.model === "string" ? data.header.config.model : undefined,
            });
        }
        const chunk = event.type === "assistant/chunk" && isRecord(data.chunk) ? data.chunk : undefined;
        const usage =
            chunk?.type === "usage"
                ? chunk.usage
                : event.type === "assistant/message" || event.type === "assistant/attempt"
                  ? data.usage
                  : undefined;
        if (
            !isRecord(usage) ||
            ![usage.inputTokens, usage.outputTokens].every(
                (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0
            )
        )
            continue;
        const key = active.get(step) ?? `step:${step}`;
        const previous = requests.get(key) ?? {};
        const message = isRecord(data.message) ? data.message : undefined;
        const source = isRecord(message?.source) ? message.source : undefined;
        requests.set(key, {
            provider: typeof source?.provider === "string" ? source.provider : previous.provider,
            model: typeof source?.model === "string" ? source.model : previous.model,
            usage,
        });
    }
    let pricedRequests = 0,
        unpricedRequests = 0;
    const currencies = new Map<string, SessionCostView["totals"][number]>();
    for (const request of requests.values()) {
        if (!request.usage) continue;
        const rate = rates.find((rate) => rate.provider === request.provider && rate.model === request.model);
        if (!rate) {
            unpricedRequests += 1;
            continue;
        }
        const count = (key: string): number =>
            typeof request.usage![key] === "number" &&
            Number.isSafeInteger(request.usage![key]) &&
            Number(request.usage![key]) >= 0
                ? Number(request.usage![key])
                : 0;
        const input = (count("inputTokens") * rate.input) / 1_000_000;
        const output = (count("outputTokens") * rate.output) / 1_000_000;
        const cache =
            (count("cacheReadTokens") * rate.cacheRead + count("cacheWriteTokens") * rate.cacheWrite) / 1_000_000;
        const total = currencies.get(rate.currency) ?? {
            currency: rate.currency,
            input: 0,
            output: 0,
            cache: 0,
            total: 0,
        };
        total.input += input;
        total.output += output;
        total.cache += cache;
        total.total += input + output + cache;
        currencies.set(rate.currency, total);
        pricedRequests += 1;
    }
    return { totals: [...currencies.values()], pricedRequests, unpricedRequests };
}
