import React, { useEffect, useState } from "react";
import type { ChatViewState, DshQuestionAnswerItem } from "../../../src/types";
import { postAction } from "../bridge";
import { t } from "../i18n";
import { interactionStatusText } from "../state";

type Interaction = ChatViewState["interactions"][number];

interface CardProps {
    interaction: Interaction;
}

function useSubmitted(interaction: Interaction): [boolean, () => void] {
    const [submitted, setSubmitted] = useState(false);
    useEffect(() => {
        if (interaction.status === "pending") setSubmitted(false);
    }, [interaction.status, interaction.error]);
    return [submitted, () => setSubmitted(true)];
}

function StatusLines({ interaction }: CardProps): React.JSX.Element | null {
    const text = interactionStatusText(interaction.status, interaction.outcome);
    return (
        <>
            {text ? <div className="dsh-card-detail">{text}</div> : null}
            {interaction.error ? <div className="dsh-card-error">{interaction.error}</div> : null}
        </>
    );
}

function ApprovalCard({ interaction }: CardProps): React.JSX.Element {
    const [submitted, markSubmitted] = useSubmitted(interaction);
    const disabled = submitted || interaction.status !== "pending";
    const answer = (outcome: "allowed-once" | "rejected"): void => {
        markSubmitted();
        postAction({ type: "answerApproval", key: interaction.key, outcome });
    };
    return (
        <div className="dsh-card dsh-interaction">
            <div className="dsh-card-title">{t("Approval required: {tool}", { tool: interaction.toolName || t("Tool call") })}</div>
            {interaction.reason ? <div className="dsh-card-detail">{interaction.reason}</div> : null}
            <StatusLines interaction={interaction} />
            <div className="dsh-card-actions">
                <button
                    type="button"
                    className="dsh-button"
                    disabled={disabled}
                    onClick={() => answer("allowed-once")}
                >
                    {t("Allow once")}
                </button>
                <button
                    type="button"
                    className="dsh-button dsh-button-secondary"
                    disabled={disabled}
                    onClick={() => answer("rejected")}
                >
                    {t("Reject")}
                </button>
            </div>
        </div>
    );
}

function PlanReviewCard({ interaction }: CardProps): React.JSX.Element {
    const [submitted, markSubmitted] = useSubmitted(interaction);
    const [feedback, setFeedback] = useState("");
    const disabled = submitted || interaction.status !== "pending";
    const review = interaction.review;

    if (!review) {
        return (
            <div className="dsh-card dsh-interaction dsh-plan-review">
                <div className="dsh-card-title">{t("Plan review")}</div>
                <div className="dsh-card-error">{t("Plan data is missing.")}</div>
            </div>
        );
    }

    const answer = (approve: boolean): void => {
        const selected = approve ? [review.approve] : review.decline ? [review.decline] : [];
        const custom = approve ? undefined : feedback.trim() || undefined;
        markSubmitted();
        postAction({
            type: "answerQuestion",
            key: interaction.key,
            answers: [
                {
                    id: review.id,
                    selected,
                    ...(custom === undefined ? {} : { custom }),
                },
            ],
        });
    };

    return (
        <div className="dsh-card dsh-interaction dsh-plan-review">
            <div className="dsh-card-title">{t("Plan review")}</div>
            <div
                className="dsh-plan-review-body dsh-message-body"
                {...(typeof interaction.planHtml === "string"
                    ? { dangerouslySetInnerHTML: { __html: interaction.planHtml } }
                    : { children: <p>{review.plan}</p> })}
            />
            <textarea
                className="dsh-plan-feedback"
                placeholder={t("Provide feedback and continue planning")}
                value={feedback}
                disabled={disabled}
                onChange={(event) => setFeedback(event.target.value)}
            />
            <StatusLines interaction={interaction} />
            <div className="dsh-card-actions">
                <button
                    type="button"
                    className="dsh-button dsh-button-secondary"
                    disabled={disabled}
                    onClick={() => answer(false)}
                >
                    {t("Continue planning")}
                </button>
                <button
                    type="button"
                    className="dsh-button"
                    disabled={disabled}
                    onClick={() => answer(true)}
                >
                    {t("Approve plan")}
                </button>
            </div>
        </div>
    );
}

function QuestionCard({ interaction }: CardProps): React.JSX.Element {
    const [submitted, markSubmitted] = useSubmitted(interaction);
    const [selections, setSelections] = useState<Record<string, string[]>>({});
    const [customs, setCustoms] = useState<Record<string, string>>({});
    const disabled = submitted || interaction.status !== "pending";
    const questions = interaction.questions ?? [];

    const toggle = (questionId: string, label: string, multi: boolean, checked: boolean): void => {
        setSelections((current) => {
            const previous = current[questionId] ?? [];
            const next = multi
                ? checked
                    ? [...previous, label]
                    : previous.filter((item) => item !== label)
                : checked
                  ? [label]
                  : [];
            return { ...current, [questionId]: next };
        });
    };

    const submit = (): void => {
        const answers: DshQuestionAnswerItem[] = questions.map((question) => {
            const custom = customs[question.id];
            return {
                id: question.id,
                selected: selections[question.id] ?? [],
                ...(custom ? { custom } : {}),
            };
        });
        markSubmitted();
        postAction({ type: "answerQuestion", key: interaction.key, answers });
    };

    return (
        <div className="dsh-card dsh-interaction">
            <div className="dsh-card-title">{t("dsh needs your answer")}</div>
            {questions.map((question) => {
                const options = question.options ?? [];
                const selected = selections[question.id] ?? [];
                return (
                    <div className="dsh-question" key={question.id}>
                        <div className="dsh-question-title">
                            {question.header || question.question}
                        </div>
                        {question.detail ? (
                            <div className="dsh-card-detail">{question.detail}</div>
                        ) : null}
                        {options.map((option) => (
                            <label className="dsh-option" key={option.label}>
                                <input
                                    type={question.multiSelect ? "checkbox" : "radio"}
                                    name={`${interaction.key}:${question.id}`}
                                    value={option.label}
                                    checked={selected.includes(option.label)}
                                    disabled={disabled}
                                    onChange={(event) =>
                                        toggle(
                                            question.id,
                                            option.label,
                                            question.multiSelect === true,
                                            event.target.checked,
                                        )
                                    }
                                />{" "}
                                {option.label}
                                {option.description ? ` — ${option.description}` : ""}
                            </label>
                        ))}
                        <input
                            className="dsh-custom-answer"
                            placeholder={options.length ? t("Other answer (optional)") : t("Enter an answer")}
                            value={customs[question.id] ?? ""}
                            disabled={disabled}
                            onChange={(event) =>
                                setCustoms((current) => ({
                                    ...current,
                                    [question.id]: event.target.value,
                                }))
                            }
                        />
                    </div>
                );
            })}
            <StatusLines interaction={interaction} />
            <div className="dsh-card-actions">
                <button
                    type="button"
                    className="dsh-button"
                    disabled={disabled}
                    onClick={submit}
                >
                    {t("Submit answer")}
                </button>
            </div>
        </div>
    );
}

export function Interactions({
    interactions,
}: {
    interactions: Interaction[];
}): React.JSX.Element | null {
    if (!interactions.length) return null;
    return (
        <div className="dsh-interactions">
            {interactions.map((interaction) => {
                if (interaction.kind === "approval") {
                    return <ApprovalCard key={interaction.key} interaction={interaction} />;
                }
                if (interaction.kind === "plan-review") {
                    return <PlanReviewCard key={interaction.key} interaction={interaction} />;
                }
                return <QuestionCard key={interaction.key} interaction={interaction} />;
            })}
        </div>
    );
}
