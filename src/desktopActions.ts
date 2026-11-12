import * as vscode from "vscode";
import type { DshRuntime } from "./dshRuntime";
import {
    DESKTOP_GRANT_SECRET,
    discoverDesktopKeys,
    resolveDesktopPairing,
    validateDesktopUrl,
    type DesktopGrant,
} from "./desktopConnection";
import { compareRuntimeVersions } from "./runtimeVersion";
import { t } from "./localize";
import { isRecord } from "./guards";

export class DesktopConnectionActions {
    public constructor(
        private readonly runtime: DshRuntime,
        private readonly secrets: vscode.SecretStorage
    ) {
        runtime.setDesktopResolver((signal) => this.resolve(signal));
    }
    private async resolve(signal: AbortSignal): Promise<DesktopGrant> {
        const raw = await this.secrets.get(DESKTOP_GRANT_SECRET);
        if (!raw) throw new Error(t("Connect to Desktop before enabling Desktop mode."));
        let saved: DesktopGrant;
        try {
            const value: unknown = JSON.parse(raw);
            if (!isRecord(value) || typeof value.url !== "string" || typeof value.runtimeVersion !== "string" ||
                compareRuntimeVersions(value.runtimeVersion, "0.1.5-rc.1") === undefined) throw new Error();
            saved = value as unknown as DesktopGrant;
        } catch { throw new Error(t("The saved Desktop grant is invalid. Connect to Desktop again.")); }
        const url =
            process.platform === "win32" && saved.key
                ? await resolveDesktopPairing(saved.key, signal)
                : validateDesktopUrl(saved.url);
        return { ...saved, url };
    }
    public async connect(): Promise<void> {
        const methods = [{ label: t("Paste Desktop connection address"), automatic: false }];
        if (process.platform === "win32" && !vscode.env.remoteName)
            methods.unshift({ label: t("Discover local Desktop"), automatic: true });
        const method = await vscode.window.showQuickPick(methods, { title: t("Connect to Desktop") });
        if (!method) return;
        let url: string;
        let key: string | undefined;
        if (method.automatic) {
            const keys = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: t("Finding Desktop connections") },
                () => discoverDesktopKeys(AbortSignal.timeout(30_000))
            );
            if (!keys.length)
                throw new Error(t("No local Desktop connect plugin was found. Enable dsh-vscode-connect in Desktop."));
            const selected =
                keys.length === 1
                    ? { key: keys[0] }
                    : await vscode.window.showQuickPick(
                          keys.map((value, index) => ({ label: `Desktop ${index + 1}`, key: value })),
                          { title: t("Choose Desktop instance") }
                      );
            if (!selected) return;
            key = selected.key;
            url = await resolveDesktopPairing(key, AbortSignal.timeout(5000));
        } else {
            const pasted = await vscode.window.showInputBox({
                title: t("Connect to Desktop"),
                password: true,
                ignoreFocusOut: true,
                prompt: t("Paste the connection address copied from dsh-vscode-connect"),
                validateInput: (value) => {
                    try {
                        validateDesktopUrl(value.trim());
                        return undefined;
                    } catch {
                        return t("Enter a local Desktop connection address.");
                    }
                },
            });
            if (!pasted) return;
            url = validateDesktopUrl(pasted.trim());
        }
        const version = await vscode.window.showInputBox({
            title: t("Desktop Runtime version"),
            prompt: t("Enter the version shown in Desktop About"),
            value: vscode.workspace.getConfiguration("dsh").get<string>("desktopRuntimeVersion", "0.2.2-rc.1"),
            validateInput: (value) => {
                const order = compareRuntimeVersions(value.trim(), "0.1.5-rc.1");
                return order === undefined || order < 0 ? t("Enter a supported complete Runtime version.") : undefined;
            },
        });
        if (!version) return;
        const config = vscode.workspace.getConfiguration("dsh");
        const changes = ([
            ["serverUrl", ""], ["desktopConnection", true], ["desktopRuntimeVersion", version.trim()],
        ] as const).map(([name, value]) => {
            const scoped = config.inspect(name);
            const target = scoped?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
                : scoped?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
            const before = target === vscode.ConfigurationTarget.WorkspaceFolder ? scoped?.workspaceFolderValue
                : target === vscode.ConfigurationTarget.Workspace ? scoped?.workspaceValue : scoped?.globalValue;
            return { name, value, target, before };
        });
        const previousGrant = await this.secrets.get(DESKTOP_GRANT_SECRET);
        const nextGrant = JSON.stringify({ url, runtimeVersion: version.trim(), ...(key ? { key } : {}) } satisfies DesktopGrant);
        await this.runtime.stop();
        try {
            await this.secrets.store(DESKTOP_GRANT_SECRET, nextGrant);
            for (const change of changes) await config.update(change.name, change.value, change.target);
            await this.runtime.start();
        } catch (error) {
            try {
              if (await this.secrets.get(DESKTOP_GRANT_SECRET) === nextGrant) {
                await this.runtime.stop().catch(() => undefined);
                const rollbackFailures: unknown[] = [];
                for (const change of changes) {
                    const latest = config.inspect(change.name);
                    const current = change.target === vscode.ConfigurationTarget.WorkspaceFolder ? latest?.workspaceFolderValue
                        : change.target === vscode.ConfigurationTarget.Workspace ? latest?.workspaceValue : latest?.globalValue;
                    if (current === change.value) {
                        try { await config.update(change.name, change.before, change.target); }
                        catch (failure) { rollbackFailures.push(failure); }
                    }
                }
                if (previousGrant === undefined) await this.secrets.delete(DESKTOP_GRANT_SECRET);
                else await this.secrets.store(DESKTOP_GRANT_SECRET, previousGrant);
                if (rollbackFailures.length) throw new Error("Configuration rollback incomplete");
              }
            } catch {
                void vscode.window.showWarningMessage(t("The Desktop connection failed and some previous settings could not be restored. Check DSH connection settings."));
            }
            throw error;
        }
        if (process.platform === "win32" && !key) {
            const paired = await this.runtime.acquireDesktopPairing().catch(() => undefined);
            if (paired)
                await this.secrets.store(
                    DESKTOP_GRANT_SECRET,
                    JSON.stringify({ url, runtimeVersion: version.trim(), key: paired } satisfies DesktopGrant)
                );
        }
    }
    public async disconnect(): Promise<void> {
        await this.runtime.stop();
        await this.secrets.delete(DESKTOP_GRANT_SECRET);
        const config = vscode.workspace.getConfiguration("dsh");
        const scoped = config.inspect("desktopConnection");
        const target = scoped?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
            : scoped?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        await config.update("desktopConnection", false, target);
    }
}
