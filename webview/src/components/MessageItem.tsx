import React, { useEffect, useRef, useState } from "react";
import type { ChatImageView, ChatMessage, ChatToolCall } from "../../../src/types";
import { findFileLocations } from "../../../src/fileLocations";
import { postAction } from "../bridge";
import { t } from "../i18n";
import { formatToolDuration, ROLE_LABELS } from "../state";
import { CloseIcon } from "./icons";

interface MessageItemProps {
    message: ChatMessage;
    submitting: boolean;
}

function LinkedFileLocations({ text }: { text: string }): React.JSX.Element {
    const locations = findFileLocations(text);
    if (locations.length === 0) return <>{text}</>;
    const content: React.ReactNode[] = [];
    let cursor = 0;
    for (const location of locations) {
        content.push(text.slice(cursor, location.start));
        content.push(
            <span
                className="file-location-link"
                role="link"
                tabIndex={0}
                data-file-path={location.path}
                data-file-line={location.line}
                {...(location.column === undefined
                    ? {}
                    : { "data-file-column": location.column })}
                key={`${location.start}:${location.end}`}
            >
                {location.text}
            </span>,
        );
        cursor = location.end;
    }
    content.push(text.slice(cursor));
    return <>{content}</>;
}

function ToolCard({ tool }: { tool: ChatToolCall }): React.JSX.Element {
    const status =
        tool.status === "running" ? t("Running") : tool.status === "failed" ? t("Failed") : t("Done");
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
                            <div className="dsh-tool-section-label">{t("Parameters")}</div>
                            <pre><LinkedFileLocations text={tool.args} /></pre>
                        </div>
                    ) : null}
                    {tool.result ? (
                        <div className="dsh-tool-section">
                            <div className="dsh-tool-section-label">{t("Result")}</div>
                            <pre><LinkedFileLocations text={tool.result} /></pre>
                        </div>
                    ) : null}
                    {tool.error ? (
                        <div className="dsh-tool-section dsh-card-error">
                            <LinkedFileLocations text={tool.error} />
                        </div>
                    ) : null}
                </div>
            ) : null}
        </details>
    );
}

function MessageImages({ images }: { images: readonly ChatImageView[] }): React.JSX.Element | null {
    const galleryRef = useRef<HTMLDivElement>(null);
    const [preview, setPreview] = useState<ChatImageView>();
    const pendingIds = images
        .filter((image) => !image.src && image.loadState === "idle" && image.attachmentId)
        .map((image) => image.attachmentId as string)
        .join("\u0000");
    useEffect(() => {
        if (!pendingIds) return;
        const load = (): void => {
            for (const attachmentId of pendingIds.split("\u0000")) {
                postAction({ type: "loadImage", attachmentId });
            }
        };
        const target = galleryRef.current;
        if (!target || typeof IntersectionObserver === "undefined") {
            load();
            return;
        }
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                observer.disconnect();
                load();
            }
        }, { rootMargin: "120px" });
        observer.observe(target);
        return () => observer.disconnect();
    }, [pendingIds]);
    if (images.length === 0) return null;
    return (
        <>
            <div ref={galleryRef} className="dsh-message-images" aria-label={t("Images")}>
                {images.map((image, index) => {
                    const label = image.name || t("Image {index}", { index: index + 1 });
                    return image.src ? (
                        <button
                            type="button"
                            className="dsh-message-image"
                            title={t("Open original image")}
                            onClick={() => setPreview(image)}
                            key={image.attachmentId ?? `${image.mediaType}:${index}`}
                        >
                            <img src={image.src} alt={label} />
                        </button>
                    ) : (
                        <button
                            type="button"
                            className={`dsh-message-image dsh-image-placeholder ${image.loadState ?? "idle"}`}
                            title={image.error || t("Load image")}
                            disabled={image.loadState === "loading" || !image.attachmentId}
                            onClick={() => {
                                if (image.attachmentId) {
                                    postAction({ type: "loadImage", attachmentId: image.attachmentId });
                                }
                            }}
                            key={image.attachmentId ?? `${image.mediaType}:${index}`}
                        >
                            <span>{image.loadState === "loading" ? t("Loading image...") : image.loadState === "error" ? t("Retry image") : t("Image")}</span>
                            <small>{label}</small>
                        </button>
                    );
                })}
            </div>
            {preview?.src ? (
                <div
                    className="dsh-image-lightbox"
                    role="dialog"
                    aria-modal="true"
                    aria-label={t("Original image preview")}
                    onClick={() => setPreview(undefined)}
                >
                    <button
                        type="button"
                        className="dsh-icon-button dsh-image-lightbox-close"
                        title={t("Close")}
                        onClick={() => setPreview(undefined)}
                    >
                        <CloseIcon />
                    </button>
                    <img
                        src={preview.src}
                        alt={preview.name || t("Image")}
                        onClick={(event) => event.stopPropagation()}
                    />
                </div>
            ) : null}
        </>
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
                    {message.reasoningState === "streaming" ? t("Thinking...") : t("Reasoning · complete")}
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
            ? t(" · waiting for response")
            : message.state === "streaming"
              ? t(" · streaming")
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
                        title={t("Locate in Trace")}
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
                    {t("Retry")}
                </button>
            ) : null}
        </div>
    );
}
