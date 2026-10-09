import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { DshRuntime } from "./dshRuntime";
import type { DshPluginChangeResult } from "./types";
import { isRecord } from "./guards";
import { errorMessage } from "./errors";
import { t } from "./localize";
import { RemoteHttpError } from "./remote/errors";

/** Install and remove bundles exclusively through the connected Host's official manager. */
export class PluginManagementController {
    private pending = false;
    public constructor(private readonly runtime: DshRuntime, private readonly output: vscode.OutputChannel,
        private readonly changed: () => Promise<void>) {}

    public async manage(): Promise<void> {
        if (this.pending) return;
        this.pending = true;
        try {
            const endpoint = this.runtime.getUrl();
            if (!endpoint) throw new Error(t("The Runtime is not connected."));
            const bundles = await this.runtime.pluginManagerBundles();
            this.assertEndpoint(endpoint);
            if (!bundles) throw new Error(t("This Runtime does not expose plugin management. Open its Web UI to manage plugins."));
            const selected = await vscode.window.showQuickPick([
                { label: `$(add) ${t("Install a plugin bundle")}`, action: "install", name: "" },
                ...bundles.filter(bundle => bundle.installed && bundle.removable && !bundle.readOnlyReason).map(bundle => ({
                    label: `$(trash) ${bundle.name}`, description: bundle.version, detail: bundle.description,
                    action: "remove", name: bundle.name,
                })),
            ], { title: t("Manage Runtime plugins"), placeHolder: t("Install a package or remove an installed bundle") });
            if (!selected) return;
            this.assertEndpoint(endpoint);
            if (selected.action === "install") await this.install(endpoint);
            else {
                const remove = t("Remove bundle");
                const confirmation = await vscode.window.showWarningMessage(t("Remove {name} from the connected Runtime profile?", { name: selected.name }),
                    { modal: true }, remove);
                if (confirmation !== remove) return;
                this.assertEndpoint(endpoint);
                const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
                    title: t("Removing {name}", { name: selected.name }) }, () => this.runtime.removePluginBundle(selected.name));
                await this.finish(result, endpoint);
            }
        } catch (error) {
            if (error instanceof RemoteHttpError && error.status === 404) {
                throw new Error(t("This Runtime does not expose plugin management. Open its Web UI to manage plugins."));
            }
            throw error;
        } finally { this.pending = false; }
    }

    private assertEndpoint(endpoint: string): void {
        if (this.runtime.getUrl() !== endpoint) throw new Error(t("The connected Runtime changed. Reopen plugin management."));
    }

    private async install(endpoint: string): Promise<void> {
        const spec = await vscode.window.showInputBox({ title: t("Install a plugin bundle"),
            prompt: t("Enter an npm package spec, Git repository, tarball URL, or a path on the Runtime host"),
            ignoreFocusOut: true, validateInput: value => !value.trim() || value.trim().startsWith("-")
                ? t("Enter a valid package spec") : undefined });
        if (spec === undefined) return;
        this.assertEndpoint(endpoint);
        const inspection = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
            title: t("Inspecting plugin package") }, () => this.runtime.inspectPlugin(spec.trim()));
        this.assertEndpoint(endpoint);
        if (inspection.status === "refused") throw new Error(`${inspection.problem}: ${inspection.reason}`);
        if (inspection.bundle === false) throw new Error(t("This package does not declare a DSH bundle."));
        const install = t("Install and enable");
        const source = inspection.host ?? inspection.registry ?? t("Runtime default registry");
        const confirmed = await vscode.window.showWarningMessage(t("Install and enable {name} on the connected Runtime? Plugins can execute code on its host.",
            { name: inspection.name ? `${inspection.name}${inspection.version ? `@${inspection.version}` : ""}` : spec.trim() }),
        { modal: true, detail: [source, inspection.description,
            inspection.bundle === null ? t("The package's bundle and compatibility are checked during installation.") : undefined].filter(Boolean).join("\n") }, install);
        if (confirmed !== install) return;
        let approvedBuilds: string[] | undefined;
        for (;;) {
            this.assertEndpoint(endpoint);
            const result = await this.runInstall(endpoint, spec.trim(), approvedBuilds);
            if (result.pendingBuilds?.length && result.application === "failed") {
                const approve = t("Approve build scripts and retry");
                const choice = await vscode.window.showWarningMessage(t("These packages require build script approval: {packages}",
                    { packages: result.pendingBuilds.join(", ") }), { modal: true }, approve);
                if (choice === approve) { approvedBuilds = result.pendingBuilds; continue; }
            }
            await this.finish(result, endpoint);
            return;
        }
    }

    private async runInstall(endpoint: string, spec: string, approvedBuilds?: string[]): Promise<DshPluginChangeResult> {
        const requestId = randomUUID();
        return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
            title: t("Installing plugin bundle"), cancellable: true }, async (progress, token) => {
            const events = this.runtime.onDidRemoteEvent((event, args) => {
                const frame = args[0];
                if (!isRecord(frame) || frame.requestId !== requestId) return;
                if (event === "plugin-manager/install-state" && typeof frame.phase === "string") {
                    const phases: Record<string, string> = {
                        installing: "Downloading plugin package",
                        cancelling: "Cancelling plugin installation",
                        applying: "Applying plugin change...",
                    };
                    if (phases[frame.phase]) progress.report({ message: t(phases[frame.phase]) });
                } else if (event === "plugin-manager/install-log" && typeof frame.text === "string") {
                    this.output.append(frame.text);
                }
            });
            let cancel: Promise<void> | undefined;
            let settled = false;
            const cancellation = token.onCancellationRequested(() => {
                cancel ??= (async () => {
                    // The request may still be reaching the Host when the user cancels.
                    while (!settled) {
                        this.assertEndpoint(endpoint);
                        const result = await this.runtime.cancelPluginInstall(requestId);
                        if (result !== "not-running") return;
                        await new Promise(resolve => setTimeout(resolve, 150));
                    }
                })().catch(error => this.output.appendLine(`[dsh:plugins] cancellation failed: ${errorMessage(error)}`));
            });
            try {
                try { return await this.runtime.installPluginBundle(spec, requestId, approvedBuilds); }
                catch (error) {
                    this.assertEndpoint(endpoint);
                    const recovered = await this.runtime.waitForPluginInstall(requestId);
                    if (recovered) return recovered;
                    throw error;
                }
            } finally {
                settled = true;
                await cancel;
                events.dispose();
                cancellation.dispose();
            }
        });
    }

    private async finish(result: DshPluginChangeResult, endpoint: string): Promise<void> {
        this.assertEndpoint(endpoint);
        await this.changed();
        const details = [result.error?.diagnostic ?? result.error?.code,
            result.packageResult?.kind, ...(result.warnings ?? [])].filter(Boolean).join("\n");
        if (result.packageResult) this.output.appendLine(`[dsh:plugins] ${result.packageResult.output}\n${result.packageResult.logPath}`);
        const states = { applied: "Applied", "restart-required": "Restart required", overridden: "Overridden", failed: "Failed", cancelled: "Cancelled" };
        const message = t("Plugin change: {target} · {state}", { target: result.target, state: t(states[result.application]) });
        if (result.application === "failed") {
            const logs = t("Open runtime logs");
            if (await vscode.window.showErrorMessage(`${message}${details ? `\n${details}` : ""}`, logs) === logs) this.output.show(true);
        } else if (result.application === "restart-required") {
            void vscode.window.showInformationMessage(`${message}\n${t("Restart the owning Runtime to apply this change.")}`);
        } else void vscode.window.showInformationMessage(`${message}${details ? `\n${details}` : ""}`);
    }
}
