import React from "react";
import type { ChatMessage, ChatToolCall } from "../../../src/types";
import { findFileLocations } from "../../../src/fileLocations";
import { postAction } from "../bridge";
import { t } from "../i18n";
import { formatToolDuration } from "../state";
import { MessageImages } from "./MessageImages";
import { LspToolResult, WebToolResult } from "./ToolResultViews";

function LinkedFileLocations({ text }: { text: string }): React.JSX.Element {
    const locations = findFileLocations(text);
    if (locations.length === 0) return <>{text}</>;
    const content: React.ReactNode[] = [];
    let cursor = 0;
    for (const location of locations) {
        content.push(text.slice(cursor, location.start));
        content.push(
            <button
                type="button"
                className="file-location-link"
                data-file-path={location.path}
                data-file-line={location.line}
                {...(location.column === undefined
                    ? {}
                    : { "data-file-column": location.column })}
                key={`${location.start}:${location.end}`}
            >
                {location.text}
            </button>,
        );
        cursor = location.end;
    }
    content.push(text.slice(cursor));
    return <>{content}</>;
}

export function ToolCard({ tool }: { tool: ChatToolCall }): React.JSX.Element {
    const status =
        tool.status === "running" ? t("Running") : tool.status === "failed" ? t("Failed") : t("Done");
    const diffPaths = tool.diffPaths ?? [];
    const hasDetail = Boolean(
        tool.args || tool.result || tool.error || tool.web || tool.lsp ||
        tool.images?.length || diffPaths.length,
    );
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
                    {diffPaths.length ? (
                        <div className="dsh-tool-section">
                            <div className="dsh-tool-section-label">{t("Changes")}</div>
                            <div className="dsh-tool-diffs">
                                {diffPaths.map((path) => (
                                    <button
                                        type="button"
                                        className="dsh-tool-diff"
                                        key={path}
                                        title={t("Open native diff for {path}", { path })}
                                        onClick={() => postAction({
                                            type: "openToolDiff",
                                            callId: tool.callId,
                                            path,
                                        })}
                                    >
                                        {path}
                                    </button>
                                ))}
                            </div>
                        </div>
                    ) : null}
                    {tool.images?.length ? <MessageImages images={tool.images} /> : null}
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

export function CompactionCard({ message }: { message: ChatMessage }): React.JSX.Element | null {
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
