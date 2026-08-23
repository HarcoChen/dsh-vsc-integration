import React, { useState } from "react";
import type { ChatViewState } from "../../../../src/types";
import { postAction } from "../../bridge";
import { t } from "../../i18n";

export function QueuePanel({ queue, running }: { queue: ChatViewState["queue"]; running: boolean }): React.JSX.Element {
    const [editing, setEditing] = useState<{ itemId: string; text: string } | null>(null);
    const act = (itemId: string, action: "edit" | "remove" | "steer", editableText?: string): void => {
        if (action === "edit") {
            setEditing({ itemId, text: editableText ?? "" });
            return;
        }
        postAction({ type: "updateQueue", itemId, action });
    };
    const saveEdit = (): void => {
        if (!editing || !editing.text.trim()) return;
        postAction({ type: "updateQueue", itemId: editing.itemId, action: "edit", text: editing.text });
        setEditing(null);
    };
    return (
        <div>
            {queue.map((item) => (
                <div className="dsh-queue-row" key={item.id}>
                    {editing?.itemId === item.id ? (
                        <div className="dsh-dock-form dsh-queue-edit">
                            <input
                                className="dsh-dock-input"
                                placeholder={t("Edit queued message")}
                                value={editing.text}
                                autoFocus
                                onChange={(event) => setEditing({ itemId: item.id, text: event.target.value })}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                        event.preventDefault();
                                        saveEdit();
                                    } else if (event.key === "Escape") {
                                        event.preventDefault();
                                        setEditing(null);
                                    }
                                }}
                            />
                            <div className="dsh-card-actions">
                                <button type="button" className="dsh-button" disabled={!editing.text.trim()} onClick={saveEdit}>{t("Save")}</button>
                                <button type="button" className="dsh-button dsh-button-secondary" onClick={() => setEditing(null)}>{t("Cancel")}</button>
                            </div>
                        </div>
                    ) : (
                        <>
                            <div className="dsh-queue-preview">
                                {item.placement === "steering" ? "↪ " : ""}
                                {item.preview || t("(no text content)")}
                            </div>
                            <div className="dsh-queue-actions">
                                {item.editableText !== undefined ? (
                                    <button type="button" className="dsh-button dsh-button-secondary" onClick={() => act(item.id, "edit", item.editableText)}>{t("Edit")}</button>
                                ) : null}
                                <button type="button" className="dsh-button dsh-button-secondary" onClick={() => act(item.id, "remove")}>{t("Remove")}</button>
                                <button type="button" className="dsh-button dsh-button-secondary" disabled={!running} onClick={() => act(item.id, "steer")}>{t("Steer now")}</button>
                            </div>
                        </>
                    )}
                </div>
            ))}
        </div>
    );
}
