import React from "react";
import type { ChatViewState } from "../../../src/types";
import { postAction } from "../bridge";
import { t } from "../i18n";

export function StatusBanner({ state }: { state: ChatViewState }): React.JSX.Element | null {
    const runtimeError = state.status.state === "error" ? state.status.message : undefined;
    const sessionError = state.sessionStatus?.error;
    const message = sessionError || runtimeError;
    if (!message) return null;
    return (
        <div className="dsh-status-banner" role="alert">
            <span>{message}</span>
            <button
                type="button"
                className="dsh-button dsh-button-secondary"
                onClick={() => postAction({ type: sessionError ? "openLogs" : "start" })}
            >
                {sessionError ? t("Open runtime logs") : t("Retry")}
            </button>
        </div>
    );
}
