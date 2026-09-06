import type { RemoteRpcFailure } from "./contracts";

/** A typed failure returned by one RC Remote endpoint. */
export class RemoteError extends Error {
    /** Structural marker preserved across duplicate bundles/realms. */
    public readonly isDSHRemoteError = true as const;
    public readonly code: string;
    public readonly details: Record<string, unknown>;
    public readonly endpoint?: string;

    public constructor(
        code: string,
        message: string,
        details: Record<string, unknown> = {},
        endpoint?: string,
    ) {
        super(message);
        this.name = "RemoteError";
        this.code = code;
        this.details = details;
        this.endpoint = endpoint;
    }

    public static fromFailure(failure: RemoteRpcFailure, endpoint?: string): RemoteError {
        return new RemoteError(failure.code, failure.message, failure.details, endpoint);
    }
}

/** HTTP/transport rejection before the Remote service produced an RPC result. */
export class RemoteHttpError extends Error {
    public constructor(
        public readonly endpoint: string,
        public readonly status: number,
        message = httpMessage(endpoint, status),
    ) {
        super(message);
        this.name = "RemoteHttpError";
    }

    public get isAuthenticationFailure(): boolean {
        return this.status === 401 || this.status === 403;
    }
}

/** The carrier was reachable but returned an invalid envelope or frame. */
export class RemoteProtocolError extends Error {
    public constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "RemoteProtocolError";
    }
}

/** A physical WebSocket failure; logical streams may be reopened on a new generation. */
export class RemoteCarrierError extends Error {
    public constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "RemoteCarrierError";
    }
}

export function isRemoteError(error: unknown): error is RemoteError {
    if (error instanceof RemoteError) return true;
    if (!error || typeof error !== "object") return false;
    const value = error as { isDSHRemoteError?: unknown; code?: unknown; message?: unknown };
    return value.isDSHRemoteError === true &&
        typeof value.code === "string" &&
        typeof value.message === "string";
}

export function remoteErrorFromUnknown(error: unknown, endpoint?: string): RemoteError {
    if (isRemoteError(error)) return error;
    return new RemoteError(
        "gateway/internal",
        error instanceof Error ? error.message : String(error),
        {},
        endpoint,
    );
}

export function isAbortError(error: unknown): boolean {
    return (
        (error instanceof DOMException && error.name === "AbortError") ||
        (error instanceof Error && error.name === "AbortError")
    );
}

function httpMessage(endpoint: string, status: number): string {
    if (status === 401) return `Remote RPC ${endpoint} requires authentication (HTTP 401)`;
    if (status === 403) return `Remote RPC ${endpoint} is not authorized (HTTP 403)`;
    if (status === 404) return `Remote RPC ${endpoint} is unavailable (HTTP 404)`;
    return `Remote RPC ${endpoint} returned HTTP ${status}`;
}
