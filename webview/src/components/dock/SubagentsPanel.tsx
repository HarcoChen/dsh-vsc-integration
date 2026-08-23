import React, { useState } from "react";
import type { SubagentHistoryPreview, SubagentTreeView } from "../../../../src/types";
import { postAction } from "../../bridge";
import { t } from "../../i18n";
import { handleMarkdownClick, handleMarkdownKeydown } from "../markdownEvents";
import { MessageContent } from "../MessageContent";

function SubagentPreviewCard({ preview }: { preview: SubagentHistoryPreview }): React.JSX.Element {
    const [followUp, setFollowUp] = useState("");
    const busy = Boolean(preview.pendingAction);
    const canFollowUp = preview.parentAvailable && !busy;
    const sendFollowUp = (): void => {
        const text = followUp.trim();
        if (!text || !canFollowUp) return;
        setFollowUp("");
        postAction({ type: "followUpSubagent", childSessionId: preview.childSessionId, text });
    };
    return (
        <div className="dsh-card">
            <div className="dsh-feature-head">
                <div className="dsh-card-title">{preview.label}</div>
                <button type="button" className="dsh-button dsh-button-secondary" onClick={() => postAction({ type: "closeSubagent" })}>{t("Close")}</button>
            </div>
            <div className="dsh-card-detail">
                {preview.mode} · {preview.activity} · {preview.parentAvailable ? t("parent available") : t("parent unavailable")}
            </div>
            {preview.state === "loading" ? <div className="dsh-card-detail">{t("Loading history...")}</div> : null}
            {preview.error ? <div className="dsh-card-error">{preview.error}</div> : null}
            {preview.pendingAction ? <div className="dsh-card-detail">{t("Running {operation}...", { operation: preview.pendingAction })}</div> : null}
            {preview.messages.length ? (
                <div className="dsh-subagent-transcript" onClick={(event) => handleMarkdownClick(event.target)} onKeyDown={handleMarkdownKeydown}>
                    {preview.messages.map((message) => (
                        <div
                            className={`dsh-message dsh-role-${message.role}`}
                            key={message.id}
                            {...(typeof message.renderId === "string" ? { "data-render-id": message.renderId } : {})}
                        >
                            <div className="dsh-message-label">
                                {message.role === "assistant" ? "subagent" : message.role === "user" ? t("You") : t("System")}
                            </div>
                            <MessageContent message={message} />
                        </div>
                    ))}
                </div>
            ) : null}
            {preview.mode === "continuable" ? (
                <div className="dsh-follow-up">
                    <input
                        placeholder={t("Add a task for the continuable subagent")}
                        value={followUp}
                        disabled={!canFollowUp}
                        onChange={(event) => setFollowUp(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.preventDefault();
                                sendFollowUp();
                            }
                        }}
                    />
                    <button type="button" className="dsh-button" disabled={!canFollowUp || !followUp.trim()} onClick={sendFollowUp}>{t("Send")}</button>
                </div>
            ) : null}
            {preview.mode === "continuable" && preview.activity === "running" ? (
                <div className="dsh-card-actions">
                    <button
                        type="button"
                        className="dsh-button dsh-button-secondary"
                        disabled={busy}
                        onClick={() => postAction({ type: "interruptSubagent", childSessionId: preview.childSessionId })}
                    >
                        {t("Interrupt")}
                    </button>
                </div>
            ) : null}
        </div>
    );
}

export function SubagentsPanel({ tree, preview }: { tree: SubagentTreeView; preview?: SubagentHistoryPreview }): React.JSX.Element {
    const statusText = tree.state === "loading"
        ? t("Loading...")
        : tree.state === "error"
          ? tree.error || t("Loading failed")
          : tree.nodes.length
            ? ""
            : t("No subagents");
    return (
        <div>
            <div className="dsh-feature-head">
                <div className="dsh-dock-title">{t("Subagent Tree")}</div>
                <button type="button" className="dsh-button dsh-button-secondary" disabled={tree.state === "loading"} onClick={() => postAction({ type: "refreshSubagents" })}>{t("Refresh")}</button>
            </div>
            {statusText ? <div className="dsh-card-detail">{statusText}</div> : null}
            {tree.nodes.map((node) => {
                const depthClass = `dsh-tree-depth-${Math.min(8, Math.max(0, Number(node.depth || 1) - 1))}`;
                if (node.kind === "diagnostic") {
                    return (
                        <div className={`dsh-tree-row ${depthClass}`} key={node.id}>
                            <div>
                                <div className="dsh-tree-label">{node.id}</div>
                                <div className="dsh-tree-meta">{t("diagnostic · {reason} · parent {parent}", { reason: node.reason || "", parent: node.parentSessionId })}</div>
                            </div>
                        </div>
                    );
                }
                const meta = [
                    node.mode,
                    node.activity,
                    node.hasChildren ? t("has children") : t("leaf"),
                    node.parentAvailable ? t("parent available") : t("parent unavailable"),
                ].filter(Boolean).join(" · ");
                return (
                    <div className={`dsh-tree-row ${depthClass}`} key={node.id}>
                        <div>
                            <div className="dsh-tree-label">{node.label || node.id}</div>
                            <div className="dsh-tree-meta">{meta}<br />{t("parent {parent}", { parent: node.parentSessionId })}</div>
                        </div>
                        <button type="button" className="dsh-button dsh-button-secondary" onClick={() => postAction({ type: "openSubagent", childSessionId: node.id })}>{t("History")}</button>
                    </div>
                );
            })}
            {preview ? <SubagentPreviewCard preview={preview} /> : null}
        </div>
    );
}
