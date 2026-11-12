import type { DshScheduleItem } from "./types";
import { scheduleProjection } from "./chatViewPresentation";
import { isRecord } from "./guards";

export type HostTaskTiming =
    | { kind: "after"; after_seconds: number }
    | { kind: "at"; at: string }
    | { kind: "every"; every_seconds: number }
    | { kind: "daily"; daily: { time: string; time_zone: string } }
    | { kind: "weekly"; weekly: { time: string; time_zone: string; weekdays: number[] } }
    | { kind: "cron"; cron: { expression: string; time_zone: string } }
    | { kind: "rrule"; rrule: string };
export type HostTaskTarget =
    | { kind: "session"; sessionId: string }
    | { kind: "new_once"; sessionId?: string; create?: { cwd?: string; agentPreset?: string } }
    | { kind: "new"; create?: { cwd?: string; agentPreset?: string } };
export type HostTask = (
    | DshScheduleItem
    | { id: string; kind: "rrule"; title: string; prompt: string; rrule: string; scheduledAt: string }
) & {
    title: string;
    status: "active" | "paused" | "ended";
    target: HostTaskTarget;
    involvedSessionIds: string[];
    updatedAt?: string;
    executionActive?: boolean;
};
export interface HostTaskPage {
    items: HostTask[];
    shown: number;
    total: number;
    limit: number;
    offset: number;
}
export interface HostScheduleView {
    page: HostTaskPage;
    loading: boolean;
    error?: string;
    canCreate: boolean;
    pending?: string;
    active?: boolean;
}

export function normalizeHostTask(value: unknown): HostTask | undefined {
    if (
        !isRecord(value) ||
        typeof value.title !== "string" ||
        !value.title.trim() ||
        !["active", "paused", "ended"].includes(String(value.status)) ||
        !isRecord(value.target) ||
        !["session", "new_once", "new"].includes(String(value.target.kind)) ||
        (value.target.kind === "session" && typeof value.target.sessionId !== "string") ||
        (value.target.kind === "new_once" && value.target.sessionId !== undefined && typeof value.target.sessionId !== "string") ||
        !Array.isArray(value.involvedSessionIds) ||
        !value.involvedSessionIds.every((id) => typeof id === "string") ||
        (value.updatedAt !== undefined && typeof value.updatedAt !== "string")
    )
        return undefined;
    const record =
        value.kind === "rrule" &&
        typeof value.id === "string" &&
        typeof value.prompt === "string" &&
        typeof value.rrule === "string" &&
        typeof value.scheduledAt === "string" &&
        Number.isFinite(Date.parse(value.scheduledAt))
            ? {
                  id: value.id,
                  kind: "rrule" as const,
                  title: value.title,
                  prompt: value.prompt,
                  rrule: value.rrule,
                  scheduledAt: value.scheduledAt,
              }
            : scheduleProjection([value])?.[0];
    if (!record) return undefined;
    return {
        ...record,
        title: value.title,
        status: value.status as HostTask["status"],
        target: value.target as unknown as HostTaskTarget,
        involvedSessionIds: value.involvedSessionIds,
        ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt }),
        ...(value.executionActive === true ? { executionActive: true } : {}),
    };
}

export function normalizeHostTaskPage(value: unknown): HostTaskPage | undefined {
    if (
        !isRecord(value) ||
        !Array.isArray(value.items) ||
        value.items.length > 500 ||
        ![value.shown, value.total, value.limit, value.offset].every(
            (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0
        ) ||
        value.shown !== value.items.length ||
        Number(value.limit) < 1 ||
        Number(value.limit) > 500 ||
        Number(value.shown) > Number(value.limit) ||
        Number(value.total) < Number(value.shown)
    )
        return undefined;
    const items = value.items.map(normalizeHostTask);
    if (items.some((item) => item === undefined) || new Set(items.map((item) => item?.id)).size !== items.length)
        return undefined;
    return {
        items: items as HostTask[],
        shown: value.shown as number,
        total: value.total as number,
        limit: value.limit as number,
        offset: value.offset as number,
    };
}
