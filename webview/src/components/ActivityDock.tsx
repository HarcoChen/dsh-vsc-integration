import React, { useEffect, useState } from "react";
import type {
    ChatViewState,
    GoalHudView,
    SubagentHistoryPreview,
    SubagentTreeView,
} from "../../../src/types";
import { postAction } from "../bridge";
import { handleMarkdownClick, handleMarkdownKeydown } from "./MessageList";
import { MessageContent } from "./MessageItem";

type DockTab = "goal" | "queue" | "subagents" | "jobs" | "permissions";

interface TabDef {
    id: DockTab;
    label: string;
    count?: number;
}

function askGoalRounds(initialValue: number | undefined): { cancelled: true } | { value?: number } {
    const raw = window.prompt(
        "最大 Goal rounds（留空使用 Harness 默认值）",
        initialValue === undefined ? "" : String(initialValue),
    );
    if (raw === null) return { cancelled: true };
    if (!raw.trim()) return { value: undefined };
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
        window.alert("Goal rounds 必须是正整数。");
        return { cancelled: true };
    }
    return { value };
}

function GoalPanel({ goal }: { goal: GoalHudView }): React.JSX.Element {
    if (goal.state === "invalid") {
        return (
            <div className="dsh-card">
                <div className="dsh-card-error">{goal.error || "Goal projection 无效"}</div>
            </div>
        );
    }

    const create = (): void => {
        const objective = window.prompt("Goal objective", "");
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
                <div className="dsh-card-detail">当前会话尚未创建 Goal。</div>
                {goal.error ? <div className="dsh-card-error">{goal.error}</div> : null}
                <div className="dsh-card-actions">
                    <button
                        type="button"
                        className="dsh-button"
                        disabled={goal.pending}
                        onClick={create}
                    >
                        创建 Goal
                    </button>
                </div>
            </div>
        );
    }

    const current = goal.goal;
    if (!current) {
        return (
            <div className="dsh-card">
                <div className="dsh-card-error">Goal 数据缺失。</div>
            </div>
        );
    }

    const disabled = goal.pending === true;
    const canResume =
        (current.phase === "active" || current.phase === "paused" || current.phase === "blocked") &&
        Number(goal.roundsStarted || 0) < Number(current.maxGoalRounds || 0);

    const edit = (): void => {
        const objective = window.prompt("编辑 Goal objective", current.objective || "");
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
        if (action === "goalClear" && !window.confirm("清除当前 Goal？")) return;
        postAction({ type: action });
    };

    return (
        <div className="dsh-card">
            <div className="dsh-goal-objective">{current.objective}</div>
            <div className="dsh-card-detail">
                阶段 {current.phase} · revision {current.revision} · round {goal.roundsStarted || 0}/
                {current.maxGoalRounds}
            </div>
            {current.blockedReason ? (
                <div className="dsh-card-error">
                    {current.blockedReason.code} · {current.blockedReason.message}
                </div>
            ) : null}
            {goal.pending ? (
                <div className="dsh-card-detail">
                    正在执行 {goal.pendingOperation || "mutation"}，等待 projection 收敛…
                </div>
            ) : null}
            {goal.error ? <div className="dsh-card-error">{goal.error}</div> : null}
            <div className="dsh-card-actions">
                <button type="button" className="dsh-button" disabled={disabled} onClick={edit}>
                    编辑
                </button>
                {current.phase === "active" ? (
                    <button
                        type="button"
                        className="dsh-button dsh-button-secondary"
                        disabled={disabled}
                        onClick={simple("goalPause")}
                    >
                        暂停
                    </button>
                ) : null}
                {canResume ? (
                    <button
                        type="button"
                        className="dsh-button dsh-button-secondary"
                        disabled={disabled}
                        onClick={simple("goalResume")}
                    >
                        继续
                    </button>
                ) : null}
                {current.phase !== "complete" ? (
                    <button
                        type="button"
                        className="dsh-button dsh-button-secondary"
                        disabled={disabled}
                        onClick={simple("goalComplete")}
                    >
                        完成
                    </button>
                ) : (
                    <button type="button" className="dsh-button" disabled={disabled} onClick={create}>
                        新 Goal
                    </button>
                )}
                <button
                    type="button"
                    className="dsh-button dsh-button-secondary"
                    disabled={disabled}
                    onClick={simple("goalClear")}
                >
                    清除
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
            const text = window.prompt("编辑排队消息", editableText ?? "");
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
                        {item.preview || "（无文本内容）"}
                    </div>
                    <div className="dsh-queue-actions">
                        {item.editableText !== undefined ? (
                            <button
                                type="button"
                                className="dsh-button dsh-button-secondary"
                                onClick={() => act(item.id, "edit", item.editableText)}
                            >
                                编辑
                            </button>
                        ) : null}
                        <button
                            type="button"
                            className="dsh-button dsh-button-secondary"
                            onClick={() => act(item.id, "remove")}
                        >
                            移除
                        </button>
                        <button
                            type="button"
                            className="dsh-button dsh-button-secondary"
                            disabled={!running}
                            onClick={() => act(item.id, "steer")}
                        >
                            立即转向
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
                    关闭
                </button>
            </div>
            <div className="dsh-card-detail">
                {preview.mode} · {preview.activity} ·{" "}
                {preview.parentAvailable ? "parent available" : "parent unavailable"}
            </div>
            {preview.state === "loading" ? (
                <div className="dsh-card-detail">加载 history…</div>
            ) : null}
            {preview.error ? <div className="dsh-card-error">{preview.error}</div> : null}
            {preview.pendingAction ? (
                <div className="dsh-card-detail">正在执行 {preview.pendingAction}…</div>
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
                                      ? "你"
                                      : "系统"}
                            </div>
                            <MessageContent message={message} />
                        </div>
                    ))}
                </div>
            ) : null}
            {preview.mode === "continuable" ? (
                <div className="dsh-follow-up">
                    <input
                        placeholder="给 continuable subagent 追加任务"
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
                        发送
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
                        中断
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
            ? "加载中…"
            : tree.state === "error"
              ? tree.error || "加载失败"
              : tree.nodes.length
                ? ""
                : "暂无 subagent";
    return (
        <div>
            <div className="dsh-feature-head">
                <div className="dsh-dock-title">Subagent Tree</div>
                <button
                    type="button"
                    className="dsh-button dsh-button-secondary"
                    disabled={tree.state === "loading"}
                    onClick={() => postAction({ type: "refreshSubagents" })}
                >
                    刷新
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
                                    diagnostic · {node.reason || ""} · parent {node.parentSessionId}
                                </div>
                            </div>
                        </div>
                    );
                }
                const meta = [
                    node.mode,
                    node.activity,
                    node.hasChildren ? "has children" : "leaf",
                    node.parentAvailable ? "parent available" : "parent unavailable",
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
                                parent {node.parentSessionId}
                            </div>
                        </div>
                        <button
                            type="button"
                            className="dsh-button dsh-button-secondary"
                            onClick={() => postAction({ type: "openSubagent", childSessionId: node.id })}
                        >
                            历史
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
            <div className="dsh-card-detail">Job Center · 只读</div>
            {jobs.map((job) => (
                <div className="dsh-job-row" key={job.id}>
                    <div>{job.label}</div>
                    <div className="dsh-job-meta">
                        {job.kind} · {job.status} · owner {job.ownerSessionId}
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
            <div className="dsh-card-detail">当前 preset：{permissions.currentLabel}</div>
            {permissions.options.map((option) => (
                <div
                    className={`dsh-permission-option${
                        option.value === permissions.currentValue ? " active" : ""
                    }`}
                    key={option.value}
                >
                    <span>
                        {option.label}
                        {option.value === permissions.currentValue ? " · 当前" : ""}
                    </span>
                    {option.description ? (
                        <span className="dsh-card-detail">{option.description}</span>
                    ) : null}
                </div>
            ))}
            <div className="dsh-card-detail">权限切换由 Harness Web UI 的公开 command 负责。</div>
        </div>
    );
}

export function ActivityDock({ state }: { state: ChatViewState }): React.JSX.Element | null {
    const [active, setActive] = useState<DockTab | null>(null);

    const tabs: TabDef[] = [];
    if (state.goal) tabs.push({ id: "goal", label: "Goal" });
    if (state.queue.length) tabs.push({ id: "queue", label: "队列", count: state.queue.length });
    if (state.subagents && state.sessionId) {
        tabs.push({
            id: "subagents",
            label: "子代理",
            count: state.subagents.nodes.length || undefined,
        });
    }
    if (state.jobs.length) tabs.push({ id: "jobs", label: "Jobs", count: state.jobs.length });
    if (state.permissions) tabs.push({ id: "permissions", label: "权限" });

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
