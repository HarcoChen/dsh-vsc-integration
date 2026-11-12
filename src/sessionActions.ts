/** Session pinning and archive recovery from the RC.2 Workspace controller. */

import * as vscode from "vscode";
import { DshRuntime } from "./dshRuntime";
import { t } from "./localize";
import { sessionCenterItems, sessionCenterPreferences, type SessionCenterPreferences } from "./sessionPreferences";

export interface SessionActionsHost {
    readonly runtime: DshRuntime;
    workspaceRoot(): string | undefined;
    openSession(sessionId: string): Promise<void>;
    preferences?: vscode.Memento;
}

type SessionAction = "open" | "pin" | "unpin" | "unarchive";

/** Live navigation for observed requests and running Sessions, grouped by DSH Workspace. */
export async function openSessionCenter(host: SessionActionsHost): Promise<void> {
    await host.runtime.start(host.workspaceRoot());
    await host.runtime.refreshSessions();
    const picker = vscode.window.createQuickPick<vscode.QuickPickItem & { sessionId?: string; value?: string }>();
    picker.title = t("DSH Session center");
    picker.placeholder = t("Observed requests first, then running Sessions. Choose a Session to continue.");
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    let preferences = sessionCenterPreferences(host.preferences?.get("sessionCenterPreferences"));
    let mode: "sessions" | "filter" | "workspace" | "sort" = "sessions";
    const filterButton = { iconPath: new vscode.ThemeIcon("filter"), tooltip: t("Filter sessions") };
    const workspaceButton = { iconPath: new vscode.ThemeIcon("folder-library"), tooltip: t("Choose DSH Workspace") };
    const sortButton = { iconPath: new vscode.ThemeIcon("sort-precedence"), tooltip: t("Sort sessions") };
    const groupButton = { iconPath: new vscode.ThemeIcon("list-tree"), tooltip: t("Toggle Workspace grouping") };
    const render = (): void => {
        const catalog = host.runtime.getSessionCatalog().snapshot();
        if (preferences.workspaceId && host.runtime.getHostDescription() && !catalog.workspaces.some(workspace => workspace.workspaceId === preferences.workspaceId)) {
            preferences = { ...preferences, workspaceId: undefined };
            void host.preferences?.update("sessionCenterPreferences", preferences);
            void vscode.window.showInformationMessage(t("The saved DSH Workspace filter no longer exists and has been reset."));
        }
        picker.buttons = mode === "sessions" ? [filterButton, workspaceButton, sortButton, groupButton] : [vscode.QuickInputButtons.Back];
        if (mode !== "sessions") {
            const choices = mode === "filter" ? [
                { label: t("All sessions"), value: "all" }, { label: t("Needs attention"), value: "attention" },
                { label: t("Running"), value: "running" }, { label: t("Pinned"), value: "pinned" },
            ] : mode === "sort" ? [
                { label: t("Recent activity first"), value: "recent" }, { label: t("Oldest activity first"), value: "oldest" }, { label: t("Title"), value: "title" },
            ] : [{ label: t("All DSH Workspaces"), value: "" }, ...catalog.workspaces.map(workspace => ({ label: workspace.title, description: workspace.path, value: workspace.workspaceId }))];
            picker.items = choices;
            return;
        }
        const workspaceBySession = new Map(catalog.workspaces.flatMap(workspace =>
            workspace.sessionIds.map(id => [id, workspace.title] as const)));
        const activeId = picker.activeItems[0]?.sessionId;
        picker.placeholder = [t({ all: "All sessions", attention: "Needs attention", running: "Running", pinned: "Pinned" }[preferences.filter]),
            t({ recent: "Recent activity first", oldest: "Oldest activity first", title: "Title" }[preferences.sort]),
            catalog.workspaces.find(item => item.workspaceId === preferences.workspaceId)?.title].filter(Boolean).join(" · ");
        const rows = sessionCenterItems(catalog, preferences).filter(item => !host.runtime.isBackgroundSession(item.sessionId))
            .map(item => ({
                label: `${item.pendingInteraction ? "$(bell)" : item.lastAgentError ? "$(error)" : item.running ? "$(sync~spin)" : "$(comment-discussion)"} ${item.title || item.sessionId}`,
                description: [workspaceBySession.get(item.sessionId) ?? t("Ungrouped sessions"),
                    item.pendingInteraction === "approval" ? t("Waiting for approval") : item.pendingInteraction === "question" ? t("Waiting for answer")
                        : item.lastAgentError ? t("Session error") : item.running ? t("Running") : undefined,
                    item.formatStatus === "migration-required" ? t("Migration required") : undefined].filter(Boolean).join(" · "),
                detail: [item.sessionId, item.lastAgentError ?? item.cwd].filter(Boolean).join(" · "),
                sessionId: item.sessionId,
            }));
        if (preferences.grouped) {
            const groups = new Map<string, typeof rows>();
            for (const row of rows) {
                const id = catalog.workspaces.find(workspace => workspace.sessionIds.includes(row.sessionId))?.workspaceId ?? "";
                const group = groups.get(id) ?? []; group.push(row); groups.set(id, group);
            }
            picker.items = [...groups].flatMap(([id, group]) => [{ label: catalog.workspaces.find(item => item.workspaceId === id)?.title ?? t("Ungrouped sessions"), kind: vscode.QuickPickItemKind.Separator }, ...group]);
        } else picker.items = rows;
        if (activeId) picker.activeItems = picker.items.filter(item => item.sessionId === activeId);
    };
    render();
    const unsubscribe = host.runtime.getSessionCatalog().onDidChange(render);
    let selected: string | undefined;
    try {
        await new Promise<void>(resolve => {
            const accept = picker.onDidAccept(() => {
                if (mode !== "sessions") {
                    const value = picker.selectedItems[0]?.value;
                    if (value === undefined) return;
                    if (mode === "filter") preferences.filter = value as SessionCenterPreferences["filter"];
                    else if (mode === "sort") preferences.sort = value as SessionCenterPreferences["sort"];
                    else preferences.workspaceId = value || undefined;
                    void host.preferences?.update("sessionCenterPreferences", preferences);
                    mode = "sessions"; picker.value = ""; render(); return;
                }
                selected = picker.selectedItems[0]?.sessionId;
                if (selected) picker.hide();
            });
            const buttons = picker.onDidTriggerButton(button => {
                if (button === groupButton) { preferences.grouped = !preferences.grouped; void host.preferences?.update("sessionCenterPreferences", preferences); }
                else mode = button === filterButton ? "filter" : button === workspaceButton ? "workspace" : button === sortButton ? "sort" : "sessions";
                picker.value = ""; render();
            });
            const hide = picker.onDidHide(() => { accept.dispose(); buttons.dispose(); hide.dispose(); resolve(); });
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
