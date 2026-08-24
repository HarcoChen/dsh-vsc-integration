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
    skills: [],
    selectionEnabled: true,
    status: { state: "stopped" },
    busy: false,
    submitting: false,
    cancelling: false,
    focusMode: false,
};

/** State slices keep non-streaming shell components independent from the full host tree. */
export type HeaderState = Pick<
    ChatViewState,
    | "status"
    | "sessionStatus"
    | "sessions"
    | "sessionId"
    | "currentWorkspace"
    | "draftWorkspaceId"
    | "draftWorkspaceTitle"
    | "focusMode"
>;

export type ActivityDockState = Pick<
    ChatViewState,
    | "goal"
    | "queue"
    | "changeReviews"
    | "subagents"
    | "subagentPreview"
    | "jobs"
    | "permissions"
    | "sessionId"
    | "agentPresetLabel"
>;

export type ComposerState = Pick<
    ChatViewState,
    | "context"
    | "selection"
    | "selectionEnabled"
    | "fileReferenceCandidates"
    | "skills"
    | "tokenUsage"
    | "sessionStats"
    | "reasoningEffort"
    | "imageLimits"
    | "busy"
    | "submitting"
    | "cancelling"
    | "sessionId"
>;

export type StatusBannerState = Pick<ChatViewState, "status" | "sessionStatus">;

export type ContextChipsState = Pick<ChatViewState, "context" | "selection" | "selectionEnabled" | "tokenUsage">;

export type ReasoningEffortState = Pick<ChatViewState, "reasoningEffort" | "submitting" | "busy">;

export type SessionStatsState = Pick<ChatViewState, "sessionStats">;

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
