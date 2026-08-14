import { projectChatMessages } from "./chatState";
import {
    GoalHudView,
    DshGoalProjection,
    DshGoalRef,
    DshHistoryResult,
    DshJobView,
    DshQuestionItem,
    DshSubagentCatalog,
    DshSubagentListEntry,
    JobCenterItem,
    SubagentTreeNodeView,
    SubagentTreeView,
} from "./types";
import { HarnessSessionStore, ProjectionCell } from "./sessionStore";

export interface PlanReviewView {
    id: string;
    question: string;
    plan: string;
    approve: string;
    decline?: string;
}

export function presentPlanReview(questions: readonly DshQuestionItem[]): PlanReviewView | undefined {
    if (questions.length !== 1) return undefined;
    const question = questions[0];
    const approve = question?.intent?.kind === "plan-review" &&
        typeof question.intent.approve === "string"
        ? question.intent.approve
        : undefined;
    if (!question || !approve || question.detail === undefined || question.multiSelect === true) {
        return undefined;
    }
    const options = question.options ?? [];
    if (options.length > 2 || !options.some((option) => option.label === approve)) return undefined;
    const decline = options.find((option) => option.label !== approve)?.label;
    return {
        id: question.id,
        question: question.question,
        plan: question.detail,
        approve,
        ...(decline === undefined ? {} : { decline }),
    };
}

export type GoalMutationOperation =
    | "create"
    | "edit"
    | "pause"
    | "resume"
    | "complete"
    | "clear";

export interface GoalMutationSnapshot {
    pending: boolean;
    operation?: GoalMutationOperation;
    error?: string;
}

interface GoalMutationRecord extends GoalMutationSnapshot {
    beforeSeq: number;
    acknowledged: boolean;
    expectedRef?: DshGoalRef;
}

export type ParsedGoalProjection =
    | { ok: true; value: DshGoalProjection | null }
    | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function normalizeGoalRef(value: unknown): DshGoalRef | undefined {
    if (!isRecord(value) || typeof value.id !== "string" || !positiveInteger(value.revision)) {
        return undefined;
    }
    return { id: value.id, revision: value.revision };
}

export function parseGoalProjection(value: unknown): ParsedGoalProjection {
    if (value === null) return { ok: true, value: null };
    if (!isRecord(value) || !isRecord(value.goal)) {
        return { ok: false, error: "Harness 返回了无效的 goal projection。" };
    }
    const goal = value.goal;
    if (
        typeof goal.id !== "string" ||
        !positiveInteger(goal.revision) ||
        typeof goal.objective !== "string" ||
        (goal.phase !== "active" &&
            goal.phase !== "paused" &&
            goal.phase !== "blocked" &&
            goal.phase !== "complete") ||
        !positiveInteger(goal.maxGoalRounds) ||
        !nonNegativeInteger(value.roundsStarted) ||
        typeof value.createdAt !== "number" ||
        !Number.isFinite(value.createdAt) ||
        typeof value.updatedAt !== "number" ||
        !Number.isFinite(value.updatedAt)
    ) {
        return { ok: false, error: "Harness 返回了无效的 goal projection。" };
    }
    let blockedReason: DshGoalProjection["goal"]["blockedReason"];
    if (goal.blockedReason !== undefined) {
        if (
            !isRecord(goal.blockedReason) ||
            typeof goal.blockedReason.code !== "string" ||
            typeof goal.blockedReason.message !== "string"
        ) {
            return { ok: false, error: "Harness 返回了无效的 goal blockedReason。" };
        }
        blockedReason = {
            code: goal.blockedReason.code,
            message: goal.blockedReason.message,
        };
    }
    if ((goal.phase === "blocked") !== (blockedReason !== undefined)) {
        return { ok: false, error: "Harness goal phase 与 blockedReason 不一致。" };
    }
    return {
        ok: true,
        value: {
            goal: {
                id: goal.id,
                revision: goal.revision,
                objective: goal.objective,
                phase: goal.phase,
                maxGoalRounds: goal.maxGoalRounds,
                ...(blockedReason === undefined ? {} : { blockedReason }),
            },
            roundsStarted: value.roundsStarted,
            createdAt: value.createdAt,
            updatedAt: value.updatedAt,
        },
    };
}

/** CAS action gate: success remains pending until a newer goal projection converges. */
export class GoalMutationGate {
    private readonly records = new Map<string, GoalMutationRecord>();

    public claim(
        sessionId: string,
        operation: GoalMutationOperation,
        beforeSeq: number,
    ): boolean {
        const current = this.records.get(sessionId);
        if (current?.pending) return false;
        this.records.set(sessionId, {
            pending: true,
            operation,
            beforeSeq,
            acknowledged: false,
        });
        return true;
    }

    public acknowledgeRef(sessionId: string, ref: DshGoalRef): void {
        const current = this.records.get(sessionId);
        if (!current?.pending) return;
        this.records.set(sessionId, { ...current, acknowledged: true, expectedRef: { ...ref } });
    }

    public acknowledgeClear(sessionId: string): void {
        const current = this.records.get(sessionId);
        if (!current?.pending || current.operation !== "clear") return;
        this.records.set(sessionId, { ...current, acknowledged: true });
    }

    public fail(sessionId: string, error: string): void {
        const current = this.records.get(sessionId);
        this.records.set(sessionId, {
            pending: false,
            beforeSeq: current?.beforeSeq ?? -1,
            acknowledged: false,
            ...(current?.operation === undefined ? {} : { operation: current.operation }),
            error,
        });
    }

    public observe(sessionId: string, cell: ProjectionCell | undefined): void {
        const current = this.records.get(sessionId);
        if (!current || !cell || cell.key !== "goal" || cell.seq <= current.beforeSeq) return;
        if (!current.pending) {
            this.records.delete(sessionId);
            return;
        }
        if (!current.acknowledged) return;

        const parsed = parseGoalProjection(cell.value);
        if (!parsed.ok) return;
        if (current.operation === "clear") {
            // Null is the direct clear result. A later non-null value means another client
            // already created a replacement; the higher-seq projection is still authoritative.
            this.records.delete(sessionId);
            return;
        }
        const expected = current.expectedRef;
        if (!expected) return;
        const projected = parsed.value?.goal;
        if (
            projected === undefined ||
            projected.id !== expected.id ||
            projected.revision >= expected.revision
        ) {
            this.records.delete(sessionId);
        }
    }

    public snapshot(sessionId: string): GoalMutationSnapshot {
        const current = this.records.get(sessionId);
        if (!current) return { pending: false };
        return {
            pending: current.pending,
            ...(current.operation === undefined ? {} : { operation: current.operation }),
            ...(current.error === undefined ? {} : { error: current.error }),
        };
    }
}

export function presentGoalHud(
    cell: ProjectionCell | undefined,
    action: GoalMutationSnapshot,
): GoalHudView | undefined {
    if (!cell || cell.key !== "goal") return undefined;
    const parsed = parseGoalProjection(cell.value);
    if (!parsed.ok) {
        return {
            state: "invalid",
            error: action.error ?? parsed.error,
            ...(action.pending ? { pending: true } : {}),
            ...(action.operation === undefined ? {} : { pendingOperation: action.operation }),
        };
    }
    if (parsed.value === null) {
        return {
            state: "empty",
            ...(action.pending ? { pending: true } : {}),
            ...(action.operation === undefined ? {} : { pendingOperation: action.operation }),
            ...(action.error === undefined ? {} : { error: action.error }),
        };
    }
    return {
        state: "present",
        goal: { ...parsed.value.goal },
        roundsStarted: parsed.value.roundsStarted,
        createdAt: parsed.value.createdAt,
        updatedAt: parsed.value.updatedAt,
        ...(action.pending ? { pending: true } : {}),
        ...(action.operation === undefined ? {} : { pendingOperation: action.operation }),
        ...(action.error === undefined ? {} : { error: action.error }),
    };
}

function normalizeSubagentEntry(value: unknown): DshSubagentListEntry | undefined {
    if (!isRecord(value) || typeof value.id !== "string") return undefined;
    if (value.kind === "diagnostic") {
        if (
            value.reason !== "corrupt" &&
            value.reason !== "unsupported" &&
            value.reason !== "unavailable"
        ) return undefined;
        return { kind: "diagnostic", id: value.id, reason: value.reason };
    }
    if (
        value.kind !== "child" ||
        (value.activity !== "running" && value.activity !== "inactive") ||
        typeof value.hasChildren !== "boolean" ||
        (value.mode !== "one-shot" && value.mode !== "continuable") ||
        (value.label !== undefined && typeof value.label !== "string") ||
        (value.mode === "continuable" && typeof value.label !== "string")
    ) return undefined;
    if (value.mode === "continuable") {
        if (typeof value.label !== "string") return undefined;
        return {
            kind: "child",
            id: value.id,
            activity: value.activity,
            hasChildren: value.hasChildren,
            mode: "continuable",
            label: value.label,
        };
    }
    return {
        kind: "child",
        id: value.id,
        activity: value.activity,
        hasChildren: value.hasChildren,
        mode: "one-shot",
        ...(value.label === undefined ? {} : { label: value.label }),
    };
}

export function normalizeSubagentCatalog(value: unknown): DshSubagentCatalog | undefined {
    if (!isRecord(value) || typeof value.parentAvailable !== "boolean" || !Array.isArray(value.entries)) {
        return undefined;
    }
    const entries: DshSubagentListEntry[] = [];
    for (const candidate of value.entries) {
        const entry = normalizeSubagentEntry(candidate);
        if (!entry) return undefined;
        entries.push(entry);
    }
    return { entries, parentAvailable: value.parentAvailable };
}

export function presentSubagentTree(
    rootSessionId: string,
    catalogs: ReadonlyMap<string, DshSubagentCatalog>,
): SubagentTreeNodeView[] {
    const nodes: SubagentTreeNodeView[] = [];
    const visitedParents = new Set<string>();
    const walk = (parentSessionId: string, depth: number): void => {
        if (visitedParents.has(parentSessionId)) return;
        visitedParents.add(parentSessionId);
        const catalog = catalogs.get(parentSessionId);
        if (!catalog) return;
        for (const entry of catalog.entries) {
            if (entry.kind === "diagnostic") {
                nodes.push({
                    kind: "diagnostic",
                    id: entry.id,
                    parentSessionId,
                    depth,
                    parentAvailable: catalog.parentAvailable,
                    reason: entry.reason,
                });
                continue;
            }
            nodes.push({
                kind: "child",
                id: entry.id,
                parentSessionId,
                depth,
                parentAvailable: catalog.parentAvailable,
                label: entry.label ?? entry.id,
                mode: entry.mode,
                activity: entry.activity,
                hasChildren: entry.hasChildren,
            });
            if (entry.hasChildren) walk(entry.id, depth + 1);
        }
    };
    walk(rootSessionId, 1);
    return nodes;
}

interface SubagentTreeRecord extends SubagentTreeView {
    generation: number;
}

/** Generation-fenced, root-keyed tree snapshots prevent switch/reconnect cross-talk. */
export class SubagentTreeStore {
    private readonly records = new Map<string, SubagentTreeRecord>();

    public begin(rootSessionId: string): number {
        const previous = this.records.get(rootSessionId);
        const generation = (previous?.generation ?? 0) + 1;
        this.records.set(rootSessionId, {
            rootSessionId,
            state: "loading",
            nodes: previous?.nodes ?? [],
            generation,
        });
        return generation;
    }

    public resolve(
        rootSessionId: string,
        generation: number,
        catalogs: ReadonlyMap<string, DshSubagentCatalog>,
    ): boolean {
        const current = this.records.get(rootSessionId);
        if (!current || current.generation !== generation) return false;
        this.records.set(rootSessionId, {
            rootSessionId,
            state: "ready",
            nodes: presentSubagentTree(rootSessionId, catalogs),
            generation,
        });
        return true;
    }

    public fail(rootSessionId: string, generation: number, error: string): boolean {
        const current = this.records.get(rootSessionId);
        if (!current || current.generation !== generation) return false;
        this.records.set(rootSessionId, {
            ...current,
            state: "error",
            error,
        });
        return true;
    }

    public get(rootSessionId: string): SubagentTreeView | undefined {
        const current = this.records.get(rootSessionId);
        return current
            ? { ...current, nodes: current.nodes.map((node) => ({ ...node })) }
            : undefined;
    }
}

export function projectSubagentHistory(
    sessionId: string,
    history: DshHistoryResult,
) {
    const store = new HarnessSessionStore();
    const snapshot = store.rebaseline(sessionId, history);
    return projectChatMessages(snapshot, []);
}

/** Read-only projection of the fields the public JobView actually exposes. */
export function presentJobCenter(
    ownerSessionId: string,
    jobs: readonly DshJobView[],
): JobCenterItem[] {
    return jobs.flatMap((job) => {
        if (
            typeof job.id !== "string" ||
            typeof job.kind !== "string" ||
            typeof job.label !== "string" ||
            (job.status !== "running" &&
                job.status !== "stopping" &&
                job.status !== "completed" &&
                job.status !== "killed" &&
                job.status !== "failed") ||
            typeof job.startedAt !== "number" ||
            !Number.isFinite(job.startedAt) ||
            (job.finishedAt !== undefined &&
                (typeof job.finishedAt !== "number" || !Number.isFinite(job.finishedAt))) ||
            (job.detail !== undefined && typeof job.detail !== "string")
        ) return [];
        return [{
            id: job.id,
            kind: job.kind,
            label: job.label,
            ownerSessionId,
            status: job.status,
            ...(job.detail === undefined ? {} : { outputSummary: job.detail }),
            startedAt: job.startedAt,
            ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
        }];
    });
}
