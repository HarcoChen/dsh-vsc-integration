import { randomUUID } from "node:crypto";
import {
    HarnessClientResponse,
    HarnessHostDescription,
    HarnessRpcMethod,
    HarnessRpcPayload,
    HarnessRpcValue,
    HarnessServerRequest,
} from "./harnessProtocol";
import {
    DshHostFrame,
    DshMuxFrame,
    DshRpcError,
    DshRpcReceipt,
} from "./types";

export type HarnessStreamEnvelope<F> = Omit<HarnessServerRequest<F>, "type">;

export interface HarnessClientDiagnostic {
    channel: "rpc" | "mux" | "host";
    message: string;
    cause?: unknown;
}

export interface HarnessApiClientOptions {
    baseUrl: string | (() => string | undefined);
    fetch?: typeof fetch;
    timeoutMs?: number | (() => number);
    mintRpcId?: () => string;
    onDiagnostic?: (diagnostic: HarnessClientDiagnostic) => void;
}

export class HarnessRpcError extends Error {
    public constructor(
        public readonly method: string,
        public readonly rpcError: DshRpcError,
    ) {
        super(`Harness RPC ${method} failed: ${rpcError.code}: ${rpcError.message}`);
        this.name = "HarnessRpcError";
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcError(value: unknown): value is DshRpcError {
    return (
        isRecord(value) &&
        typeof value.code === "string" &&
        typeof value.message === "string"
    );
}

function abortError(error: unknown): boolean {
    return (
        (error instanceof DOMException && error.name === "AbortError") ||
        (error instanceof Error && error.name === "AbortError")
    );
}

/**
 * Typed carrier for the currently integrated Harness Web RPC surface.
 * Runtime schemas remain owned by Harness; this layer validates the common wire envelope and
 * leaves merge-extensible business values to the feature that consumes them.
 */
export class HarnessApiClient {
    private readonly doFetch: typeof fetch;
    private readonly mintRpcId: () => string;

    public constructor(private readonly options: HarnessApiClientOptions) {
        this.doFetch = options.fetch ?? fetch;
        this.mintRpcId = options.mintRpcId ?? randomUUID;
    }

    public async call<K extends HarnessRpcMethod>(
        method: K,
        payload: HarnessRpcPayload<K>,
        signal?: AbortSignal,
    ): Promise<HarnessRpcValue<K>> {
        const rpcId = this.mintRpcId();
        const controller = new AbortController();
        const relayAbort = (): void => controller.abort(signal?.reason);
        signal?.addEventListener("abort", relayAbort, { once: true });
        if (signal?.aborted) relayAbort();

        const timeout = setTimeout(
            () => controller.abort(new Error(`Harness RPC ${method} timed out`)),
            this.timeoutMs(),
        );

        try {
            const response = await this.doFetch(this.url(`/api/${method}`), {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    type: "client-request",
                    rpcId,
                    method,
                    payload,
                }),
                signal: controller.signal,
            });

            if (!response.ok) {
                throw new Error(`Harness RPC ${method} returned HTTP ${response.status}`);
            }

            const body: unknown = await response.json();
            if (!isRecord(body) || body.type !== "server-response") {
                throw new Error(`Harness RPC ${method} returned an invalid server-response`);
            }
            if (body.rpcId !== rpcId) {
                throw new Error(
                    `Harness RPC ${method} rpcId mismatch: sent ${rpcId}, received ${String(body.rpcId)}`,
                );
            }
            if (!isRecord(body.result) || typeof body.result.ok !== "boolean") {
                throw new Error(`Harness RPC ${method} returned an invalid result envelope`);
            }
            if (!body.result.ok) {
                const error = isRpcError(body.result.error)
                    ? body.result.error
                    : { code: "invalid-error", message: "Harness returned an invalid RPC error" };
                throw new HarnessRpcError(method, error);
            }
            if (!("value" in body.result)) {
                throw new Error(`Harness RPC ${method} returned no value`);
            }
            return body.result.value as HarnessRpcValue<K>;
        } catch (error) {
            if (controller.signal.aborted && !signal?.aborted && abortError(error)) {
                throw new Error(`Harness RPC ${method} timed out`);
            }
            throw error;
        } finally {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", relayAbort);
        }
    }

    public describe(signal?: AbortSignal): Promise<HarnessHostDescription> {
        return this.call("host.describe", {}, signal);
    }

    public mux(
        signal: AbortSignal,
        onOpen?: () => void,
    ): AsyncIterable<HarnessStreamEnvelope<DshMuxFrame>> {
        return this.readSse("/api/events.mux", "mux", signal, onOpen);
    }

    public host(
        signal: AbortSignal,
        onOpen?: () => void,
    ): AsyncIterable<HarnessStreamEnvelope<DshHostFrame>> {
        return this.readSse("/api/events.host", "host", signal, onOpen);
    }

    public async respond<T>(
        response: HarnessClientResponse<T>,
        signal?: AbortSignal,
    ): Promise<DshRpcReceipt> {
        const httpResponse = await this.doFetch(this.url("/api/respond"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(response),
            signal,
        });
        if (!httpResponse.ok) {
            throw new Error(`Harness respond returned HTTP ${httpResponse.status}`);
        }
        const body: unknown = await httpResponse.json();
        if (!isRecord(body) || typeof body.accepted !== "boolean") {
            throw new Error("Harness respond returned an invalid receipt");
        }
        if (body.accepted) {
            return { accepted: true };
        }
        if (typeof body.reason !== "string") {
            throw new Error("Harness respond returned an invalid rejection receipt");
        }
        return { accepted: false, reason: body.reason };
    }

    private async *readSse<F extends { type: string }>(
        path: string,
        channel: "mux" | "host",
        signal: AbortSignal,
        onOpen?: () => void,
    ): AsyncGenerator<HarnessStreamEnvelope<F>> {
        const response = await this.doFetch(this.url(path), { signal });
        if (!response.ok || response.body === null) {
            throw new Error(`Harness ${channel} stream returned HTTP ${response.status}`);
        }
        onOpen?.();

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
            while (true) {
                const { done, value } = await reader.read();
                buffer += decoder.decode(value, { stream: !done });
                const parsed = takeSseData(buffer);
                buffer = parsed.rest;
                for (const data of parsed.values) {
                    const envelope = this.parseStreamEnvelope<F>(data, channel);
                    if (envelope) {
                        yield envelope;
                    }
                }
                if (done) {
                    if (buffer.trim()) {
                        this.diagnostic(channel, "Ignoring unterminated SSE frame");
                    }
                    return;
                }
            }
        } finally {
            await reader.cancel().catch(() => undefined);
        }
    }

    private parseStreamEnvelope<F extends { type: string }>(
        data: string,
        channel: "mux" | "host",
    ): HarnessStreamEnvelope<F> | undefined {
        try {
            const body: unknown = JSON.parse(data);
            if (
                !isRecord(body) ||
                body.type !== "server-request" ||
                typeof body.rpcId !== "string" ||
                typeof body.method !== "string" ||
                !isRecord(body.payload) ||
                typeof body.payload.type !== "string"
            ) {
                throw new Error("invalid server-request envelope");
            }
            return {
                rpcId: body.rpcId,
                method: body.method,
                payload: body.payload as F,
            };
        } catch (error) {
            this.diagnostic(channel, "Dropping malformed SSE frame", error);
            return undefined;
        }
    }

    private url(path: string): string {
        const configured =
            typeof this.options.baseUrl === "function"
                ? this.options.baseUrl()
                : this.options.baseUrl;
        if (!configured) {
            throw new Error("Harness runtime is not connected");
        }
        const base = configured.endsWith("/") ? configured : `${configured}/`;
        return new URL(path.replace(/^\//u, ""), base).toString();
    }

    private timeoutMs(): number {
        const value =
            typeof this.options.timeoutMs === "function"
                ? this.options.timeoutMs()
                : (this.options.timeoutMs ?? 600_000);
        return Math.max(1, value);
    }

    private diagnostic(
        channel: "rpc" | "mux" | "host",
        message: string,
        cause?: unknown,
    ): void {
        this.options.onDiagnostic?.({ channel, message, cause });
    }
}

interface SseDataResult {
    values: string[];
    rest: string;
}

/** Extract all complete SSE records while retaining an incomplete tail. */
export function takeSseData(input: string): SseDataResult {
    const values: string[] = [];
    let rest = input;
    while (true) {
        const match = /\r?\n\r?\n/u.exec(rest);
        if (!match || match.index === undefined) {
            break;
        }
        const block = rest.slice(0, match.index);
        rest = rest.slice(match.index + match[0].length);
        const lines = block.split(/\r?\n/u);
        const dataLines = lines
            .filter((line) => line === "data" || line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /u, ""));
        if (dataLines.length) {
            values.push(dataLines.join("\n"));
        }
    }
    return { values, rest };
}
