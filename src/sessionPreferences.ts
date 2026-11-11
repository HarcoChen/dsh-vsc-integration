import type { HarnessCatalogSnapshot, SessionCatalogItem } from "./sessionCatalog";

export interface SessionCenterPreferences {
    filter: "all" | "attention" | "running" | "pinned";
    sort: "recent" | "title" | "oldest";
    grouped: boolean;
    workspaceId?: string;
}
export function sessionCenterPreferences(value: unknown): SessionCenterPreferences {
    const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    return {
        filter: ["attention", "running", "pinned"].includes(String(raw.filter))
            ? (raw.filter as SessionCenterPreferences["filter"])
            : "all",
        sort: raw.sort === "title" || raw.sort === "oldest" ? raw.sort : "recent",
        grouped: raw.grouped === true,
        ...(typeof raw.workspaceId === "string" ? { workspaceId: raw.workspaceId } : {}),
    };
}

export function sessionCenterItems(
    catalog: HarnessCatalogSnapshot,
    preferences: SessionCenterPreferences
): SessionCatalogItem[] {
    const archived = new Set(catalog.archivedSessionIds),
        pinned = new Set(catalog.pinnedSessionIds);
    const workspace = catalog.workspaces.find((item) => item.workspaceId === preferences.workspaceId);
    const workspaceIds = workspace ? new Set(workspace.sessionIds) : undefined;
    const priority = (item: SessionCatalogItem): number =>
        item.pendingInteraction ? 0 : item.lastAgentError ? 1 : item.running ? 2 : 3;
    return catalog.sessions
        .filter(
            (item) =>
                !archived.has(item.sessionId) &&
                item.origin !== "subagent" &&
                (!workspaceIds || workspaceIds.has(item.sessionId)) &&
                (preferences.filter === "all" ||
                    (preferences.filter === "running" && item.running) ||
                    (preferences.filter === "attention" && (item.pendingInteraction || item.lastAgentError)) ||
                    (preferences.filter === "pinned" && pinned.has(item.sessionId)))
        )
        .sort((left, right) => {
            if (preferences.sort === "title")
                return (
                    (left.title ?? left.sessionId).localeCompare(right.title ?? right.sessionId) ||
                    left.sessionId.localeCompare(right.sessionId)
                );
            const order = preferences.sort === "oldest" ? 1 : -1;
            return (
                (preferences.sort === "recent" ? priority(left) - priority(right) : 0) ||
                order * ((left.updatedAt ?? 0) - (right.updatedAt ?? 0)) ||
                left.sessionId.localeCompare(right.sessionId)
            );
        });
}
