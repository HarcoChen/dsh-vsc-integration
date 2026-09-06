import type { DshWorkspaceListResult, DshWorkspaceView } from "../types";

/** Decode one Workspace projection from `workspace/follow` or a mutation result. */
export function workspaceView(value: unknown): DshWorkspaceView | undefined {
    if (
        !isRecord(value) ||
        typeof value.workspaceId !== "string" ||
        typeof value.path !== "string" ||
        typeof value.title !== "string" ||
        !Array.isArray(value.sessionIds) ||
        !value.sessionIds.every((id) => typeof id === "string") ||
        typeof value.createdAt !== "string" ||
        typeof value.updatedAt !== "string"
    ) return undefined;
    return {
        workspaceId: value.workspaceId,
        path: value.path,
        title: value.title,
        sessionIds: [...value.sessionIds] as string[],
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
    };
}

/** Decode the complete Workspace opening baseline. */
export function workspaceBaseline(value: unknown): DshWorkspaceListResult | undefined {
    if (!isRecord(value) || !Array.isArray(value.items) || !Array.isArray(value.archivedSessionIds)) return undefined;
    const items = value.items.map(workspaceView);
    if (items.some((item) => item === undefined)) return undefined;
    if (!value.archivedSessionIds.every((id) => typeof id === "string")) return undefined;
    const archivedSessionIds = value.archivedSessionIds as string[];
    return { items: items as DshWorkspaceView[], archivedSessionIds };
}

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
