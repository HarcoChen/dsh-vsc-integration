import { randomUUID } from "node:crypto";
import {
    ABSENT_VALUE_METHODS,
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
import { isRecord } from "./guards";

export type HarnessStreamEnvelope<F> = Omit<HarnessServerRequest<F>, "type">;

export interface HarnessClientDiagnostic {
    channel: "rpc" | "mux" | "host";
    message: string;
    cause?: unknown;
}

export interface HarnessApiClientOptions {
    baseUrl: string | (() => string | undefined);
    fetch?: typeof fetch;
    /** WebSocket constructor used for Harness event streams (injectable for non-browser hosts/tests). */
    webSocketFactory?: (url: string) => WebSocket;
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

/**
 * Carrier-level failure: the Runtime answered, but not with an RPC envelope.
 * The status is kept because a 404 is how a Runtime reports that it serves no
 * such method at all — the signal an optional feature degrades on.
 */
export class HarnessHttpError extends Error {
    public constructor(
        public readonly method: string,
        public readonly status: number,
    ) {
        super(`Harness RPC ${method} returned HTTP ${status}`);
        this.name = "HarnessHttpError";
    }
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
                throw new HarnessHttpError(method, response.status);
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
            if (!("value" in body.result) && !ABSENT_VALUE_METHODS.has(method)) {
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
        return this.readStream("/api/events.mux", "mux", signal, onOpen);
    }

    public host(
        signal: AbortSignal,
        onOpen?: () => void,
    ): AsyncIterable<HarnessStreamEnvelope<DshHostFrame>> {
        return this.readStream("/api/events.host", "host", signal, onOpen);
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

    private async *readStream<F extends { type: string }>(
        path: string,
        channel: "mux" | "host",
        signal: AbortSignal,
        onOpen?: () => void,
    ): AsyncGenerator<HarnessStreamEnvelope<F>> {
        // Existing callers can inject fetch for deterministic protocol checks. The extension
        // itself uses the WebSocket path, which is required by current Harness web servers.
        if (this.options.webSocketFactory === undefined && this.options.fetch !== undefined) {
            yield* this.readSse(path, channel, signal, onOpen);
            return;
        }

        const factory = this.options.webSocketFactory ?? defaultWebSocketFactory;
        const socket = factory(toWebSocketUrl(this.url(path)));
        yield* this.readWebSocket(socket, channel, signal, onOpen);
    }

    private async *readWebSocket<F extends { type: string }>(
        socket: WebSocket,
        channel: "mux" | "host",
        signal: AbortSignal,
        onOpen?: () => void,
    ): AsyncGenerator<HarnessStreamEnvelope<F>> {
        const queue: Array<string | ArrayBuffer | Blob> = [];
        let wake: (() => void) | undefined;
        let closed = false;
        let failure: unknown;
        const notify = (): void => {
            wake?.();
            wake = undefined;
        };
        const onMessage = (event: MessageEvent): void => {
            queue.push(event.data);
            notify();
        };
        const onError = (event: Event): void => {
            failure = new Error(`Harness ${channel} WebSocket failed`);
            (failure as Error & { cause?: unknown }).cause = event;
            closed = true;
            notify();
        };
        const onClose = (): void => {
            closed = true;
            notify();
        };
        const abort = (): void => {
            closed = true;
            socket.close();
            notify();
        };

        socket.addEventListener("message", onMessage);
        socket.addEventListener("error", onError);
        socket.addEventListener("close", onClose);
        signal.addEventListener("abort", abort, { once: true });
        try {
            await waitForWebSocketOpen(socket, signal);
            onOpen?.();
            while (!closed || queue.length > 0) {
                if (queue.length === 0) {
                    await new Promise<void>((resolve) => (wake = resolve));
                    continue;
                }
                const data = await webSocketDataToText(queue.shift()!);
                const envelope = this.parseStreamEnvelope<F>(data, channel);
                if (envelope) yield envelope;
            }
            if (failure) throw failure;
        } finally {
            signal.removeEventListener("abort", abort);
            socket.removeEventListener("message", onMessage);
            socket.removeEventListener("error", onError);
            socket.removeEventListener("close", onClose);
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
                socket.close();
            }
        }
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
            this.diagnostic(channel, "Dropping malformed Harness stream frame", error);
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

function defaultWebSocketFactory(url: string): WebSocket {
    if (typeof WebSocket !== "function") {
        throw new Error("Harness WebSocket is unavailable in this runtime");
    }
    return new WebSocket(url);
}

function toWebSocketUrl(url: string): string {
    const parsed = new URL(url);
    parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    return parsed.toString();
}

function waitForWebSocketOpen(socket: WebSocket, signal: AbortSignal): Promise<void> {
    if (socket.readyState === WebSocket.OPEN) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const cleanup = (): void => {
            socket.removeEventListener("open", opened);
            socket.removeEventListener("error", failed);
            socket.removeEventListener("close", closed);
            signal.removeEventListener("abort", aborted);
        };
        const opened = (): void => {
            cleanup();
            resolve();
        };
        const failed = (): void => {
            cleanup();
            reject(new Error("Harness WebSocket failed during handshake"));
        };
        const closed = (): void => {
            cleanup();
            reject(new Error("Harness WebSocket closed during handshake"));
        };
        const aborted = (): void => {
            cleanup();
            socket.close();
            reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
        };
        socket.addEventListener("open", opened);
        socket.addEventListener("error", failed);
        socket.addEventListener("close", closed);
        signal.addEventListener("abort", aborted, { once: true });
    });
}

async function webSocketDataToText(data: string | ArrayBuffer | Blob): Promise<string> {
    if (typeof data === "string") return data;
    if (data instanceof Blob) return data.text();
    return new TextDecoder().decode(data);
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
