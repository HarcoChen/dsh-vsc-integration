import React, { useLayoutEffect, useRef } from "react";
import type { ChatMessage } from "../../../src/types";
import { postAction } from "../bridge";
import { t } from "../i18n";
import { MessageItem } from "./MessageItem";

interface MessageListProps {
    messages: ChatMessage[];
    submitting: boolean;
}

function closestElement(target: EventTarget | null, selector: string): HTMLElement | undefined {
    if (!(target instanceof Element)) return undefined;
    return target.closest<HTMLElement>(selector) ?? undefined;
}

/**
 * Delegated handling for markdown HTML injected via dangerouslySetInnerHTML:
 * external links and code-block actions inside host pre-rendered content.
 * Returns true when the event was consumed.
 */
export function handleMarkdownClick(target: EventTarget | null): boolean {
    const file = closestElement(target, "[data-file-path]");
    const line = Number(file?.dataset.fileLine);
    const column = file?.dataset.fileColumn === undefined
        ? undefined
        : Number(file.dataset.fileColumn);
    if (
        file?.dataset.filePath &&
        Number.isSafeInteger(line) &&
        line > 0 &&
        (column === undefined || (Number.isSafeInteger(column) && column > 0))
    ) {
        postAction({
            type: "openFileLocation",
            path: file.dataset.filePath,
            line,
            ...(column === undefined ? {} : { column }),
        });
        return true;
    }
    const link = closestElement(target, "[data-external-url]");
    if (link?.dataset.externalUrl) {
        postAction({ type: "openExternalLink", url: link.dataset.externalUrl });
        return true;
    }
    const codeAction = closestElement(target, "[data-code-action]");
    const host = codeAction ? closestElement(codeAction, "[data-render-id]") : undefined;
    const action = codeAction?.dataset.codeAction;
    const codeBlockId = codeAction?.dataset.codeBlockId ?? codeAction?.dataset.copyCodeId;
    if (
        codeAction instanceof HTMLButtonElement &&
        host?.dataset.renderId &&
        codeBlockId &&
        (action === "copyCode" || action === "insertCode" || action === "openCode" || action === "applyCode") &&
        !codeAction.disabled
    ) {
        codeAction.disabled = true;
        const language = codeAction.dataset.codeLanguage;
        postAction({
            type: action,
            renderId: host.dataset.renderId,
            codeBlockId,
            ...(action === "openCode" || action === "applyCode") && language
                ? { language }
                : {},
        });
        window.setTimeout(() => {
            codeAction.disabled = false;
        }, action === "applyCode" ? 2_000 : 750);
        return true;
    }
    return false;
}

/** Keyboard activation for links inside injected markdown (Enter / Space). */
export function handleMarkdownKeydown(event: React.KeyboardEvent): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.matches("[data-file-path]")) {
        event.preventDefault();
        handleMarkdownClick(target);
        return;
    }
    if (target.matches("[data-code-action]")) {
        event.preventDefault();
        handleMarkdownClick(target);
        return;
    }
    if (!target.matches("[data-external-url]")) return;
    const url = (target as HTMLElement).dataset.externalUrl;
    if (!url) return;
    event.preventDefault();
    postAction({ type: "openExternalLink", url });
}

export function MessageList({ messages, submitting }: MessageListProps): React.JSX.Element {
    const listRef = useRef<HTMLDivElement>(null);
    const stickToBottomRef = useRef(true);

    useLayoutEffect(() => {
        const list = listRef.current;
        if (list && stickToBottomRef.current) {
            list.scrollTop = list.scrollHeight;
        }
    }, [messages]);

    const onScroll = (): void => {
        const list = listRef.current;
        if (!list) return;
        stickToBottomRef.current =
            list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    };

    const onClick = (event: React.MouseEvent): void => {
        const retry = closestElement(event.target, "[data-retry-id]");
        if (retry instanceof HTMLButtonElement && retry.dataset.retryId && !retry.disabled) {
            retry.disabled = true;
            postAction({ type: "retryPrompt", id: retry.dataset.retryId });
            return;
        }
        const trace = closestElement(event.target, "[data-trace-seq]");
        if (trace?.dataset.traceSeq !== undefined) {
            postAction({ type: "openTrace", seq: Number(trace.dataset.traceSeq) });
            return;
        }
        handleMarkdownClick(event.target);
    };

    return (
        <div
            className="dsh-messages"
            ref={listRef}
            onScroll={onScroll}
            onClick={onClick}
            onKeyDown={handleMarkdownKeydown}
        >
            {messages.length === 0 ? (
                <div className="dsh-empty">
                    <div className="dsh-empty-title">{t("Describe a task.")}</div>
                    <div className="dsh-empty-detail">
                        {t("The current selection is attached automatically. You can also use @ to reference files.")}
                        <br />
                        {t("Ctrl/Cmd + Enter to send.")}
                    </div>
                </div>
            ) : (
                messages.map((message) => (
                    <MessageItem key={message.id} message={message} submitting={submitting} />
                ))
            )}
        </div>
    );
}
