import React, { useEffect, useState } from "react";
import type {
    ChatViewState,
    GoalHudView,
    SubagentHistoryPreview,
    SubagentTreeView,
} from "../../../src/types";
import { postAction } from "../bridge";
import { t } from "../i18n";
import { handleMarkdownClick, handleMarkdownKeydown } from "./MessageList";
import { MessageContent } from "./MessageItem";

type DockTab = "goal" | "queue" | "changes" | "subagents" | "jobs" | "permissions";

interface TabDef {
    id: DockTab;
    label: string;
    count?: number;
}

function askGoalRounds(initialValue: number | undefined): { cancelled: true } | { value?: number } {
    const raw = window.prompt(
        t("Maximum Goal rounds (leave empty for the Harness default)"),
        initialValue === undefined ? "" : String(initialValue),
    );
    if (raw === null) return { cancelled: true };
    if (!raw.trim()) return { value: undefined };
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
        window.alert(t("Goal rounds must be a positive integer."));
        return { cancelled: true };
    }
    return { value };
}

function GoalPanel({ goal }: { goal: GoalHudView }): React.JSX.Element {
    if (goal.state === "invalid") {
        return (
            <div className="dsh-card">
                <div className="dsh-card-error">{goal.error || t("Invalid Goal projection")}</div>
            </div>
        );
    }

    const create = (): void => {
        const objective = window.prompt(t("Goal objective"), "");
        if (objective === null || !objective.trim()) return;
        const rounds = askGoalRounds(undefined);
        if ("cancelled" in rounds) return;
        postAction({
            type: "goalCreate",
            objective: objective.trim(),
            ...(rounds.value === undefined ? {} : { maxGoalRounds: rounds.value }),
        });
    };

    if (goal.state === "empty") {
        return (
            <div className="dsh-card">
                <div className="dsh-card-detail">{t("This session has no Goal yet.")}</div>
                {goal.error ? <div className="dsh-card-error">{goal.error}</div> : null}
                <div className="dsh-card-actions">
                    <button
                        type="button"
                        className="dsh-button"
                        disabled={goal.pending}
                        onClick={create}
                    >
                        {t("Create Goal")}
                    </button>
                </div>
            </div>
        );
    }

    const current = goal.goal;
    if (!current) {
        return (
            <div className="dsh-card">
                <div className="dsh-card-error">{t("Goal data is missing.")}</div>
            </div>
        );
    }

    const disabled = goal.pending === true;
    const canResume =
        (current.phase === "active" || current.phase === "paused" || current.phase === "blocked") &&
        Number(goal.roundsStarted || 0) < Number(current.maxGoalRounds || 0);

    const edit = (): void => {
        const objective = window.prompt(t("Edit Goal objective"), current.objective || "");
        if (objective === null || !objective.trim()) return;
        const rounds = askGoalRounds(current.maxGoalRounds);
        if ("cancelled" in rounds) return;
        postAction({
            type: "goalEdit",
            objective: objective.trim(),
            ...(rounds.value === undefined ? {} : { maxGoalRounds: rounds.value }),
        });
    };
    const simple = (action: "goalPause" | "goalResume" | "goalComplete" | "goalClear") => (): void => {
        if (action === "goalClear" && !window.confirm(t("Clear the current Goal?"))) return;
        postAction({ type: action });
    };

    return (
        <div className="dsh-card">
            <div className="dsh-goal-objective">{current.objective}</div>
            <div className="dsh-card-detail">
                {t("Phase {phase} · revision {revision} · round {started}/{maximum}", {
                    phase: current.phase,
                    revision: current.revision,
                    started: goal.roundsStarted || 0,
                    maximum: current.maxGoalRounds,
                })}
            </div>
            {current.blockedReason ? (
                <div className="dsh-card-error">
                    {current.blockedReason.code} · {current.blockedReason.message}
                </div>
            ) : null}
            {goal.pending ? (
                <div className="dsh-card-detail">
                    {t("Running {operation}; waiting for the projection to converge...", {
                        operation: goal.pendingOperation || t("mutation"),
                    })}
                </div>
            ) : null}
            {goal.error ? <div className="dsh-card-error">{goal.error}</div> : null}
            <div className="dsh-card-actions">
                <button type="button" className="dsh-button" disabled={disabled} onClick={edit}>
                    {t("Edit")}
                </button>
                {current.phase === "active" ? (
                    <button
                        type="button"
                        className="dsh-button dsh-button-secondary"
                        disabled={disabled}
                        onClick={simple("goalPause")}
                    >
                        {t("Pause")}
                    </button>
                ) : null}
                {canResume ? (
                    <button
                        type="button"
                        className="dsh-button dsh-button-secondary"
                        disabled={disabled}
                        onClick={simple("goalResume")}
                    >
                        {t("Resume")}
                    </button>
                ) : null}
                {current.phase !== "complete" ? (
                    <button
                        type="button"
                        className="dsh-button dsh-button-secondary"
                        disabled={disabled}
                        onClick={simple("goalComplete")}
                    >
                        {t("Complete")}
                    </button>
                ) : (
                    <button type="button" className="dsh-button" disabled={disabled} onClick={create}>
                        {t("New Goal")}
                    </button>
                )}
                <button
                    type="button"
                    className="dsh-button dsh-button-secondary"
                    disabled={disabled}
                    onClick={simple("goalClear")}
                >
                    {t("Clear")}
                </button>
            </div>
        </div>
    );
}

function QueuePanel({
    queue,
    running,
}: {
    queue: ChatViewState["queue"];
    running: boolean;
}): React.JSX.Element {
    const act = (itemId: string, action: "edit" | "remove" | "steer", editableText?: string): void => {
        if (action === "edit") {
            const text = window.prompt(t("Edit queued message"), editableText ?? "");
            if (text === null || !text.trim()) return;
            postAction({ type: "updateQueue", itemId, action: "edit", text });
            return;
        }
        postAction({ type: "updateQueue", itemId, action });
    };
    return (
        <div>
            {queue.map((item) => (
                <div className="dsh-queue-row" key={item.id}>
                    <div className="dsh-queue-preview">
                        {item.placement === "steering" ? "↪ " : ""}
                        {item.preview || t("(no text content)")}
                    </div>
                    <div className="dsh-queue-actions">
                        {item.editableText !== undefined ? (
                            <button
                                type="button"
                                className="dsh-button dsh-button-secondary"
                                onClick={() => act(item.id, "edit", item.editableText)}
                            >
                                {t("Edit")}
                            </button>
                        ) : null}
                        <button
                            type="button"
                            className="dsh-button dsh-button-secondary"
                            onClick={() => act(item.id, "remove")}
                        >
                            {t("Remove")}
                        </button>
                        <button
                            type="button"
                            className="dsh-button dsh-button-secondary"
                            disabled={!running}
                            onClick={() => act(item.id, "steer")}
                        >
                            {t("Steer now")}
                        </button>
                    </div>
                </div>
            ))}
        </div>
    );
}

function SubagentPreviewCard({ preview }: { preview: SubagentHistoryPreview }): React.JSX.Element {
    const [followUp, setFollowUp] = useState("");
    const busy = Boolean(preview.pendingAction);
    const canFollowUp = preview.parentAvailable && !busy;

    const sendFollowUp = (): void => {
        const text = followUp.trim();
        if (!text || !canFollowUp) return;
        setFollowUp("");
        postAction({ type: "followUpSubagent", childSessionId: preview.childSessionId, text });
    };

    return (
        <div className="dsh-card">
            <div className="dsh-feature-head">
                <div className="dsh-card-title">{preview.label}</div>
                <button
                    type="button"
                    className="dsh-button dsh-button-secondary"
                    onClick={() => postAction({ type: "closeSubagent" })}
                >
                    {t("Close")}
                </button>
            </div>
            <div className="dsh-card-detail">
                {preview.mode} · {preview.activity} ·{" "}
                {preview.parentAvailable ? t("parent available") : t("parent unavailable")}
            </div>
            {preview.state === "loading" ? (
                <div className="dsh-card-detail">{t("Loading history...")}</div>
            ) : null}
            {preview.error ? <div className="dsh-card-error">{preview.error}</div> : null}
            {preview.pendingAction ? (
                <div className="dsh-card-detail">{t("Running {operation}...", { operation: preview.pendingAction })}</div>
            ) : null}
            {preview.messages.length ? (
                <div
                    className="dsh-subagent-transcript"
                    onClick={(event) => handleMarkdownClick(event.target)}
                    onKeyDown={handleMarkdownKeydown}
                >
                    {preview.messages.map((message) => (
                        <div
                            className={`dsh-message dsh-role-${message.role}`}
                            key={message.id}
                            {...(typeof message.renderId === "string"
                                ? { "data-render-id": message.renderId }
                                : {})}
                        >
                            <div className="dsh-message-label">
                                {message.role === "assistant"
                                    ? "subagent"
                                    : message.role === "user"
                                      ? t("You")
                                      : t("System")}
                            </div>
                            <MessageContent message={message} />
                        </div>
                    ))}
                </div>
            ) : null}
            {preview.mode === "continuable" ? (
                <div className="dsh-follow-up">
                    <input
                        placeholder={t("Add a task for the continuable subagent")}
                        value={followUp}
                        disabled={!canFollowUp}
                        onChange={(event) => setFollowUp(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.preventDefault();
                                sendFollowUp();
                            }
                        }}
                    />
                    <button
                        type="button"
                        className="dsh-button"
                        disabled={!canFollowUp || !followUp.trim()}
                        onClick={sendFollowUp}
                    >
                        {t("Send")}
                    </button>
                </div>
            ) : null}
            {preview.mode === "continuable" && preview.activity === "running" ? (
                <div className="dsh-card-actions">
                    <button
                        type="button"
                        className="dsh-button dsh-button-secondary"
                        disabled={busy}
                        onClick={() =>
                            postAction({
                                type: "interruptSubagent",
                                childSessionId: preview.childSessionId,
                            })
                        }
                    >
                        {t("Interrupt")}
                    </button>
                </div>
            ) : null}
        </div>
    );
}

function SubagentsPanel({
    tree,
    preview,
}: {
    tree: SubagentTreeView;
    preview?: SubagentHistoryPreview;
}): React.JSX.Element {
    const statusText =
        tree.state === "loading"
            ? t("Loading...")
            : tree.state === "error"
              ? tree.error || t("Loading failed")
              : tree.nodes.length
                ? ""
                : t("No subagents");
    return (
        <div>
            <div className="dsh-feature-head">
                <div className="dsh-dock-title">{t("Subagent Tree")}</div>
                <button
                    type="button"
                    className="dsh-button dsh-button-secondary"
                    disabled={tree.state === "loading"}
                    onClick={() => postAction({ type: "refreshSubagents" })}
                >
                    {t("Refresh")}
                </button>
            </div>
            {statusText ? <div className="dsh-card-detail">{statusText}</div> : null}
            {tree.nodes.map((node) => {
                const depthClass = `dsh-tree-depth-${Math.min(8, Math.max(0, Number(node.depth || 1) - 1))}`;
                if (node.kind === "diagnostic") {
                    return (
                        <div className={`dsh-tree-row ${depthClass}`} key={node.id}>
                            <div>
                                <div className="dsh-tree-label">{node.id}</div>
                                <div className="dsh-tree-meta">
                                    {t("diagnostic · {reason} · parent {parent}", {
                                        reason: node.reason || "",
                                        parent: node.parentSessionId,
                                    })}
                                </div>
                            </div>
                        </div>
                    );
                }
                const meta = [
                    node.mode,
                    node.activity,
                    node.hasChildren ? t("has children") : t("leaf"),
                    node.parentAvailable ? t("parent available") : t("parent unavailable"),
                ]
                    .filter(Boolean)
                    .join(" · ");
                return (
                    <div className={`dsh-tree-row ${depthClass}`} key={node.id}>
                        <div>
                            <div className="dsh-tree-label">{node.label || node.id}</div>
                            <div className="dsh-tree-meta">
                                {meta}
                                <br />
                                {t("parent {parent}", { parent: node.parentSessionId })}
                            </div>
                        </div>
                        <button
                            type="button"
                            className="dsh-button dsh-button-secondary"
                            onClick={() => postAction({ type: "openSubagent", childSessionId: node.id })}
                        >
                            {t("History")}
                        </button>
                    </div>
                );
            })}
            {preview ? <SubagentPreviewCard preview={preview} /> : null}
        </div>
    );
}

function JobsPanel({ jobs }: { jobs: ChatViewState["jobs"] }): React.JSX.Element {
    return (
        <div>
            <div className="dsh-card-detail">{t("Job Center · read-only")}</div>
            {jobs.map((job) => (
                <div className="dsh-job-row" key={job.id}>
                    <div>{job.label}</div>
                    <div className="dsh-job-meta">
                        {job.kind} · {job.status} · {t("owner {owner}", { owner: job.ownerSessionId })}
                    </div>
                    {job.outputSummary ? (
                        <div className="dsh-job-summary">{job.outputSummary}</div>
                    ) : null}
                </div>
            ))}
        </div>
    );
}

function PermissionsPanel({
    permissions,
}: {
    permissions: NonNullable<ChatViewState["permissions"]>;
}): React.JSX.Element {
    return (
        <div className="dsh-card">
            <div className="dsh-card-detail">{t("Current preset: {preset}", { preset: permissions.currentLabel })}</div>
            {permissions.options.map((option) => (
                <div
                    className={`dsh-permission-option${
                        option.value === permissions.currentValue ? " active" : ""
                    }`}
                    key={option.value}
                >
                    <span>
                        {option.label}
                        {option.value === permissions.currentValue ? t(" · current") : ""}
                    </span>
                    {option.description ? (
                        <span className="dsh-card-detail">{option.description}</span>
                    ) : null}
                </div>
            ))}
            <div className="dsh-card-detail">{t("Permission changes are handled by the public command in the Harness Web UI.")}</div>
        </div>
    );
}

const CHANGE_LABELS = {
    added: t("Added"),
    modified: t("Modified"),
    deleted: t("Deleted"),
    renamed: t("Renamed"),
} as const;

function ChangesPanel({
    reviews,
    running,
}: {
    reviews: ChatViewState["changeReviews"];
    running: boolean;
}): React.JSX.Element {
    return (
        <div className="dsh-changes">
            {reviews.map((review) => {
                const canRestore = review.state === "ready" &&
                    review.files.length > 0 &&
                    !running &&
                    !review.restored &&
                    review.files.every((file) => file.restorable);
                return (
                    <section className="dsh-change-turn" key={review.turn}>
                        <div className="dsh-change-head">
                            <strong>{t("Turn {turn}", { turn: review.turn })}</strong>
                            <span className="dsh-card-detail">
                                {review.state === "capturing"
                                    ? t("Capturing changes...")
                                    : review.restored
                                        ? t("Restored")
                                        : t("{count} files", { count: review.files.length })}
                            </span>
                            <button
                                type="button"
                                className="dsh-button dsh-change-restore"
                                disabled={!canRestore}
                                title={review.files.some((file) => !file.restorable)
                                    ? t("This turn contains a file type that cannot be restored safely.")
                                    : running
                                        ? t("Wait for the current turn to finish before restoring changes.")
                                        : t("Restore all changes from this turn")}
                                onClick={() => postAction({ type: "restoreTurnChanges", turn: review.turn })}
                            >
                                {t("Restore")}
                            </button>
                        </div>
                        {review.error ? <div className="dsh-card-error">{review.error}</div> : null}
                        {review.files.map((file) => (
                            <button
                                type="button"
                                className="dsh-change-file"
                                key={file.id}
                                title={t("Open native diff for {path}", { path: file.path })}
                                onClick={() => postAction({
                                    type: "openChangeDiff",
                                    turn: review.turn,
                                    fileId: file.id,
                                })}
                            >
                                <span className={`dsh-change-status ${file.status}`}>
                                    {CHANGE_LABELS[file.status]}
                                </span>
                                <span className="dsh-change-path">
                                    {file.status === "renamed" && file.oldPath
                                        ? `${file.oldPath} → ${file.path}`
                                        : file.path}
                                </span>
                            </button>
                        ))}
                    </section>
                );
            })}
        </div>
    );
}

export function ActivityDock({ state }: { state: ChatViewState }): React.JSX.Element | null {
    const [active, setActive] = useState<DockTab | null>(null);

    const tabs: TabDef[] = [];
    if (state.goal) tabs.push({ id: "goal", label: "Goal" });
    if (state.queue.length) tabs.push({ id: "queue", label: t("Queue"), count: state.queue.length });
    if (state.changeReviews.length) {
        const count = state.changeReviews.reduce((total, review) => total + review.files.length, 0);
        tabs.push({ id: "changes", label: t("Changes"), count: count || undefined });
    }
    if (state.subagents && state.sessionId) {
        tabs.push({
            id: "subagents",
            label: t("Subagents"),
            count: state.subagents.nodes.length || undefined,
        });
    }
    if (state.jobs.length) tabs.push({ id: "jobs", label: "Jobs", count: state.jobs.length });
    if (state.permissions) tabs.push({ id: "permissions", label: t("Permissions") });

    const available = tabs.map((tab) => tab.id).join(",");
    useEffect(() => {
        if (active && !available.split(",").includes(active)) {
            setActive(null);
        }
    }, [available, active]);

    if (!tabs.length) return null;

    const preview =
        state.subagentPreview && state.subagentPreview.rootSessionId === state.sessionId
            ? state.subagentPreview
            : undefined;

    return (
        <div className="dsh-dock">
            <div className="dsh-dock-tabs" role="tablist">
                {tabs.map((tab) => (
                    <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={active === tab.id}
                        className={`dsh-dock-tab${active === tab.id ? " active" : ""}`}
                        onClick={() => setActive((current) => (current === tab.id ? null : tab.id))}
                    >
                        {tab.label}
                        {tab.count !== undefined ? (
                            <span className="dsh-badge">{tab.count}</span>
                        ) : null}
                    </button>
                ))}
            </div>
            {active ? (
                <div className="dsh-dock-panel" role="tabpanel">
                    {active === "goal" && state.goal ? <GoalPanel goal={state.goal} /> : null}
                    {active === "queue" ? (
                        <QueuePanel
                            queue={state.queue}
                            running={state.sessionStatus?.running === true}
                        />
                    ) : null}
                    {active === "changes" ? (
                        <ChangesPanel
                            reviews={state.changeReviews}
                            running={state.sessionStatus?.running === true}
                        />
                    ) : null}
                    {active === "subagents" && state.subagents ? (
                        <SubagentsPanel tree={state.subagents} preview={preview} />
                    ) : null}
                    {active === "jobs" ? <JobsPanel jobs={state.jobs} /> : null}
                    {active === "permissions" && state.permissions ? (
                        <PermissionsPanel permissions={state.permissions} />
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
