import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { DshRuntime } from "./dshRuntime";
import type { DshPluginChangeResult } from "./types";
import { isRecord } from "./guards";
import { errorMessage } from "./errors";
import { normalizePluginChange, pluginChangeDetails } from "./pluginInventory";
import { t } from "./localize";
import { isRemoteEndpointUnavailable } from "./remote/errors";

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
                { label: `$(search) ${t("Search community plugins")}`, action: "search", name: "" },
                { label: `$(add) ${t("Install a plugin bundle")}`, action: "install", name: "" },
                ...bundles.filter(bundle => !bundle.enabled && (bundle.installed || bundle.optional) && !bundle.readOnlyReason && !bundle.errorCode).map(bundle => ({
                    label: `$(play) ${bundle.name}`, description: bundle.version, detail: t("Enable bundle"), action: "enable", name: bundle.name,
                })),
                ...bundles.filter(bundle => bundle.installed && bundle.update && !bundle.readOnlyReason).map(bundle => ({
                    label: `$(arrow-up) ${bundle.name}`, description: bundle.version, detail: t("Update installed bundle"), action: "update", name: bundle.name,
                })),
                ...bundles.filter(bundle => bundle.installed && bundle.removable && !bundle.readOnlyReason).map(bundle => ({
                    label: `$(trash) ${bundle.name}`, description: bundle.version, detail: bundle.description,
                    action: "remove", name: bundle.name,
                })),
            ], { title: t("Manage Runtime plugins"), placeHolder: t("Install, update or remove Runtime bundles") });
            if (!selected) return;
            this.assertEndpoint(endpoint);
            if (selected.action === "search") await this.search(endpoint);
            else if (selected.action === "install") await this.install(endpoint);
            else if (selected.action === "update") await this.update(endpoint, selected.name, bundles.find(bundle => bundle.name === selected.name)?.update);
            else if (selected.action === "enable") {
                const result = await this.runtime.setBundleEnabled(selected.name, true);
                await this.finish(result, endpoint);
            }
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
            if (isRemoteEndpointUnavailable(error)) {
                throw new Error(t("This Runtime does not expose plugin management. Open its Web UI to manage plugins."));
            }
            throw error;
        } finally { this.pending = false; }
    }

    private assertEndpoint(endpoint: string): void {
        if (this.runtime.getUrl() !== endpoint) throw new Error(t("The connected Runtime changed. Reopen plugin management."));
    }

    private localized(value: unknown): string {
        if (typeof value === "string") return value;
        if (!isRecord(value)) return "";
        const language = vscode.env.language.toLowerCase();
        const key = Object.keys(value).find(key => key.toLowerCase() === language)
            ?? Object.keys(value).find(key => key.toLowerCase() === language.split("-")[0]) ?? "en";
        return typeof value[key] === "string" ? value[key] : "";
    }

    private async search(endpoint: string): Promise<void> {
        const api = this.runtime.getApiClient();
        let indexes: unknown;
        try { indexes = await api.call("pluginMarket/listIndexes", {}); }
        catch (error) {
            if (isRemoteEndpointUnavailable(error, "pluginMarket/listIndexes")) throw new Error(t("Enable the official Plugin Market bundle in Runtime plugins to browse community plugins."));
            throw error;
        }
        if (!Array.isArray(indexes)) throw new Error(t("The Runtime returned an invalid plugin market."));
        const sources = indexes.filter(isRecord).filter(item => typeof item.url === "string");
        const source = await vscode.window.showQuickPick([
            { label: t("Add market index"), url: undefined as string | undefined },
            ...sources.map(item => ({ label: this.localized(item.title) || String(item.url), description: String(item.url), url: String(item.url) })),
        ], { title: t("Community plugin source") });
        if (!source) return;
        if (!source.url) {
            const url = await vscode.window.showInputBox({ title: t("Market index URL"), ignoreFocusOut: true });
            if (!url?.trim()) return;
            this.assertEndpoint(endpoint);
            const current = await api.call<unknown>("pluginMarket/listIndexes", {});
            if (!Array.isArray(current)) throw new Error(t("The Runtime returned an invalid plugin market."));
            await api.call("pluginMarket/setIndexes", { urls: [...current.filter(isRecord).map(item => item.url), url.trim()] });
            return this.search(endpoint);
        }
        let text = await vscode.window.showInputBox({ title: t("Search community plugins"), ignoreFocusOut: true });
        if (text === undefined) return;
        let offset = 0, fetchedAt: number | undefined;
        for (;;) {
            this.assertEndpoint(endpoint);
            const page = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
                title: t("Searching plugins") }, () => api.call<unknown>("pluginMarket/search", {
                    url: source.url, query: { text, offset, limit: 50, sort: { kind: "relevance" }, ...(fetchedAt ? { fetchedAt } : {}) },
                }));
            this.assertEndpoint(endpoint);
            if (!isRecord(page) || !Array.isArray(page.entries)) throw new Error(t("The Runtime returned an invalid plugin market."));
            fetchedAt = typeof page.fetchedAt === "number" ? page.fetchedAt : undefined;
            const entries = page.entries.filter(isRecord).filter(item => typeof item.name === "string");
            const selected = await vscode.window.showQuickPick([
                { label: t("Change search"), action: "query", entry: undefined as Record<string, unknown> | undefined },
                ...(typeof page.nextOffset === "number" ? [{ label: t("Next page"), action: "next", entry: undefined }] : []),
                ...(offset > 0 ? [{ label: t("Previous page"), action: "previous", entry: undefined }] : []),
                ...entries.map(entry => ({ label: this.localized(entry.title) || String(entry.name), description: String(entry.name),
                    detail: this.localized(entry.description), action: "entry", entry })),
            ], { title: t("Community plugins · {count} results", { count: typeof page.total === "number" ? page.total : entries.length }), matchOnDescription: true, matchOnDetail: true });
            if (!selected) return;
            if (selected.action === "query") {
                const query = await vscode.window.showInputBox({ title: t("Search community plugins"), value: text, ignoreFocusOut: true });
                if (query === undefined) return;
                text = query; offset = 0; fetchedAt = undefined; continue;
            }
            if (selected.action === "next") { offset = Number(page.nextOffset); continue; }
            if (selected.action === "previous") { offset = Math.max(0, offset - 50); continue; }
            const entry = selected.entry;
            if (!entry || !Array.isArray(entry.versions)) continue;
            const version = await vscode.window.showQuickPick(entry.versions.filter(isRecord).map(value => ({
                label: String(value.version), description: isRecord(value.compatibility) && value.compatibility.compatible === false ? t("Incompatible with this Runtime") : "",
                value,
            })), { title: String(entry.name) });
            if (!version) continue;
            const detail = t("Read plugin details"), install = t("Install and enable");
            const installed = isRecord(entry.installation) && entry.installation.status !== "not-installed";
            const actionLabel = installed ? t("Update installed bundle") : install;
            const choice = await vscode.window.showQuickPick([detail,
                ...(isRecord(version.value.compatibility) && version.value.compatibility.compatible === true ? [actionLabel] : [])], { title: `${entry.name}@${version.value.version}` });
            if (choice === detail) {
                const document = await api.call<unknown>("pluginMarket/readEntryDetail", { url: source.url, name: entry.name, version: version.value.version, language: vscode.env.language });
                this.assertEndpoint(endpoint);
                if (isRecord(document) && document.status === "found" && typeof document.markdown === "string") {
                    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: "markdown", content: document.markdown }), { preview: true });
                } else void vscode.window.showInformationMessage(t("No plugin detail document is available."));
            } else if (choice === actionLabel && isRecord(version.value.install) && typeof version.value.install.spec === "string") {
                const registry = typeof version.value.install.registry === "string" ? version.value.install.registry : undefined;
                if (installed) {
                    const bundle = (await this.runtime.pluginManagerBundles())?.find(item => item.name === entry.name);
                    if (!bundle?.update) { void vscode.window.showInformationMessage(t("This bundle cannot be updated through the market.")); continue; }
                    await this.update(endpoint, String(entry.name), bundle.update, { version: String(version.value.version), registry,
                        ...(bundle.update === "git" ? { spec: version.value.install.spec } : {}) });
                } else await this.install(endpoint, version.value.install.spec, registry);
                return;
            }
        }
    }

    private async update(endpoint: string, name: string, kind?: "registry" | "git", planned?: { version: string; registry?: string; spec?: string }): Promise<void> {
        let version: string | undefined;
        let registry: string | undefined;
        let spec: string | undefined;
        if (planned) { version = planned.version; registry = planned.registry; spec = planned.spec; }
        else if (kind === "git") {
            spec = await vscode.window.showInputBox({ title: t("Git bundle update"), prompt: t("Enter the same repository spec pinned to a full commit"), ignoreFocusOut: true });
            if (!spec?.trim()) return;
            this.assertEndpoint(endpoint);
            const inspection = await this.runtime.inspectPlugin(spec.trim());
            if (inspection.status !== "accepted" || inspection.kind !== "git") throw new Error(t("Enter a valid Git package spec."));
            version = await vscode.window.showInputBox({ title: t("Exact target package version"), ignoreFocusOut: true });
        } else {
            const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t("Checking plugin versions") },
                () => this.runtime.getApiClient().call<unknown>("pluginManager/listVersions", { name }));
            this.assertEndpoint(endpoint);
            if (!isRecord(result) || result.status !== "listed" || !Array.isArray(result.versions)) {
                throw new Error(isRecord(result) && typeof result.reason === "string" ? result.reason : t("Could not read plugin versions."));
            }
            registry = typeof result.registry === "string" ? result.registry : undefined;
            const versions = result.versions.filter(isRecord).filter(item => typeof item.version === "string" && item.bundle === true && !item.incompatible && !item.deprecated);
            if (!versions.length) { void vscode.window.showInformationMessage(t("No compatible newer bundle versions are available.")); return; }
            version = (await vscode.window.showQuickPick(versions.map(item => ({ label: String(item.version),
                description: [item.prerelease ? t("Prerelease") : "", ...(Array.isArray(item.tags) ? item.tags.filter(tag => typeof tag === "string") : [])].filter(Boolean).join(" · "),
                version: String(item.version) })), { title: t("Choose plugin version") }))?.version;
        }
        if (!version?.trim()) return;
        const confirm = t("Update bundle");
        if (await vscode.window.showWarningMessage(t("Update {name} to {version} on the connected Runtime?", { name, version }), { modal: true }, confirm) !== confirm) return;
        this.assertEndpoint(endpoint);
        const requestId = randomUUID();
        const response = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t("Updating {name}", { name }), cancellable: true }, async (progress, token) => {
            let cancelled = token.isCancellationRequested;
            let cancellation: Promise<unknown> | undefined;
            const requestCancellation = (): void => {
                cancellation = this.runtime.cancelPluginInstall(requestId)
                    .catch(error => this.output.appendLine(`[dsh:plugins] ${errorMessage(error)}`));
            };
            const events = this.runtime.onDidRemoteEvent((event, args) => {
                const frame = args[0];
                if (!isRecord(frame) || frame.requestId !== requestId) return;
                if (event === "plugin-manager/update-state" && typeof frame.step === "string") progress.report({ message: t(frame.step) });
                if (event === "plugin-manager/install-log" && typeof frame.text === "string") this.output.append(frame.text);
                if (cancelled && event === "plugin-manager/install-state" && frame.phase === "installing") requestCancellation();
            });
            const cancel = token.onCancellationRequested(() => { cancelled = true; requestCancellation(); });
            try {
                return await this.runtime.getApiClient().call<unknown>("pluginManager/updateBundle", { name, version: version!.trim(),
                    options: { requestId, ...(registry ? { registry } : {}), ...(spec ? { spec: spec.trim() } : {}) } });
            } finally { events.dispose(); cancel.dispose(); await cancellation; }
        });
        this.assertEndpoint(endpoint);
        const result = isRecord(response) ? normalizePluginChange(response.result) : undefined;
        if (!result) throw new Error(t("The Runtime returned an invalid plugin update result."));
        if (isRecord(response) && response.restore !== undefined) {
            const restored = normalizePluginChange(response.restore);
            this.output.appendLine(`[dsh:plugins] update restore: ${JSON.stringify(restored)}`);
            const restoredSuccessfully = restored && ["applied", "restart-required", "overridden"].includes(restored.application);
            void vscode.window.showWarningMessage(t(restoredSuccessfully ? "The update failed; the previous bundle was restored." : "The update and rollback failed. Check Runtime logs."));
        }
        await this.finish(result, endpoint);
    }

    private async install(endpoint: string, suggestedSpec?: string, registry?: string): Promise<void> {
        const spec = await vscode.window.showInputBox({ title: t("Install a plugin bundle"),
            prompt: t("Enter an npm package spec, Git repository, tarball URL, or a path on the Runtime host"), value: suggestedSpec,
            ignoreFocusOut: true, validateInput: value => !value.trim() || value.trim().startsWith("-")
                ? t("Enter a valid package spec") : undefined });
        if (spec === undefined) return;
        this.assertEndpoint(endpoint);
        const inspection = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
            title: t("Inspecting plugin package") }, () => this.runtime.inspectPlugin(spec.trim(), undefined, registry));
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
            const result = await this.runInstall(endpoint, spec.trim(), approvedBuilds, registry);
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

    private async runInstall(endpoint: string, spec: string, approvedBuilds?: string[], registry?: string): Promise<DshPluginChangeResult> {
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
                try { return await this.runtime.installPluginBundle(spec, requestId, approvedBuilds, registry); }
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
        const details = [...pluginChangeDetails(result), result.packageResult?.kind].filter(Boolean).join("\n");
        if (result.packageResult) this.output.appendLine(`[dsh:plugins] ${result.packageResult.output}\n${result.packageResult.logPath}`);
        const states = { applied: "Applied", "restart-required": "Restart required", overridden: "Overridden", failed: "Failed", cancelled: "Cancelled" };
        const message = t("Plugin change: {target} · {state}", { target: result.target, state: t(states[result.application]) });
        if (result.application === "failed") {
            const logs = t("Open runtime logs");
            if (await vscode.window.showErrorMessage(`${message}${details ? `\n${details}` : ""}`, logs) === logs) this.output.show(true);
        } else if (result.application === "restart-required") {
            void vscode.window.showInformationMessage(`${message}\n${t("Restart the owning Runtime to apply this change.")}${details ? `\n${details}` : ""}`);
        } else void vscode.window.showInformationMessage(`${message}${details ? `\n${details}` : ""}`);
    }
}
