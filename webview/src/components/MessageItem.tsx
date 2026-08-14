import React from "react";
import type { ChatMessage, ChatToolCall } from "../../../src/types";
import { formatToolDuration, ROLE_LABELS } from "../state";

interface MessageItemProps {
    message: ChatMessage;
    submitting: boolean;
}

function ToolCard({ tool }: { tool: ChatToolCall }): React.JSX.Element {
    const status =
        tool.status === "running" ? "运行中" : tool.status === "failed" ? "失败" : "完成";
    const hasDetail = Boolean(tool.args || tool.result || tool.error);
    return (
        <details className={`dsh-tool-card ${tool.status}`}>
            <summary>
                <span className="dsh-tool-status" />
                <span className="dsh-tool-title">{tool.title || tool.name}</span>
                <span className="dsh-tool-meta">
                    {status}
                    {formatToolDuration(tool.durationMs)}
                </span>
            </summary>
            {hasDetail ? (
                <div className="dsh-tool-detail">
                    {tool.args ? (
                        <div className="dsh-tool-section">
                            <div className="dsh-tool-section-label">参数</div>
                            <pre>{tool.args}</pre>
                        </div>
                    ) : null}
                    {tool.result ? (
                        <div className="dsh-tool-section">
                            <div className="dsh-tool-section-label">结果</div>
                            <pre>{tool.result}</pre>
                        </div>
                    ) : null}
                    {tool.error ? (
                        <div className="dsh-tool-section dsh-card-error">{tool.error}</div>
                    ) : null}
                </div>
            ) : null}
        </details>
    );
}

/**
 * Body + optional reasoning fold. `renderedHtml` is fixed-vocabulary HTML produced
 * by the extension-host safe Markdown renderer, so it is injected verbatim.
 */
export function MessageContent({ message }: { message: ChatMessage }): React.JSX.Element {
    if (message.role === "tool" && message.tool) {
        return <ToolCard tool={message.tool} />;
    }
    const body = (
        <div
            className="dsh-message-body"
            {...(typeof message.renderedHtml === "string"
                ? { dangerouslySetInnerHTML: { __html: message.renderedHtml } }
                : { children: <p>{message.text}</p> })}
        />
    );
    if (message.role !== "assistant" || !message.reasoning) {
        return body;
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
            {body}
            <details
                className="dsh-message-reasoning"
                {...(typeof message.reasoningRenderId === "string"
                    ? { "data-render-id": message.reasoningRenderId }
                    : {})}
            >
                <summary>
                    {message.reasoningState === "streaming" ? "思考中…" : "思考过程 · 已完成"}
                </summary>
                {reasoningBody}
            </details>
        </>
    );
}

export function MessageItem({ message, submitting }: MessageItemProps): React.JSX.Element {
    const stateClass =
        message.state === "streaming"
            ? " dsh-streaming"
            : message.state === "pending"
              ? " dsh-pending"
              : "";
    const stateLabel =
        message.state === "pending"
            ? " · 等待接收"
            : message.state === "streaming"
              ? " · 流式生成"
              : "";
    const hasTrace = Number.isSafeInteger(message.seq) && (message.seq ?? -1) >= 0;
    return (
        <div
            className={`dsh-message dsh-role-${message.role}${stateClass}`}
            {...(typeof message.renderId === "string"
                ? { "data-render-id": message.renderId }
                : {})}
        >
            <div className="dsh-message-label">
                {ROLE_LABELS[message.role]}
                {stateLabel}
                {hasTrace ? (
                    <button
                        type="button"
                        className="dsh-message-trace"
                        data-trace-seq={message.seq}
                        title="在 Trace 中定位"
                    >
                        trace
                    </button>
                ) : null}
            </div>
            <MessageContent message={message} />
            {message.state === "failed" ? (
                <button
                    type="button"
                    className="dsh-message-retry dsh-button-secondary"
                    data-retry-id={message.id}
                    disabled={submitting}
                >
                    重试
                </button>
            ) : null}
        </div>
    );
}
