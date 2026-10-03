/** RC.2 background job roster and non-consuming output subscriptions. */
import type { RemoteConnectionController } from "./remote/connection";
import type { RemoteUnaryClient } from "./remote/unaryClient";
import { RemoteCarrierError, RemoteProtocolError } from "./remote/errors";
import { errorMessage } from "./errors";
import { isRecord as isRemoteRecord } from "./guards";
import type { DshJobWatchItem } from "./types";

type JobWatchListener = (items: readonly DshJobWatchItem[]) => void;

interface JobWatchState {
    readonly sessionId: string;
    readonly abort: AbortController;
    readonly listeners: Set<JobWatchListener>;
    readonly jobs: Map<string, DshJobWatchItem>;
    readonly followControllers: Map<string, AbortController>;
    readonly cursors: Map<string, number>;
    readonly finished: Set<string>;
    ready: boolean;
}
const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export class JobsController {
    private readonly jobWatches = new Map<string, JobWatchState>();
    public constructor(
        private readonly unary: Pick<RemoteUnaryClient, "call">,
        private readonly connection: Pick<RemoteConnectionController, "open">,
        private readonly log: (message: string) => void,
    ) {}

    public dispose(): void {
        for (const watch of this.jobWatches.values()) {
            watch.abort.abort();
            for (const controller of watch.followControllers.values()) controller.abort();
        }
        this.jobWatches.clear();
    }

    /** Watch one Session's visible background jobs and each live output ring. */
    public watch(sessionId: string, listener: JobWatchListener): () => void {
        let watch = this.jobWatches.get(sessionId);
        if (!watch) {
            watch = {
                sessionId,
                abort: new AbortController(),
                listeners: new Set(),
                jobs: new Map(),
                followControllers: new Map(),
                cursors: new Map(),
                finished: new Set(),
                ready: false,
            };
            this.jobWatches.set(sessionId, watch);
            void this.runJobRows(watch);
        }
        watch.listeners.add(listener);
        if (watch.ready) listener([...watch.jobs.values()]);
        let released = false;
        return () => {
            if (!watch || released) return;
            released = true;
            watch.listeners.delete(listener);
            if (watch.listeners.size !== 0) return;
            watch.abort.abort();
            for (const controller of watch.followControllers.values()) controller.abort();
            watch.followControllers.clear();
            if (this.jobWatches.get(sessionId) === watch) this.jobWatches.delete(sessionId);
        };
    }

    /** Kill a visible background job on behalf of the editor user. */
    public async killJob(sessionId: string, jobId: string): Promise<"requested" | "already-finished"> {
        const value = await this.unary.call<unknown>("job/kill", { request: { sessionId, jobId } });
        if (!isRemoteRecord(value) || (value.outcome !== "requested" && value.outcome !== "already-finished")) {
            throw new RemoteProtocolError("Remote job/kill returned an invalid value");
        }
        return value.outcome;
    }

    private publishJobWatch(watch: JobWatchState): void {
        const items = [...watch.jobs.values()].sort((left, right) => left.startedAt - right.startedAt);
        for (const listener of [...watch.listeners]) listener(items);
    }

    private parseJobView(value: unknown): DshJobWatchItem | undefined {
        if (!isRemoteRecord(value) || typeof value.id !== "string" || !value.id ||
            typeof value.kind !== "string" || typeof value.label !== "string" ||
            !["running", "stopping", "completed", "killed", "failed"].includes(value.status as string) ||
            typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt) ||
            (value.finishedAt !== undefined && (typeof value.finishedAt !== "number" || !Number.isFinite(value.finishedAt))) ||
            (value.owner !== undefined && typeof value.owner !== "string") ||
            (value.progress !== undefined && typeof value.progress !== "string") ||
            (value.detail !== undefined && typeof value.detail !== "string") ||
            !isRemoteRecord(value.output) || !natural(value.output.total) || !natural(value.output.earliest) || value.output.earliest > value.output.total) return undefined;
        return {
            id: value.id,
            kind: value.kind,
            label: value.label,
            ownerSessionId: typeof value.owner === "string" ? value.owner : "",
            status: value.status as DshJobWatchItem["status"],
            ...(typeof value.detail === "string" ? { outputSummary: value.detail } : {}),
            ...(typeof value.progress === "string" ? { progress: value.progress } : {}),
            startedAt: value.startedAt,
            ...(typeof value.finishedAt === "number" ? { finishedAt: value.finishedAt } : {}),
            canKill: value.status === "running",
        };
    }

    private async runJobRows(watch: JobWatchState): Promise<void> {
        while (!watch.abort.signal.aborted) {
            let opened = false;
            try {
                for await (const raw of this.connection.open("job/list", { request: { sessionId: watch.sessionId } }, watch.abort.signal)) {
                    if (!isRemoteRecord(raw) || raw.type !== "rows" || !Array.isArray(raw.jobs)) {
                        throw new RemoteProtocolError("Remote job/list returned an invalid frame");
                    }
                    const visible = new Set<string>();
                    for (const rawJob of raw.jobs) {
                        const job = this.parseJobView(rawJob);
                        if (!job || visible.has(job.id)) throw new RemoteProtocolError("Remote job/list returned an invalid job");
                        visible.add(job.id);
                        const previous = watch.jobs.get(job.id);
                        watch.jobs.set(job.id, {
                            ...job,
                            ...(previous?.outputText === undefined ? {} : { outputText: previous.outputText }),
                            ...(previous?.outputGap === undefined ? {} : { outputGap: previous.outputGap }),
                            ...(previous?.streaming === undefined ? {} : { streaming: previous.streaming }),
                            ...(previous?.streamError === undefined ? {} : { streamError: previous.streamError }),
                        });
                        if (!watch.followControllers.has(job.id) && !watch.finished.has(job.id)) void this.runJobFollow(watch, job.id);
                    }
                    for (const id of watch.jobs.keys()) {
                        if (visible.has(id)) continue;
                        watch.followControllers.get(id)?.abort();
                        watch.followControllers.delete(id);
                        watch.cursors.delete(id);
                        watch.finished.delete(id);
                        watch.jobs.delete(id);
                    }
                    opened = true;
                    watch.ready = true;
                    this.publishJobWatch(watch);
                }
                if (watch.abort.signal.aborted) return;
                if (!opened) throw new RemoteProtocolError("Remote job/list ended before its roster");
                throw new RemoteCarrierError("Remote job/list closed before release");
            } catch (error) {
                if (watch.abort.signal.aborted) break;
                this.log(`[dsh:jobs] roster reconnect: ${errorMessage(error)}`);
                if (!(error instanceof RemoteCarrierError)) {
                    for (const controller of watch.followControllers.values()) controller.abort();
                    watch.jobs.clear();
                    watch.ready = true;
                    this.publishJobWatch(watch);
                    watch.abort.abort();
                    if (this.jobWatches.get(watch.sessionId) === watch) {
                        this.jobWatches.delete(watch.sessionId);
                    }
                    return;
                }
                await delay(500);
            }
        }
    }

    private async runJobFollow(watch: JobWatchState, jobId: string): Promise<void> {
        const controller = new AbortController();
        watch.followControllers.set(jobId, controller);
        try {
            while (!watch.abort.signal.aborted && !controller.signal.aborted) {
                try {
                    let opened = false;
                    const from = watch.cursors.get(jobId);
                    for await (const raw of this.connection.open("job/follow", {
                        request: { sessionId: watch.sessionId, jobId, ...(from === undefined ? {} : { from }) },
                    }, AbortSignal.any([watch.abort.signal, controller.signal]))) {
                        if (!isRemoteRecord(raw) || typeof raw.type !== "string") {
                            throw new RemoteProtocolError("Remote job/follow returned an invalid frame");
                        }
                        const current = watch.jobs.get(jobId);
                        if (!current) return;
                        if (raw.type === "opened") {
                            const job = this.parseJobView(raw.job);
                            if (opened || !natural(raw.from) || !job || job.id !== jobId || !isRemoteRecord(raw.job) || !isRemoteRecord(raw.job.output)) throw new RemoteProtocolError("Remote job/follow anchor is invalid");
                            opened = true;
                            watch.cursors.set(jobId, raw.from);
                            watch.jobs.set(jobId, { ...current, ...job, streaming: true, streamError: undefined,
                                outputGap: current.outputGap === true || (current.outputText === undefined && raw.from > 0) || raw.from < (raw.job.output.earliest as number) });
                        } else if (raw.type === "output") {
                            if (!opened || !Array.isArray(raw.chunks) || !natural(raw.next) || raw.next < (watch.cursors.get(jobId) ?? 0)) throw new RemoteProtocolError("Remote job/follow output is invalid");
                            let output = current.outputText ?? "";
                            let gap = current.outputGap === true || raw.lossy === true;
                            for (const chunk of raw.chunks) {
                                if (!isRemoteRecord(chunk) || !natural(chunk.at) || typeof chunk.text !== "string") throw new RemoteProtocolError("Remote job/follow chunk is invalid");
                                output += chunk.text;
                                gap ||= chunk.gapBefore === true;
                            }
                            if (output.length > 128 * 1024) {
                                let cut = output.length - 128 * 1024;
                                if (output.charCodeAt(cut) >= 0xDC00 && output.charCodeAt(cut) <= 0xDFFF) cut++;
                                output = output.slice(cut); gap = true;
                            }
                            watch.cursors.set(jobId, raw.next);
                            watch.jobs.set(jobId, { ...current, outputText: output, outputGap: gap, streaming: true, streamError: undefined });
                        } else if (raw.type === "status") {
                            const next = this.parseJobView(raw.job);
                            if (!opened || !next || next.id !== jobId || next.status === "running" || next.status === "stopping") throw new RemoteProtocolError("Remote job/follow status is invalid");
                            watch.finished.add(jobId);
                            watch.jobs.set(jobId, { ...current, ...next, streaming: false, canKill: false });
                            this.publishJobWatch(watch);
                            return;
                        } else throw new RemoteProtocolError("Remote job/follow returned an unknown frame");
                        this.publishJobWatch(watch);
                    }
                    if (watch.abort.signal.aborted || controller.signal.aborted) return;
                    if (!opened) throw new RemoteProtocolError("Remote job/follow ended before its anchor");
                    throw new RemoteCarrierError("Remote job/follow closed before settlement");
                } catch (error) {
                    if (watch.abort.signal.aborted || controller.signal.aborted) return;
                    const current = watch.jobs.get(jobId);
                    if (current) {
                        watch.jobs.set(jobId, { ...current, streaming: false, streamError: errorMessage(error) });
                        this.publishJobWatch(watch);
                    }
                    if (!(error instanceof RemoteCarrierError)) {
                        watch.finished.add(jobId);
                        return;
                    }
                    await delay(500);
                }
            }
        } finally {
            if (watch.followControllers.get(jobId) === controller) watch.followControllers.delete(jobId);
        }
    }

}
