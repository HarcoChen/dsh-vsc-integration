import React, { useState } from "react";
import type { GoalHudView } from "../../../../src/types";
import { postAction } from "../../bridge";
import { t } from "../../i18n";

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
                <div className="dsh-card-error">{goal.error || t("Invalid Goal projection")}</div>
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
                {goal.error ? <div className="dsh-card-error">{goal.error}</div> : null}
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
    const canResume =
        (current.phase === "active" || current.phase === "paused" || current.phase === "blocked") &&
        Number(goal.roundsStarted || 0) < Number(current.maxGoalRounds || 0);
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
                <div className="dsh-card-actions">
                    <button type="button" className="dsh-button" disabled={disabled} onClick={edit}>{t("Edit")}</button>
                    {current.phase === "active" ? (
                        <button type="button" className="dsh-button dsh-button-secondary" disabled={disabled} onClick={simple("goalPause")}>{t("Pause")}</button>
                    ) : null}
                    {canResume ? (
                        <button type="button" className="dsh-button dsh-button-secondary" disabled={disabled} onClick={simple("goalResume")}>{t("Resume")}</button>
                    ) : null}
                    {current.phase !== "complete" ? (
                        <button type="button" className="dsh-button dsh-button-secondary" disabled={disabled} onClick={simple("goalComplete")}>{t("Complete")}</button>
                    ) : (
                        <button type="button" className="dsh-button" disabled={disabled} onClick={create}>{t("New Goal")}</button>
                    )}
                    <button type="button" className="dsh-button dsh-button-secondary" disabled={disabled} onClick={simple("goalClear")}>{t("Clear")}</button>
                </div>
            )}
        </div>
    );
}
