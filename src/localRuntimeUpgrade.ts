import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as vscode from "vscode";
import { spawnOwnedRuntime, terminateOwnedRuntime } from "./runtimeProcess";
import { t } from "./localize";
import { isOlderRuntimeVersion } from "./runtimeVersion";
import { isSupportedRuntimeVersion } from "./managedRuntime/types";

const PACKAGE = "@deepseek-ai/dsh";

interface NpmInstallation { prefix: string; cli: string; entry: string; node: string }

/** Only update the active npm prefix when its package and bin resolve to the probed CLI. */
async function npmInstallation(command: string, npm: string, prefix: string, node: string): Promise<NpmInstallation | undefined> {
    try {
        if (!isAbsolute(prefix)) return undefined;
        const packageRoot = join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules", PACKAGE);
        const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
            name?: string; bin?: string | { dsh?: string };
        };
        const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.dsh;
        if (manifest.name !== PACKAGE || typeof bin !== "string") return undefined;
        const entry = await realpath(resolve(packageRoot, bin));
        const withinPackage = relative(await realpath(packageRoot), entry);
        if (withinPackage.startsWith("..") || isAbsolute(withinPackage)) return undefined;
        const commandPath = await realpath(command);
        if (process.platform === "win32") {
            if (resolve(dirname(command)).toLowerCase() !== resolve(prefix).toLowerCase()) return undefined;
            const shim = (await readFile(command, "utf8")).replaceAll("\\", "/");
            if (!shim.includes(`node_modules/${PACKAGE}/${bin.replaceAll("\\", "/")}`)) return undefined;
        } else if (commandPath !== entry) return undefined;
        const cli = process.platform === "win32"
            ? await realpath(join(dirname(npm), "node_modules", "npm", "bin", "npm-cli.js"))
            : await realpath(npm);
        if (!cli.endsWith(`${process.platform === "win32" ? "\\" : "/"}npm-cli.js`)) return undefined;
        const npmManifest = JSON.parse(await readFile(join(dirname(cli), "..", "package.json"), "utf8")) as { name?: string };
        if (npmManifest.name !== "npm") return undefined;
        return { prefix, cli, entry, node: resolve(node) };
    } catch { return undefined; }
}

/** Await a choice without allowing a delayed click to install after Runtime startup was cancelled. */
async function choose<T>(choice: Thenable<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolveChoice, reject) => {
        const abort = (): void => { signal.removeEventListener("abort", abort); reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        void Promise.resolve(choice).then(resolveChoice, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}

async function install(installation: NpmInstallation, target: string, registry: string | undefined, timeout: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const child = spawnOwnedRuntime(installation.node, [installation.cli, "install", "--global", "--prefix", installation.prefix,
        `${PACKAGE}@${target}`, ...(registry ? ["--registry", registry] : [])], {
        cwd: installation.prefix, env: { ...process.env },
        windowsHide: true, stdio: "ignore",
    });
    try {
        await new Promise<void>((resolveInstall, reject) => {
            const abort = (): void => { cleanup(); reject(signal.reason); };
            const timer = setTimeout(() => { cleanup(); reject(new Error(t("The CLI upgrade timed out."))); }, timeout);
            const cleanup = (): void => {
                clearTimeout(timer);
                signal.removeEventListener("abort", abort);
            };
            signal.addEventListener("abort", abort, { once: true });
            child.once("error", error => { cleanup(); reject(error); });
            child.once("exit", code => {
                cleanup();
                if (code === 0) resolveInstall();
                else reject(new Error(t("npm exited with code {code}.", { code: String(code) })));
            });
            if (signal.aborted) abort();
        });
    } finally {
        // POSIX groups retain ownership after npm exits; Windows taskkill needs a live root.
        if (process.platform !== "win32" || (child.exitCode === null && child.signalCode === null)) {
            await terminateOwnedRuntime(child);
        }
    }
}

export interface LocalRuntimeUpgradeOptions {
    command: string;
    actual: string | undefined;
    target: string;
    npm?: string;
    node?: string;
    prefix?: string;
    registry?: string;
    timeout: number;
    signal: AbortSignal;
    probe: () => Promise<string | undefined>;
    log: (message: string) => void;
}

export class LocalRuntimeUpgradeCancelledError extends Error {}

/** Offer a single explicit upgrade; declined, unsupported and failed upgrades leave launcher fallback to the caller. */
export async function offerLocalRuntimeUpgrade(options: LocalRuntimeUpgradeOptions): Promise<string | undefined> {
    const { command, actual, target, signal } = options;
    const installation = isOlderRuntimeVersion(actual, target) && options.npm && options.prefix && options.node
        ? await npmInstallation(command, options.npm, options.prefix, options.node) : undefined;
    signal.throwIfAborted();
    const skip = t("Skip upgrade");
    if (!installation) {
        const copy = t("Copy target version");
        const selected = await choose(vscode.window.showWarningMessage(
            t("Local dsh reports {actual} and is not compatible. Install the supported version {target} with its original installer: {path}", { actual: actual ?? t("unknown"), target, path: command }),
            { modal: true, detail: t("Automatic upgrade requires an older, verified npm global installation. Unknown versions are not overwritten. Skip to use the plugin Runtime, or copy the target version and restart DSH after upgrading manually.") }, copy, skip,
        ), signal);
        signal.throwIfAborted();
        if (selected === copy) {
            await vscode.env.clipboard.writeText(target);
            throw new LocalRuntimeUpgradeCancelledError();
        }
        return undefined;
    }
    const upgrade = t("Upgrade to {version}", { version: target });
    const selected = await choose(vscode.window.showWarningMessage(
        t("Local dsh {actual} is older than the required {target}. Upgrade it now?", { actual: actual!, target }),
        { modal: true, detail: t("CLI: {path}\nnpm prefix: {prefix}\nThis runs npm install --global @deepseek-ai/dsh@{target} in this prefix. Other tools using this installation will use the new version.", { path: command, prefix: installation.prefix, target }) },
        upgrade, skip,
    ), signal);
    signal.throwIfAborted();
    if (selected !== upgrade) return undefined;
    // Recheck ownership and version after the dialog: the installation may have changed elsewhere.
    const current = await options.probe();
    if (isSupportedRuntimeVersion(current)) return current;
    const checked = options.npm && options.prefix && options.node ? await npmInstallation(command, options.npm, options.prefix, options.node) : undefined;
    if (!isOlderRuntimeVersion(current, target) || current !== actual || checked?.entry !== installation.entry || checked?.cli !== installation.cli) {
        options.log("[dsh:upgrade] installation changed while awaiting confirmation; skipped");
        return undefined;
    }
    try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t("Upgrading local dsh to {version}", { version: target }), cancellable: true }, async (_progress, token) => {
            const controller = new AbortController();
            const abort = (): void => controller.abort(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            const subscription = token.onCancellationRequested(() => controller.abort());
            if (signal.aborted || token.isCancellationRequested) controller.abort();
            try { await install(installation, target, options.registry, options.timeout, controller.signal); }
            finally { signal.removeEventListener("abort", abort); subscription.dispose(); }
        });
        signal.throwIfAborted();
        const version = await options.probe();
        if (version !== target) throw new Error(t("The CLI still reports {actual} after upgrading to {target}.", { actual: version ?? t("unknown"), target }));
        options.log(`[dsh:upgrade] verified ${command}: ${version}`);
        return version;
    } catch (error) {
        signal.throwIfAborted();
        const reason = error instanceof Error ? error.message : String(error);
        options.log(`[dsh:upgrade] ${reason}`);
        const fallback = t("Use plugin Runtime");
        const selected = await choose(vscode.window.showWarningMessage(
            t("Local dsh upgrade did not complete: {reason}. Use the plugin Runtime instead?", { reason }),
            { modal: true }, fallback, t("Cancel startup"),
        ), signal);
        signal.throwIfAborted();
        if (selected !== fallback) throw new LocalRuntimeUpgradeCancelledError();
        return undefined;
    }
}
