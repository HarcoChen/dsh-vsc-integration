import React from "react";
import type { ChatViewState } from "../../../../src/types";
import { postAction } from "../../bridge";
import { t } from "../../i18n";

const CHANGE_LABELS = {
    added: t("Added"),
    modified: t("Modified"),
    deleted: t("Deleted"),
    renamed: t("Renamed"),
} as const;

export function ChangesPanel({ reviews, running }: { reviews: ChatViewState["changeReviews"]; running: boolean }): React.JSX.Element {
    return (
        <div className="dsh-changes">
            {reviews.map((review) => {
                const canRestore = review.state === "ready" && review.files.length > 0 && !running && !review.restored && review.files.every((file) => file.restorable);
                return (
                    <section className="dsh-change-turn" key={review.turn}>
                        <div className="dsh-change-head">
                            <strong>{t("Turn {turn}", { turn: review.turn })}</strong>
                            <span className="dsh-card-detail">
                                {review.state === "capturing" ? t("Capturing changes...") : review.restored ? t("Restored") : t("{count} files", { count: review.files.length })}
                            </span>
                            <button
                                type="button"
                                className="dsh-button dsh-change-restore"
                                disabled={!canRestore}
                                title={review.files.some((file) => !file.restorable)
                                    ? t("This turn contains a file type that cannot be restored safely.")
                                    : running
                                      ? t("Wait for the current turn to finish before restoring changes.")
                                      : t("Restore all changes from this turn")}
                                onClick={() => postAction({ type: "restoreTurnChanges", turn: review.turn })}
                            >
                                {t("Restore")}
                            </button>
                        </div>
                        {review.error ? <div className="dsh-card-error">{review.error}</div> : null}
                        {review.files.map((file) => (
                            <button
                                type="button"
                                className="dsh-change-file"
                                key={file.id}
                                title={t("Open native diff for {path}", { path: file.path })}
                                onClick={() => postAction({ type: "openChangeDiff", turn: review.turn, fileId: file.id })}
                            >
                                <span className={`dsh-change-status ${file.status}`}>{CHANGE_LABELS[file.status]}</span>
                                <span className="dsh-change-path">{file.status === "renamed" && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
                            </button>
                        ))}
                    </section>
                );
            })}
        </div>
    );
}
