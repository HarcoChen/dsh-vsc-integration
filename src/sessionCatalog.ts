import type { HarnessStreamEnvelope } from "./harnessClient";
import {
    ChatViewState,
    DshHostFrame,
    DshMuxFrame,
    DshSessionListResult,
    DshSessionProjectionsBlock,
    DshSessionSummary,
    DshWorkspaceListResult,
    DshWorkspaceView,
} from "./types";
import { isRecord } from "./guards";

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

/**
 * Projects the switcher rows from a catalog snapshot.
 *
 * Archived sessions are dropped rather than flagged, so every emitted row carries
 * `archived: false`; the field exists for the webview's row type, not as a filter
 * the client re-applies. Workspace grouping comes from each workspace's own
 * `sessionIds`, so a session belonging to no workspace simply omits both fields.
 *
 * @param catalog - the current catalog snapshot.
 * @returns the rows in catalog order (most recently updated first).
 */
export function presentSessionRows(
    catalog: HarnessCatalogSnapshot,
): ChatViewState["sessions"] {
    const archived = new Set(catalog.archivedSessionIds);
    const workspaceBySession = new Map(
        catalog.workspaces.flatMap((workspace) =>
            workspace.sessionIds.map((sessionId) => [sessionId, workspace] as const),
        ),
    );
    return catalog.sessions
        .filter((item) => !archived.has(item.sessionId))
        .map((item) => {
            const workspace = workspaceBySession.get(item.sessionId);
            return {
                sessionId: item.sessionId,
                title: item.title || item.sessionId.slice(0, 12),
                ...(workspace === undefined
                    ? {}
                    : { workspaceId: workspace.workspaceId, workspaceTitle: workspace.title }),
                running: item.running === true,
                attention: item.pendingInteraction !== undefined,
                archived: false,
            };
        });
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
    return titleFromProjectionBlock(summary.projections);
}

function titleFromProjectionBlock(
    block: DshSessionProjectionsBlock | undefined,
): ProjectionTitle | undefined {
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
    private remoteBaselineDepth = 0;
    private remoteBaselineDirty = false;

    public constructor(private readonly now: () => number = Date.now) {}

    /**
     * Returns a plain unsubscribe function rather than a `vscode.Disposable`,
     * for the same reason as `HarnessSessionStore.onDidChange`: this module must
     * stay loadable under `node --test`. Callers wrap it where a Disposable is
     * required.
     */
    public onDidChange(listener: HarnessCatalogListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    public baselineRevision(): number {
        return this.revision;
    }

    /** Suppress intermediate catalog notifications while a new Remote generation opens. */
    public beginRemoteBaseline(): void {
        this.remoteBaselineDepth += 1;
    }

    /** Publish the atomically replaced session/workspace opening state. */
    public endRemoteBaseline(): void {
        if (this.remoteBaselineDepth === 0) return;
        this.remoteBaselineDepth -= 1;
        if (this.remoteBaselineDepth === 0 && this.remoteBaselineDirty) {
            this.remoteBaselineDirty = false;
            this.publishNow();
        }
    }

    /** Clear all generation-scoped Remote rows before a new baseline opens. */
    public resetRemoteGeneration(): void {
        this.sessions.clear();
        this.workspaces.clear();
        this.titles.clear();
        this.pendingBySession.clear();
        this.workspaceOrder = [];
        this.archived = { ids: new Set(), revision: ++this.revision };
        this.publish();
    }

    /** Replace the session-list baseline belonging to one Remote generation. */
    public replaceRemoteSessions(result: DshSessionListResult): void {
        this.sessions.clear();
        this.titles.clear();
        this.pendingBySession.clear();
        const revision = ++this.revision;
        for (const summary of result.items) {
            const coldTitle = titleFromSummary(summary);
            if (coldTitle) this.titles.set(summary.sessionId, coldTitle);
            this.sessions.set(summary.sessionId, {
                value: this.withDerivedState(summary),
                revision,
            });
        }
        this.publish();
    }

    /** Replace the workspace-follow baseline belonging to one Remote generation. */
    public replaceRemoteWorkspaces(result: DshWorkspaceListResult): void {
        this.workspaces.clear();
        const revision = ++this.revision;
        for (const workspace of result.items) {
            this.workspaces.set(workspace.workspaceId, {
                value: { ...workspace, sessionIds: [...workspace.sessionIds] },
                revision,
            });
        }
        this.workspaceOrder = result.items.map((item) => item.workspaceId);
        this.archived = { ids: new Set(result.archivedSessionIds), revision };
        this.publish();
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

    /**
     * Merge a locally-known creation result into the catalog. Host stream frames
     * can arrive before or after the RPC response, so a creation echo must not
     * erase parent/cwd/blank metadata that the host already supplied.
     */
    public upsertCreated(
        sessionId: string,
        cwd?: string,
        options: { blank?: boolean; parentSessionId?: string; agentPreset?: string } = {},
    ): void {
        const current = this.sessions.get(sessionId)?.value;
        const revision = ++this.revision;
        this.sessions.set(sessionId, {
            value: this.withDerivedState({
                ...current,
                sessionId,
                updatedAt: current?.updatedAt ?? this.now(),
                running: current?.running ?? false,
                blank: options.blank ?? current?.blank ?? true,
                ...(current?.cwd === undefined && cwd !== undefined ? { cwd } : {}),
                ...(options.parentSessionId === undefined
                    ? {}
                    : { parentSessionId: options.parentSessionId }),
                ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
            }),
            revision,
        });
        this.publish();
    }

    /** Merge one RC `api-session/added` notification into the catalog. */
    public upsertRemoteSession(summary: DshSessionSummary): void {
        const current = this.sessions.get(summary.sessionId)?.value;
        this.sessions.set(summary.sessionId, {
            value: this.withDerivedState({ ...current, ...summary }),
            revision: ++this.revision,
        });
        this.publish();
    }

    /** Remove a Session after an RC `api-session/removed` notification. */
    public removeSession(sessionId: string): void {
        this.sessions.delete(sessionId);
        this.titles.delete(sessionId);
        this.pendingBySession.delete(sessionId);
        this.revision += 1;
        this.publish();
    }

    public applyRemoteSessionStatus(sessionId: string, running: boolean): void {
        const current = this.sessions.get(sessionId)?.value;
        if (!current) return;
        this.sessions.set(sessionId, {
            value: {
                ...current,
                running,
                blank: running ? false : current.blank,
                ...(running ? { lastAgentError: undefined } : {}),
            },
            revision: ++this.revision,
        });
        this.publish();
    }

    public applyRemoteSessionActivity(sessionId: string, updatedAt: number): void {
        const current = this.sessions.get(sessionId)?.value;
        if (!current) return;
        this.sessions.set(sessionId, {
            value: { ...current, updatedAt: Math.max(current.updatedAt ?? 0, updatedAt), blank: false },
            revision: ++this.revision,
        });
        this.publish();
    }

    public applyRemoteSessionError(sessionId: string, message: string): void {
        const current = this.sessions.get(sessionId)?.value;
        if (!current) return;
        this.sessions.set(sessionId, {
            value: { ...current, lastAgentError: message },
            revision: ++this.revision,
        });
        this.publish();
    }

    /** Apply the generation-scoped preset selection notification to its Session row. */
    public applyRemoteAgentPreset(sessionId: string, agentPreset: string): void {
        if (!agentPreset) return;
        const current = this.sessions.get(sessionId)?.value;
        if (!current) return;
        this.sessions.set(sessionId, {
            value: { ...current, agentPreset },
            revision: ++this.revision,
        });
        this.publish();
    }

    /**
     * Merge projection values carried by a history-tail baseline. Title
     * projections live in the SessionStore as well, but the picker/trace title
     * is sourced from this catalog, so opening a fork must hydrate both stores.
     */
    public applyProjectionBaseline(
        sessionId: string,
        projections: DshSessionProjectionsBlock | undefined,
    ): void {
        const title = titleFromProjectionBlock(projections);
        if (title && this.applyTitle(sessionId, title.value, title.seq)) {
            this.publish();
        }
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
        if (this.remoteBaselineDepth > 0) {
            this.remoteBaselineDirty = true;
            return;
        }
        this.publishNow();
    }

    private publishNow(): void {
        const snapshot = this.snapshot();
        for (const listener of this.listeners) {
            listener(snapshot);
        }
    }
}
