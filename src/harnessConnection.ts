import {
    HarnessApiClient,
    HarnessClientDiagnostic,
    HarnessStreamEnvelope,
} from "./harnessClient";
import { HarnessHostDescription } from "./harnessProtocol";
import { DshHostFrame, DshMuxFrame } from "./types";

export type HarnessConnectionState =
    | "connecting"
    | "connected"
    | "reconnecting"
    | "stopped";

export interface HarnessConnectionSinks {
    onMuxEnvelope?: (envelope: HarnessStreamEnvelope<DshMuxFrame>) => void;
    onHostEnvelope?: (envelope: HarnessStreamEnvelope<DshHostFrame>) => void;
    /** Fires once per established generation; consumers re-fetch history baselines here. */
    onConnected?: (
        description: HarnessHostDescription,
        generation: number,
    ) => void | Promise<void>;
    onStateChange?: (state: HarnessConnectionState) => void;
    onDiagnostic?: (diagnostic: HarnessClientDiagnostic) => void;
}

export interface HarnessConnectionConfig {
    backoffBaseMs?: number;
    backoffFactor?: number;
    backoffMaxMs?: number;
    streamOpenTimeoutMs?: number;
    random?: () => number;
    sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface HarnessConnectionTransport {
    describe(signal?: AbortSignal): Promise<HarnessHostDescription>;
    mux(
        signal: AbortSignal,
        onOpen?: () => void,
    ): AsyncIterable<HarnessStreamEnvelope<DshMuxFrame>>;
    host(
        signal: AbortSignal,
        onOpen?: () => void,
    ): AsyncIterable<HarnessStreamEnvelope<DshHostFrame>>;
}

const DEFAULTS = {
    backoffBaseMs: 500,
    backoffFactor: 2,
    backoffMaxMs: 10_000,
    streamOpenTimeoutMs: 3_000,
};

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timeout = setTimeout(finish, milliseconds);
        signal.addEventListener("abort", finish, { once: true });
        function finish(): void {
            clearTimeout(timeout);
            signal.removeEventListener("abort", finish);
            resolve();
        }
    });
}

/** Owns both Harness event streams as one reconnecting connection generation. */
export class HarnessConnectionController implements AsyncDisposable {
    private readonly config: Required<Omit<HarnessConnectionConfig, "random" | "sleep">>;
    private readonly random: () => number;
    private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    private running = false;
    private generation = 0;
    private attempt = 0;
    private currentAbort: AbortController | undefined;
    private loopPromise: Promise<void> | undefined;
    private lastState: HarnessConnectionState = "stopped";

    public constructor(
        private readonly client: HarnessConnectionTransport | HarnessApiClient,
        private readonly sinks: HarnessConnectionSinks = {},
        config: HarnessConnectionConfig = {},
    ) {
        this.config = {
            backoffBaseMs: config.backoffBaseMs ?? DEFAULTS.backoffBaseMs,
            backoffFactor: config.backoffFactor ?? DEFAULTS.backoffFactor,
            backoffMaxMs: config.backoffMaxMs ?? DEFAULTS.backoffMaxMs,
            streamOpenTimeoutMs:
                config.streamOpenTimeoutMs ?? DEFAULTS.streamOpenTimeoutMs,
        };
        this.random = config.random ?? Math.random;
        this.sleep = config.sleep ?? defaultSleep;
    }

    public start(): void {
        if (this.running) {
            return;
        }
        this.running = true;
        this.emitState("connecting");
        this.loopPromise = this.loop();
    }

    public async stop(): Promise<void> {
        if (!this.running && !this.loopPromise) {
            this.emitState("stopped");
            return;
        }
        this.running = false;
        this.currentAbort?.abort();
        await this.loopPromise;
        this.loopPromise = undefined;
        this.currentAbort = undefined;
        this.emitState("stopped");
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        await this.stop();
    }

    private async loop(): Promise<void> {
        while (this.running) {
            const generation = ++this.generation;
            const controller = new AbortController();
            this.currentAbort = controller;

            let muxOpened = (): void => undefined;
            let hostOpened = (): void => undefined;
            const streamsOpened = Promise.all([
                new Promise<void>((resolve) => {
                    muxOpened = resolve;
                }),
                new Promise<void>((resolve) => {
                    hostOpened = resolve;
                }),
            ]);

            let endGeneration = (): void => undefined;
            const generationEnded = new Promise<void>((resolve) => {
                let ended = false;
                endGeneration = (): void => {
                    if (ended) {
                        return;
                    }
                    ended = true;
                    controller.abort();
                    resolve();
                };
            });

            const muxPump = this.pump(
                this.client.mux(controller.signal, muxOpened),
                this.sinks.onMuxEnvelope,
                "mux",
                endGeneration,
            );
            const hostPump = this.pump(
                this.client.host(controller.signal, hostOpened),
                this.sinks.onHostEnvelope,
                "host",
                endGeneration,
            );

            try {
                const descriptionPromise = this.client.describe(controller.signal);
                const openTimeout = this.streamOpenTimeout();
                let description: HarnessHostDescription;
                try {
                    description = await Promise.race([
                        Promise.all([
                            descriptionPromise,
                            Promise.race([streamsOpened, openTimeout.promise]),
                        ]).then(([value]) => value),
                        generationEnded.then(() => {
                            throw new Error("Harness event stream ended during handshake");
                        }),
                    ]);
                } finally {
                    openTimeout.cancel();
                }

                if (!this.running || controller.signal.aborted) {
                    throw new Error("Harness connection generation was stopped");
                }
                this.attempt = 0;
                this.emitState("connected");
                this.callConnected(description, generation);
                await generationEnded;
            } catch (error) {
                if (this.running) {
                    this.diagnostic("rpc", "Harness connection generation failed", error);
                }
            } finally {
                controller.abort();
                await Promise.allSettled([muxPump, hostPump]);
            }

            if (!this.running) {
                break;
            }
            this.emitState("reconnecting");
            this.attempt += 1;
            const waitAbort = new AbortController();
            this.currentAbort = waitAbort;
            await this.sleep(this.backoffDelay(this.attempt), waitAbort.signal);
        }
    }

    private async pump<F extends { type: string }>(
        stream: AsyncIterable<HarnessStreamEnvelope<F>>,
        sink: ((envelope: HarnessStreamEnvelope<F>) => void) | undefined,
        channel: "mux" | "host",
        onEnd: () => void,
    ): Promise<void> {
        try {
            for await (const envelope of stream) {
                if (envelope.payload.type === "stream/error") {
                    this.diagnostic(channel, "Harness stream reported stream/error", envelope.payload);
                    return;
                }
                if (sink) {
                    this.callSink(() => sink(envelope), channel);
                }
            }
        } catch (error) {
            if (this.running) {
                this.diagnostic(channel, "Harness event stream failed", error);
            }
        } finally {
            onEnd();
        }
    }

    private callConnected(
        description: HarnessHostDescription,
        generation: number,
    ): void {
        try {
            const result = this.sinks.onConnected?.(description, generation);
            if (result) {
                void result.catch((error) =>
                    this.diagnostic("rpc", "Harness rebaseline callback failed", error),
                );
            }
        } catch (error) {
            this.diagnostic("rpc", "Harness rebaseline callback failed", error);
        }
    }

    private backoffDelay(attempt: number): number {
        const cap = Math.min(
            this.config.backoffMaxMs,
            this.config.backoffBaseMs *
                this.config.backoffFactor ** Math.max(0, attempt - 1),
        );
        return cap / 2 + this.random() * (cap / 2);
    }

    private streamOpenTimeout(): { promise: Promise<void>; cancel: () => void } {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const promise = new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, this.config.streamOpenTimeoutMs);
        });
        return {
            promise,
            cancel: () => {
                if (timeout !== undefined) {
                    clearTimeout(timeout);
                }
            },
        };
    }

    private emitState(state: HarnessConnectionState): void {
        if (this.lastState === state) {
            return;
        }
        this.lastState = state;
        this.callSink(() => this.sinks.onStateChange?.(state), "rpc");
    }

    private callSink(action: () => void, channel: "rpc" | "mux" | "host"): void {
        try {
            action();
        } catch (error) {
            this.diagnostic(channel, "Harness connection sink failed", error);
        }
    }

    private diagnostic(
        channel: "rpc" | "mux" | "host",
        message: string,
        cause?: unknown,
    ): void {
        this.sinks.onDiagnostic?.({ channel, message, cause });
    }
}
