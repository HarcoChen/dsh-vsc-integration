import { HarnessStreamEnvelope } from "./harnessClient";
import {
    DshHistoryEntry,
    DshHistoryEvent,
    DshHistoryResult,
    DshJobView,
    DshMuxFrame,
    DshQueuedInboxItem,
    DshSessionEvent,
    DshSessionProjectionsBlock,
} from "./types";

/** Exact current Harness SurfaceEventType union from @deepseek-ai/dsh-session. */
const SURFACE_EVENT_TYPES = new Set([
    "user/message",
    "assistant/message",
    "tool/result",
]);

export interface SessionStoreDiagnostic {
    sessionId?: string;
    code:
        | "invalid-event"
        | "event-gap"
        | "surface-invalid"
        | "invalid-frame"
        | "unknown-frame";
    message: string;
    value?: unknown;
}

export interface StoredSessionEvent {
    event: DshSessionEvent;
    view?: unknown;
    source: "history" | "live";
}

export interface SurfaceNode extends StoredSessionEvent {
    seq: number;
    sourceEventSeqs: readonly number[];
}

export interface SurfaceFoldEvent {
    event: DshSessionEvent;
    view?: unknown;
    source?: "history" | "live";
}

export interface SurfaceReplacement {
    seq: number;
    start: number;
    end: number;
    shadowedSeqs: readonly number[];
}

export interface SessionSurfaceSnapshot {
    nodes: readonly SurfaceNode[];
    replacements: readonly SurfaceReplacement[];
    /** False while history pages leave any raw seq gap in the known window. */
    complete: boolean;
    issues: readonly string[];
}

export interface ProjectionCell {
    key: string;
    value: unknown;
    seq: number;
}

export interface AuthoritativeSnapshot<T> {
    items: readonly T[];
    revision: number;
    rpcId?: string;
    receivedAt?: number;
    source: "initial" | "frame" | "subscribed-clear";
}

export interface SessionStateSnapshot {
    sessionId: string;
    events: readonly StoredSessionEvent[];
    surface: SessionSurfaceSnapshot;
    projections: readonly ProjectionCell[];
    queue: AuthoritativeSnapshot<DshQueuedInboxItem>;
    jobs: AuthoritativeSnapshot<DshJobView>;
    subscribedLastSeq?: number;
    needsHistoryBaseline: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSeq(value: unknown, allowEmpty = false): value is number {
    return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= (allowEmpty ? -1 : 0)
    );
}

function normalizeEvent(value: DshHistoryEvent | DshSessionEvent): DshSessionEvent | undefined {
    const raw = value as unknown;
    if (
        !isRecord(raw) ||
        typeof raw.type !== "string" ||
        !isSeq(raw.seq) ||
        typeof raw.time !== "number" ||
        !Number.isFinite(raw.time) ||
        !("data" in raw)
    ) {
        return undefined;
    }
    return raw as unknown as DshSessionEvent;
}

function validSourceSeqs(
    value: unknown,
    currentSeq: number,
    eventType: string,
): value is number[] {
    return (
        Array.isArray(value) &&
        (value.length > 0 || eventType === "assistant/message") &&
        value.every((seq) => isSeq(seq) && seq < currentSeq) &&
        new Set(value).size === value.length
    );
}

function cloneSnapshot<T>(snapshot: AuthoritativeSnapshot<T>): AuthoritativeSnapshot<T> {
    return { ...snapshot, items: [...snapshot.items] };
}

/** Generic projection cells governed solely by the protocol's higher-seq-wins rule. */
export class GenericProjectionStore {
    private readonly cells = new Map<string, ProjectionCell>();

    public seed(block: DshSessionProjectionsBlock): boolean {
        if (!isSeq(block.asOfSeq, true) || !isRecord(block.values)) {
            return false;
        }
        let changed = false;
        const incomingKeys = new Set(Object.keys(block.values));
        for (const [key, cell] of this.cells) {
            if (!incomingKeys.has(key) && cell.seq <= block.asOfSeq) {
                this.cells.delete(key);
                changed = true;
            }
        }
        for (const [key, value] of Object.entries(block.values)) {
            changed = this.apply(key, value, block.asOfSeq) || changed;
        }
        return changed;
    }

    public apply(key: string, value: unknown, seq: number): boolean {
        if (!key || !isSeq(seq, true)) {
            return false;
        }
        const current = this.cells.get(key);
        if (current && current.seq >= seq) {
            return false;
        }
        this.cells.set(key, { key, value, seq });
        return true;
    }

    public get(key: string): ProjectionCell | undefined {
        const cell = this.cells.get(key);
        return cell ? { ...cell } : undefined;
    }

    public snapshot(): ProjectionCell[] {
        return [...this.cells.values()]
            .sort((left, right) => left.key.localeCompare(right.key))
            .map((cell) => ({ ...cell }));
    }
}

/** Raw, seq-addressed event log plus the independently derived current surface. */
export class SessionEventStore {
    private readonly events = new Map<number, StoredSessionEvent>();
    private subscribedLastSeq: number | undefined;
    private gapObserved = false;

    public constructor(
        public readonly sessionId: string,
        private readonly onDiagnostic?: (diagnostic: SessionStoreDiagnostic) => void,
    ) {}

    public ingestHistory(entries: readonly DshHistoryEntry[]): boolean {
        let changed = false;
        for (const entry of entries) {
            const event = normalizeEvent(entry.event);
            if (!event) {
                this.diagnostic("invalid-event", "History contained an invalid session event", entry);
                continue;
            }
            changed = this.upsert(event, entry.view, "history") || changed;
        }
        if (this.isContiguousFromZero(this.ordered())) {
            this.gapObserved = false;
        }
        return changed;
    }

    public ingestLive(eventValue: DshSessionEvent, view?: unknown): boolean {
        const event = normalizeEvent(eventValue);
        if (!event) {
            this.diagnostic("invalid-event", "Live stream contained an invalid session event", eventValue);
            return false;
        }
        const highest = this.highestSeq();
        if (highest >= 0 && event.seq > highest + 1) {
            this.gapObserved = true;
            this.diagnostic(
                "event-gap",
                `Live event seq ${event.seq} arrived after ${highest}; history rebaseline required`,
                event,
            );
        }
        return this.upsert(event, view, "live");
    }

    public subscribed(lastSeq: number): void {
        if (!isSeq(lastSeq, true)) {
            this.diagnostic("invalid-frame", "session/subscribed carried an invalid lastSeq", lastSeq);
            return;
        }
        this.subscribedLastSeq = lastSeq;
        if (!this.hasContiguousThrough(lastSeq)) {
            this.gapObserved = true;
        }
    }

    public get needsHistoryBaseline(): boolean {
        return this.gapObserved;
    }

    public get subscribedWatermark(): number | undefined {
        return this.subscribedLastSeq;
    }

    public ordered(): StoredSessionEvent[] {
        return [...this.events.values()]
            .sort((left, right) => left.event.seq - right.event.seq)
            .map((stored) => ({ ...stored }));
    }

    public surface(): SessionSurfaceSnapshot {
        const ordered = this.ordered();
        const folded = foldSessionSurface(ordered, (issue) =>
            this.diagnostic("surface-invalid", issue),
        );
        return {
            ...folded,
            complete: this.isContiguousFromZero(ordered),
        };
    }

    private upsert(
        event: DshSessionEvent,
        view: unknown,
        source: "history" | "live",
    ): boolean {
        const existing = this.events.get(event.seq);
        if (!existing) {
            this.events.set(event.seq, { event, view, source });
            return true;
        }

        const shouldReplaceEvent = existing.source === "history" && source === "live";
        const shouldReplaceView = view !== undefined && view !== existing.view;
        if (!shouldReplaceEvent && !shouldReplaceView) {
            return false;
        }
        this.events.set(event.seq, {
            event: shouldReplaceEvent ? event : existing.event,
            view: shouldReplaceView ? view : existing.view,
            source: shouldReplaceEvent ? source : existing.source,
        });
        return true;
    }

    private highestSeq(): number {
        let highest = -1;
        for (const seq of this.events.keys()) {
            highest = Math.max(highest, seq);
        }
        return highest;
    }

    private isContiguousFromZero(ordered: readonly StoredSessionEvent[]): boolean {
        return ordered.every((stored, index) => stored.event.seq === index);
    }

    private hasContiguousThrough(lastSeq: number): boolean {
        if (lastSeq < 0) {
            return true;
        }
        for (let seq = 0; seq <= lastSeq; seq += 1) {
            if (!this.events.has(seq)) {
                return false;
            }
        }
        return true;
    }

    private diagnostic(
        code: SessionStoreDiagnostic["code"],
        message: string,
        value?: unknown,
    ): void {
        this.onDiagnostic?.({ sessionId: this.sessionId, code, message, value });
    }
}

/**
 * Pure replay of Harness' current SurfaceEventType contract. Invalid replacement metadata is
 * diagnosed and skipped atomically, keeping the last reconstructable surface available.
 */
export function foldSessionSurface(
    input: readonly SurfaceFoldEvent[],
    onIssue?: (message: string) => void,
): Omit<SessionSurfaceSnapshot, "complete"> {
    const ordered = [...input].sort((left, right) => left.event.seq - right.event.seq);
    const nodes: SurfaceFoldEvent[] = [];
    const replacements: SurfaceReplacement[] = [];
    const issues: string[] = [];

    for (const stored of ordered) {
        const event = stored.event;
        const raw = event as unknown as Record<string, unknown>;
        const operation = raw.surfaceOp;
        if (!SURFACE_EVENT_TYPES.has(event.type)) {
            if (operation !== undefined || raw.sourceEventSeqs !== undefined) {
                issues.push(
                    `Event ${event.seq} (${event.type}) is not surface-eligible but carries surface metadata`,
                );
            }
            continue;
        }
        if (operation === "append") {
            if (
                raw.sourceEventSeqs !== undefined &&
                !validSourceSeqs(raw.sourceEventSeqs, event.seq, event.type)
            ) {
                issues.push(`Event ${event.seq} carries invalid sourceEventSeqs`);
                continue;
            }
            nodes.push(stored);
            continue;
        }
        if (
            !isRecord(operation) ||
            operation.op !== "replace" ||
            Object.keys(operation).length !== 3 ||
            !isSeq(operation.start) ||
            !isSeq(operation.end)
        ) {
            issues.push(`Surface event ${event.seq} carries an invalid surfaceOp`);
            continue;
        }
        const startIndex = nodes.findIndex((node) => node.event.seq === operation.start);
        const endIndex = nodes.findIndex((node) => node.event.seq === operation.end);
        if (startIndex < 0 || endIndex < startIndex) {
            issues.push(
                `Surface replacement ${event.seq} cannot resolve range ${operation.start}-${operation.end}`,
            );
            continue;
        }
        const shadowed = nodes.slice(startIndex, endIndex + 1);
        if (!validSourceSeqs(raw.sourceEventSeqs, event.seq, event.type)) {
            issues.push(`Surface replacement ${event.seq} carries invalid sourceEventSeqs`);
            continue;
        }
        const sources = new Set(raw.sourceEventSeqs);
        const missing = shadowed
            .map((node) => node.event.seq)
            .filter((seq) => !sources.has(seq));
        if (missing.length) {
            issues.push(
                `Surface replacement ${event.seq} omits shadowed seqs ${missing.join(", ")}`,
            );
            continue;
        }
        nodes.splice(startIndex, endIndex - startIndex + 1, stored);
        replacements.push({
            seq: event.seq,
            start: operation.start,
            end: operation.end,
            shadowedSeqs: shadowed.map((node) => node.event.seq),
        });
    }

    for (const issue of issues) {
        onIssue?.(issue);
    }
    return {
        nodes: nodes.map((stored) => ({
            ...stored,
            source: stored.source ?? "history",
            seq: stored.event.seq,
            sourceEventSeqs: Array.isArray(stored.event.sourceEventSeqs)
                ? [...stored.event.sourceEventSeqs]
                : [],
        })),
        replacements,
        issues,
    };
}

class SessionState {
    public readonly projections = new GenericProjectionStore();
    public readonly events: SessionEventStore;
    private queueState: AuthoritativeSnapshot<DshQueuedInboxItem> = {
        items: [],
        revision: 0,
        source: "initial",
    };
    private jobsState: AuthoritativeSnapshot<DshJobView> = {
        items: [],
        revision: 0,
        source: "initial",
    };

    public constructor(
        public readonly sessionId: string,
        onDiagnostic?: (diagnostic: SessionStoreDiagnostic) => void,
    ) {
        this.events = new SessionEventStore(sessionId, onDiagnostic);
    }

    public clearTransientOnSubscribe(receivedAt: number, rpcId: string): void {
        this.queueState = {
            items: [],
            revision: this.queueState.revision + 1,
            rpcId,
            receivedAt,
            source: "subscribed-clear",
        };
        this.jobsState = {
            items: [],
            revision: this.jobsState.revision + 1,
            rpcId,
            receivedAt,
            source: "subscribed-clear",
        };
    }

    public replaceQueue(items: readonly DshQueuedInboxItem[], receivedAt: number, rpcId: string): void {
        this.queueState = {
            items: [...items],
            revision: this.queueState.revision + 1,
            rpcId,
            receivedAt,
            source: "frame",
        };
    }

    public replaceJobs(items: readonly DshJobView[], receivedAt: number, rpcId: string): void {
        this.jobsState = {
            items: [...items],
            revision: this.jobsState.revision + 1,
            rpcId,
            receivedAt,
            source: "frame",
        };
    }

    public snapshot(): SessionStateSnapshot {
        return {
            sessionId: this.sessionId,
            events: this.events.ordered(),
            surface: this.events.surface(),
            projections: this.projections.snapshot(),
            queue: cloneSnapshot(this.queueState),
            jobs: cloneSnapshot(this.jobsState),
            subscribedLastSeq: this.events.subscribedWatermark,
            needsHistoryBaseline: this.events.needsHistoryBaseline,
        };
    }
}

export type SessionStateListener = (sessionId: string, snapshot: SessionStateSnapshot) => void;

/** Routes mux frames into isolated per-session state containers. */
export class HarnessSessionStore {
    private readonly sessions = new Map<string, SessionState>();
    private readonly listeners = new Set<SessionStateListener>();

    public constructor(
        private readonly onDiagnostic?: (diagnostic: SessionStoreDiagnostic) => void,
        private readonly now: () => number = Date.now,
    ) {}

    public onDidChange(listener: SessionStateListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    public rebaseline(sessionId: string, history: DshHistoryResult): SessionStateSnapshot {
        const state = this.state(sessionId);
        state.events.ingestHistory(history.events);
        if (history.projections) {
            state.projections.seed(history.projections);
        }
        return this.publish(state);
    }

    public applyMuxEnvelope(envelope: HarnessStreamEnvelope<DshMuxFrame>): void {
        const frame = envelope.payload as unknown;
        if (!isRecord(frame) || typeof frame.type !== "string") {
            this.diagnostic("invalid-frame", "Mux stream carried an invalid frame", frame);
            return;
        }
        const sessionId = typeof frame.sessionId === "string" ? frame.sessionId : undefined;

        switch (frame.type) {
            case "session/event": {
                if (!sessionId || !isRecord(frame.event)) {
                    this.diagnostic("invalid-frame", "session/event frame is malformed", frame);
                    return;
                }
                const state = this.state(sessionId);
                state.events.ingestLive(frame.event as unknown as DshSessionEvent, frame.view);
                this.publish(state);
                return;
            }
            case "session/subscribed": {
                if (!sessionId || !isSeq(frame.lastSeq, true)) {
                    this.diagnostic("invalid-frame", "session/subscribed frame is malformed", frame);
                    return;
                }
                const state = this.state(sessionId);
                state.events.subscribed(frame.lastSeq);
                state.clearTransientOnSubscribe(this.now(), envelope.rpcId);
                this.publish(state);
                return;
            }
            case "session/projection": {
                if (
                    !sessionId ||
                    typeof frame.key !== "string" ||
                    !isSeq(frame.seq, true) ||
                    !("value" in frame)
                ) {
                    this.diagnostic("invalid-frame", "session/projection frame is malformed", frame);
                    return;
                }
                const state = this.state(sessionId);
                if (state.projections.apply(frame.key, frame.value, frame.seq)) {
                    this.publish(state);
                }
                return;
            }
            case "session/queue": {
                if (!sessionId || !Array.isArray(frame.items)) {
                    this.diagnostic("invalid-frame", "session/queue frame is malformed", frame);
                    return;
                }
                const state = this.state(sessionId);
                state.replaceQueue(
                    frame.items as unknown as DshQueuedInboxItem[],
                    this.now(),
                    envelope.rpcId,
                );
                this.publish(state);
                return;
            }
            case "session/jobs": {
                if (!sessionId || !Array.isArray(frame.jobs)) {
                    this.diagnostic("invalid-frame", "session/jobs frame is malformed", frame);
                    return;
                }
                const state = this.state(sessionId);
                state.replaceJobs(
                    frame.jobs as unknown as DshJobView[],
                    this.now(),
                    envelope.rpcId,
                );
                this.publish(state);
                return;
            }
            case "approval/requested":
            case "approval/resolved":
            case "question/requested":
            case "question/resolved":
            case "stream/error":
                // These have their own interaction/transport stores in the next phase.
                return;
            default:
                this.diagnostic("unknown-frame", `Unknown mux frame ${frame.type}`, frame);
        }
    }

    public get(sessionId: string): SessionStateSnapshot | undefined {
        return this.sessions.get(sessionId)?.snapshot();
    }

    public list(): SessionStateSnapshot[] {
        return [...this.sessions.values()].map((state) => state.snapshot());
    }

    private state(sessionId: string): SessionState {
        let state = this.sessions.get(sessionId);
        if (!state) {
            state = new SessionState(sessionId, this.onDiagnostic);
            this.sessions.set(sessionId, state);
        }
        return state;
    }

    private publish(state: SessionState): SessionStateSnapshot {
        const snapshot = state.snapshot();
        for (const listener of this.listeners) {
            listener(state.sessionId, snapshot);
        }
        return snapshot;
    }

    private diagnostic(
        code: SessionStoreDiagnostic["code"],
        message: string,
        value?: unknown,
    ): void {
        this.onDiagnostic?.({ code, message, value });
    }
}
