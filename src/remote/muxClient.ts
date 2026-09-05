import NodeWebSocket from "ws";
import { randomUUID } from "node:crypto";
import {
    assertRemoteEndpoint,
    isRemoteJsonValue,
    parseRemoteStreamServerMessage,
    remoteMuxUrl,
    type RemoteStreamClientMessage,
    type RemoteStreamServerMessage,
} from "./contracts";
import { RemoteCarrierError, RemoteError } from "./errors";

export interface RemoteWebSocket {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: string, listener: (event: any) => void, options?: { once?: boolean }): void;
    removeEventListener(type: string, listener: (event: any) => void): void;
}

export interface RemoteStreamMuxClientOptions {
    baseUrl: string | (() => string | undefined);
    requestHeaders?: () => Record<string, string>;
    webSocketFactory?: (url: string, headers?: Record<string, string>) => RemoteWebSocket;
    /** Maximum UTF-8 size accepted for one text frame from the Host. */
    maxFrameBytes?: number;
    onOpen?: (generation: number) => void;
    onClose?: (generation: number, error: RemoteCarrierError) => void;
    onDiagnostic?: (message: string, cause?: unknown) => void;
}

interface SocketWaiter {
    readonly revision: number;
    resolve(socket: RemoteWebSocket): void;
    reject(error: unknown): void;
}

/** One persistent WebSocket carrying all logical RC Remote streams. */
export class RemoteStreamMuxClient implements AsyncDisposable {
    private static readonly DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
    private socket: RemoteWebSocket | undefined;
    private candidateCancel: ((error: Error) => void) | undefined;
    private keepAlive: Promise<void> | undefined;
    private readonly streams = new Map<string, StreamInbox>();
    private readonly terminalStreams = new Set<string>();
    private readonly waiters = new Set<SocketWaiter>();
    private running = false;
    private disposed = false;
    private revision = 0;
    private generation = 0;
    private reconnectAttempt = 0;
    private retryTimer: ReturnType<typeof setTimeout> | undefined;

    private readonly maxFrameBytes: number;

    public constructor(private readonly options: RemoteStreamMuxClientOptions) {
        const configured = options.maxFrameBytes;
        this.maxFrameBytes = configured !== undefined && Number.isSafeInteger(configured) && configured > 0
            ? configured
            : RemoteStreamMuxClient.DEFAULT_MAX_FRAME_BYTES;
    }

    public start(): void {
        if (this.disposed) return;
        this.running = true;
        if (this.socket?.readyState === WEB_SOCKET_OPEN) return;
        if (this.retryTimer !== undefined) return;
        if (this.keepAlive === undefined) this.maintain();
        else void this.keepAlive.then(() => this.maintain());
    }

    public reconnect(): void {
        if (!this.running || this.disposed) return;
        const failure = new RemoteCarrierError("DSH Remote stream reconnect requested");
        this.revision += 1;
        this.candidateCancel?.(failure);
        const socket = this.socket;
        if (socket !== undefined) {
            this.socket = undefined;
            this.failAll(failure);
            this.options.onClose?.(this.generation, failure);
            socket.close(4000, "reconnect requested");
        }
        if (this.retryTimer !== undefined) {
            clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
        }
        if (this.keepAlive === undefined) this.maintain();
        else void this.keepAlive.then(() => this.maintain());
    }

    public async *open(
        endpoint: string,
        args: Record<string, unknown> = {},
        signal: AbortSignal,
    ): AsyncGenerator<unknown> {
        if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
        assertRemoteEndpoint(endpoint);
        if (!isPlainRecord(args) || !isRemoteJsonValue(args)) {
            throw new TypeError(`Remote ${endpoint} args must be a plain object`);
        }
        const streamId = randomUUID();
        const inbox = new StreamInbox();
        this.terminalStreams.delete(streamId);
        let socket: RemoteWebSocket | undefined;
        let opened = false;
        let terminal = false;
        const onAbort = (): void => inbox.fail(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        try {
            socket = await this.waitForSocket(signal);
            if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
            this.streams.set(streamId, inbox);
            this.send(socket, { type: "open", streamId, endpoint, payload: { args } });
            opened = true;
            while (true) {
                const frame = await inbox.next();
                if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
                if (frame.type === "item") {
                    yield frame.value;
                    continue;
                }
                terminal = true;
                if (frame.type === "error") {
                    throw RemoteError.fromFailure(frame.error, endpoint);
                }
                return;
            }
        } finally {
            signal.removeEventListener("abort", onAbort);
            this.streams.delete(streamId);
            if (opened && !terminal && socket?.readyState === WEB_SOCKET_OPEN) {
                this.send(socket, { type: "cancel", streamId });
            }
        }
    }

    /** Stop the current carrier while keeping the client reusable for restart. */
    public async stop(): Promise<void> {
        this.running = false;
        this.revision += 1;
        if (this.retryTimer !== undefined) {
            clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
        }
        const failure = new RemoteCarrierError("DSH Remote stream client stopped");
        this.failAll(failure);
        for (const waiter of [...this.waiters]) waiter.reject(failure);
        this.candidateCancel?.(failure);
        const socket = this.socket;
        this.socket = undefined;
        socket?.close(1000, "stopped");
        await this.keepAlive;
        this.keepAlive = undefined;
    }

    /** Permanently dispose the carrier. */
    public async close(): Promise<void> {
        if (!this.disposed) {
            this.disposed = true;
            await this.stop();
        }
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }

    private connect(): Promise<RemoteWebSocket> {
        const socket = (this.options.webSocketFactory ?? defaultWebSocketFactory)(
            remoteMuxUrl(this.baseUrl()),
            this.options.requestHeaders?.() ?? {},
        );
        const generation = this.generation + 1;
        return new Promise<RemoteWebSocket>((resolve, reject) => {
            let settled = false;
            const cleanup = (removeMessage = true): void => {
                socket.removeEventListener("open", opened);
                // Once the handshake settles, error/close/message remain
                // installed for the socket lifetime. Removing close here
                // would make a silently dead carrier that never starts a new
                // generation after the peer disconnects.
                if (removeMessage) {
                    socket.removeEventListener("error", failed);
                    socket.removeEventListener("close", closed);
                    socket.removeEventListener("message", received);
                }
                if (this.candidateCancel === rejectCandidate) this.candidateCancel = undefined;
            };
            const rejectCandidate = (error: Error): void => {
                if (settled) return;
                settled = true;
                cleanup();
                socket.close();
                reject(error);
            };
            const opened = (): void => {
                if (settled) return;
                settled = true;
                // Keep the message listener installed for the lifetime of the
                // established socket. Candidate listeners are removed now;
                // removing `message` here would silently drop every logical
                // stream frame after the handshake.
                cleanup(false);
                this.generation = generation;
                this.reconnectAttempt = 0;
                this.socket = socket;
                for (const waiter of [...this.waiters]) waiter.resolve(socket);
                this.options.onOpen?.(generation);
                resolve(socket);
            };
            const failed = (event: unknown): void => {
                if (!settled) {
                    rejectCandidate(new RemoteCarrierError("DSH Remote stream WebSocket failed to open", { cause: event }));
                    return;
                }
                const error = new RemoteCarrierError("DSH Remote stream WebSocket failed", { cause: event });
                this.lost(socket, generation, error);
                socket.close();
            };
            const closed = (): void => {
                if (!settled) {
                    rejectCandidate(new RemoteCarrierError("DSH Remote stream WebSocket closed before opening"));
                    return;
                }
                this.lost(socket, generation);
            };
            const received = (event: { data?: unknown }): void => {
                this.receive(socket, event.data);
            };
            this.candidateCancel = rejectCandidate;
            socket.addEventListener("open", opened, { once: true });
            socket.addEventListener("error", failed, { once: true });
            socket.addEventListener("message", received);
            socket.addEventListener("close", closed, { once: true });
        });
    }

    private waitForSocket(signal: AbortSignal): Promise<RemoteWebSocket> {
        if (signal.aborted) return Promise.reject(signal.reason);
        if (this.socket?.readyState === WEB_SOCKET_OPEN) return Promise.resolve(this.socket);
        if (this.disposed) return Promise.reject(new Error("DSH Remote stream client disposed"));
        if (!this.running) return Promise.reject(new Error("DSH Remote stream client not started"));
        return new Promise((resolve, reject) => {
            const waiter: SocketWaiter = {
                revision: this.revision,
                resolve: (value) => {
                    cleanup();
                    resolve(value);
                },
                reject: (error) => {
                    cleanup();
                    reject(error);
                },
            };
            const aborted = (): void => waiter.reject(signal.reason);
            const cleanup = (): void => {
                this.waiters.delete(waiter);
                signal.removeEventListener("abort", aborted);
            };
            this.waiters.add(waiter);
            signal.addEventListener("abort", aborted, { once: true });
        });
    }

    private receive(socket: RemoteWebSocket, data: unknown): void {
        if (socket !== this.socket) return;
        try {
            if (typeof data !== "string") throw new Error("Remote stream WebSocket requires text messages");
            if (Buffer.byteLength(data, "utf8") > this.maxFrameBytes) {
                throw new Error(`Remote stream frame exceeds ${this.maxFrameBytes} bytes`);
            }
            const frame = parseRemoteStreamServerMessage(data);
            const inbox = this.streams.get(frame.streamId);
            if (!inbox) {
                this.options.onDiagnostic?.(
                    this.terminalStreams.has(frame.streamId)
                        ? "Ignoring a late frame for a terminated Remote stream"
                        : "Ignoring a frame for an unknown Remote stream",
                    { type: frame.type, streamId: frame.streamId },
                );
                return;
            }
            if (this.terminalStreams.has(frame.streamId)) {
                this.options.onDiagnostic?.("Ignoring a duplicate terminal Remote stream frame", {
                    type: frame.type,
                    streamId: frame.streamId,
                });
                return;
            }
            inbox.push(frame);
            if (frame.type === "end" || frame.type === "error") {
                this.terminalStreams.add(frame.streamId);
                if (this.terminalStreams.size > 1024) {
                    const oldest = this.terminalStreams.values().next().value as string | undefined;
                    if (oldest !== undefined) this.terminalStreams.delete(oldest);
                }
            }
        } catch (cause) {
            const failure = new RemoteCarrierError("DSH Remote stream frame is invalid", { cause });
            this.options.onDiagnostic?.(failure.message, cause);
            this.failAll(failure);
            this.lost(socket, this.generation, failure);
            socket.close(4002, "invalid Remote stream frame");
        }
    }

    private lost(
        socket: RemoteWebSocket,
        generation: number,
        error = new RemoteCarrierError("DSH Remote stream WebSocket closed"),
    ): void {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.failAll(error);
        this.options.onClose?.(generation, error);
        // A close can arrive after the original connect promise settled, so
        // there is no keep-alive continuation left to schedule the next
        // attempt. Schedule a bounded, jittered retry for this physical loss.
        this.scheduleRetry();
    }

    private maintain(): void {
        if (!this.running || this.disposed || this.keepAlive !== undefined || this.socket?.readyState === WEB_SOCKET_OPEN) return;
        const revision = this.revision;
        const task = this.connect().then(
            () => undefined,
            (error: unknown) => {
                if (!this.running) return;
                for (const waiter of [...this.waiters]) {
                    if (waiter.revision <= revision) waiter.reject(error);
                }
                this.options.onDiagnostic?.("DSH Remote stream connection failed", error);
            },
        );
        this.keepAlive = task;
        void task.then(() => {
            this.keepAlive = undefined;
            if (this.running && this.socket === undefined) {
                this.scheduleRetry();
            }
        });
    }

    private scheduleRetry(): void {
        if (
            !this.running ||
            this.disposed ||
            this.keepAlive !== undefined ||
            this.socket !== undefined ||
            this.retryTimer !== undefined
        ) return;
        const attempt = this.reconnectAttempt++;
        const ceiling = Math.min(8_000, 250 * 2 ** Math.min(attempt, 5));
        const delay = Math.max(50, Math.round(ceiling * (0.75 + Math.random() * 0.5)));
        this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            this.maintain();
        }, delay);
    }

    private failAll(error: unknown): void {
        for (const stream of this.streams.values()) stream.fail(error);
    }

    private send(socket: RemoteWebSocket, message: RemoteStreamClientMessage): void {
        socket.send(JSON.stringify(message));
    }

    private baseUrl(): string {
        const value = typeof this.options.baseUrl === "function"
            ? this.options.baseUrl()
            : this.options.baseUrl;
        if (!value) throw new Error("DSH Runtime is not connected");
        return value;
    }
}

class StreamInbox {
    private readonly frames: RemoteStreamServerMessage[] = [];
    private wake: (() => void) | undefined;
    private failure: unknown;
    private failed = false;

    public push(frame: RemoteStreamServerMessage): void {
        if (this.failed) return;
        this.frames.push(frame);
        this.wake?.();
        this.wake = undefined;
    }

    public fail(error: unknown): void {
        if (this.failed) return;
        this.failed = true;
        this.failure = error;
        this.frames.length = 0;
        this.wake?.();
        this.wake = undefined;
    }

    public async next(): Promise<RemoteStreamServerMessage> {
        while (this.frames.length === 0) {
            if (this.failed) throw this.failure;
            await new Promise<void>((resolve) => {
                this.wake = resolve;
            });
        }
        return this.frames.shift() as RemoteStreamServerMessage;
    }
}

function defaultWebSocketFactory(url: string, headers: Record<string, string> = {}): RemoteWebSocket {
    if (Object.keys(headers).length > 0) {
        return new NodeWebSocket(url, { headers }) as unknown as RemoteWebSocket;
    }
    if (typeof WebSocket === "function") return new WebSocket(url) as unknown as RemoteWebSocket;
    return new NodeWebSocket(url) as unknown as RemoteWebSocket;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

const WEB_SOCKET_OPEN = 1;
