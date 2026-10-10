/** Session pinning and archive recovery from the RC.2 Workspace controller. */

import * as vscode from "vscode";
import { DshRuntime } from "./dshRuntime";
import { t } from "./localize";

export interface SessionActionsHost {
    readonly runtime: DshRuntime;
    workspaceRoot(): string | undefined;
    openSession(sessionId: string): Promise<void>;
}

type SessionAction = "open" | "pin" | "unpin" | "unarchive";

/** Live navigation for observed requests and running Sessions, grouped by DSH Workspace. */
export async function openSessionCenter(host: SessionActionsHost): Promise<void> {
    await host.runtime.start(host.workspaceRoot());
    await host.runtime.refreshSessions();
    const picker = vscode.window.createQuickPick<vscode.QuickPickItem & { sessionId: string }>();
    picker.title = t("DSH Session center");
    picker.placeholder = t("Observed requests first, then running Sessions. Choose a Session to continue.");
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    const render = (): void => {
        const catalog = host.runtime.getSessionCatalog().snapshot();
        const archived = new Set(catalog.archivedSessionIds);
        const workspaceBySession = new Map(catalog.workspaces.flatMap(workspace =>
            workspace.sessionIds.map(id => [id, workspace.title] as const)));
        const priority = (item: typeof catalog.sessions[number]): number => item.pendingInteraction ? 0 : item.lastAgentError ? 1 : item.running ? 2 : 3;
        const activeId = picker.activeItems[0]?.sessionId;
        picker.items = [...catalog.sessions].filter(item => !archived.has(item.sessionId) && item.origin !== "subagent")
            .sort((a, b) => priority(a) - priority(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
            .map(item => ({
                label: `${item.pendingInteraction ? "$(bell)" : item.lastAgentError ? "$(error)" : item.running ? "$(sync~spin)" : "$(comment-discussion)"} ${item.title || item.sessionId}`,
                description: [workspaceBySession.get(item.sessionId) ?? t("Ungrouped sessions"),
                    item.pendingInteraction === "approval" ? t("Waiting for approval") : item.pendingInteraction === "question" ? t("Waiting for answer")
                        : item.lastAgentError ? t("Session error") : item.running ? t("Running") : undefined,
                    item.formatStatus === "migration-required" ? t("Migration required") : undefined].filter(Boolean).join(" · "),
                detail: item.lastAgentError ?? item.cwd,
                sessionId: item.sessionId,
            }));
        if (activeId) picker.activeItems = picker.items.filter(item => item.sessionId === activeId);
    };
    render();
    const unsubscribe = host.runtime.getSessionCatalog().onDidChange(render);
    let selected: string | undefined;
    try {
        await new Promise<void>(resolve => {
            const accept = picker.onDidAccept(() => {
                selected = picker.selectedItems[0]?.sessionId;
                if (selected) picker.hide();
            });
            const hide = picker.onDidHide(() => { accept.dispose(); hide.dispose(); resolve(); });
            picker.show();
        });
    } finally {
        unsubscribe();
        picker.dispose();
    }
    if (selected) await host.openSession(selected);
}

/** Keeps the session picker open while the user pins, restores, or opens Sessions. */
export async function manageSessions(host: SessionActionsHost): Promise<void> {
    await host.runtime.start(host.workspaceRoot());
    await host.runtime.refreshSessions();

    while (true) {
        const catalog = host.runtime.getSessionCatalog().snapshot();
        const archived = new Set(catalog.archivedSessionIds);
        const pinned = new Map(catalog.pinnedSessionIds.map((sessionId, index) => [sessionId, index] as const));
        const sessions = new Map(catalog.sessions.map((session) => [session.sessionId, session] as const));
        const ids = [...new Set([
            ...catalog.pinnedSessionIds,
            ...catalog.sessions.map((session) => session.sessionId),
            ...catalog.archivedSessionIds,
        ])].sort((left, right) => {
            const leftPin = pinned.get(left);
            const rightPin = pinned.get(right);
            if (leftPin !== undefined || rightPin !== undefined) {
                if (leftPin === undefined) return 1;
                if (rightPin === undefined) return -1;
                if (leftPin !== rightPin) return leftPin - rightPin;
            }
            const leftUpdated = sessions.get(left)?.updatedAt ?? 0;
            const rightUpdated = sessions.get(right)?.updatedAt ?? 0;
            return rightUpdated - leftUpdated || left.localeCompare(right);
        });
        if (ids.length === 0) {
            void vscode.window.showInformationMessage(t("No DSH Sessions are available."));
            return;
        }

        const choices = ids.map((sessionId) => {
            const session = sessions.get(sessionId);
            const isArchived = archived.has(sessionId);
            const isPinned = pinned.has(sessionId);
            const statuses = [
                ...(isArchived ? [t("Archived")] : []),
                ...(!isArchived && isPinned ? [t("Pinned")] : []),
                ...(!isArchived && session?.running ? [t("Running")] : []),
            ];
            return {
                label: `${isArchived ? "$(archive)" : isPinned ? "$(pin)" : "$(comment-discussion)"} ${session?.title || sessionId}`,
                description: [sessionId, ...statuses].join(" · "),
                detail: session?.cwd,
                title: session?.title || sessionId,
                sessionId,
                isArchived,
                isPinned,
            };
        });
        const selected = await vscode.window.showQuickPick(choices, {
            title: t("Manage DSH Sessions"),
            placeHolder: t("Choose a Session to manage"),
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!selected) return;

        const actions: Array<vscode.QuickPickItem & { action: SessionAction }> = selected.isArchived
            ? [{ action: "unarchive", label: `$(archive) ${t("Restore session")}` }]
            : [
                { action: "open", label: `$(comment-discussion) ${t("Open session")}` },
                selected.isPinned
                    ? { action: "unpin", label: `$(pin) ${t("Unpin session")}` }
                    : { action: "pin", label: `$(pin) ${t("Pin session")}` },
            ];
        const action = await vscode.window.showQuickPick(actions, {
            title: selected.title,
            placeHolder: t("Choose an action"),
        });
        if (!action) continue;

        if (action.action === "open") {
            await host.openSession(selected.sessionId);
            return;
        }
        if (action.action === "pin") {
            await host.runtime.pinSession(selected.sessionId);
        } else if (action.action === "unpin") {
            await host.runtime.unpinSession(selected.sessionId);
        } else {
            await host.runtime.unarchiveSession(selected.sessionId);
            await host.runtime.refreshSessions();
        }
    }
}
