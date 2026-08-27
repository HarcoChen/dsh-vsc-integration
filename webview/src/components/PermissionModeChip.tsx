import React from "react";
import type { ChatViewState } from "../../../src/types";
import { postAction } from "../bridge";
import { t } from "../i18n";

/**
 * Always-visible indicator of the session's permission preset, and the fastest
 * way to change it.
 *
 * Clicking advances to the next selectable preset rather than opening a menu:
 * the shipped table is small (workspace-write / danger-full-access) and the
 * value is one a reader checks far more often than they change. `custom` is a
 * derived value the host reports when the underlying knobs match no entry — it
 * displays, but cycling skips it because it cannot be selected.
 */
export function PermissionModeChip({
    permissions,
    switchable,
}: {
    permissions: ChatViewState["permissions"];
    switchable: boolean;
}): React.JSX.Element | null {
    if (!permissions) return null;
    const selectable = permissions.options.filter((option) => option.value !== "custom");
    const label = t("Permissions: {preset}", { preset: permissions.currentLabel });
    if (!switchable || selectable.length < 2) {
        return <span className="dsh-permission-chip">{label}</span>;
    }
    const index = selectable.findIndex((option) => option.value === permissions.currentValue);
    // An unmatched current value (custom) starts the cycle at the first entry.
    const next = selectable[(index + 1) % selectable.length]!;
    return (
        <button
            type="button"
            className="dsh-permission-chip"
            title={t("Switch to {preset}", { preset: next.label })}
            onClick={() => postAction({ type: "setPermissionPreset", value: next.value })}
        >
            {label}
        </button>
    );
}
