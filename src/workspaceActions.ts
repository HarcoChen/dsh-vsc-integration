/**
 * The "Manage DSH Workspaces" QuickPick flow.
 *
 * A Workspace is a Harness grouping of Sessions (see AGENTS.md — it is not a
 * VS Code workspace folder). These are user-driven editor interactions rather
 * than view state, so they live beside the chat view instead of inside it; the
 * view keeps only the draft bookkeeping it owns, reached through
 * {@link WorkspaceActionsHost}.
 */

import * as vscode from "vscode";
import { DshRuntime } from "./dshRuntime";
import { t } from "./localize";
import { samePath } from "./paths";
import { DshWorkspaceView } from "./types";

/**
 * What these flows need from the chat view. Deliberately narrow: the runtime,
 * the current folder, and two notifications for the one piece of view state a
 * Workspace edit can invalidate — the pending New Session draft, which pins a
 * Workspace by id and would otherwise keep a stale title or a dead reference.
 */
export interface WorkspaceActionsHost {
    readonly runtime: DshRuntime;
    workspaceRoot(): string | undefined;
    /** A Workspace was renamed; a draft pinned to it should follow the title. */
    onWorkspaceRenamed(workspaceId: string, title: string): void;
    /** A Workspace group was removed; a draft pinned to it must be cleared. */
    onWorkspaceRemoved(workspaceId: string): void;
}

type WorkspaceAction = "rename" | "top" | "up" | "down" | "bottom" | "sessions" | "remove";

/**
 * Lists Workspaces and loops on the picker until dismissed, so managing
 * several in a row does not mean reopening the command each time.
 */
export async function manageWorkspaces(host: WorkspaceActionsHost): Promise<void> {
    const workspaceRoot = host.workspaceRoot();
    await host.runtime.start(workspaceRoot);
    await host.runtime.refreshSessions();

    while (true) {
        const catalog = host.runtime.getSessionCatalog().snapshot();
        const currentRegistered = workspaceRoot
            ? catalog.workspaces.some((workspace) => samePath(workspace.path, workspaceRoot))
            : true;
        type WorkspaceChoice = vscode.QuickPickItem &
            ({ choiceType: "workspace"; workspace: DshWorkspaceView } | { choiceType: "register" });
        const choices: WorkspaceChoice[] = [
            ...(!currentRegistered && workspaceRoot ? [{
                choiceType: "register" as const,
                label: `$(add) ${t("Register current folder as a DSH Workspace")}`,
                detail: workspaceRoot,
                alwaysShow: true,
            }] : []),
            ...catalog.workspaces.map((workspace): WorkspaceChoice => ({
                choiceType: "workspace",
                workspace,
                label: `$(folder) ${workspace.title}`,
                description: t("{count} sessions", { count: workspace.sessionIds.length }),
                detail: workspace.path,
            })),
        ];
        if (choices.length === 0) {
            void vscode.window.showInformationMessage(t("No DSH Workspaces are registered."));
            return;
        }
        const selected = await vscode.window.showQuickPick(choices, {
            title: t("Manage DSH Workspaces"),
            placeHolder: t("Choose a Workspace to manage"),
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!selected) return;
        if (selected.choiceType === "register") {
            if (workspaceRoot) {
                await host.runtime.createWorkspace(workspaceRoot);
                await host.runtime.refreshSessions();
            }
            continue;
        }

        const action = await chooseWorkspaceAction(selected.workspace, catalog.workspaces);
        if (!action) continue;
        if (action === "rename") {
            await renameWorkspace(host, selected.workspace);
        } else if (action === "sessions") {
            await reorderWorkspaceSession(host, selected.workspace);
        } else if (action === "remove") {
            await removeWorkspace(host, selected.workspace);
        } else {
            await reorderWorkspace(host, selected.workspace, catalog.workspaces, action);
        }
    }
}

/** Offers only the moves that this Workspace's position actually allows. */
async function chooseWorkspaceAction(
    workspace: DshWorkspaceView,
    workspaces: readonly DshWorkspaceView[],
): Promise<WorkspaceAction | undefined> {
    const index = workspaces.findIndex((candidate) => candidate.workspaceId === workspace.workspaceId);
    const actions: Array<vscode.QuickPickItem & { action: WorkspaceAction }> = [{
        action: "rename",
        label: `$(edit) ${t("Rename Workspace")}`,
        detail: workspace.path,
    }];
    if (index > 0) {
        actions.push(
            { action: "top", label: `$(fold-up) ${t("Move Workspace to top")}` },
            { action: "up", label: `$(arrow-up) ${t("Move Workspace up")}` },
        );
    }
    if (index >= 0 && index < workspaces.length - 1) {
        actions.push(
            { action: "down", label: `$(arrow-down) ${t("Move Workspace down")}` },
            { action: "bottom", label: `$(fold-down) ${t("Move Workspace to bottom")}` },
        );
    }
    if (workspace.sessionIds.length > 1) {
        actions.push({
            action: "sessions",
            label: `$(list-ordered) ${t("Reorder sessions")}`,
            detail: t("{count} sessions", { count: workspace.sessionIds.length }),
        });
    }
    actions.push({
        action: "remove",
        label: `$(trash) ${t("Remove Workspace group")}`,
        detail: t("Keep its directory and Session logs"),
    });
    const selected = await vscode.window.showQuickPick(actions, {
        title: workspace.title,
        placeHolder: t("Choose an action"),
    });
    return selected?.action;
}

async function renameWorkspace(
    host: WorkspaceActionsHost,
    workspace: DshWorkspaceView,
): Promise<void> {
    const title = await vscode.window.showInputBox({
        title: t("Rename DSH Workspace"),
        value: workspace.title,
        prompt: workspace.path,
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() ? undefined : t("The title cannot be empty."),
    });
    if (title === undefined || title.trim() === workspace.title) return;
    const renamed = await host.runtime.renameWorkspace(workspace.workspaceId, title.trim());
    host.onWorkspaceRenamed(workspace.workspaceId, renamed.title);
}

/**
 * Reorders by naming the Workspace to insert before. Moving down skips the
 * neighbour that is about to shift up, which is why it reaches two positions
 * ahead; moving to the bottom names nothing at all.
 */
async function reorderWorkspace(
    host: WorkspaceActionsHost,
    workspace: DshWorkspaceView,
    workspaces: readonly DshWorkspaceView[],
    direction: "top" | "up" | "down" | "bottom",
): Promise<void> {
    const index = workspaces.findIndex((candidate) => candidate.workspaceId === workspace.workspaceId);
    if (index < 0) return;
    let beforeWorkspaceId: string | undefined;
    if (direction === "top") {
        beforeWorkspaceId = workspaces[0]?.workspaceId;
    } else if (direction === "up") {
        beforeWorkspaceId = workspaces[index - 1]?.workspaceId;
    } else if (direction === "down") {
        beforeWorkspaceId = workspaces[index + 2]?.workspaceId;
    }
    await host.runtime.moveWorkspace(workspace.workspaceId, beforeWorkspaceId);
}

/** Two-step pick — which Session, then where — over one Workspace's order. */
async function reorderWorkspaceSession(
    host: WorkspaceActionsHost,
    workspace: DshWorkspaceView,
): Promise<void> {
    const catalog = host.runtime.getSessionCatalog().snapshot();
    const sessions = new Map(catalog.sessions.map((session) => [session.sessionId, session]));
    const archived = new Set(catalog.archivedSessionIds);
    const selected = await vscode.window.showQuickPick(
        workspace.sessionIds.map((sessionId, index) => {
            const session = sessions.get(sessionId);
            return {
                label: `${archived.has(sessionId) ? "$(archive)" : "$(comment-discussion)"} ${session?.title || sessionId}`,
                description: t("Position {position}", { position: index + 1 }),
                detail: archived.has(sessionId) ? t("Archived Session") : session?.cwd,
                sessionId,
            };
        }),
        {
            title: t("Reorder sessions in {workspace}", { workspace: workspace.title }),
            placeHolder: t("Choose a Session to move"),
            matchOnDescription: true,
            matchOnDetail: true,
        },
    );
    if (!selected) return;

    const index = workspace.sessionIds.indexOf(selected.sessionId);
    const actions: Array<vscode.QuickPickItem & { direction: "top" | "up" | "down" | "bottom" }> = [];
    if (index > 0) {
        actions.push(
            { direction: "top", label: `$(fold-up) ${t("Move Session to top")}` },
            { direction: "up", label: `$(arrow-up) ${t("Move Session up")}` },
        );
    }
    if (index >= 0 && index < workspace.sessionIds.length - 1) {
        actions.push(
            { direction: "down", label: `$(arrow-down) ${t("Move Session down")}` },
            { direction: "bottom", label: `$(fold-down) ${t("Move Session to bottom")}` },
        );
    }
    if (actions.length === 0) return;
    const move = await vscode.window.showQuickPick(actions, {
        title: sessions.get(selected.sessionId)?.title || selected.sessionId,
        placeHolder: t("Choose a new position"),
    });
    if (!move) return;

    let beforeSessionId: string | undefined;
    if (move.direction === "top") {
        beforeSessionId = workspace.sessionIds[0];
    } else if (move.direction === "up") {
        beforeSessionId = workspace.sessionIds[index - 1];
    } else if (move.direction === "down") {
        beforeSessionId = workspace.sessionIds[index + 2];
    }
    await host.runtime.moveWorkspaceSession(
        workspace.workspaceId,
        selected.sessionId,
        beforeSessionId,
    );
}

/**
 * Removes the grouping only. The confirmation says so explicitly because the
 * word "remove" beside a directory path reads as a destructive action, and
 * this one keeps every file and Session log.
 */
async function removeWorkspace(
    host: WorkspaceActionsHost,
    workspace: DshWorkspaceView,
): Promise<void> {
    const remove = t("Remove Workspace group");
    const confirmed = await vscode.window.showWarningMessage(
        t("Remove DSH Workspace group {workspace}?", { workspace: workspace.title }),
        {
            modal: true,
            detail: t("The directory and all Session logs will be kept. Its Sessions will appear as ungrouped."),
        },
        remove,
    );
    if (confirmed !== remove) return;
    await host.runtime.deleteWorkspace(workspace.workspaceId);
    host.onWorkspaceRemoved(workspace.workspaceId);
}
