import React, { useEffect, useRef, useState } from "react";
import type {
    ChatImageView,
    ChatLspLocationView,
    ChatLspResultView,
    ChatMessage,
    ChatToolCall,
    ChatWebResultView,
    ChatWebSourceView,
} from "../../../src/types";
import { findFileLocations } from "../../../src/fileLocations";
import { postAction } from "../bridge";
import { t } from "../i18n";
import { formatToolDuration, ROLE_LABELS } from "../state";
import { CloseIcon } from "./icons";

interface MessageItemProps {
    message: ChatMessage;
    submitting: boolean;
    agentStatusLabel?: string;
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

function WebLink({
    location,
    label,
    className,
}: {
    location: Pick<ChatWebSourceView, "url" | "href">;
    label: string;
    className: string;
}): React.JSX.Element {
    return location.href ? (
        <span
            className={className}
            role="link"
            tabIndex={0}
            data-external-url={location.href}
            title={location.url}
        >
            {label}
        </span>
    ) : <span className={`${className} dsh-web-link-disabled`}>{label}</span>;
}

function WebToolResult({ web }: { web: ChatWebResultView }): React.JSX.Element {
    if (web.kind === "fetch") {
        return (
            <div className="dsh-web-result dsh-web-fetch">
                <WebLink location={web} label={web.url} className="dsh-web-fetch-url" />
                <div className="dsh-web-meta">
                    {web.domain ? <span>{web.domain}</span> : null}
                    <span className={web.statusCode >= 400 ? "dsh-web-status-error" : ""}>
                        HTTP {web.statusCode}
                    </span>
                    {web.truncated ? <span>{t("Content truncated")}</span> : null}
                </div>
            </div>
        );
    }
    const empty = !web.answer && web.sources.length === 0;
    return (
        <div className="dsh-web-result dsh-web-search">
            {web.answer ? <div className="dsh-web-answer">{web.answer}</div> : null}
            {empty ? <div className="dsh-web-empty">{t("No results found")}</div> : (
                <ol className="dsh-web-sources">
                    {web.sources.map((source, index) => (
                        <li key={`${source.url}:${index}`}>
                            <WebLink
                                location={source}
                                label={source.title || source.domain || source.url}
                                className="dsh-web-source-link"
                            />
                            {source.snippet ? <div className="dsh-web-snippet">{source.snippet}</div> : null}
                            {source.domain || source.publishedAt ? (
                                <div className="dsh-web-meta">
                                    {source.domain ? <span>{source.domain}</span> : null}
                                    {source.publishedAt ? <span>{source.publishedAt}</span> : null}
                                </div>
                            ) : null}
                        </li>
                    ))}
                </ol>
            )}
            {web.truncated ? <div className="dsh-web-truncated">{t("Source list truncated")}</div> : null}
        </div>
    );
}

function LspLocationLink({ location }: { location: ChatLspLocationView }): React.JSX.Element {
    return location.path && location.line ? (
        <span
            className="dsh-lsp-location"
            role="link"
            tabIndex={0}
            data-file-path={location.path}
            data-file-line={location.line}
            {...(location.character === undefined
                ? {}
                : { "data-file-column": location.character })}
        >
            {location.label}
        </span>
    ) : <span>{location.label}</span>;
}

function lspOperationLabel(operation: ChatLspResultView["operation"]): string {
    switch (operation) {
        case "goToDefinition": return t("Definition");
        case "findReferences": return t("References");
        case "goToImplementation": return t("Implementations");
        case "hover": return "Hover";
    }
}

function LspToolResult({ lsp }: { lsp: ChatLspResultView }): React.JSX.Element {
    return (
        <div className="dsh-lsp-result">
            <div className="dsh-lsp-head">
                <strong>{lspOperationLabel(lsp.operation)}</strong>
                <span>{t("Query")}: <LspLocationLink location={lsp.query} /></span>
            </div>
            {lsp.empty ? <div className="dsh-lsp-empty">{t("No LSP results")}</div> : null}
            {lsp.kind === "locations" && lsp.locations.length ? (
                <ol className="dsh-lsp-locations">
                    {lsp.locations.map((location, index) => (
                        <li key={`${location.label}:${index}`}>
                            <LspLocationLink location={location} />
                        </li>
                    ))}
                </ol>
            ) : null}
            {lsp.kind === "hover" && lsp.content ? (
                <pre className="dsh-lsp-hover">{lsp.content}</pre>
            ) : null}
            {lsp.kind === "locations" && lsp.notices.length ? (
                <div className="dsh-lsp-notices">
                    {lsp.notices.map((notice, index) => <div key={`${notice}:${index}`}>{notice}</div>)}
                </div>
            ) : null}
            {lsp.truncated ? <div className="dsh-lsp-truncated">{t("LSP result truncated")}</div> : null}
        </div>
    );
}

function ToolCard({ tool }: { tool: ChatToolCall }): React.JSX.Element {
    const status =
        tool.status === "running" ? t("Running") : tool.status === "failed" ? t("Failed") : t("Done");
    const hasDetail = Boolean(tool.args || tool.result || tool.error || tool.web || tool.lsp);
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
                    {tool.web ? <WebToolResult web={tool.web} /> : null}
                    {tool.lsp ? <LspToolResult lsp={tool.lsp} /> : null}
                    {tool.args && !tool.lsp ? (
                        <div className="dsh-tool-section">
                            <div className="dsh-tool-section-label">{t("Parameters")}</div>
                            <pre><LinkedFileLocations text={tool.args} /></pre>
                        </div>
                    ) : null}
                    {tool.result && !tool.lsp && (!tool.web || tool.web.kind === "fetch") ? (
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

function CompactionCard({ message }: { message: ChatMessage }): React.JSX.Element | null {
    const compaction = message.compaction;
    if (!compaction) return null;
    const statusLabel =
        compaction.status === "running"
            ? t("Compacting")
            : compaction.status === "failed"
              ? t("Failed")
              : t("Completed");
    return (
        <div className={`dsh-compaction-card ${compaction.status}`}>
            <div className="dsh-compaction-head">
                <span className="dsh-compaction-status" />
                <span className="dsh-compaction-title">{message.text}</span>
                <span className="dsh-compaction-meta">{statusLabel}</span>
            </div>
            {compaction.summary ? (
                <div className="dsh-compaction-summary">{compaction.summary}</div>
            ) : null}
            {compaction.error ? (
                <div className="dsh-compaction-error">{compaction.error}</div>
            ) : null}
        </div>
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

export function MessageItem({ message, submitting, agentStatusLabel }: MessageItemProps): React.JSX.Element {
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
            </div>
            <MessageContent message={message} agentStatusLabel={agentStatusLabel} />
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
