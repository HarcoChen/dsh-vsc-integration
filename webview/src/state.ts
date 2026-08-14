import type {
    ChatRole,
    ChatViewState,
    RuntimeStatus,
    TurnStatusView,
} from "../../src/types";
import { t } from "./i18n";

/** Mirrors the initial state of the legacy inline webview before the first host push. */
export const DEFAULT_STATE: ChatViewState = {
    messages: [],
    context: [],
    sessions: [],
    interactions: [],
    queue: [],
    jobs: [],
    changeReviews: [],
    selectionEnabled: true,
    status: { state: "stopped" },
    busy: false,
    submitting: false,
    cancelling: false,
    focusMode: false,
};

export function statusLabel(status: RuntimeStatus): string {
    if (status.state === "running") return t("Running");
    if (status.state === "starting") return t("Starting");
    if (status.state === "error") return t("Error");
    return t("Stopped");
}

export const TURN_LABELS: Record<TurnStatusView["phase"], string> = {
    queued: t("Queued"),
    running: t("Running"),
    waiting: t("Waiting for action"),
    completed: t("Completed"),
    cancelled: t("Cancelled"),
    failed: t("Failed"),
};

export const ROLE_LABELS: Record<ChatRole, string> = {
    user: t("You"),
    assistant: "dsh",
    tool: t("Tool"),
    system: t("System"),
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
    if (status === "submitting") return t("Submitting...");
    if (status === "resolved") return t("Processed: {outcome}", { outcome: outcome || t("Done") });
    if (status === "unavailable") return t("Request is no longer active");
    if (status === "failed") return t("Submission outcome is uncertain; waiting for reconnect");
    return "";
}
