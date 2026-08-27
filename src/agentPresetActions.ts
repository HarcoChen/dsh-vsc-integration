/**
 * The "Manage Agent Presets" QuickPick flow.
 *
 * An Agent Preset is the composition a Session's agent runs. Harness owns the
 * preset files; the editor only browses them, copies a system preset into an
 * editable user one, and hands the user off to the Harness-owned directory —
 * it never authors composition text itself.
 */

import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { DshRuntime } from "./dshRuntime";
import { errorMessage } from "./errors";
import { t } from "./localize";
import { DshAgentPresetEntry } from "./types";

/** Preset ids double as directory names, so they stay lowercase and slug-like. */
const AGENT_PRESET_ID = /^[a-z0-9][a-z0-9-]*$/u;

/** Scheme of the read-only composition snapshots {@link manageAgentPresets} opens. */
export const AGENT_PRESET_DOCUMENT_SCHEME = "dsh-agent-preset";

/**
 * What these flows need from the chat view: the runtime, a log, the current
 * folder, and three notifications for view state a preset edit touches — the
 * cached catalog, the snapshot documents the view serves, and the pending New
 * Session draft, which pins a preset by id.
 */
export interface AgentPresetActionsHost {
    readonly runtime: DshRuntime;
    readonly output: vscode.OutputChannel;
    workspaceRoot(): string | undefined;
    /** The picker just pulled a fresh catalog; the view may cache it. */
    onCatalog(presets: readonly DshAgentPresetEntry[]): void;
    /** Body of a read-only snapshot document, to serve under this exact URI. */
    onSnapshotDocument(uri: string, content: string): void;
    /** A user Preset was deleted; a draft pinned to it must be cleared. */
    onPresetRemoved(presetId: string): void;
}

type PresetAction = "view" | "copy" | "open" | "default" | "remove";

/**
 * Lists Presets and loops until dismissed. Each pass re-pulls the catalog and
 * the settings-writability bit, because both change under the actions offered
 * here — making a Preset default writes a setting, and copying adds an entry.
 */
export async function manageAgentPresets(host: AgentPresetActionsHost): Promise<void> {
    await host.runtime.start(host.workspaceRoot());

    while (true) {
        const [catalog, settingsWritable] = await Promise.all([
            host.runtime.agentPresets(),
            host.runtime.describeSettings()
                .then((settings) => settings.writable)
                .catch((error) => {
                    // A deployment may expose no settings surface at all. That
                    // only removes "Make default"; the rest stays usable.
                    host.output.appendLine(`[dsh:agent-preset] settings status unavailable: ${errorMessage(error)}`);
                    return false;
                }),
        ]);
        host.onCatalog(catalog.presets);
        if (catalog.presets.length === 0) {
            void vscode.window.showInformationMessage(t("Harness returned no Agent Presets to manage."));
            return;
        }
        const selected = await vscode.window.showQuickPick(
            catalog.presets.map((preset) => ({
                label: `${preset.broken ? "$(error)" : preset.trust === "system" ? "$(verified)" : "$(person)"} ${preset.name || preset.id}`,
                description: [
                    preset.id,
                    preset.trust === "system" ? t("System") : t("User"),
                    ...(preset.isDefault ? [t("Default")] : []),
                ].join(" · "),
                detail: preset.broken
                    ? t("Broken: {reason}", { reason: preset.broken })
                    : preset.description,
                preset,
            })),
            {
                title: t("Manage Agent Presets"),
                placeHolder: t("Choose an Agent Preset to manage"),
                matchOnDescription: true,
                matchOnDetail: true,
            },
        );
        if (!selected) return;

        const action = await chooseAgentPresetAction(
            selected.preset,
            catalog.authorable,
            settingsWritable,
        );
        if (!action) continue;
        if (action === "view") {
            await viewAgentPreset(host, selected.preset);
        } else if (action === "copy") {
            await copyAgentPreset(host, selected.preset, catalog.presets);
        } else if (action === "open") {
            await openAgentPresetLocation(host.runtime, selected.preset.id);
        } else if (action === "default") {
            await host.runtime.setDefaultAgentPreset(selected.preset.id);
            void vscode.window.showInformationMessage(t("DSH: {preset} is now the default Agent Preset.", {
                preset: selected.preset.name || selected.preset.id,
            }));
        } else {
            await removeAgentPreset(host, selected.preset);
        }
    }
}

/**
 * Offers only what this Preset permits: viewing always; copying when the
 * deployment allows authoring; defaulting when the Preset is usable, is not
 * already default, and settings are writable; editing and deleting only for
 * user Presets, since system ones are not the editor's to change.
 */
async function chooseAgentPresetAction(
    preset: DshAgentPresetEntry,
    authorable: boolean,
    settingsWritable: boolean,
): Promise<PresetAction | undefined> {
    const actions: Array<vscode.QuickPickItem & { action: PresetAction }> = [{
        action: "view",
        label: `$(preview) ${t("View composition")}`,
        detail: t("Open a read-only snapshot of this Preset"),
    }];
    if (authorable) {
        actions.push({
            action: "copy",
            label: `$(copy) ${t("Copy as a user Preset")}`,
            detail: t("Create an editable Preset from this composition"),
        });
    }
    if (!preset.broken && !preset.isDefault && settingsWritable) {
        actions.push({
            action: "default",
            label: `$(star-full) ${t("Make default")}`,
            detail: t("Use this Preset for future Sessions without an explicit mode"),
        });
    }
    if (preset.trust === "user") {
        actions.push({
            action: "open",
            label: `$(folder-opened) ${t("Open Preset files")}`,
            detail: t("Edit this user Preset in its Harness-owned directory"),
        });
        actions.push({
            action: "remove",
            label: `$(trash) ${t("Delete user Preset")}`,
            detail: t("Existing Sessions keep their mounted composition"),
        });
    }
    const selected = await vscode.window.showQuickPick(actions, {
        title: preset.name || preset.id,
        placeHolder: preset.broken
            ? t("Broken: {reason}", { reason: preset.broken })
            : t("Choose an action"),
    });
    return selected?.action;
}

/**
 * Opens the composed tree as a read-only document. The URI carries a fresh
 * snapshot id so reopening a Preset after editing it shows the new
 * composition instead of VS Code's cached document for the same URI.
 */
async function viewAgentPreset(
    host: AgentPresetActionsHost,
    preset: DshAgentPresetEntry,
): Promise<void> {
    const result = await host.runtime.readAgentPreset(preset.id);
    const uri = vscode.Uri.from({
        scheme: AGENT_PRESET_DOCUMENT_SCHEME,
        path: `/${preset.id}.yaml`,
        query: `snapshot=${randomUUID()}`,
    });
    host.onSnapshotDocument(uri.toString(), result.content);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
}

/**
 * Copy is the only authoring path: the editor never writes composition text,
 * it asks Harness to duplicate one and then opens the result for editing.
 */
async function copyAgentPreset(
    host: AgentPresetActionsHost,
    source: DshAgentPresetEntry,
    presets: readonly DshAgentPresetEntry[],
): Promise<void> {
    const id = await vscode.window.showInputBox({
        title: t("Copy Agent Preset {preset}", { preset: source.name || source.id }),
        prompt: t("Choose the new Preset ID used as its directory name"),
        value: `${source.id}-copy`,
        ignoreFocusOut: true,
        validateInput: (value) => {
            const normalized = value.trim();
            if (!normalized) return t("Enter a Preset ID.");
            if (normalized.length > 128 || !AGENT_PRESET_ID.test(normalized)) {
                return t("Use lowercase letters, numbers, and hyphens; start with a letter or number.");
            }
            if (presets.some((preset) => preset.id === normalized)) {
                return t("An Agent Preset with this ID already exists.");
            }
            return undefined;
        },
    });
    if (id === undefined) return;
    const name = await vscode.window.showInputBox({
        title: t("Name the new Agent Preset"),
        prompt: t("Optional display name; leave empty to use the Preset ID"),
        ignoreFocusOut: true,
    });
    if (name === undefined) return;

    const created = await host.runtime.copyAgentPreset(
        source.id,
        id.trim(),
        name.trim() || undefined,
    );
    void vscode.window.showInformationMessage(t("DSH: Agent Preset {preset} was created.", {
        preset: created,
    }));
    await openAgentPresetLocation(host.runtime, created);
}

/**
 * Asks the host to reveal the Preset directory. A headless or remote host
 * cannot open a desktop path, so its reported path is offered for copying
 * instead of being silently dropped.
 */
export async function openAgentPresetLocation(
    runtime: DshRuntime,
    agentPreset: string,
): Promise<void> {
    const result = await runtime.openAgentPresetDocument(agentPreset);
    if (result.opened) return;
    const copy = t("Copy path");
    const selected = await vscode.window.showInformationMessage(
        t("Agent Preset files: {path}", { path: result.path }),
        copy,
    );
    if (selected === copy) await vscode.env.clipboard.writeText(result.path);
}

async function removeAgentPreset(
    host: AgentPresetActionsHost,
    preset: DshAgentPresetEntry,
): Promise<void> {
    if (preset.trust !== "user") return;
    const remove = t("Delete user Preset");
    const confirmed = await vscode.window.showWarningMessage(
        t("Delete user Agent Preset {preset}?", { preset: preset.name || preset.id }),
        {
            modal: true,
            detail: t("Its files will be removed. Existing Sessions keep their currently mounted composition."),
        },
        remove,
    );
    if (confirmed !== remove) return;
    await host.runtime.removeAgentPreset(preset.id);
    host.onPresetRemoved(preset.id);
    void vscode.window.showInformationMessage(t("DSH: Agent Preset {preset} was deleted.", {
        preset: preset.name || preset.id,
    }));
}
