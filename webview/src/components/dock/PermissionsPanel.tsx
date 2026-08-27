import React from "react";
import type { ChatViewState } from "../../../../src/types";
import { postAction } from "../../bridge";
import { t } from "../../i18n";

/**
 * The preset table, switchable in place.
 *
 * Switching runs the host's own `/permissionPresets` command, so the IDE and
 * every other client drive the same code path. `custom` is a derived value the
 * host reports when the two underlying knobs match no entry — it can be the
 * current value but is never selectable, so it renders without an action.
 */
export function PermissionsPanel({
    permissions,
    switchable,
}: {
    permissions: NonNullable<ChatViewState["permissions"]>;
    switchable: boolean;
}): React.JSX.Element {
    return (
        <div className="dsh-card">
            <div className="dsh-card-detail">{t("Current preset: {preset}", { preset: permissions.currentLabel })}</div>
            {permissions.options.map((option) => {
                const current = option.value === permissions.currentValue;
                const body = (
                    <>
                        <span>{option.label}{current ? t(" · current") : ""}</span>
                        {option.description ? <span className="dsh-card-detail">{option.description}</span> : null}
                    </>
                );
                if (!switchable || current) {
                    return (
                        <div className={`dsh-permission-option${current ? " active" : ""}`} key={option.value}>
                            {body}
                        </div>
                    );
                }
                return (
                    <button
                        type="button"
                        className="dsh-permission-option"
                        key={option.value}
                        title={t("Switch to {preset}", { preset: option.label })}
                        onClick={() => postAction({ type: "setPermissionPreset", value: option.value })}
                    >
                        {body}
                    </button>
                );
            })}
            {switchable ? null : (
                <div className="dsh-card-detail">
                    {t("The connected Runtime exposes no permission command, so switching happens in the dsh Web UI.")}
                </div>
            )}
        </div>
    );
}
