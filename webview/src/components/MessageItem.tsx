import React, { useEffect, useId, useRef, useState } from "react";
import type {
    ChatMessage,
    ChatMessageFeedbackView,
    DshFeedbackCategory,
    DshMessageFeedbackRating,
} from "../../../src/types";
import { postAction } from "../bridge";
import { t } from "../i18n";
import { ROLE_LABELS } from "../state";
import { MessageContent } from "./MessageContent";
import { CheckIcon, CloseIcon, CopyIcon, DislikeIcon, LikeIcon, MoreIcon } from "./icons";

export { MessageContent } from "./MessageContent";

interface MessageItemProps {
    message: ChatMessage;
    submitting: boolean;
    agentStatusLabel?: string;
    autoOpenReasoning?: boolean;
}

type CheckpointAction =
    | "forkFromMessage"
    | "restoreCodeToMessage"
    | "forkAndRestoreCodeToMessage";

const MESSAGE_FEEDBACK_CATEGORIES: readonly DshFeedbackCategory[] = [
    "task-result",
    "instruction-following",
    "product-interaction",
    "service-stability",
    "resource-cost",
    "security-privacy-permission",
    "other",
];

const MESSAGE_FEEDBACK_CATEGORY_LABELS: Readonly<Record<DshFeedbackCategory, string>> = {
    "task-result": "Task result",
    "instruction-following": "Instruction following",
    "product-interaction": "Product interaction",
    "service-stability": "Service stability",
    "resource-cost": "Resource cost",
    "security-privacy-permission": "Security, privacy, or permissions",
    other: "Other",
};

function canCopyMessage(message: ChatMessage): boolean {
    return (
        (message.role === "user" || message.role === "assistant") &&
        (message.text.trim().length > 0 || Boolean(message.skillInvocation))
    );
}

function MessageCopyButton({ message }: { message: ChatMessage }): React.JSX.Element | null {
    const [copied, setCopied] = useState(false);
    const resetTimerRef = useRef<number>();

    useEffect(() => () => {
        if (resetTimerRef.current !== undefined) window.clearTimeout(resetTimerRef.current);
    }, []);

    if (!canCopyMessage(message)) return null;

    const copy = (): void => {
        postAction({ type: "copyMessage", messageId: message.id });
        setCopied(true);
        if (resetTimerRef.current !== undefined) window.clearTimeout(resetTimerRef.current);
        resetTimerRef.current = window.setTimeout(() => setCopied(false), 1_500);
    };

    return (
        <button
            type="button"
            className="dsh-message-action-trigger dsh-icon-button"
            aria-label={copied ? t("Copied") : t("Copy message")}
            title={copied ? t("Copied") : t("Copy message")}
            onClick={(event) => {
                event.stopPropagation();
                copy();
            }}
        >
            {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
    );
}

function MessageActions({
    checkpointSeq,
}: {
    checkpointSeq?: number;
}): React.JSX.Element | null {
    const [open, setOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: MouseEvent): void => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("mousedown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [open]);

    const run = (type: CheckpointAction): void => {
        if (checkpointSeq === undefined) return;
        postAction({ type, seq: checkpointSeq });
        setOpen(false);
    };

    if (checkpointSeq === undefined) return null;

    return (
        <div className={`dsh-message-actions${open ? " open" : ""}`} ref={menuRef}>
            <button
                type="button"
                className="dsh-message-action-trigger dsh-icon-button"
                aria-label={t("Message actions")}
                aria-expanded={open}
                title={t("Message actions")}
                onClick={(event) => {
                    event.stopPropagation();
                    setOpen((current) => !current);
                }}
            >
                <MoreIcon />
            </button>
            {open ? (
                <div className="dsh-message-action-menu">
                    <button type="button" onClick={(event) => { event.stopPropagation(); run("forkFromMessage"); }}>
                        {t("Fork from here")}
                    </button>
                    <button type="button" onClick={(event) => { event.stopPropagation(); run("restoreCodeToMessage"); }}>
                        {t("Restore code to here")}
                    </button>
                    <button type="button" onClick={(event) => { event.stopPropagation(); run("forkAndRestoreCodeToMessage"); }}>
                        {t("Fork + restore code")}
                    </button>
                </div>
            ) : null}
        </div>
    );
}

function MessageFeedbackActions({
    messageId,
    feedback,
}: {
    messageId: string;
    feedback: ChatMessageFeedbackView;
}): React.JSX.Element {
    const [dialog, setDialog] = useState<{
        rating: DshMessageFeedbackRating;
        category?: DshFeedbackCategory;
        note: string;
    }>();
    const [submitting, setSubmitting] = useState(false);
    const [pendingObserved, setPendingObserved] = useState(false);
    const [toast, setToast] = useState(false);
    const toastTimerRef = useRef<number>();
    const dialogTitleId = useId();
    const hasRating = feedback.rating !== undefined;
    const pending = Boolean(feedback.pending);
    const disabled = pending || feedback.status === "loading" || submitting;

    useEffect(() => {
        return () => {
            if (toastTimerRef.current !== undefined) window.clearTimeout(toastTimerRef.current);
        };
    }, []);

    useEffect(() => {
        if (!dialog || !submitting) return;
        if (pending) {
            setPendingObserved(true);
            return;
        }
        if (!pendingObserved) return;
        if (feedback.error) {
            setSubmitting(false);
            setPendingObserved(false);
            return;
        }
        if (feedback.rating !== dialog.rating) return;
        setDialog(undefined);
        setSubmitting(false);
        setPendingObserved(false);
        setToast(true);
        if (toastTimerRef.current !== undefined) window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = window.setTimeout(() => setToast(false), 2_500);
    }, [dialog, feedback.error, feedback.rating, pending, pendingObserved, submitting]);

    useEffect(() => {
        if (!dialog) return;
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape" && !submitting) setDialog(undefined);
        };
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [dialog, submitting]);

    const toggle = (rating: DshMessageFeedbackRating): void => {
        if (disabled) return;
        if (feedback.rating === rating) {
            postAction({ type: "toggleMessageFeedback", messageId, rating });
            return;
        }
        setDialog({ rating, note: "" });
        setSubmitting(false);
        setPendingObserved(false);
    };

    const submit = (): void => {
        if (!dialog || submitting) return;
        setSubmitting(true);
        setPendingObserved(false);
        const note = dialog.note.trim();
        postAction({
            type: "submitMessageFeedback",
            messageId,
            rating: dialog.rating,
            ...(note.length === 0 ? {} : { note }),
            ...(dialog.category === undefined ? {} : { category: dialog.category }),
        });
    };

    const selected = feedback.rating;
    const hasVisibleFeedback = hasRating || Boolean(feedback.error) || dialog !== undefined || toast;
    return (
        <>
            <div className={`dsh-message-feedback${hasVisibleFeedback ? " has-feedback" : ""}${dialog ? " open" : ""}`}>
                <button
                    type="button"
                    className={`dsh-message-feedback-button${selected === "positive" ? " active" : ""}`}
                    aria-label={t(selected === "positive" ? "Like (selected)" : "Like")}
                    aria-pressed={selected === "positive"}
                    aria-haspopup="dialog"
                    title={t(selected === "positive" ? "Like (selected)" : "Like")}
                    disabled={disabled}
                    onClick={(event) => {
                        event.stopPropagation();
                        toggle("positive");
                    }}
                >
                    <LikeIcon />
                </button>
                <button
                    type="button"
                    className={`dsh-message-feedback-button${selected === "negative" ? " active" : ""}`}
                    aria-label={t(selected === "negative" ? "Dislike (selected)" : "Dislike")}
                    aria-pressed={selected === "negative"}
                    aria-haspopup="dialog"
                    title={t(selected === "negative" ? "Dislike (selected)" : "Dislike")}
                    disabled={disabled}
                    onClick={(event) => {
                        event.stopPropagation();
                        toggle("negative");
                    }}
                >
                    <DislikeIcon />
                </button>
                {!dialog && feedback.error ? (
                    <span className="dsh-feedback-error" role="status">
                        {feedback.error}
                    </span>
                ) : null}
            </div>
            {dialog ? (
                <div
                    className="dsh-session-feedback-backdrop"
                    role="presentation"
                    onMouseDown={(event) => {
                        if (event.target === event.currentTarget && !submitting) setDialog(undefined);
                    }}
                >
                    <section
                        className="dsh-session-feedback-dialog"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby={dialogTitleId}
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <div className="dsh-session-feedback-head">
                            <div>
                                <h2 id={dialogTitleId}>{t("Submit feedback")}</h2>
                                <p>{t("Your feedback helps us improve this response.")}</p>
                            </div>
                            <button
                                type="button"
                                className="dsh-icon-button"
                                aria-label={t("Close")}
                                title={t("Close")}
                                disabled={submitting}
                                onClick={() => setDialog(undefined)}
                            >
                                <CloseIcon />
                            </button>
                        </div>
                        <fieldset className="dsh-session-feedback-categories" disabled={submitting}>
                            <legend>{t("Feedback category")}</legend>
                            {MESSAGE_FEEDBACK_CATEGORIES.map((category) => (
                                <button
                                    key={category}
                                    type="button"
                                    className={`dsh-session-feedback-category${dialog.category === category ? " active" : ""}`}
                                    aria-pressed={dialog.category === category}
                                    onClick={() => setDialog((current) => current && {
                                        ...current,
                                        ...(current.category === category ? { category: undefined } : { category }),
                                    })}
                                >
                                    {t(MESSAGE_FEEDBACK_CATEGORY_LABELS[category])}
                                </button>
                            ))}
                        </fieldset>
                        <label className="dsh-session-feedback-label" htmlFor={dialogTitleId + "-detail"}>
                            {t("Feedback details")}
                        </label>
                        <textarea
                            id={dialogTitleId + "-detail"}
                            className="dsh-session-feedback-textarea"
                            value={dialog.note}
                            maxLength={32_768}
                            disabled={submitting}
                            placeholder={t("Add details about this response.")}
                            onChange={(event) => setDialog((current) => current && {
                                ...current,
                                note: event.target.value,
                            })}
                        />
                        {feedback.error ? (
                            <div className="dsh-session-feedback-error" role="alert">{feedback.error}</div>
                        ) : null}
                        <div className="dsh-session-feedback-actions">
                            <button
                                type="button"
                                className="dsh-button dsh-button-secondary"
                                disabled={submitting}
                                onClick={() => setDialog(undefined)}
                            >
                                {t("Cancel")}
                            </button>
                            <button type="button" className="dsh-button" disabled={submitting} onClick={submit}>
                                {submitting ? t("Submitting...") : t("Submit feedback")}
                            </button>
                        </div>
                    </section>
                </div>
            ) : null}
            {toast ? (
                <div className="dsh-session-feedback-toast" role="status" aria-live="polite">
                    {t("Thanks for your feedback")}
                </div>
            ) : null}
        </>
    );
}

function MessageFooterActions({
    message,
    traceSeq,
}: {
    message: ChatMessage;
    traceSeq?: number;
}): React.JSX.Element | null {
    if (traceSeq === undefined && !canCopyMessage(message)) return null;
    return (
        <div className="dsh-message-footer-actions">
            {traceSeq === undefined ? null : (
                <button
                    type="button"
                    className="dsh-message-trace"
                    data-trace-seq={traceSeq}
                    title={t("Locate in Trace")}
                >
                    trace
                </button>
            )}
            <MessageCopyButton message={message} />
        </div>
    );
}

export const MessageItem = React.memo(function MessageItem({
    message,
    submitting,
    agentStatusLabel,
    autoOpenReasoning,
}: MessageItemProps): React.JSX.Element {
    const stateClass =
        message.state === "streaming"
            ? " dsh-streaming"
            : message.state === "pending"
              ? " dsh-pending"
              : "";
    const stateLabel =
        message.state === "pending"
            ? t(" · waiting for response")
            : message.state === "streaming" && message.role === "assistant"
              ? ` · ${agentStatusLabel ?? t("Thinking...")}`
              : message.state === "streaming"
                ? t(" · streaming")
              : "";
    const hasTrace = Number.isSafeInteger(message.seq) && (message.seq ?? -1) >= 0;
    const checkpointSeq =
        (message.role === "user" || message.role === "assistant") &&
        message.state !== "streaming" &&
        message.state !== "pending" &&
        typeof message.seq === "number" &&
        Number.isSafeInteger(message.seq) &&
        message.seq >= 0
            ? message.seq
            : undefined;
    const feedbackTarget =
        message.role === "assistant" &&
        message.state === "committed" &&
        message.messageId &&
        message.feedback
            ? message.messageId
            : undefined;
    return (
        <div
            className={`dsh-message dsh-role-${message.role}${stateClass}`}
            {...(typeof message.renderId === "string"
                ? { "data-render-id": message.renderId }
                : {})}
            {...(Number.isSafeInteger(message.seq) ? { "data-message-seq": message.seq } : {})}
        >
            <div className="dsh-message-label">
                {ROLE_LABELS[message.role]}
                {stateLabel}
                <MessageActions checkpointSeq={checkpointSeq} />
            </div>
            <MessageContent
                message={message}
                agentStatusLabel={agentStatusLabel}
                autoOpenReasoning={autoOpenReasoning}
            />
            {feedbackTarget && message.feedback ? (
                <div className="dsh-message-feedback-row">
                    <MessageFeedbackActions messageId={feedbackTarget} feedback={message.feedback} />
                </div>
            ) : null}
            <MessageFooterActions message={message} traceSeq={hasTrace ? message.seq : undefined} />
            {message.state === "failed" ? (
                <button
                    type="button"
                    className="dsh-message-retry dsh-button-secondary"
                    data-retry-id={message.id}
                    disabled={submitting}
                >
                    {t("Retry")}
                </button>
            ) : null}
        </div>
    );
});
