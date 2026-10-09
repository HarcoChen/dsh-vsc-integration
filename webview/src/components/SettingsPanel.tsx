import React, { useEffect, useMemo, useRef, useState } from "react";
import type { DshSettingFieldView, DshSettingsCardView, DshSettingsPanelView } from "../../../src/types";
import { postAction } from "../bridge";
import { PluginInventoryPanel } from "./PluginInventoryPanel";
import { t } from "../i18n";
import { CloseIcon, ExternalLinkIcon, PluginIcon, PlusIcon } from "./icons";

function fieldKey(field: DshSettingFieldView): string {
    return field.path.join("\u0000");
}

function SettingsCard({ card, writable }: { card: DshSettingsCardView; writable: boolean }): React.JSX.Element {
    const [open, setOpen] = useState(false);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const signature = `${card.revision}:${card.fields.map((field) => `${fieldKey(field)}=${field.value}`).join("|")}`;
    useEffect(() => {
        setDrafts(Object.fromEntries(card.fields.map((field) => [fieldKey(field), field.value])));
    }, [signature]);
    const changes = useMemo(
        () => card.fields
            .filter((field) => !field.secret && drafts[fieldKey(field)] !== field.value)
            .map((field) => {
                const value = drafts[fieldKey(field)] ?? "";
                return {
                    path: field.path,
                    value,
                    clear: value.length === 0,
                };
            }),
        [card.fields, drafts],
    );
    return (
        <section className={`dsh-settings-card${open ? " open" : ""}`}>
            <button
                type="button"
                className="dsh-settings-card-head"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
            >
                <span>
                    <strong>{card.title}</strong>
                    <small>{card.ns} · {card.applies === "restart" ? t("Applies after restart") : t("Applies immediately")}</small>
                </span>
                {changes.length ? <em>{t("Unsaved")}</em> : null}
                <span aria-hidden="true">{open ? "⌃" : "⌄"}</span>
            </button>
            {open ? (
                <div className="dsh-settings-card-body">
                    {!writable || !card.writable ? <div className="dsh-settings-readonly">{t("Settings are read-only")}</div> : null}
                    {card.fields.length === 0 ? <div className="dsh-settings-empty">{t("No editable settings exposed")}</div> : null}
                    {card.fields.map((field) => {
                        const key = fieldKey(field);
                        if (field.secret) {
                            return (
                                <div className="dsh-settings-field" key={key}>
                                    <div className="dsh-settings-field-head">
                                        <strong>{field.label}</strong>
                                        <span>{field.secretSet ? t("Configured") : t("Not configured")}</span>
                                    </div>
                                    <small>{t("Secret values are managed by the credential provider and never shown here.")}</small>
                                </div>
                            );
                        }
                        const value = drafts[key] ?? field.value;
                        return (
                            <label className="dsh-settings-field" key={key}>
                                <span className="dsh-settings-field-head">
                                    <strong>{field.label}</strong>
                                    {field.overridden ? <em>{t("Overridden")}</em> : null}
                                </span>
                                {field.type === "boolean" ? (
                                    <select
                                        value={value}
                                        disabled={!writable || !card.writable}
                                        onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))}
                                    >
                                        <option value="true">true</option>
                                        <option value="false">false</option>
                                    </select>
                                ) : field.type === "json" ? (
                                    <textarea
                                        value={value}
                                        disabled={!writable || !card.writable}
                                        onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))}
                                    />
                                ) : (
                                    <input
                                        type={field.type === "number" ? "number" : "text"}
                                        value={value}
                                        disabled={!writable || !card.writable}
                                        onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))}
                                    />
                                )}
                                <small>{field.description || field.path.join(".")}</small>
                                {field.overridden ? (
                                    <button
                                        type="button"
                                        className="dsh-settings-reset"
                                        disabled={!writable || !card.writable}
                                        onClick={() => setDrafts((current) => ({ ...current, [key]: "" }))}
                                    >
                                        {t("Reset")}
                                    </button>
                                ) : null}
                            </label>
                        );
                    })}
                    <div className="dsh-settings-card-actions">
                        <button
                            type="button"
                            disabled={!changes.length || !writable || !card.writable}
                            onClick={() => postAction({
                                type: "mutateSettings",
                                ns: card.ns,
                                revision: card.revision,
                                changes,
                            })}
                        >
                            {t("Save")}
                        </button>
                        <button
                            type="button"
                            disabled={!changes.length}
                            onClick={() => setDrafts(Object.fromEntries(card.fields.map((field) => [fieldKey(field), field.value])))}
                        >
                            {t("Discard")}
                        </button>
                    </div>
                </div>
            ) : null}
        </section>
    );
}

export function SettingsPanel({ settings }: { settings: DshSettingsPanelView }): React.JSX.Element {
    const [view, setView] = useState<"plugins" | "configuration">("plugins");
    const closeRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        const previousFocus = document.activeElement;
        closeRef.current?.focus();
        return () => {
            if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
        };
    }, []);
    return (
        <section className="dsh-settings-panel" aria-label={t("Plugin settings")}>
            <div className="dsh-settings-panel-head">
                <span className="dsh-settings-heading-icon"><PluginIcon size={20} /></span>
                <div className="dsh-settings-heading">
                    <h2>{t("Plugins")}</h2>
                    <small>{t("Manage plugins and their configuration")}</small>
                </div>
                <button ref={closeRef} type="button" className="dsh-icon-button" title={t("Back to conversation")} aria-label={t("Back to conversation")} onClick={() => postAction({ type: "manageSettings" })}>
                    <CloseIcon size={16} />
                </button>
            </div>
            <div className="dsh-settings-views" role="group" aria-label={t("Plugin views")}>
                <button type="button" id="dsh-plugin-inventory-view" aria-pressed={view === "plugins"} aria-controls="dsh-plugin-inventory-content" onClick={() => setView("plugins")}>
                    {t("Plugin inventory")}
                </button>
                <button type="button" id="dsh-plugin-configuration-view" aria-pressed={view === "configuration"} aria-controls="dsh-plugin-configuration-content" onClick={() => setView("configuration")}>
                    {t("Plugin configuration")}
                    {settings.cards.length > 0 ? <span className="dsh-settings-count">{settings.cards.length}</span> : null}
                </button>
            </div>
            <div className="dsh-settings-content">
                <section id="dsh-plugin-inventory-content" aria-labelledby="dsh-plugin-inventory-view" hidden={view !== "plugins"}>
                    <div className="dsh-settings-section-head">
                        <div>
                            <h3>{t("Runtime plugins")}</h3>
                            <p>{t("Enable or disable Runtime plugins and bundles")}</p>
                        </div>
                        <button type="button" className="dsh-button dsh-settings-install" title={t("Install or remove plugins")} onClick={() => postAction({ type: "managePlugins" })}>
                            <PlusIcon />{t("Manage")}
                        </button>
                    </div>
                    {settings.pluginInventory ? <PluginInventoryPanel inventory={settings.pluginInventory} /> : (
                        <div className={settings.loading ? "dsh-settings-loading" : "dsh-settings-empty"} role="status">
                            {t(settings.loading ? "Reading plugins..." : "Plugins are temporarily unavailable.")}
                        </div>
                    )}
                </section>
                <section id="dsh-plugin-configuration-content" aria-labelledby="dsh-plugin-configuration-view" hidden={view !== "configuration"}>
                    <div className="dsh-settings-section-head">
                        <div><h3>{t("Plugin settings")}</h3><p>{t("Configure the plugins available in this Runtime")}</p></div>
                    </div>
                    {settings.loading ? <div className="dsh-settings-loading" role="status">{t("Loading...")}</div> : null}
                    {!settings.loading && !settings.error && settings.cards.length === 0 ? (
                        <div className="dsh-settings-empty-state">
                            <span className="dsh-settings-empty-icon"><PluginIcon size={24} /></span>
                            <strong>{t("No plugin settings exposed")}</strong>
                            <p>{t("Plugin configuration will appear here when available.")}</p>
                        </div>
                    ) : null}
                    <div className="dsh-settings-cards">
                        {settings.cards.map((card) => <SettingsCard key={card.ns} card={card} writable={settings.writable} />)}
                    </div>
                </section>
                {settings.error ? <div className="dsh-settings-error" role="alert">{settings.error}</div> : null}
            </div>
            <div className="dsh-settings-panel-footer">
                <span>dsh Web UI</span>
                <button type="button" className="dsh-settings-document" title={t("Open advanced configuration in the dsh Web UI")} onClick={() => postAction({ type: "openBrowser" })}>
                    {t("Advanced configuration")}<ExternalLinkIcon />
                </button>
            </div>
        </section>
    );
}
