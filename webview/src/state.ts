import type {
    ChatRole,
    ChatViewState,
    RuntimeStatus,
    TurnStatusView,
} from "../../src/types";

/** Mirrors the initial state of the legacy inline webview before the first host push. */
export const DEFAULT_STATE: ChatViewState = {
    messages: [],
    context: [],
    sessions: [],
    interactions: [],
    queue: [],
    jobs: [],
    selectionEnabled: true,
    status: { state: "stopped" },
    busy: false,
    submitting: false,
    cancelling: false,
    focusMode: false,
};

export function statusLabel(status: RuntimeStatus): string {
    if (status.state === "running") return "运行中";
    if (status.state === "starting") return "启动中";
    if (status.state === "error") return "错误";
    return "未启动";
}

export const TURN_LABELS: Record<TurnStatusView["phase"], string> = {
    queued: "已排队",
    running: "运行中",
    waiting: "等待操作",
    completed: "已完成",
    cancelled: "已取消",
    failed: "失败",
};

export const ROLE_LABELS: Record<ChatRole, string> = {
    user: "你",
    assistant: "dsh",
    tool: "工具",
    system: "系统",
};

export function formatToolDuration(durationMs: number | undefined): string {
    if (durationMs === undefined || !Number.isFinite(durationMs)) return "";
    return durationMs < 1000
        ? ` · ${durationMs} ms`
        : ` · ${(durationMs / 1000).toFixed(1)} s`;
}

export function interactionStatusText(
    status: "pending" | "submitting" | "resolved" | "failed" | "unavailable",
    outcome: string | undefined,
): string {
    if (status === "submitting") return "正在提交…";
    if (status === "resolved") return `已处理：${outcome || "完成"}`;
    if (status === "unavailable") return "请求已失效";
    if (status === "failed") return "提交结果不确定，等待重连确认";
    return "";
}
