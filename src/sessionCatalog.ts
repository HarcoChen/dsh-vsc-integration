import { HarnessStreamEnvelope } from "./harnessClient";
import {
    DshHostFrame,
    DshMuxFrame,
    DshSessionListResult,
    DshSessionSummary,
    DshWorkspaceListResult,
    DshWorkspaceView,
} from "./types";

export interface SessionCatalogItem extends DshSessionSummary {
    title?: string;
    lastAgentError?: string;
    pendingInteraction?: "approval" | "question";
}

export interface HarnessCatalogSnapshot {
    sessions: readonly SessionCatalogItem[];
    workspaces: readonly DshWorkspaceView[];
    archivedSessionIds: readonly string[];
    revision: number;
}

interface RevisionedSession {
    value: SessionCatalogItem;
    revision: number;
}

interface RevisionedWorkspace {
    value: DshWorkspaceView;
    revision: number;
}

interface ProjectionTitle {
    value: string;
    seq: number;
}

export type HarnessCatalogListener = (snapshot: HarnessCatalogSnapshot) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function directUserMessage(frame: Record<string, unknown>): boolean {
    if (frame.type !== "session/event" || !isRecord(frame.event)) {
        return false;
    }
    const event = frame.event;
    if (event.type !== "user/message" || !isRecord(event.data)) {
        return false;
    }
    return isRecord(event.data.source) && event.data.source.kind === "user";
}

function titleFromSummary(summary: DshSessionSummary): ProjectionTitle | undefined {
    const block = summary.projections;
    const value = block?.values.title;
    return block && typeof value === "string" && value.trim()
        ? { value, seq: block.asOfSeq }
        : undefined;
}

function stringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function workspaceView(value: unknown): DshWorkspaceView | undefined {
    if (
        !isRecord(value) ||
        typeof value.workspaceId !== "string" ||
        typeof value.path !== "string" ||
        typeof value.title !== "string" ||
        !stringArray(value.sessionIds) ||
        typeof value.createdAt !== "string" ||
        typeof value.updatedAt !== "string"
    ) {
        return undefined;
    }
    return {
        workspaceId: value.workspaceId,
        path: value.path,
        title: value.title,
        sessionIds: [...value.sessionIds],
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
    };
}

/**
 * Reconnect-safe session/workspace catalog. Baseline calls capture a revision first; rows
 * changed by live frames after that cut always win over the late baseline response.
 */
export class HarnessCatalogStore {
    private readonly sessions = new Map<string, RevisionedSession>();
    private readonly workspaces = new Map<string, RevisionedWorkspace>();
    private readonly titles = new Map<string, ProjectionTitle>();
    private readonly pendingBySession = new Map<string, "approval" | "question">();
    private readonly listeners = new Set<HarnessCatalogListener>();
    private archived = { ids: new Set<string>(), revision: 0 };
    private workspaceOrder: string[] = [];
    private revision = 0;

    public constructor(private readonly now: () => number = Date.now) {}

    public onDidChange(listener: HarnessCatalogListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    public baselineRevision(): number {
        return this.revision;
    }

    public seedSessions(result: DshSessionListResult, baselineRevision: number): void {
        const incoming = new Set(result.items.map((item) => item.sessionId));
        for (const [sessionId, current] of this.sessions) {
            if (current.revision <= baselineRevision && !incoming.has(sessionId)) {
                this.sessions.delete(sessionId);
                this.titles.delete(sessionId);
                this.pendingBySession.delete(sessionId);
            }
        }
        for (const summary of result.items) {
            const current = this.sessions.get(summary.sessionId);
            const coldTitle = titleFromSummary(summary);
            if (coldTitle) {
                this.applyTitle(summary.sessionId, coldTitle.value, coldTitle.seq);
            } else if (summary.projections) {
                const currentTitle = this.titles.get(summary.sessionId);
                if (currentTitle && currentTitle.seq <= summary.projections.asOfSeq) {
                    this.titles.delete(summary.sessionId);
                }
            }
            if (current && current.revision > baselineRevision) {
                continue;
            }
            this.sessions.set(summary.sessionId, {
                value: this.withDerivedState(summary),
                revision: baselineRevision,
            });
        }
        this.bumpAndPublish();
    }

    public seedWorkspaces(result: DshWorkspaceListResult, baselineRevision: number): void {
        const incoming = new Set(result.items.map((item) => item.workspaceId));
        for (const [workspaceId, current] of this.workspaces) {
            if (current.revision <= baselineRevision && !incoming.has(workspaceId)) {
                this.workspaces.delete(workspaceId);
            }
        }
        for (const workspace of result.items) {
            const current = this.workspaces.get(workspace.workspaceId);
            if (current && current.revision > baselineRevision) {
                continue;
            }
            this.workspaces.set(workspace.workspaceId, {
                value: { ...workspace, sessionIds: [...workspace.sessionIds] },
                revision: baselineRevision,
            });
        }
        if (this.archived.revision <= baselineRevision) {
            this.archived = {
                ids: new Set(result.archivedSessionIds),
                revision: baselineRevision,
            };
        }
        const liveIds = this.workspaceOrder.filter((id) => this.workspaces.has(id));
        const missingIds = result.items
            .map((item) => item.workspaceId)
            .filter((id) => !liveIds.includes(id));
        this.workspaceOrder = [...liveIds, ...missingIds];
        this.bumpAndPublish();
    }

    public applyHostEnvelope(envelope: HarnessStreamEnvelope<DshHostFrame>): void {
        const frame: unknown = envelope.payload;
        if (!isRecord(frame) || typeof frame.type !== "string") {
            return;
        }
        const revision = ++this.revision;
        switch (frame.type) {
            case "host/session-added": {
                if (
                    typeof frame.sessionId !== "string" ||
                    typeof frame.blank !== "boolean" ||
                    (frame.parentSessionId !== undefined && typeof frame.parentSessionId !== "string") ||
                    (frame.origin !== undefined && frame.origin !== "subagent") ||
                    (frame.cwd !== undefined && typeof frame.cwd !== "string") ||
                    (frame.agentPreset !== undefined && typeof frame.agentPreset !== "string")
                ) {
                    return;
                }
                const sessionId = frame.sessionId;
                const current = this.sessions.get(sessionId)?.value;
                const value: SessionCatalogItem = this.withDerivedState({
                    ...current,
                    sessionId,
                    updatedAt: current?.updatedAt ?? this.now(),
                    running: current?.running ?? false,
                    blank: frame.blank,
                    ...(frame.parentSessionId === undefined
                        ? {}
                        : { parentSessionId: frame.parentSessionId }),
                    ...(frame.origin === undefined ? {} : { origin: frame.origin }),
                    ...(frame.cwd === undefined ? {} : { cwd: frame.cwd }),
                    ...(frame.agentPreset === undefined
                        ? {}
                        : { agentPreset: frame.agentPreset }),
                });
                this.sessions.set(sessionId, { value, revision });
                break;
            }
            case "host/session-removed": {
                if (typeof frame.sessionId !== "string") return;
                const sessionId = frame.sessionId;
                this.sessions.delete(sessionId);
                this.titles.delete(sessionId);
                this.pendingBySession.delete(sessionId);
                break;
            }
            case "host/session-status": {
                if (typeof frame.sessionId !== "string" || typeof frame.running !== "boolean") return;
                const sessionId = frame.sessionId;
                const running = frame.running;
                const current = this.sessions.get(sessionId)?.value;
                if (current) {
                    this.sessions.set(sessionId, {
                        value: {
                            ...current,
                            running,
                            blank: running ? false : current.blank,
                            ...(running ? { lastAgentError: undefined } : {}),
                        },
                        revision,
                    });
                }
                break;
            }
            case "host/agent-error": {
                if (typeof frame.sessionId !== "string" || typeof frame.message !== "string") return;
                const sessionId = frame.sessionId;
                const current = this.sessions.get(sessionId)?.value;
                if (current) {
                    this.sessions.set(sessionId, {
                        value: { ...current, lastAgentError: frame.message },
                        revision,
                    });
                }
                break;
            }
            case "host/workspace-changed": {
                const workspace = workspaceView(frame.workspace);
                if (!workspace) return;
                this.workspaces.set(workspace.workspaceId, {
                    value: workspace,
                    revision,
                });
                if (!this.workspaceOrder.includes(workspace.workspaceId)) {
                    this.workspaceOrder.push(workspace.workspaceId);
                }
                break;
            }
            case "host/workspace-removed": {
                if (typeof frame.workspaceId !== "string") return;
                const workspaceId = frame.workspaceId;
                this.workspaces.delete(workspaceId);
                this.workspaceOrder = this.workspaceOrder.filter((id) => id !== workspaceId);
                break;
            }
            case "host/workspace-order-changed":
                if (!stringArray(frame.workspaceIds)) return;
                this.workspaceOrder = [...frame.workspaceIds];
                break;
            case "host/archived-sessions-changed":
                if (!stringArray(frame.archivedSessionIds)) return;
                this.archived = { ids: new Set(frame.archivedSessionIds), revision };
                break;
            default:
                return;
        }
        this.publish();
    }

    public applyMuxEnvelope(envelope: HarnessStreamEnvelope<DshMuxFrame>): void {
        const raw = envelope.payload as unknown;
        if (!isRecord(raw) || typeof raw.type !== "string") {
            return;
        }
        const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : undefined;
        if (!sessionId) {
            return;
        }
        let changed = false;
        if (raw.type === "session/projection" && raw.key === "title") {
            if (typeof raw.value === "string" && typeof raw.seq === "number") {
                changed = this.applyTitle(sessionId, raw.value, raw.seq);
            }
        } else if (directUserMessage(raw)) {
            const current = this.sessions.get(sessionId)?.value;
            if (current) {
                const event = raw.event as Record<string, unknown>;
                const time = typeof event.time === "number" ? event.time : this.now();
                this.sessions.set(sessionId, {
                    value: { ...current, updatedAt: Math.max(current.updatedAt ?? 0, time), blank: false },
                    revision: ++this.revision,
                });
                changed = true;
            }
        }
        if (changed) {
            this.publish();
        }
    }

    public upsertCreated(sessionId: string, cwd?: string): void {
        const revision = ++this.revision;
        this.sessions.set(sessionId, {
            value: this.withDerivedState({
                sessionId,
                updatedAt: this.now(),
                running: false,
                blank: true,
                ...(cwd === undefined ? {} : { cwd }),
            }),
            revision,
        });
        this.publish();
    }

    public applyRename(sessionId: string, title: string, seq: number): void {
        if (this.applyTitle(sessionId, title, seq)) {
            this.publish();
        }
    }

    public setPendingInteraction(
        sessionId: string,
        pendingInteraction: "approval" | "question" | undefined,
    ): void {
        const current = this.sessions.get(sessionId);
        const previous = this.pendingBySession.get(sessionId);
        if (previous === pendingInteraction) {
            return;
        }
        if (pendingInteraction === undefined) {
            this.pendingBySession.delete(sessionId);
        } else {
            this.pendingBySession.set(sessionId, pendingInteraction);
        }
        if (!current) {
            return;
        }
        this.sessions.set(sessionId, {
            value: { ...current.value, pendingInteraction },
            revision: ++this.revision,
        });
        this.publish();
    }

    public replaceArchived(ids: readonly string[]): void {
        this.archived = { ids: new Set(ids), revision: ++this.revision };
        this.publish();
    }

    public upsertWorkspace(workspace: DshWorkspaceView): void {
        this.workspaces.set(workspace.workspaceId, {
            value: { ...workspace, sessionIds: [...workspace.sessionIds] },
            revision: ++this.revision,
        });
        if (!this.workspaceOrder.includes(workspace.workspaceId)) {
            this.workspaceOrder.push(workspace.workspaceId);
        }
        this.publish();
    }

    public removeWorkspace(workspaceId: string): void {
        this.workspaces.delete(workspaceId);
        this.workspaceOrder = this.workspaceOrder.filter((id) => id !== workspaceId);
        this.revision += 1;
        this.publish();
    }

    public replaceWorkspaceOrder(ids: readonly string[]): void {
        const known = ids.filter((id) => this.workspaces.has(id));
        const missing = this.workspaceOrder.filter(
            (id) => this.workspaces.has(id) && !known.includes(id),
        );
        this.workspaceOrder = [...known, ...missing];
        this.revision += 1;
        this.publish();
    }

    /** Returns non-blank sessions registered for the canonical workspace path. */
    public sessionsForWorkspace(path: string): readonly SessionCatalogItem[] {
        const workspace = [...this.workspaces.values()].find((entry) => entry.value.path === path)?.value;
        if (!workspace) return [];
        const byId = new Map(
            [...this.sessions.values()].map((entry) => [entry.value.sessionId, entry.value] as const),
        );
        return workspace.sessionIds
            .map((sessionId) => byId.get(sessionId))
            .filter((session): session is SessionCatalogItem => session !== undefined && !session.blank);
    }

    public snapshot(): HarnessCatalogSnapshot {
        const sessions = [...this.sessions.values()]
            .map((entry) => this.withDerivedState(entry.value))
            .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
        const ordered = this.workspaceOrder
            .map((id) => this.workspaces.get(id)?.value)
            .filter((value): value is DshWorkspaceView => value !== undefined);
        const unordered = [...this.workspaces.values()]
            .map((entry) => entry.value)
            .filter((value) => !this.workspaceOrder.includes(value.workspaceId));
        return {
            sessions: sessions.map((item) => ({ ...item })),
            workspaces: [...ordered, ...unordered].map((workspace) => ({
                ...workspace,
                sessionIds: [...workspace.sessionIds],
            })),
            archivedSessionIds: [...this.archived.ids],
            revision: this.revision,
        };
    }

    private applyTitle(sessionId: string, value: string, seq: number): boolean {
        if (!Number.isSafeInteger(seq) || seq < -1) {
            return false;
        }
        const current = this.titles.get(sessionId);
        if (current && current.seq >= seq) {
            return false;
        }
        this.titles.set(sessionId, { value, seq });
        const row = this.sessions.get(sessionId);
        if (row) {
            this.sessions.set(sessionId, {
                value: { ...row.value, title: value },
                revision: ++this.revision,
            });
        }
        return true;
    }

    private withDerivedState(summary: DshSessionSummary): SessionCatalogItem {
        const title = this.titles.get(summary.sessionId)?.value ?? summary.title;
        const pendingInteraction = this.pendingBySession.get(summary.sessionId);
        return {
            ...summary,
            ...(title === undefined ? {} : { title }),
            ...(pendingInteraction === undefined ? {} : { pendingInteraction }),
        };
    }

    private bumpAndPublish(): void {
        this.revision += 1;
        this.publish();
    }

    private publish(): void {
        const snapshot = this.snapshot();
        for (const listener of this.listeners) {
            listener(snapshot);
        }
    }
}
