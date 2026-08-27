import React from "react";
import type { ChatViewState } from "../../../src/types";
import { postAction } from "../bridge";
import { t } from "../i18n";
import { ShieldIcon } from "./icons";

/**
 * Always-visible indicator of the session's permission preset, and the fastest
 * way to change it.
 *
 * The visible text is just the preset name next to a shield glyph — the
 * "Permissions:" qualifier lives in the tooltip/aria-label, since the chip
 * sits in a footer the reader already understands. Presets whose value
 * contains "danger" (danger-full-access) get a warning tint so the risky
 * state reads at a glance.
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
    const fullLabel = t("Permissions: {preset}", { preset: permissions.currentLabel });
    const danger = permissions.currentValue.includes("danger");
    const className = `dsh-permission-chip${danger ? " dsh-permission-chip-danger" : ""}`;
    const content = (
        <>
            <ShieldIcon />
            {permissions.currentLabel}
        </>
    );
    if (!switchable || selectable.length < 2) {
        return (
            <span className={className} title={fullLabel} aria-label={fullLabel}>
                {content}
            </span>
        );
    }
    const index = selectable.findIndex((option) => option.value === permissions.currentValue);
    // An unmatched current value (custom) starts the cycle at the first entry.
    const next = selectable[(index + 1) % selectable.length]!;
    return (
        <button
            type="button"
            className={className}
            title={t("Switch to {preset}", { preset: next.label })}
            aria-label={fullLabel}
            onClick={() => postAction({ type: "setPermissionPreset", value: next.value })}
        >
            {content}
        </button>
    );
}
