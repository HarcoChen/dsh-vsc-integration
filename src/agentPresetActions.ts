/** Read and select Agent Presets exposed by the composed Harness Runtime. */

import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { DshRuntime } from "./dshRuntime";
import { errorMessage } from "./errors";
import { t } from "./localize";
import { DshAgentPresetEntry } from "./types";

/** Scheme of the read-only composition snapshots opened by {@link manageAgentPresets}. */
export const AGENT_PRESET_DOCUMENT_SCHEME = "dsh-agent-preset";

export interface AgentPresetActionsHost {
    readonly runtime: DshRuntime;
    readonly output: vscode.OutputChannel;
    workspaceRoot(): string | undefined;
    onCatalog(presets: readonly DshAgentPresetEntry[], modeSelectionEnabled: boolean): void;
    onSnapshotDocument(uri: string, content: string): void;
}

type PresetAction = "view" | "default";

/** Browse the Host-owned roster, inspect compositions, or choose its default. */
export async function manageAgentPresets(host: AgentPresetActionsHost): Promise<void> {
    await host.runtime.start(host.workspaceRoot());

    while (true) {
        const [catalog, settings] = await Promise.all([
            host.runtime.agentPresets(),
            host.runtime.describeSettings()
                .catch((error) => {
                    host.output.appendLine(`[dsh:agent-preset] settings status unavailable: ${errorMessage(error)}`);
                    return undefined;
                }),
        ]);
        const presetSettingsNamespace = settings?.namespaces.some((item) => item.ns === "agent-preset-registry")
            ? "agent-preset-registry"
            : settings?.namespaces.some((item) => item.ns === "agent-presets")
                ? "agent-presets"
                : undefined;
        host.onCatalog(catalog.presets, catalog.modeSelectionEnabled !== false);
        if (catalog.presets.length === 0) {
            void vscode.window.showInformationMessage(t("Harness returned no Agent Presets to manage."));
            return;
        }

        const selected = await vscode.window.showQuickPick(
            catalog.presets.map((preset) => ({
                label: `${preset.broken ? "$(error)" : "$(person)"} ${preset.name || preset.id}`,
                description: [preset.id, ...(preset.isDefault ? [t("Default")] : [])].join(" · "),
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
            settings?.writable === true && presetSettingsNamespace !== undefined &&
                catalog.modeSelectionEnabled !== false,
        );
        if (action === "view") {
            await viewAgentPreset(host, selected.preset);
        } else if (action === "default") {
            if (presetSettingsNamespace === undefined) continue;
            await host.runtime.setDefaultAgentPreset(selected.preset.id, presetSettingsNamespace);
            void vscode.window.showInformationMessage(t("DSH: {preset} is now the default Agent Preset.", {
                preset: selected.preset.name || selected.preset.id,
            }));
        }
    }
}

async function chooseAgentPresetAction(
    preset: DshAgentPresetEntry,
    settingsWritable: boolean,
): Promise<PresetAction | undefined> {
    const actions: Array<vscode.QuickPickItem & { action: PresetAction }> = [{
        action: "view",
        label: `$(preview) ${t("View composition")}`,
        detail: t("Open a read-only snapshot of this Preset"),
    }];
    if (!preset.broken && !preset.isDefault && settingsWritable) {
        actions.push({
            action: "default",
            label: `$(star-full) ${t("Make default")}`,
            detail: t("Use this Preset for future Sessions without an explicit mode"),
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
