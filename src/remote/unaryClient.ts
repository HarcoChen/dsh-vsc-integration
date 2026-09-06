import { randomUUID } from "node:crypto";
import {
    assertRemoteEndpoint,
    isRemoteJsonValue,
    parseRemoteServerResponse,
    remoteEndpointUrl,
    type RemoteClientRequest,
} from "./contracts";
import { isAbortError, RemoteError, RemoteHttpError, RemoteProtocolError } from "./errors";

export interface RemoteUnaryClientOptions {
    baseUrl: string | (() => string | undefined);
    fetch?: typeof fetch;
    requestHeaders?: () => Record<string, string>;
    timeoutMs?: number | (() => number);
    mintRpcId?: () => string;
    onDiagnostic?: (message: string, cause?: unknown) => void;
}

/**
 * Unary caller for the RC Remote API.  The feature-facing payload is always
 * an `args` object; this class owns the full Connection envelope and validates
 * every response before returning the endpoint value.
 */
export class RemoteUnaryClient {
    private readonly doFetch: typeof fetch;
    private readonly mintRpcId: () => string;

    public constructor(private readonly options: RemoteUnaryClientOptions) {
        this.doFetch = options.fetch ?? fetch;
        this.mintRpcId = options.mintRpcId ?? randomUUID;
    }

    public async call<T = unknown>(
        endpoint: string,
        args: Record<string, unknown> = {},
        signal?: AbortSignal,
    ): Promise<T> {
        assertRemoteEndpoint(endpoint);
        if (!isPlainRecord(args) || !isRemoteJsonValue(args)) {
            throw new TypeError(`Remote ${endpoint} args must be a plain object`);
        }
        const base = this.baseUrl();
        const rpcId = this.mintRpcId();
        const request: RemoteClientRequest = {
            type: "client-request",
            rpcId,
            method: endpoint,
            payload: { args },
        };
        const controller = new AbortController();
        const relayAbort = (): void => controller.abort(signal?.reason);
        signal?.addEventListener("abort", relayAbort, { once: true });
        if (signal?.aborted) relayAbort();
        const timeoutMs = this.timeoutMs();
        const timeout = setTimeout(
            () => controller.abort(new Error(`Remote RPC ${endpoint} timed out`)),
            timeoutMs,
        );
        try {
            const response = await this.doFetch(remoteEndpointUrl(base, endpoint), {
                method: "POST",
                headers: {
                    ...this.requestHeaders(),
                    "content-type": "application/json",
                },
                body: JSON.stringify(request),
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new RemoteHttpError(endpoint, response.status);
            }
            let decoded: unknown;
            try {
                decoded = await response.json();
            } catch (cause) {
                throw new RemoteProtocolError(`Remote ${endpoint} returned invalid JSON`, { cause });
            }
            let full;
            try {
                full = parseRemoteServerResponse(decoded);
            } catch (cause) {
                throw new RemoteProtocolError(`Remote ${endpoint} returned an invalid response`, { cause });
            }
            if (full.rpcId !== rpcId) {
                throw new RemoteProtocolError(
                    `Remote ${endpoint} rpcId mismatch: sent ${rpcId}, received ${full.rpcId}`,
                );
            }
            if (!full.result.ok) {
                throw RemoteError.fromFailure(full.result.error, endpoint);
            }
            return full.result.value as T;
        } catch (error) {
            if (controller.signal.aborted && !signal?.aborted && isAbortError(error)) {
                throw new Error(`Remote RPC ${endpoint} timed out`);
            }
            throw error;
        } finally {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", relayAbort);
        }
    }

    /** A small authenticated probe used by startup diagnostics and health checks. */
    public async probe(signal?: AbortSignal): Promise<void> {
        // `session.list`'s generated descriptor keeps its reserved argument
        // name `_request`; using `request` is rejected by Gateway validation.
        await this.call("session/list", { _request: {} }, signal);
    }

    private baseUrl(): string {
        const configured = typeof this.options.baseUrl === "function"
            ? this.options.baseUrl()
            : this.options.baseUrl;
        if (!configured) throw new Error("DSH Runtime is not connected");
        return configured;
    }

    private timeoutMs(): number {
        const value = typeof this.options.timeoutMs === "function"
            ? this.options.timeoutMs()
            : this.options.timeoutMs ?? 600_000;
        return Number.isFinite(value) && value > 0 ? value : 600_000;
    }

    private requestHeaders(): Record<string, string> {
        return this.options.requestHeaders?.() ?? {};
    }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
