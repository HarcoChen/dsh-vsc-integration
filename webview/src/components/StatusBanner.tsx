import React, { useEffect, useState } from "react";
import { postAction } from "../bridge";
import { t } from "../i18n";
import type { StatusBannerState } from "../state";
import { CloseIcon } from "./icons";

export function StatusBanner({ status, sessionStatus }: StatusBannerState): React.JSX.Element | null {
    const runtimeError = status.state === "error" ? status.message : undefined;
    const sessionError = sessionStatus?.error;
    const message = sessionError || runtimeError;
    const messageKey = message ? `${sessionError ? "session" : "runtime"}:${message}` : undefined;
    const [dismissedKey, setDismissedKey] = useState<string>();

    // A dismissal applies only to the current error. A new error (or a changed
    // message after a retry) must become visible without requiring a reload.
    useEffect(() => {
        setDismissedKey(undefined);
    }, [messageKey]);

    if (!message || messageKey === dismissedKey) return null;
    const isSessionError = Boolean(sessionError);
    return (
        <div className="dsh-error-banner" role="alert" aria-live="assertive">
            <div className="dsh-error-banner-content">
                <span className="dsh-error-banner-message">{message}</span>
                <div className="dsh-error-banner-actions">
                    <button
                        type="button"
                        className="dsh-button dsh-button-secondary"
                        onClick={() => postAction({ type: isSessionError ? "openLogs" : "start" })}
                    >
                        {isSessionError ? t("View details") : t("Retry")}
                    </button>
                    <button
                        type="button"
                        className="dsh-icon-button"
                        aria-label={t("Dismiss")}
                        title={t("Dismiss")}
                        onClick={() => setDismissedKey(messageKey)}
                    >
                        <CloseIcon />
                    </button>
                </div>
            </div>
        </div>
    );
}
