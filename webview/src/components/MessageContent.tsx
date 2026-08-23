import React from "react";
import type { ChatMessage } from "../../../src/types";
import { t } from "../i18n";
import { CompactionCard, ToolCard } from "./Cards";
import { MessageImages } from "./MessageImages";

/**
 * Body + optional reasoning fold. `renderedHtml` is fixed-vocabulary HTML produced
 * by the extension-host safe Markdown renderer, so it is injected verbatim.
 */
export function MessageContent({
    message,
    agentStatusLabel,
}: {
    message: ChatMessage;
    agentStatusLabel?: string;
}): React.JSX.Element {
    if (message.role === "tool" && message.tool) {
        return <ToolCard tool={message.tool} />;
    }
    if (message.compaction) {
        return <CompactionCard message={message} />;
    }
    const body = message.text ? (
        <div
            className="dsh-message-body"
            {...(typeof message.renderedHtml === "string"
                ? { dangerouslySetInnerHTML: { __html: message.renderedHtml } }
                : { children: <p>{message.text}</p> })}
        />
    ) : null;
    const images = message.images?.length ? <MessageImages images={message.images} /> : null;
    if (message.role !== "assistant" || !message.reasoning) {
        return <>{images}{body}</>;
    }
    const reasoningBody = (
        <div
            className="dsh-message-body"
            {...(typeof message.renderedReasoningHtml === "string"
                ? { dangerouslySetInnerHTML: { __html: message.renderedReasoningHtml } }
                : { children: <p>{message.reasoning}</p> })}
        />
    );
    return (
        <>
            {images}
            {body}
            <details
                className="dsh-message-reasoning"
                {...(typeof message.reasoningRenderId === "string"
                    ? { "data-render-id": message.reasoningRenderId }
                    : {})}
            >
                <summary>
                    {message.reasoningState === "streaming"
                        ? agentStatusLabel ?? t("Thinking...")
                        : t("Reasoning · complete")}
                </summary>
                {reasoningBody}
            </details>
        </>
    );
}
