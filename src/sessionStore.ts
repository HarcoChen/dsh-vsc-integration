import { HarnessStreamEnvelope } from "./harnessClient";
import {
    DshHistoryEntry,
    DshHistoryEvent,
    DshHistoryResult,
    DshApprovalRequested,
    DshApprovalResolved,
    DshJobView,
    DshMuxFrame,
    DshQuestionItem,
    DshQuestionRequested,
    DshQuestionResolved,
    DshQueuedInboxItem,
    DshRpcReceipt,
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
    interactions: readonly SessionInteractionSnapshot[];
    subscribedLastSeq?: number;
    needsHistoryBaseline: boolean;
}

export type SessionInteractionStatus =
    | "pending"
    | "submitting"
    | "resolved"
    | "failed"
    | "unavailable";

interface SessionInteractionBase {
    key: string;
    rpcId: string;
    sessionId: string;
    status: SessionInteractionStatus;
    outcome?: string;
    error?: string;
    receivedAt: number;
}

export interface SessionApprovalInteraction extends SessionInteractionBase {
    kind: "approval";
    approvalId: string;
    toolName: string;
    callId?: string;
    reason?: string;
}

export interface SessionQuestionInteraction extends SessionInteractionBase {
    kind: "question";
    questions: readonly DshQuestionItem[];
}

export type SessionInteractionSnapshot =
    | SessionApprovalInteraction
    | SessionQuestionInteraction;

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

function normalizeQuestionItems(value: unknown): DshQuestionItem[] | undefined {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const result: DshQuestionItem[] = [];
    for (const candidate of value) {
        if (
            !isRecord(candidate) ||
            typeof candidate.id !== "string" ||
            typeof candidate.question !== "string" ||
            (candidate.header !== undefined && typeof candidate.header !== "string") ||
            (candidate.detail !== undefined && typeof candidate.detail !== "string") ||
            (candidate.multiSelect !== undefined && typeof candidate.multiSelect !== "boolean")
        ) {
            return undefined;
        }
        let options: DshQuestionItem["options"];
        if (candidate.options !== undefined) {
            if (!Array.isArray(candidate.options)) return undefined;
            options = [];
            for (const option of candidate.options) {
                if (
                    !isRecord(option) ||
                    typeof option.label !== "string" ||
                    (option.description !== undefined && typeof option.description !== "string")
                ) {
                    return undefined;
                }
                options.push({
                    label: option.label,
                    ...(option.description === undefined
                        ? {}
                        : { description: option.description }),
                });
            }
        }
        if (
            candidate.intent !== undefined &&
            (!isRecord(candidate.intent) || typeof candidate.intent.kind !== "string")
        ) {
            return undefined;
        }
        const intent = isRecord(candidate.intent) && typeof candidate.intent.kind === "string"
            ? { ...candidate.intent, kind: candidate.intent.kind }
            : undefined;
        result.push({
            id: candidate.id,
            question: candidate.question,
            ...(candidate.header === undefined ? {} : { header: candidate.header }),
            ...(candidate.detail === undefined ? {} : { detail: candidate.detail }),
            ...(options === undefined ? {} : { options }),
            ...(candidate.multiSelect === undefined
                ? {}
                : { multiSelect: candidate.multiSelect }),
            ...(intent === undefined ? {} : { intent }),
        });
    }
    return result;
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
    private readonly interactions = new Map<string, SessionInteractionSnapshot>();

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
        // The mux open contract emits subscribed first, then replays every still-pending
        // request with its stable rpcId. Clearing here makes absence authoritative without
        // racing a replay that may have arrived before the connection callback.
        this.interactions.clear();
    }

    public requestApproval(
        frame: DshApprovalRequested,
        rpcId: string,
        receivedAt: number,
    ): void {
        const key = `a:${rpcId}`;
        const current = this.interactions.get(key);
        this.interactions.set(key, {
            kind: "approval",
            key,
            rpcId,
            sessionId: frame.sessionId,
            approvalId: frame.approvalId,
            toolName: frame.toolName,
            ...(frame.callId === undefined ? {} : { callId: frame.callId }),
            ...(frame.reason === undefined ? {} : { reason: frame.reason }),
            status: current?.status ?? "pending",
            ...(current?.outcome === undefined ? {} : { outcome: current.outcome }),
            ...(current?.error === undefined ? {} : { error: current.error }),
            receivedAt,
        });
    }

    public resolveApproval(frame: DshApprovalResolved): void {
        for (const [key, interaction] of this.interactions) {
            if (interaction.kind !== "approval" || interaction.approvalId !== frame.approvalId) {
                continue;
            }
            this.interactions.set(key, {
                ...interaction,
                status: "resolved",
                outcome: frame.outcome,
                error: undefined,
            });
        }
    }

    public requestQuestion(
        frame: DshQuestionRequested,
        rpcId: string,
        receivedAt: number,
    ): void {
        const key = `q:${rpcId}`;
        const current = this.interactions.get(key);
        this.interactions.set(key, {
            kind: "question",
            key,
            rpcId,
            sessionId: frame.sessionId,
            questions: frame.questions.map((question) => ({ ...question })),
            status: current?.status ?? "pending",
            ...(current?.outcome === undefined ? {} : { outcome: current.outcome }),
            ...(current?.error === undefined ? {} : { error: current.error }),
            receivedAt,
        });
    }

    public resolveQuestion(frame: DshQuestionResolved): void {
        const key = `q:${frame.questionRpcId}`;
        const interaction = this.interactions.get(key);
        if (!interaction || interaction.kind !== "question") {
            return;
        }
        this.interactions.set(key, {
            ...interaction,
            status: "resolved",
            outcome: frame.outcome,
            error: undefined,
        });
    }

    public claimInteraction(key: string): SessionInteractionSnapshot | undefined {
        const interaction = this.interactions.get(key);
        if (!interaction || interaction.status !== "pending") {
            return undefined;
        }
        const claimed: SessionInteractionSnapshot = {
            ...interaction,
            status: "submitting",
            error: undefined,
        };
        this.interactions.set(key, claimed);
        return { ...claimed };
    }

    public settleInteractionReceipt(key: string, receipt: DshRpcReceipt): void {
        const interaction = this.interactions.get(key);
        if (!interaction || interaction.status !== "submitting" || receipt.accepted) {
            return;
        }
        this.interactions.set(key, {
            ...interaction,
            status: receipt.reason === "not-pending" ? "unavailable" : "failed",
            error:
                receipt.reason === "not-pending"
                    ? "请求已不再等待回答。"
                    : `回答被 Harness 拒绝：${receipt.reason}`,
        });
    }

    public failInteraction(key: string, message: string): void {
        const interaction = this.interactions.get(key);
        if (!interaction || interaction.status !== "submitting") {
            return;
        }
        // A transport failure is ambiguous: the host may have accepted the response. Keep
        // the card inert until an authoritative resolved frame or reconnect replay arrives.
        this.interactions.set(key, {
            ...interaction,
            status: "failed",
            error: message,
        });
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
            interactions: [...this.interactions.values()]
                .sort((left, right) => left.receivedAt - right.receivedAt)
                .map((interaction) => ({ ...interaction })),
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
            case "approval/requested": {
                if (
                    !sessionId ||
                    typeof frame.approvalId !== "string" ||
                    typeof frame.toolName !== "string" ||
                    (frame.callId !== undefined && typeof frame.callId !== "string") ||
                    (frame.reason !== undefined && typeof frame.reason !== "string")
                ) {
                    this.diagnostic("invalid-frame", "approval/requested frame is malformed", frame);
                    return;
                }
                const state = this.state(sessionId);
                state.requestApproval(
                    {
                        type: "approval/requested",
                        sessionId,
                        approvalId: frame.approvalId,
                        toolName: frame.toolName,
                        ...(frame.callId === undefined ? {} : { callId: frame.callId }),
                        ...(frame.reason === undefined ? {} : { reason: frame.reason }),
                    },
                    envelope.rpcId,
                    this.now(),
                );
                this.publish(state);
                return;
            }
            case "approval/resolved": {
                if (
                    !sessionId ||
                    typeof frame.approvalId !== "string" ||
                    typeof frame.outcome !== "string"
                ) {
                    this.diagnostic("invalid-frame", "approval/resolved frame is malformed", frame);
                    return;
                }
                const state = this.state(sessionId);
                state.resolveApproval({
                    type: "approval/resolved",
                    sessionId,
                    approvalId: frame.approvalId,
                    outcome: frame.outcome,
                });
                this.publish(state);
                return;
            }
            case "question/requested": {
                const questions = normalizeQuestionItems(frame.questions);
                if (!sessionId || !questions) {
                    this.diagnostic("invalid-frame", "question/requested frame is malformed", frame);
                    return;
                }
                const state = this.state(sessionId);
                state.requestQuestion(
                    { type: "question/requested", sessionId, questions },
                    envelope.rpcId,
                    this.now(),
                );
                this.publish(state);
                return;
            }
            case "question/resolved": {
                if (
                    !sessionId ||
                    typeof frame.questionRpcId !== "string" ||
                    typeof frame.outcome !== "string"
                ) {
                    this.diagnostic("invalid-frame", "question/resolved frame is malformed", frame);
                    return;
                }
                const state = this.state(sessionId);
                state.resolveQuestion({
                    type: "question/resolved",
                    sessionId,
                    questionRpcId: frame.questionRpcId,
                    outcome: frame.outcome,
                });
                this.publish(state);
                return;
            }
            case "stream/error":
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

    /** Atomically claims an answerable request; a second click receives undefined. */
    public claimInteraction(
        sessionId: string,
        key: string,
    ): SessionInteractionSnapshot | undefined {
        const state = this.sessions.get(sessionId);
        if (!state) {
            return undefined;
        }
        const interaction = state.claimInteraction(key);
        if (interaction) {
            this.publish(state);
        }
        return interaction;
    }

    public settleInteractionReceipt(
        sessionId: string,
        key: string,
        receipt: DshRpcReceipt,
    ): void {
        const state = this.sessions.get(sessionId);
        if (!state) {
            return;
        }
        state.settleInteractionReceipt(key, receipt);
        this.publish(state);
    }

    public failInteraction(sessionId: string, key: string, message: string): void {
        const state = this.sessions.get(sessionId);
        if (!state) {
            return;
        }
        state.failInteraction(key, message);
        this.publish(state);
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
