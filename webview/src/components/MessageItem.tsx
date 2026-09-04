import React, { useEffect, useRef, useState } from "react";
import type {
    ChatMessage,
    ChatMessageFeedbackView,
    DshMessageFeedbackRating,
} from "../../../src/types";
import { postAction } from "../bridge";
import { t } from "../i18n";
import { ROLE_LABELS } from "../state";
import { MessageContent } from "./MessageContent";
import { DislikeIcon, LikeIcon, MoreIcon } from "./icons";

export { MessageContent } from "./MessageContent";

interface MessageItemProps {
    message: ChatMessage;
    submitting: boolean;
    agentStatusLabel?: string;
}

function MessageFeedbackActions({
    messageId,
    feedback,
}: {
    messageId: string;
    feedback: ChatMessageFeedbackView;
}): React.JSX.Element {
    const [noteOpen, setNoteOpen] = useState(false);
    const [draft, setDraft] = useState("");
    const feedbackRef = useRef<HTMLSpanElement>(null);
    const hasRating = feedback.rating !== undefined;
    const pending = Boolean(feedback.pending);
    const disabled = pending || feedback.status === "loading";

    useEffect(() => {
        if (!noteOpen) return;
        setDraft(feedback.note ?? "");
    }, [feedback.note, noteOpen]);

    useEffect(() => {
        if (!noteOpen) return;
        const onPointerDown = (event: MouseEvent): void => {
            if (feedbackRef.current && !feedbackRef.current.contains(event.target as Node)) {
                setNoteOpen(false);
            }
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape") setNoteOpen(false);
        };
        document.addEventListener("mousedown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("mousedown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [noteOpen]);

    const toggle = (rating: DshMessageFeedbackRating): void => {
        if (disabled) return;
        setNoteOpen(false);
        postAction({ type: "toggleMessageFeedback", messageId, rating });
    };

    const openNote = (): void => {
        if (disabled || !hasRating) return;
        setDraft(feedback.note ?? "");
        setNoteOpen((open) => !open);
    };

    const saveNote = (): void => {
        if (disabled) return;
        postAction({ type: "saveMessageFeedbackNote", messageId, note: draft });
        setNoteOpen(false);
    };

    const selected = feedback.rating;
    const hasVisibleFeedback = hasRating || Boolean(feedback.error) || noteOpen;
    return (
        <span
            className={`dsh-message-feedback${hasVisibleFeedback ? " has-feedback" : ""}${noteOpen ? " open" : ""}`}
            ref={feedbackRef}
        >
            <button
                type="button"
                className={`dsh-message-feedback-button${selected === "positive" ? " active" : ""}`}
                aria-label={t(selected === "positive" ? "Like (selected)" : "Like")}
                aria-pressed={selected === "positive"}
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
                title={t(selected === "negative" ? "Dislike (selected)" : "Dislike")}
                disabled={disabled}
                onClick={(event) => {
                    event.stopPropagation();
                    toggle("negative");
                }}
            >
                <DislikeIcon />
            </button>
            {hasRating ? (
                <button
                    type="button"
                    className={`dsh-message-feedback-note${feedback.note ? " has-note" : ""}`}
                    aria-haspopup="dialog"
                    aria-expanded={noteOpen}
                    aria-label={t(feedback.note ? "Edit feedback note" : "Add feedback note")}
                    title={t(feedback.note ? "Edit feedback note" : "Add feedback note")}
                    disabled={disabled}
                    onClick={(event) => {
                        event.stopPropagation();
                        openNote();
                    }}
                >
                    {feedback.note ? feedback.note.slice(0, 40) : t("Add note")}
                </button>
            ) : null}
            {noteOpen ? (
                <span
                    className="dsh-feedback-note-panel"
                    role="dialog"
                    aria-label={t("Feedback")}
                    onClick={(event) => event.stopPropagation()}
                >
                    <textarea
                        className="dsh-feedback-note-input"
                        value={draft}
                        maxLength={32768}
                        autoFocus
                        aria-label={t("Feedback note")}
                        placeholder={t("Optional feedback note")}
                        onChange={(event) => setDraft(event.target.value)}
                    />
                    <span className="dsh-feedback-note-actions">
                        <button type="button" className="dsh-button-secondary" onClick={() => setNoteOpen(false)}>
                            {t("Cancel")}
                        </button>
                        <button type="button" className="dsh-button" disabled={disabled} onClick={saveNote}>
                            {t("Save feedback note")}
                        </button>
                    </span>
                </span>
            ) : null}
            {feedback.error ? (
                <span className="dsh-feedback-error" role="status">
                    {feedback.error}
                </span>
            ) : null}
        </span>
    );
}

type CheckpointAction =
    | "forkFromMessage"
    | "restoreCodeToMessage"
    | "forkAndRestoreCodeToMessage";

function MessageCheckpointMenu({ seq }: { seq: number }): React.JSX.Element {
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
        postAction({ type, seq });
        setOpen(false);
    };

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

export const MessageItem = React.memo(function MessageItem({
    message,
    submitting,
    agentStatusLabel,
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
        message.role === "assistant" && message.state === "committed" && message.messageId && message.feedback
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
                {hasTrace ? (
                    <button
                        type="button"
                        className="dsh-message-trace"
                        data-trace-seq={message.seq}
                        title={t("Locate in Trace")}
                    >
                        trace
                    </button>
                ) : null}
                {checkpointSeq === undefined ? null : <MessageCheckpointMenu seq={checkpointSeq} />}
            </div>
            <MessageContent message={message} agentStatusLabel={agentStatusLabel} />
            {feedbackTarget && message.feedback ? (
                <div className="dsh-message-feedback-row">
                    <MessageFeedbackActions messageId={feedbackTarget} feedback={message.feedback} />
                </div>
            ) : null}
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
