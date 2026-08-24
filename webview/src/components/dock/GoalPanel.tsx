import React, { useState } from "react";
import {
    GOAL_ACTIONS_BY_PHASE,
    goalActionAllowed,
    type GoalAction,
} from "../../../../src/goalActions";
import type { GoalHudView } from "../../../../src/types";
import { postAction } from "../../bridge";
import { t } from "../../i18n";
import { CloseIcon } from "../icons";

const GOAL_PHASE_LABELS: Readonly<Record<NonNullable<GoalHudView["goal"]>["phase"], string>> = {
    active: "In progress",
    paused: "Paused",
    blocked: "Blocked",
    complete: "Completed",
};

function GoalError({ error }: { error: string }): React.JSX.Element {
    const [summary, ...detailLines] = error.split("\n");
    const detail = detailLines.join("\n").trim();
    return (
        <div className="dsh-goal-error">
            <div className="dsh-card-error" title={detail || undefined}>{summary || error}</div>
            {detail ? (
                <details className="dsh-goal-error-detail">
                    <summary>{t("Technical details")}</summary>
                    <pre>{detail}</pre>
                </details>
            ) : null}
        </div>
    );
}

interface GoalDraft {
    mode: "create" | "edit";
    objective: string;
    rounds: string;
    error?: string;
}

function GoalDraftForm({
    draft,
    pending,
    onChange,
    onCancel,
    onSubmit,
}: {
    draft: GoalDraft;
    pending: boolean;
    onChange: (draft: GoalDraft) => void;
    onCancel: () => void;
    onSubmit: () => void;
}): React.JSX.Element {
    const onKeyDown = (event: React.KeyboardEvent): void => {
        if (event.key === "Enter") {
            event.preventDefault();
            onSubmit();
        } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
        }
    };
    return (
        <div className="dsh-dock-form">
            <input
                className="dsh-dock-input"
                placeholder={draft.mode === "create" ? t("Goal objective") : t("Edit Goal objective")}
                value={draft.objective}
                autoFocus
                onChange={(event) => onChange({ ...draft, objective: event.target.value })}
                onKeyDown={onKeyDown}
            />
            <input
                className="dsh-dock-input"
                inputMode="numeric"
                placeholder={t("Maximum Goal rounds (leave empty for the Harness default)")}
                value={draft.rounds}
                onChange={(event) => onChange({ ...draft, rounds: event.target.value })}
                onKeyDown={onKeyDown}
            />
            {draft.error ? <div className="dsh-card-error">{draft.error}</div> : null}
            <div className="dsh-card-actions">
                <button
                    type="button"
                    className="dsh-button"
                    disabled={pending || !draft.objective.trim()}
                    onClick={onSubmit}
                >
                    {t("Confirm")}
                </button>
                <button type="button" className="dsh-button dsh-button-secondary" onClick={onCancel}>
                    {t("Cancel")}
                </button>
            </div>
        </div>
    );
}

export function GoalPanel({ goal }: { goal: GoalHudView }): React.JSX.Element {
    const [draft, setDraft] = useState<GoalDraft | null>(null);
    const [confirmingClear, setConfirmingClear] = useState(false);

    const submitDraft = (): void => {
        if (!draft) return;
        const objective = draft.objective.trim();
        if (!objective) return;
        let maxGoalRounds: number | undefined;
        if (draft.rounds.trim()) {
            const value = Number(draft.rounds);
            if (!Number.isSafeInteger(value) || value <= 0) {
                setDraft({ ...draft, error: t("Goal rounds must be a positive integer.") });
                return;
            }
            maxGoalRounds = value;
        }
        setDraft(null);
        postAction({
            type: draft.mode === "create" ? "goalCreate" : "goalEdit",
            objective,
            ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }),
        });
    };

    if (goal.state === "invalid") {
        return (
            <div className="dsh-card">
                <GoalError error={goal.error || t("Invalid Goal projection")} />
            </div>
        );
    }

    const create = (): void => {
        setConfirmingClear(false);
        setDraft({ mode: "create", objective: "", rounds: "" });
    };

    if (goal.state === "empty") {
        return (
            <div className="dsh-card">
                <div className="dsh-card-detail">{t("This session has no Goal yet.")}</div>
                {goal.error ? <GoalError error={goal.error} /> : null}
                {draft ? (
                    <GoalDraftForm
                        draft={draft}
                        pending={goal.pending === true}
                        onChange={setDraft}
                        onCancel={() => setDraft(null)}
                        onSubmit={submitDraft}
                    />
                ) : (
                    <div className="dsh-card-actions">
                        <button type="button" className="dsh-button" disabled={goal.pending} onClick={create}>
                            {t("Create Goal")}
                        </button>
                    </div>
                )}
            </div>
        );
    }

    const current = goal.goal;
    if (!current) {
        return <div className="dsh-card"><div className="dsh-card-error">{t("Goal data is missing.")}</div></div>;
    }

    const disabled = goal.pending === true;
    const roundsStarted = Number(goal.roundsStarted || 0);
    const availableActions = GOAL_ACTIONS_BY_PHASE[current.phase];
    const canAction = (action: GoalAction): boolean =>
        availableActions.includes(action) &&
        goalActionAllowed(current.phase, action, roundsStarted, current.maxGoalRounds);
    const canResume = canAction("resume");
    const edit = (): void => {
        setConfirmingClear(false);
        setDraft({ mode: "edit", objective: current.objective || "", rounds: String(current.maxGoalRounds) });
    };
    const simple = (action: "goalPause" | "goalResume" | "goalComplete" | "goalClear") => (): void => {
        if (action === "goalClear") {
            setDraft(null);
            setConfirmingClear(true);
            return;
        }
        postAction({ type: action });
    };

    return (
        <div className="dsh-card">
            <div
                className="dsh-goal-objective"
                title={t("Goal revision {revision}", { revision: current.revision })}
            >
                {current.objective}
            </div>
            <div className="dsh-card-detail">
                {t("{phase} · round {started}/{maximum}", {
                    phase: t(GOAL_PHASE_LABELS[current.phase]),
                    started: roundsStarted,
                    maximum: current.maxGoalRounds,
                })}
            </div>
            {current.blockedReason ? (
                <div className="dsh-goal-blocked" role="status">
                    <strong>{t("Blocked")}</strong>
                    <span>{current.blockedReason.code} · {current.blockedReason.message}</span>
                </div>
            ) : null}
            {goal.pending ? (
                <div className="dsh-card-detail">
                    {t("Running {operation}; waiting for the projection to converge...", {
                        operation: goal.pendingOperation || t("mutation"),
                    })}
                </div>
            ) : null}
            {goal.error ? <GoalError error={goal.error} /> : null}
            {draft ? (
                <GoalDraftForm
                    draft={draft}
                    pending={disabled}
                    onChange={setDraft}
                    onCancel={() => setDraft(null)}
                    onSubmit={submitDraft}
                />
            ) : confirmingClear ? (
                <div className="dsh-dock-confirm">
                    <span>{t("Clear the current Goal?")}</span>
                    <button
                        type="button"
                        className="dsh-button"
                        disabled={disabled}
                        onClick={() => {
                            setConfirmingClear(false);
                            postAction({ type: "goalClear" });
                        }}
                    >
                        {t("Confirm")}
                    </button>
                    <button
                        type="button"
                        className="dsh-button dsh-button-secondary"
                        onClick={() => setConfirmingClear(false)}
                    >
                        {t("Cancel")}
                    </button>
                </div>
            ) : (
                <div className="dsh-goal-actions">
                    <div className="dsh-card-actions">
                        {canAction("pause") ? (
                            <button type="button" className="dsh-button" disabled={disabled} onClick={simple("goalPause")}>{t("Pause")}</button>
                        ) : null}
                        {canResume ? (
                            <button type="button" className="dsh-button" disabled={disabled} onClick={simple("goalResume")}>{t("Resume")}</button>
                        ) : null}
                        {canAction("complete") ? (
                            <button type="button" className="dsh-button" disabled={disabled} onClick={simple("goalComplete")}>{t("Complete")}</button>
                        ) : null}
                        {canAction("edit") ? (
                            <button type="button" className="dsh-button dsh-button-secondary" disabled={disabled} onClick={edit}>{t("Edit")}</button>
                        ) : null}
                        {canAction("create") ? (
                            <button type="button" className="dsh-button" disabled={disabled} onClick={create}>{t("New Goal")}</button>
                        ) : null}
                    </div>
                    {canAction("clear") ? (
                        <button
                            type="button"
                            className="dsh-icon-button dsh-goal-clear"
                            aria-label={t("Clear")}
                            title={t("Clear")}
                            disabled={disabled}
                            onClick={simple("goalClear")}
                        >
                            <CloseIcon />
                        </button>
                    ) : null}
                </div>
            )}
        </div>
    );
}
