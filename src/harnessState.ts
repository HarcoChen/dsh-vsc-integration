import { HarnessApiClient, HarnessClientDiagnostic } from "./harnessClient";
import {
    HarnessConnectionConfig,
    HarnessConnectionController,
    HarnessConnectionState,
} from "./harnessConnection";
import { HarnessHostDescription } from "./harnessProtocol";
import {
    HarnessSessionStore,
    SessionStateSnapshot,
    SessionStoreDiagnostic,
} from "./sessionStore";
import { DshHostFrame, DshHistoryEntry, DshHistoryResult } from "./types";

export interface HarnessStateCoordinatorSinks {
    onConnectionState?: (state: HarnessConnectionState) => void;
    onHostDescription?: (description: HarnessHostDescription) => void;
    onHostFrame?: (frame: DshHostFrame) => void;
    onSessionChange?: (sessionId: string, snapshot: SessionStateSnapshot) => void;
    onDiagnostic?: (
        diagnostic: HarnessClientDiagnostic | SessionStoreDiagnostic,
    ) => void;
}

export interface HarnessStateCoordinatorOptions {
    connection?: HarnessConnectionConfig;
    historyPageSize?: number;
}

/**
 * Connects the physical mux/host streams to the per-session store. A subscribed watermark or
 * detected event gap schedules a full paginated history repair; duplicate triggers coalesce.
 */
export class HarnessStateCoordinator implements AsyncDisposable {
    public readonly sessions: HarnessSessionStore;
    private readonly connection: HarnessConnectionController;
    private readonly syncing = new Map<string, Promise<void>>();
    private readonly historyPageSize: number;
    private historyAbort = new AbortController();

    public constructor(
        private readonly api: HarnessApiClient,
        private readonly sinks: HarnessStateCoordinatorSinks = {},
        options: HarnessStateCoordinatorOptions = {},
    ) {
        this.historyPageSize = Math.max(1, options.historyPageSize ?? 100);
        this.sessions = new HarnessSessionStore((diagnostic) =>
            this.sinks.onDiagnostic?.(diagnostic),
        );
        this.sessions.onDidChange((sessionId, snapshot) => {
            this.sinks.onSessionChange?.(sessionId, snapshot);
            if (snapshot.needsHistoryBaseline) {
                void this.syncHistory(sessionId);
            }
        });
        this.connection = new HarnessConnectionController(
            api,
            {
                onMuxEnvelope: (envelope) => {
                    this.sessions.applyMuxEnvelope(envelope);
                    if (
                        envelope.payload.type === "session/subscribed" &&
                        typeof envelope.payload.sessionId === "string"
                    ) {
                        // Absence of queue/jobs frames means empty, while projection baseline
                        // always comes from history — even an empty session at lastSeq -1.
                        void this.syncHistory(envelope.payload.sessionId);
                    }
                },
                onHostEnvelope: (envelope) => this.sinks.onHostFrame?.(envelope.payload),
                onConnected: async (description) => {
                    this.sinks.onHostDescription?.(description);
                    // Mux subscribed frames normally schedule these repairs. Re-check every
                    // known session to close the stream-open/handshake delivery race.
                    await Promise.all(
                        this.sessions
                            .list()
                            .map((session) => this.syncHistory(session.sessionId)),
                    );
                },
                onStateChange: (state) => this.sinks.onConnectionState?.(state),
                onDiagnostic: (diagnostic) => this.sinks.onDiagnostic?.(diagnostic),
            },
            options.connection,
        );
    }

    public start(): void {
        if (this.historyAbort.signal.aborted) {
            this.historyAbort = new AbortController();
        }
        this.connection.start();
    }

    public async stop(): Promise<void> {
        this.historyAbort.abort();
        await this.connection.stop();
        await Promise.allSettled(this.syncing.values());
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        await this.stop();
    }

    public syncHistory(sessionId: string): Promise<void> {
        const pending = this.syncing.get(sessionId);
        if (pending) {
            return pending;
        }
        const sync = this.readCompleteHistory(sessionId)
            .catch((error) => {
                if (this.historyAbort.signal.aborted) {
                    return;
                }
                this.sinks.onDiagnostic?.({
                    channel: "rpc",
                    message: `Failed to rebaseline session ${sessionId}`,
                    cause: error,
                });
            })
            .finally(() => {
                if (this.syncing.get(sessionId) === sync) {
                    this.syncing.delete(sessionId);
                }
            });
        this.syncing.set(sessionId, sync);
        return sync;
    }

    private async readCompleteHistory(sessionId: string): Promise<void> {
        const tail = await this.api.call("session.history", {
            sessionId,
            maxMessages: this.historyPageSize,
        }, this.historyAbort.signal);
        const pages: DshHistoryEntry[][] = [tail.events];
        let hasMore = tail.hasMore === true;
        let beforeSeq = lowestSeq(tail.events);

        while (hasMore) {
            if (beforeSeq === undefined || beforeSeq <= 0) {
                throw new Error(
                    `Harness history for ${sessionId} reported hasMore without an older seq`,
                );
            }
            const page = await this.api.call("session.history", {
                sessionId,
                beforeSeq,
                maxMessages: this.historyPageSize,
            }, this.historyAbort.signal);
            pages.push(page.events);
            const nextBeforeSeq = lowestSeq(page.events);
            if (page.hasMore && (nextBeforeSeq === undefined || nextBeforeSeq >= beforeSeq)) {
                throw new Error(`Harness history pagination for ${sessionId} did not advance`);
            }
            beforeSeq = nextBeforeSeq;
            hasMore = page.hasMore === true;
        }

        this.sessions.rebaseline(sessionId, {
            events: pages.flat(),
            hasMore: false,
            projections: tail.projections,
        } satisfies DshHistoryResult);
    }
}

function lowestSeq(entries: readonly DshHistoryEntry[]): number | undefined {
    let lowest: number | undefined;
    for (const entry of entries) {
        const seq = entry.event.seq;
        if (typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0) {
            lowest = lowest === undefined ? seq : Math.min(lowest, seq);
        }
    }
    return lowest;
}
