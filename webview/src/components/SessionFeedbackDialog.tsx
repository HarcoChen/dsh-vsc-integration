import React, { useEffect, useState } from "react";
import type { DshFeedbackCategory, DshSessionFeedbackStateView } from "../../../src/types";
import { postAction } from "../bridge";
import { t } from "../i18n";
import { CloseIcon } from "./icons";

const CATEGORIES: readonly DshFeedbackCategory[] = [
    "task-result",
    "instruction-following",
    "product-interaction",
    "service-stability",
    "resource-cost",
    "security-privacy-permission",
    "other",
];

const CATEGORY_LABELS: Readonly<Record<DshFeedbackCategory, string>> = {
    "task-result": "Task result",
    "instruction-following": "Instruction following",
    "product-interaction": "Product interaction",
    "service-stability": "Service stability",
    "resource-cost": "Resource cost",
    "security-privacy-permission": "Security, privacy, or permissions",
    other: "Other",
};

export function SessionFeedbackDialog({
    feedback,
}: {
    feedback?: DshSessionFeedbackStateView;
}): React.JSX.Element | null {
    const [category, setCategory] = useState<DshFeedbackCategory>();
    const [text, setText] = useState("");
    const [draftSequence, setDraftSequence] = useState<number>();
    const open = feedback?.open === true;
    const submitting = feedback?.status === "submitting";

    useEffect(() => {
        if (feedback?.sequence === undefined || feedback.sequence === draftSequence) return;
        setCategory(undefined);
        setText("");
        setDraftSequence(feedback.sequence);
    }, [draftSequence, feedback?.sequence]);

    useEffect(() => {
        if (!open) return;
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape" && !submitting) postAction({ type: "dismissSessionFeedback" });
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [open, submitting]);

    if (!feedback) return null;

    if (!open) {
        return feedback.status === "success" || feedback.status === "unavailable"
            ? (
                <div className="dsh-session-feedback-toast" role="status" aria-live="polite">
                    {feedback.status === "success"
                        ? t("Thanks for your feedback")
                        : feedback.error || t("Session feedback is unavailable in this Runtime.")}
                </div>
            )
            : null;
    }

    const submit = (): void => {
        if (submitting) return;
        postAction({
            type: "recordSessionFeedback",
            text,
            ...(category === undefined ? {} : { category }),
        });
    };

    return (
        <div
            className="dsh-session-feedback-backdrop"
            role="presentation"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget && !submitting) {
                    postAction({ type: "dismissSessionFeedback" });
                }
            }}
        >
            <section
                className="dsh-session-feedback-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="dsh-session-feedback-title"
            >
                <div className="dsh-session-feedback-head">
                    <div>
                        <h2 id="dsh-session-feedback-title">{t("Submit feedback")}</h2>
                        <p>{t("Your feedback helps us improve this Session.")}</p>
                    </div>
                    <button
                        type="button"
                        className="dsh-icon-button"
                        aria-label={t("Close")}
                        title={t("Close")}
                        disabled={submitting}
                        onClick={() => postAction({ type: "dismissSessionFeedback" })}
                    >
                        <CloseIcon />
                    </button>
                </div>
                <fieldset className="dsh-session-feedback-categories" disabled={submitting}>
                    <legend>{t("Feedback category")}</legend>
                    {CATEGORIES.map((item) => (
                        <button
                            key={item}
                            type="button"
                            className={`dsh-session-feedback-category${category === item ? " active" : ""}`}
                            aria-pressed={category === item}
                            onClick={() => setCategory((current) => current === item ? undefined : item)}
                        >
                            {t(CATEGORY_LABELS[item])}
                        </button>
                    ))}
                </fieldset>
                <label className="dsh-session-feedback-label" htmlFor="dsh-session-feedback-text">
                    {t("Feedback details")}
                </label>
                <textarea
                    id="dsh-session-feedback-text"
                    className="dsh-session-feedback-textarea"
                    value={text}
                    maxLength={32_768}
                    disabled={submitting}
                    placeholder={t("Add details to help us improve. Your submission will include the current conversation log.")}
                    onChange={(event) => setText(event.target.value)}
                />
                {feedback.status === "error" && feedback.error ? (
                    <div className="dsh-session-feedback-error" role="alert">{feedback.error}</div>
                ) : null}
                <div className="dsh-session-feedback-actions">
                    <button
                        type="button"
                        className="dsh-button dsh-button-secondary"
                        disabled={submitting}
                        onClick={() => postAction({ type: "dismissSessionFeedback" })}
                    >
                        {t("Cancel")}
                    </button>
                    <button type="button" className="dsh-button" disabled={submitting} onClick={submit}>
                        {submitting ? t("Submitting...") : t("Submit feedback")}
                    </button>
                </div>
            </section>
        </div>
    );
}
