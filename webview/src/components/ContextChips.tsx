import React from "react";
import type { ChatViewState } from "../../../src/types";
import { postAction } from "../bridge";
import { t } from "../i18n";
import { CloseIcon, EyeIcon, EyeOffIcon } from "./icons";

/** Renders the context attachment chips plus the summary and warning notices. */
export function ContextChips({ state }: { state: ChatViewState }): React.JSX.Element {
    const selection = state.selection;
    const selectionRange = selection?.range;
    const selectionLines = selectionRange
        ? Math.max(1, selectionRange.endLine - selectionRange.startLine + 1)
        : 0;

    const promptItems = [
        ...(selection && state.selectionEnabled ? [selection] : []),
        ...state.context,
    ];
    const promptBytes = promptItems.reduce((total, item) => total + item.byteLength, 0);
    const estimatedAttachmentTokens = Math.ceil(promptBytes / 4);
    const contextWindow = state.tokenUsage?.context?.contextWindow;
    const projectedTokens = state.tokenUsage?.context?.projectedTokens;
    const projectedWithAttachments = (projectedTokens ?? 0) + estimatedAttachmentTokens;
    const overContextWindow = contextWindow !== undefined && projectedTokens !== undefined && projectedWithAttachments > contextWindow;
    const sensitiveItems = promptItems.filter((item) => /(^|[/\\.])(env|env\..*|pem|key|p12|pfx|secret|credentials?)([/\\.]|$)/iu.test(item.path ?? item.label));
    const truncatedItems = promptItems.filter((item) => item.truncated);

    return (
        <>
            {selection || state.context.length ? (
                <div className="dsh-context-items">
                    {selection ? (
                        <div
                            className={`dsh-chip${state.selectionEnabled ? "" : " dsh-chip-disabled"}`}
                            title={t("The current selection is read again when sending")}
                        >
                            <span className="dsh-chip-label">
                                Selection · {selection.label} · {selectionLines} lines · {selection.byteLength.toLocaleString()} B
                                {selection.truncated ? ` · ${t("truncated")}` : ""}
                            </span>
                            <button
                                type="button"
                                className="dsh-chip-button"
                                title={t("Toggle automatic selection context")}
                                onClick={() => postAction({ type: "toggleSelection" })}
                            >
                                {state.selectionEnabled ? <EyeIcon /> : <EyeOffIcon />}
                            </button>
                        </div>
                    ) : null}
                    {state.context.map((item) => (
                        <div className="dsh-chip" title={t("One-shot attachment")} key={item.id}>
                            <span className="dsh-chip-label">
                                {item.label} · {item.byteLength.toLocaleString()} B
                                {item.truncated ? ` · ${t("truncated")}` : ""}
                            </span>
                            <button
                                type="button"
                                className="dsh-chip-button"
                                title={t("Remove")}
                                onClick={() => postAction({ type: "removeContext", id: item.id })}
                            >
                                <CloseIcon />
                            </button>
                        </div>
                    ))}
                </div>
            ) : null}
            {promptItems.length ? (
                <div className="dsh-context-summary">
                    {t("This send includes {count} context item(s), {bytes} B in the prompt", {
                        count: promptItems.length,
                        bytes: promptBytes.toLocaleString(),
                    })}
                </div>
            ) : null}
            {promptItems.length ? (
                <div className="dsh-context-notices" role="status">
                    {overContextWindow ? (
                        <div className="dsh-context-warning">
                            {t("This send may exceed the model context window ({used} / {window} tokens). Remove a large attachment before sending.", {
                                used: projectedWithAttachments.toLocaleString(),
                                window: contextWindow!.toLocaleString(),
                            })}
                        </div>
                    ) : null}
                    {truncatedItems.length ? (
                        <div className="dsh-context-warning">
                            {t("{count} attachment(s) will be truncated before entering the prompt.", { count: truncatedItems.length })}
                        </div>
                    ) : null}
                    {sensitiveItems.length ? (
                        <div className="dsh-context-warning">
                            {t("Check {count} attachment(s): their path looks like it may contain secrets or credentials.", { count: sensitiveItems.length })}
                        </div>
                    ) : null}
                </div>
            ) : null}
        </>
    );
}
