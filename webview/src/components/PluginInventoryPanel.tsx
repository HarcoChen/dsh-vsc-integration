import React, { useEffect, useMemo, useState } from "react";
import type {
    DshPluginFiberPhase,
    DshPluginInventoryEntry,
    DshPluginInventoryPanelView,
    DshPluginInventoryPreset,
    DshPluginInventoryRow,
    DshPluginBundleInfo,
    DshManagedPluginInfo,
} from "../../../src/types";
import { postAction } from "../bridge";
import { t } from "../i18n";
import { PluginIcon, RefreshIcon, SearchIcon } from "./icons";

const PHASE_LABELS: Readonly<Record<Exclude<DshPluginFiberPhase, null>, string>> = {
    pending: "Waiting for dependencies",
    loading: "Loading",
    active: "Running",
    failed: "Failed to start",
    unloading: "Unloading",
};

function phaseLabel(phase: DshPluginFiberPhase): string {
    return phase === null ? t("Not running") : t(PHASE_LABELS[phase]);
}

function readOnlyLabel(reason: string): string {
    if (reason === "management-required") return t("Required by plugin management");
    if (reason === "unaddressable") return t("This row cannot be addressed by the profile patch");
    return reason;
}

function moduleShortName(moduleName: string): string {
    const unscoped = moduleName.startsWith("@") && moduleName.includes("/")
        ? moduleName.slice(moduleName.indexOf("/") + 1)
        : moduleName;
    return unscoped
        .replace(/^cordis:/u, "")
        .replace(/^cordis-plugin-/u, "")
        .replace(/^dsh-(?:host-|client-)?/u, "");
}

function presetName(preset: DshPluginInventoryPreset): string {
    return preset.name?.trim() || preset.id;
}

function presetLabel(preset: DshPluginInventoryPreset): string {
    const name = presetName(preset);
    if (preset.broken !== undefined) return t("{name} (failed to load)", { name });
    return preset.isDefault ? t("{name} (default)", { name }) : name;
}

function matches(moduleName: string, entryId: string | null | undefined, query: string): boolean {
    if (!query) return true;
    return [moduleName, ...(entryId === null || entryId === undefined ? [] : [entryId])]
        .some((value) => value.toLocaleLowerCase().includes(query));
}

function statusLabel(
    enabled: boolean | "conditional",
    failed: boolean,
): string {
    if (failed) return t("Failed to start");
    if (enabled === "conditional") return t("Conditional");
    return enabled ? t("Enabled") : t("Disabled");
}

function InventoryCard({
    moduleName,
    entryId,
    status,
    phase,
    facts,
}: {
    moduleName: string;
    entryId: string | null;
    status: string;
    phase?: DshPluginFiberPhase;
    facts: ReadonlyArray<readonly [string, React.ReactNode]>;
}): React.JSX.Element {
    const failed = phase === "failed";
    return (
        <details className={`dsh-plugin-card${failed ? " failed" : ""}`}>
            <summary className="dsh-plugin-card-summary">
                <strong title={moduleName}>{moduleShortName(moduleName)}</strong>
                <span>
                    {status}
                    {phase !== undefined && phase !== null ? ` · ${phaseLabel(phase)}` : ""}
                </span>
            </summary>
            <div className="dsh-plugin-card-details">
                {entryId !== null ? <code>{entryId}</code> : null}
                <dl>
                    {facts.map(([label, value]) => (
                        <div key={label}>
                            <dt>{label}</dt>
                            <dd>{value}</dd>
                        </div>
                    ))}
                </dl>
            </div>
        </details>
    );
}

function presetRowCard(preset: DshPluginInventoryPreset, row: DshPluginInventoryRow, index: number): React.JSX.Element {
    const failed = row.fiberPhase === "failed";
    const status = statusLabel(row.enabled, failed);
    return (
        <li key={`${preset.id}:${String(index)}`}>
            <InventoryCard
                moduleName={row.moduleName}
                entryId={row.entryId}
                status={status}
                phase={row.fiberPhase}
                facts={[
                    [t("Module"), row.moduleName],
                    [t("From"), presetName(preset)],
                    [t("Configuration"), status],
                    ...(row.fiberPhase === null ? [] : [[t("Status"), phaseLabel(row.fiberPhase)] as const]),
                    ...(row.condition === undefined ? [] : [[t("Disabled when"), <code key="condition">{row.condition}</code>] as const]),
                ]}
            />
        </li>
    );
}

function globalEntryCard(
    entry: DshPluginInventoryEntry,
    enabledIn: readonly string[] | undefined,
    managed: DshManagedPluginInfo | undefined,
    mutation: DshPluginInventoryPanelView["mutation"],
): React.JSX.Element {
    const failed = entry.fiberPhase === "failed";
    const presetProvided = !entry.enabled && enabledIn !== undefined && enabledIn.length > 0;
    const status = failed
        ? t("Failed to start")
        : presetProvided
          ? t("Enabled via presets")
          : entry.enabled
            ? t("Enabled")
            : t("Disabled");
    const phase = entry.enabled || failed ? entry.fiberPhase : undefined;
    const facts: Array<readonly [string, React.ReactNode]> = [
        [t("Module"), entry.moduleName],
        [t("Configuration"), presetProvided ? t("Preset provides this plugin") : status],
    ];
    if (presetProvided) {
        facts.push([t("Enabled in"), enabledIn?.join(" · ") ?? ""]);
    } else if (phase !== undefined) {
        facts.push([t("Status"), phaseLabel(phase)]);
    }
    if (managed?.patchId !== undefined) facts.push([t("Patch row"), managed.patchId]);
    if (managed?.readOnlyReason !== undefined) facts.push([t("Read-only"), readOnlyLabel(managed.readOnlyReason)]);
    return (
        <li key={entry.entryId}>
            <InventoryCard
                moduleName={entry.moduleName}
                entryId={entry.entryId}
                status={status}
                phase={phase}
                facts={facts}
            />
            {managed ? <button
                type="button"
                className="dsh-button dsh-button-secondary"
                title={managed.readOnlyReason === undefined ? undefined : readOnlyLabel(managed.readOnlyReason)}
                disabled={managed.readOnlyReason !== undefined || mutation?.pending === true}
                onClick={() => postAction({ type: "setPluginEnabled", entryId: managed.entryId, enabled: !managed.enabled })}
            >
                {managed.enabled ? t("Disable") : t("Enable")}
            </button> : null}
        </li>
    );
}

function bundleCard(bundle: DshPluginBundleInfo, mutation: DshPluginInventoryPanelView["mutation"]): React.JSX.Element {
    const status = bundle.errorCode
        ? t("Error: {code}", { code: bundle.errorCode })
        : bundle.enabled
          ? t("Enabled")
          : bundle.installed
            ? t("Installed")
            : bundle.optional
              ? t("Available")
              : t("Dependency");
    return (
        <li key={bundle.name}>
            <InventoryCard
                moduleName={bundle.name}
                entryId={null}
                status={status}
                facts={[
                    [t("Bundle"), bundle.name],
                    ...(bundle.version === undefined ? [] : [[t("Version"), bundle.version] as const]),
                    ...(bundle.description === undefined ? [] : [[t("Description"), bundle.description] as const]),
                    [t("Activation"), bundle.enabled ? t("Selected in this profile") : t("Not selected")],
                    ...(bundle.readOnlyReason === undefined ? [] : [[t("Read-only"), readOnlyLabel(bundle.readOnlyReason)] as const]),
                ]}
            />
            <button
                type="button"
                className="dsh-button dsh-button-secondary"
                title={bundle.readOnlyReason === undefined ? undefined : readOnlyLabel(bundle.readOnlyReason)}
                disabled={bundle.readOnlyReason !== undefined || mutation?.pending === true || (!bundle.enabled && bundle.errorCode !== undefined)}
                onClick={() => postAction({ type: "setBundleEnabled", name: bundle.name, enabled: !bundle.enabled })}
            >
                {bundle.enabled ? t("Deselect bundle") : t("Select bundle")}
            </button>
        </li>
    );
}

export function PluginInventoryPanel({ inventory }: { inventory: DshPluginInventoryPanelView }): React.JSX.Element {
    const [query, setQuery] = useState("");
    const [selectedPresetId, setSelectedPresetId] = useState<string | undefined>();
    const presets = inventory.agentPresets ?? [];
    const bundles = inventory.bundles ?? [];
    const managedById = useMemo(() => new Map(
        (inventory.managedPlugins ?? []).map((plugin) => [plugin.entryId, plugin]),
    ), [inventory.managedPlugins]);
    const fallbackPreset = presets.find((preset) => preset.isDefault) ?? presets[0];
    const selectedPreset = presets.find((preset) => preset.id === selectedPresetId) ?? fallbackPreset;
    const normalizedQuery = query.trim().toLocaleLowerCase();

    useEffect(() => {
        if (selectedPreset?.id !== selectedPresetId) setSelectedPresetId(selectedPreset?.id);
    }, [selectedPreset?.id, selectedPresetId]);

    const enabledIn = useMemo(() => {
        const found = new Map<string, string[]>();
        for (const preset of presets) {
            for (const row of preset.rows) {
                if (row.enabled !== true) continue;
                const names = found.get(row.moduleName) ?? [];
                if (!names.includes(presetName(preset))) names.push(presetName(preset));
                found.set(row.moduleName, names);
            }
        }
        return found;
    }, [presets]);

    const failedEntries = inventory.entries.filter((entry) => entry.fiberPhase === "failed" && matches(entry.moduleName, entry.entryId, normalizedQuery));
    const regularEntries = inventory.entries.filter((entry) => entry.fiberPhase !== "failed" && matches(entry.moduleName, entry.entryId, normalizedQuery));
    const selectedRows = selectedPreset?.rows.filter((row) => matches(row.moduleName, row.entryId, normalizedQuery)) ?? [];
    const otherPresetMatches = normalizedQuery
        ? presets.filter((preset) => preset !== selectedPreset && preset.rows.some((row) => matches(row.moduleName, row.entryId, normalizedQuery)))
        : [];
    const otherMatchCount = otherPresetMatches.reduce(
        (total, preset) => total + preset.rows.filter((row) => matches(row.moduleName, row.entryId, normalizedQuery)).length,
        0,
    );
    const matchingBundles = bundles.filter((bundle) => matches(bundle.name, null, normalizedQuery));
    const hasMatches = failedEntries.length > 0 || regularEntries.length > 0 || selectedRows.length > 0 || otherMatchCount > 0 || matchingBundles.length > 0;

    return (
        <section className="dsh-plugin-inventory" aria-label={t("Plugin inventory")}>
            <div className="dsh-plugin-inventory-toolbar">
                <label className="dsh-plugin-inventory-search">
                    <SearchIcon size={15} />
                    <input
                        type="search"
                        value={query}
                        aria-label={t("Search plugins")}
                        placeholder={t("Search plugins")}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </label>
                <button
                    type="button"
                    className="dsh-icon-button dsh-plugin-refresh"
                    disabled={inventory.loading}
                    title={t("Refresh plugin inventory")}
                    aria-label={t("Refresh plugin inventory")}
                    onClick={() => postAction({ type: "refreshPluginInventory" })}
                >
                    <RefreshIcon />
                </button>
            </div>
            {inventory.mutation?.pending ? <div className="dsh-card-detail">{t("Applying plugin change...")}</div> : null}
            {inventory.mutation?.message ? <div role="status" className={inventory.mutation.failed ? "dsh-settings-error" : "dsh-card-detail"}>{inventory.mutation.message}</div> : null}
            {inventory.mutation?.restartRequired ? <button type="button" className="dsh-button" onClick={() => postAction({ type: "restartRuntime" })}>{t("Restart Runtime")}</button> : null}
            {inventory.loading ? <div className="dsh-settings-loading" role="status">{t("Reading plugins...")}</div> : null}
            {inventory.error ? (
                <div className="dsh-settings-error" role="alert">
                    <span>{inventory.error}</span>
                    <button type="button" className="dsh-button dsh-button-secondary" disabled={inventory.loading} onClick={() => postAction({ type: "refreshPluginInventory" })}>{t("Retry")}</button>
                </div>
            ) : null}
            {!inventory.loading && !inventory.error ? <>
                {!normalizedQuery && inventory.entries.length === 0 && presets.length === 0 && bundles.length === 0 ? (
                    <div className="dsh-settings-empty-state">
                        <span className="dsh-settings-empty-icon"><PluginIcon size={24} /></span>
                        <strong>{t("No plugins are available.")}</strong>
                        <p>{t("Add a plugin bundle to extend your Runtime.")}</p>
                        <button type="button" className="dsh-button dsh-button-secondary" onClick={() => postAction({ type: "managePlugins" })}>{t("Install or remove plugins")}</button>
                    </div>
                ) : null}
                {normalizedQuery && !hasMatches ? (
                    <div className="dsh-settings-empty-state" role="status">
                        <span className="dsh-settings-empty-icon"><SearchIcon size={24} /></span>
                        <strong>{t("No matching plugins.")}</strong>
                        <button type="button" className="dsh-button dsh-button-secondary" onClick={() => setQuery("")}>{t("Clear search")}</button>
                    </div>
                ) : null}

                {matchingBundles.length > 0 ? (
                    <details className="dsh-plugin-group" open>
                        <summary>
                            <strong>{t("Runtime bundles")}</strong>
                            <span>{t("{count} bundles", { count: matchingBundles.length })}</span>
                        </summary>
                        <small>{t("Choose the bundles used by this Runtime profile")}</small>
                        <ul className="dsh-plugin-cards">
                            {matchingBundles.map((bundle) => bundleCard(bundle, inventory.mutation))}
                        </ul>
                    </details>
                ) : null}

                {selectedPreset ? (
                    <details className="dsh-plugin-group" open>
                        <summary>
                            <strong>{t("Session plugins")}</strong>
                            <span>{t("{count} plugins", { count: selectedRows.length })}</span>
                        </summary>
                        <div className="dsh-plugin-group-head">
                            <small>{t("Composed per session by agent presets")}</small>
                            <select
                                aria-label={t("Choose agent preset")}
                                value={selectedPreset.id}
                                onChange={(event) => setSelectedPresetId(event.target.value)}
                            >
                                {presets.map((preset) => <option key={preset.id} value={preset.id}>{presetLabel(preset)}</option>)}
                            </select>
                        </div>
                        {selectedPreset.broken !== undefined ? <div className="dsh-plugin-broken" role="alert">{selectedPreset.broken}</div> : null}
                        {selectedRows.length > 0 ? (
                            <ul className="dsh-plugin-cards">
                                {selectedRows.map((row, index) => presetRowCard(selectedPreset, row, index))}
                            </ul>
                        ) : null}
                        {otherMatchCount > 0 ? (
                            <div className="dsh-plugin-hint">
                                {t("{count} more matches in other presets", { count: otherMatchCount })}
                                {otherPresetMatches.map((preset) => (
                                    <button type="button" key={preset.id} onClick={() => setSelectedPresetId(preset.id)}>
                                        {presetName(preset)}
                                    </button>
                                ))}
                            </div>
                        ) : null}
                    </details>
                ) : null}

                {inventory.entries.length > 0 ? (
                    <details className="dsh-plugin-group" open={!selectedPreset}>
                        <summary>
                            <strong>{t("Global plugins")}</strong>
                            <span>{t("{count} plugins", { count: failedEntries.length + regularEntries.length })}</span>
                        </summary>
                        <small>{t("Shared by the system and every session")}</small>
                        {failedEntries.length + regularEntries.length > 0 ? (
                            <ul className="dsh-plugin-cards">
                                {failedEntries.map((entry) => globalEntryCard(entry, enabledIn.get(entry.moduleName), managedById.get(entry.entryId), inventory.mutation))}
                                {regularEntries.map((entry) => globalEntryCard(entry, enabledIn.get(entry.moduleName), managedById.get(entry.entryId), inventory.mutation))}
                            </ul>
                        ) : null}
                    </details>
                ) : null}
            </> : null}
        </section>
    );
}
