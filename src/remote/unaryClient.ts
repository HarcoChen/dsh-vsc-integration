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
            let full;
            try {
                const mediaType = response.headers.get("content-type")
                    ?.split(";", 1)[0]
                    ?.trim()
                    .toLowerCase();
                full = mediaType === "multipart/form-data"
                    ? await parseBinaryResponse(response)
                    : parseRemoteServerResponse(await response.json());
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

/** Rebuild Connection's multipart attachment envelope used for native RPC bytes. */
async function parseBinaryResponse(response: Response) {
    const form = await response.formData();
    const fields = new Map<string, FormDataEntryValue>();
    form.forEach((value, name) => {
        if (fields.has(name)) throw new TypeError("Remote binary response has duplicate fields");
        fields.set(name, value);
    });

    const metadata = fields.get("metadata");
    fields.delete("metadata");
    if (typeof metadata !== "string") throw new TypeError("Remote binary response has no metadata field");
    const envelope: unknown = JSON.parse(metadata);
    if (
        !isPlainRecord(envelope) ||
        !exactKeys(envelope, ["type", "rpcId", "result", "attachments"]) ||
        !Array.isArray(envelope.attachments) ||
        envelope.attachments.length === 0
    ) {
        throw new TypeError("Remote binary response metadata is malformed");
    }

    const full = parseRemoteServerResponse({
        type: envelope.type,
        rpcId: envelope.rpcId,
        result: envelope.result,
    });
    if (!full.result.ok || full.result.value === undefined) {
        throw new TypeError("Remote binary response must contain a successful value");
    }

    const root: { value: unknown } = { value: full.result.value };
    const paths = new Set<string>();
    for (const rawAttachment of envelope.attachments) {
        if (
            !isPlainRecord(rawAttachment) ||
            !exactKeys(rawAttachment, ["path", "codec", "part"]) ||
            rawAttachment.codec !== "bytes" ||
            typeof rawAttachment.part !== "string" ||
            !/^bytes-[0-9]+$/u.test(rawAttachment.part) ||
            !Array.isArray(rawAttachment.path) ||
            !rawAttachment.path.every((segment) =>
                typeof segment === "string" ||
                (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0),
            )
        ) {
            throw new TypeError("Remote binary response attachment is malformed");
        }
        const pathKey = JSON.stringify(rawAttachment.path);
        if (paths.has(pathKey)) throw new TypeError("Remote binary response repeats an attachment path");
        paths.add(pathKey);

        const bytes = fields.get(rawAttachment.part);
        fields.delete(rawAttachment.part);
        if (!(bytes instanceof Blob)) throw new TypeError("Remote binary response is missing a byte part");

        let parent: object = root;
        let key: string | number = "value";
        for (const segment of rawAttachment.path) {
            const value: unknown = Reflect.get(parent, key);
            if (typeof value !== "object" || value === null) {
                throw new TypeError("Remote binary response path is invalid");
            }
            if (Array.isArray(value)) {
                if (typeof segment !== "number" || segment >= value.length) {
                    throw new TypeError("Remote binary response path is invalid");
                }
            } else if (typeof segment !== "string") {
                throw new TypeError("Remote binary response path is invalid");
            }
            if (!Object.hasOwn(value, segment)) throw new TypeError("Remote binary response path is invalid");
            parent = value;
            key = segment;
        }
        if (Reflect.get(parent, key) !== null) {
            throw new TypeError("Remote binary response byte placeholder is invalid");
        }
        Object.defineProperty(parent, key, {
            value: new Uint8Array(await bytes.arrayBuffer()),
            enumerable: true,
            writable: true,
            configurable: true,
        });
    }
    if (fields.size !== 0) throw new TypeError("Remote binary response has unexpected fields");
    return {
        type: "server-response" as const,
        rpcId: full.rpcId,
        result: { ok: true as const, value: root.value },
    };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Reflect.ownKeys(value);
    return actual.length === keys.length && actual.every((key) => typeof key === "string" && keys.includes(key));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
