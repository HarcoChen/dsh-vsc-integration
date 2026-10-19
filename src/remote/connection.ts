import { compareRuntimeVersions } from "../runtimeVersion";
import { RemoteAccessState } from "./access";
import {
    type RemoteEventFrame,
    type RemoteEventReadyFrame,
    type RemoteEventResultRequest,
} from "./contracts";
import { RemoteCarrierError, RemoteHttpError, isRemoteError } from "./errors";
import { RemoteEventController } from "./events";
import { RemoteStreamMuxClient, type RemoteStreamMuxClientOptions } from "./muxClient";
import { RemoteUnaryClient } from "./unaryClient";

export type RemoteConnectionState = "connecting" | "connected" | "reconnecting" | "stopped";

export interface RemoteConnectionOptions
    extends Omit<RemoteStreamMuxClientOptions, "onOpen" | "onClose"> {
    unary?: RemoteUnaryClient;
    onStateChange?: (state: RemoteConnectionState) => void;
    onConnected?: (ready: RemoteEventReadyFrame, generation: number) => void | Promise<void>;
    onEvent?: (frame: RemoteEventFrame, generation: number) => void;
    onDiagnostic?: (message: string, cause?: unknown) => void;
}

interface ReadyWaiter {
    resolve: () => void;
    reject: (error: unknown) => void;
    signal: AbortSignal;
}

/**
 * Connection facade shared by every Remote feature.  It maintains one physical
 * mux socket, one `$events` stream per generation, and exposes only logical
 * streams to callers.
 */
export class RemoteConnectionController implements AsyncDisposable {
    public readonly access = new RemoteAccessState();
    private runtimeVersion?: string;
    public setRuntimeVersion(version: string): void { this.runtimeVersion = version; }
    private accessReady: Promise<void> = Promise.resolve();
    private readonly accessListeners = new Set<() => void>();
    public onAccessChange(listener: () => void): () => void { this.accessListeners.add(listener); return () => this.accessListeners.delete(listener); }
    private publishAccess(): void { for (const listener of this.accessListeners) listener(); }

    public readonly mux: RemoteStreamMuxClient;
    public readonly unary: RemoteUnaryClient;
    private eventController: RemoteEventController | undefined;
    private eventAbort: AbortController | undefined;
    private eventPump: Promise<void> | undefined;
    private readonly readyWaiters = new Set<ReadyWaiter>();
    private readonly connectedListeners = new Set<(ready: RemoteEventReadyFrame, generation: number) => void | Promise<void>>();
    private readonly eventListeners = new Set<(frame: RemoteEventFrame, generation: number) => void>();
    private readonly stateListeners = new Set<(state: RemoteConnectionState) => void>();
    private generation = 0;
    private readyGeneration = 0;
    private running = false;
    private stopped = false;
    private lastState: RemoteConnectionState = "stopped";

    public constructor(private readonly options: RemoteConnectionOptions) {
        this.unary = options.unary ?? new RemoteUnaryClient(options);
        this.mux = new RemoteStreamMuxClient({
            ...options,
            onOpen: (generation) => this.onPhysicalOpen(generation),
            onClose: (generation, error) => this.onPhysicalClose(generation, error),
        });
    }

    public get currentGeneration(): number {
        return this.generation;
    }

    public get isReady(): boolean {
        return this.readyGeneration === this.generation && this.generation > 0;
    }

    public get hostInfo(): { home: string } | undefined {
        return this.eventController?.hostInfo;
    }

    public onConnected(listener: (ready: RemoteEventReadyFrame, generation: number) => void | Promise<void>): () => void {
        this.connectedListeners.add(listener);
        return () => this.connectedListeners.delete(listener);
    }

    public onEvent(listener: (frame: RemoteEventFrame, generation: number) => void): () => void {
        this.eventListeners.add(listener);
        return () => this.eventListeners.delete(listener);
    }

    public onStateChange(listener: (state: RemoteConnectionState) => void): () => void {
        this.stateListeners.add(listener);
        return () => this.stateListeners.delete(listener);
    }

    public start(): void {
        if (this.running) return;
        this.stopped = false;
        this.running = true;
        this.emitState("connecting");
        this.mux.start();
    }

    /** Tear down the current generation and let the mux establish a fresh one. */
    public reconnect(): void {
        if (!this.running || this.stopped) return;
        this.readyGeneration = 0;
        this.emitState("reconnecting");
        this.mux.reconnect();
    }

    public async stop(): Promise<void> {
        this.running = false;
        this.stopped = true;
        this.readyGeneration = 0;
        this.eventAbort?.abort();
        this.access.reset();
        this.publishAccess();
        for (const waiter of [...this.readyWaiters]) {
            waiter.reject(new Error("DSH Remote connection stopped"));
            this.readyWaiters.delete(waiter);
        }
        await this.mux.stop();
        await this.eventPump?.catch(() => undefined);
        this.eventPump = undefined;
        this.eventController = undefined;
        this.emitState("stopped");
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        await this.stop();
    }

    public async *open(
        endpoint: string,
        args: Record<string, unknown> = {},
        signal: AbortSignal,
        uplink?: AsyncIterable<unknown>,
    ): AsyncGenerator<unknown> {
        this.start();
        await this.waitUntilReady(signal);
        yield* this.mux.open(endpoint, args, signal, uplink);
    }

    public async answerRemoteEvent(
        eventId: string,
        outcome: RemoteEventResultRequest["outcome"],
        signal?: AbortSignal,
    ): Promise<void> {
        if (!this.access.snapshot.owner) throw new Error("Only the Runtime owner can answer interactive requests");
        const controller = this.eventController;
        if (!controller) throw new Error("Remote event stream is not ready");
        await controller.answer(eventId, outcome, signal);
    }

    private onPhysicalOpen(generation: number): void {
        if (!this.running) return;
        this.generation = generation;
        this.readyGeneration = 0;
        this.eventAbort?.abort();
        const eventAbort = new AbortController();
        this.eventAbort = eventAbort;
        this.access.reset();
        this.publishAccess();
        let resolveAccess!: () => void;
        this.accessReady = new Promise<void>(resolve => { resolveAccess = resolve; });
        void (async () => {
            let first = true;
            try {
                for await (const frame of this.mux.open("remoteAccess/follow", {}, eventAbort.signal)) {
                    if (eventAbort.signal.aborted || generation !== this.generation) return;
                    this.access.apply(frame, first);
                    first = false;
                    resolveAccess();
                    this.publishAccess();
                }
                if (!eventAbort.signal.aborted) throw new Error("Remote access stream ended; refresh to reconnect");
            } catch (error) {
                if (eventAbort.signal.aborted || generation !== this.generation) return;
                // Only a missing endpoint on legacy Hosts permits owner compatibility.
                if (first && this.runtimeVersion && (compareRuntimeVersions(this.runtimeVersion, "0.2.1-alpha.3") ?? 1) < 0 &&
                    ((error instanceof RemoteHttpError && error.status === 404) || (isRemoteError(error) && error.code === "gateway/invocation-unavailable"))) this.access.legacyOwner();
                else if (!first && this.access.snapshot.owner) {
                    // A fixed owner principal needs no grants; snapshot loss cannot revoke ownership.
                    this.options.onDiagnostic?.("Owner access snapshot ended; owner permissions remain available", error);
                } else {
                    this.access.reset();
                    this.options.onDiagnostic?.("Remote access unavailable; permissions disabled", error);
                }
                resolveAccess();
                this.publishAccess();
            }
        })();
        const controller = new RemoteEventController(this.mux, this.unary, {
            onReady: (ready, currentGeneration) => this.onEventsReady(ready, currentGeneration),
            onEmit: (frame, currentGeneration) => this.emitEvent(frame, currentGeneration),
            onWaterfall: (frame, currentGeneration) => this.emitEvent(frame, currentGeneration),
            onCancel: (frame, currentGeneration) => this.emitEvent(frame, currentGeneration),
            onDiagnostic: (message, cause) => {
                if (isRemoteError(cause) && (cause.code === "gateway/interactions-forbidden" || cause.code === "remote-access/denied")) return;
                this.options.onDiagnostic?.(message, cause);
            },
        });
        this.eventController = controller;
        this.eventPump = controller.consume(generation, eventAbort.signal).catch((error) => {
            if (eventAbort.signal.aborted || !this.running) return;
            if (isRemoteError(error) && (error.code === "gateway/interactions-forbidden" || error.code === "remote-access/denied")) {
                // Read-only Peers can follow Session state without joining the interactive event channel.
                this.onEventsReady({ type: "ready", clientId: "", host: { home: "" } }, generation);
                return;
            }
            this.options.onDiagnostic?.("Remote event generation failed", error);
            this.readyGeneration = 0;
            this.emitState("reconnecting");
            this.mux.reconnect();
        });
    }

    private onEventsReady(ready: RemoteEventReadyFrame, generation: number): void {
        void this.accessReady.then(() => this.finishEventsReady(ready, generation));
    }

    private finishEventsReady(ready: RemoteEventReadyFrame, generation: number): void {
        if (!this.running || generation !== this.generation) return;
        this.readyGeneration = generation;
        this.emitState("connected");
        for (const waiter of [...this.readyWaiters]) {
            this.readyWaiters.delete(waiter);
            waiter.resolve();
        }
        try {
            const result = this.options.onConnected?.(ready, generation);
            if (result) void result.catch((error) => this.options.onDiagnostic?.("Remote rebaseline callback failed", error));
            for (const listener of this.connectedListeners) {
                try {
                    const callback = listener(ready, generation);
                    if (callback) void callback.catch((error) => this.options.onDiagnostic?.("Remote rebaseline callback failed", error));
                } catch (error) {
                    this.options.onDiagnostic?.("Remote rebaseline callback failed", error);
                }
            }
        } catch (error) {
            this.options.onDiagnostic?.("Remote rebaseline callback failed", error);
        }
    }

    private onPhysicalClose(generation: number, error: RemoteCarrierError): void {
        if (generation !== this.generation || !this.running) return;
        this.readyGeneration = 0;
        this.eventAbort?.abort(error);
        this.access.reset();
        this.publishAccess();
        // Do not let an answer race a dead generation while the event pump's
        // finally/catch path is still unwinding.  The next physical open
        // installs a fresh controller and client id.
        this.eventController = undefined;
        this.emitState("reconnecting");
    }

    private waitUntilReady(signal: AbortSignal): Promise<void> {
        if (signal.aborted) return Promise.reject(signal.reason);
        if (this.isReady) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
            const waiter: ReadyWaiter = { resolve, reject, signal };
            const abort = (): void => {
                this.readyWaiters.delete(waiter);
                reject(signal.reason);
            };
            waiter.resolve = (): void => {
                signal.removeEventListener("abort", abort);
                resolve();
            };
            waiter.reject = (error): void => {
                signal.removeEventListener("abort", abort);
                reject(error);
            };
            this.readyWaiters.add(waiter);
            signal.addEventListener("abort", abort, { once: true });
        });
    }

    private emitState(state: RemoteConnectionState): void {
        if (state === this.lastState) return;
        this.lastState = state;
        this.options.onStateChange?.(state);
        for (const listener of this.stateListeners) {
            try {
                listener(state);
            } catch (error) {
                this.options.onDiagnostic?.("Remote connection state listener failed", error);
            }
        }
    }

    private emitEvent(frame: RemoteEventFrame, generation: number): void {
        this.options.onEvent?.(frame, generation);
        for (const listener of this.eventListeners) {
            try {
                listener(frame, generation);
            } catch (error) {
                this.options.onDiagnostic?.("Remote event listener failed", error);
            }
        }
    }
}
