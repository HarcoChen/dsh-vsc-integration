import React from "react";
import type { ChatViewState } from "../../../../src/types";
import { t } from "../../i18n";

export function PermissionsPanel({ permissions }: { permissions: NonNullable<ChatViewState["permissions"]> }): React.JSX.Element {
    return (
        <div className="dsh-card">
            <div className="dsh-card-detail">{t("Current preset: {preset}", { preset: permissions.currentLabel })}</div>
            {permissions.options.map((option) => (
                <div className={`dsh-permission-option${option.value === permissions.currentValue ? " active" : ""}`} key={option.value}>
                    <span>{option.label}{option.value === permissions.currentValue ? t(" · current") : ""}</span>
                    {option.description ? <span className="dsh-card-detail">{option.description}</span> : null}
                </div>
            ))}
            <div className="dsh-card-detail">{t("Permission changes are handled by the public command in the Harness Web UI.")}</div>
        </div>
    );
}
