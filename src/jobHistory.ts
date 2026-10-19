import type { StoredSessionEvent } from "./sessionStore";
import type { JobCenterItem } from "./types";
import { isRecord } from "./guards";

/** Durable lifecycle records describe past executions; only the live roster authorizes control. */
export function mergeJobHistory(sessionId: string, events: readonly StoredSessionEvent[], live: readonly JobCenterItem[]): JobCenterItem[] {
    const history = new Map<string, JobCenterItem>();
    for (const { event } of events) {
        if (event.type !== "job/registered" && event.type !== "job/settled") continue;
        const data = event.data;
        if (!isRecord(data) || typeof data.jobId !== "string" || typeof data.owner !== "string" ||
            typeof data.kind !== "string" || typeof data.label !== "string" || typeof data.startedAt !== "number" || !Number.isFinite(data.startedAt)) continue;
        const settled = event.type === "job/settled";
        if (settled && (!["completed", "killed", "failed"].includes(String(data.status)) || typeof data.finishedAt !== "number" || !Number.isFinite(data.finishedAt))) continue;
        history.set(data.jobId, { id: data.jobId, kind: data.kind, label: data.label, ownerSessionId: data.owner,
            startedAt: data.startedAt, status: settled ? data.status as "completed" | "killed" | "failed" : "unavailable",
            ...(settled ? { finishedAt: data.finishedAt as number } : {}),
            ...(typeof data.detail === "string" ? { outputSummary: data.detail } : {}),
            historical: true, canKill: false });
    }
    for (const item of live) {
        const recorded = history.get(item.id);
        if (recorded && recorded.ownerSessionId !== item.ownerSessionId) continue;
        history.set(item.id, { ...recorded, ...item, historical: false, canKill: item.canKill === true && item.ownerSessionId === sessionId });
    }
    return [...history.values()].sort((a, b) => b.startedAt - a.startedAt);
}
