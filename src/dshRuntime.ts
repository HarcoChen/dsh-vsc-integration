import { ChildProcess, execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, open, readFile, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, extname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { HarnessApiClient, HarnessHttpError } from "./harnessClient";
import {
    HarnessClientResponse,
    HarnessHostDescription,
    HarnessGoalEditChanges,
    HarnessQueueAction,
} from "./harnessProtocol";
import { HarnessStateCoordinator } from "./harnessState";
import { t } from "./localize";
import {
    RUNTIME_DEFAULT_VERSION,
    acquireManagedRuntime,
    checkInstalled,
    resolveTarget,
} from "./managedRuntime";
import type { ManagedRuntime, RuntimeInstallPhase } from "./managedRuntime";
import {
    DshCommandDescriptor,
    DshCommandExecution,
    DshGoalRef,
    DshGoalRefResult,
    DshHistoryResult,
    DshSessionCreateResult,
    DshSessionForkResult,
    DshSessionPromptResult,
    DshImageAttachmentResult,
    DshImageUpload,
    DshSessionModelsResult,
    DshSessionSelectModelResult,
    DshAgentPresetListResult,
    DshAgentPresetOpenResult,
    DshAgentPresetReadResult,
    DshAgentPresetSelectResult,
    DshSessionRenameResult,
    DshSessionSearchResult,
    DshSkillEntry,
    DshSkillListResult,
    DshProviderListResult,
    DshCredentialDescribeResult,
    DshSettingsDescribeResult,
    DshSettingsNamespaceView,
    DshSettingsPathOperation,
    DshSubagentAddress,
    DshSubagentCatalog,
    DshSubagentHistoryResult,
    DshSubagentPromptResult,
    DshRpcReceipt,
    DshWorkspaceCreateResult,
    DshWorkspaceView,
    RuntimeStatus,
} from "./types";

type RuntimeListener = (status: RuntimeStatus) => void;
type HarnessConnectedListener = () => void;
/** One allowlisted host cordis event forwarded verbatim by the Runtime. */
type RemoteEventListener = (event: string) => void;
const execFileAsync = promisify(execFile);
const DEFAULT_NPX_TIMEOUT_MS = 120_000;
const DEFAULT_PACKAGE_MANAGER_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_NPM_REGISTRY = "https://registry.npmmirror.com";
const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org";
const NPM_REGISTRY_QUERY_TIMEOUT_MS = 5_000;
/**
 * The start lock every dsh editor integration shares, so one Runtime serves the
 * machine instead of one per editor. The name is deliberately editor-neutral:
 * the JetBrains plugin takes the same file.
 */
const RUNTIME_LOCK_FILE = "dsh-runtime.lock";
/**
 * The name this extension used before the lock was shared. A peer that has not
 * updated yet still owns that file, so it is read for an advertised URL and
 * deferred to while its owner lives — otherwise the rename would reintroduce
 * exactly the double-spawn the lock exists to prevent.
 */
const LEGACY_RUNTIME_LOCK_FILE = "dsh-vscode-runtime.lock";

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeUrl(value: string): string {
    return value.trim().replace(/\/+$/, "");
}

/** One lock file's advertised Runtime URL, or undefined when it has none. */
async function readLockRecordUrl(path: string): Promise<string | undefined> {
    try {
        const contents = await readFile(path, "utf8");
        const record = JSON.parse(contents) as { url?: unknown };
        return loopbackRuntimeUrl(record.url);
    } catch {
        // A missing, half-written, or concurrently updated lock advertises nothing.
        return undefined;
    }
}

function loopbackRuntimeUrl(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    try {
        const url = new URL(normalizeUrl(value));
        if (
            url.protocol !== "http:" ||
            !url.port ||
            (url.hostname !== "127.0.0.1" &&
                url.hostname !== "localhost" &&
                url.hostname !== "0.0.0.0" &&
                url.hostname !== "[::1]") ||
            (url.pathname !== "/" && url.pathname !== "") ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
        ) {
            return undefined;
        }
        const hostname = url.hostname === "[::1]" ? "[::1]" : "127.0.0.1";
        return `http://${hostname}:${url.port}`;
    } catch {
        return undefined;
    }
}

function extractUrl(value: string): string | undefined {
    const match = value.match(
        /https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):\d+/i,
    );
    return match ? loopbackRuntimeUrl(match[0]) : undefined;
}

function portFromArgs(args: string[]): number | undefined {
    const inline = args.find((argument) => argument.startsWith("--port="));
    if (inline) {
        const value = Number(inline.slice("--port=".length));
        return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : undefined;
    }

    const index = args.findIndex((argument) => argument === "--port" || argument === "-p");
    if (index < 0) {
        return undefined;
    }

    const value = Number(args[index + 1]);
    return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : undefined;
}

function launcherNeedsShell(command: string): boolean {
    if (process.platform !== "win32") return false;
    return !/\.exe$/iu.test(command);
}

async function findExecutable(command: string): Promise<string | undefined> {
    const mode = process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK;
    const candidates: string[] = [];

    if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
        candidates.push(command);
    } else {
        const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
        const extensions =
            process.platform === "win32"
                ? extname(command)
                    ? [""]
                    : (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
                : [""];
        for (const directory of pathEntries) {
            for (const extension of extensions) {
                candidates.push(join(directory, `${command}${extension}`));
            }
        }
    }

    for (const candidate of candidates) {
        try {
            await access(candidate, mode);
            return candidate;
        } catch {
            // Try the next PATH entry.
        }
    }
    return undefined;
}

async function executableExists(command: string): Promise<boolean> {
    return (await findExecutable(command)) !== undefined;
}

function redactArgument(argument: string, previous?: string): string {
    const sensitive = /(?:api[-_]?key|auth|credential|password|secret|token)/iu;
    if (previous && sensitive.test(previous)) return "<redacted>";
    const inline = argument.match(/^([^=]+)=/u);
    return inline && sensitive.test(inline[1] as string)
        ? `${inline[1]}=<redacted>`
        : argument;
}

function redactArguments(args: string[]): string {
    return args
        .map((argument, index) => redactArgument(argument, args[index - 1]))
        .join(" ");
}

function redactUrl(value: string): string {
    try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/$/u, "");
    } catch {
        return "<invalid URL>";
    }
}

function normalizeNpmRegistry(value: string | undefined): string | undefined {
    const candidate = value?.trim();
    if (!candidate) return undefined;
    try {
        const url = new URL(candidate);
        if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
        if (url.username || url.password || url.search || url.hash) return undefined;
        return url.toString().replace(/\/$/u, "");
    } catch {
        return undefined;
    }
}

function hasNpmRegistryArgument(args: string[]): boolean {
    return args.some((argument) => argument === "--registry" || argument.startsWith("--registry="));
}

function hasNpmOptionArgument(args: string[], option: string): boolean {
    return args.some((argument) => argument === option || argument.startsWith(`${option}=`));
}

function withNpmRegistry(args: string[], registry: string | undefined): string[] | undefined {
    if (!registry || hasNpmRegistryArgument(args)) return undefined;
    return ["--registry", registry, ...args];
}

function alternateNpmRegistry(
    configuredRegistry: string | undefined,
    activeRegistry: string | undefined,
): string | undefined {
    if (!configuredRegistry) return undefined;
    if (!activeRegistry || configuredRegistry !== activeRegistry) return configuredRegistry;
    return activeRegistry === DEFAULT_NPM_REGISTRY
        ? OFFICIAL_NPM_REGISTRY
        : DEFAULT_NPM_REGISTRY;
}

async function activeNpmRegistry(cwd?: string, packageManager = "npm"): Promise<string | undefined> {
    const environmentRegistry = normalizeNpmRegistry(
        process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY,
    );
    if (environmentRegistry) return environmentRegistry;
    const configCommand = packageManager === "pnpm" ? "pnpm" : "npm";
    if (!(await executableExists(configCommand))) return undefined;
    try {
        const result = await execFileAsync(configCommand, ["config", "get", "registry"], {
            cwd,
            timeout: NPM_REGISTRY_QUERY_TIMEOUT_MS,
            windowsHide: true,
            shell: process.platform === "win32",
        });
        return normalizeNpmRegistry(result.stdout);
    } catch {
        return undefined;
    }
}

function isLikelyNpmDownloadFailure(error: unknown, outputTail = ""): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /(?:npm\s+(?:err(?:or)?|warn)|npx\b|pnpm\b|err_pnpm|registry|download|fetch failed|network (?:error|request|timeout)|timed out waiting for dsh web|eai_again|etimedout|econnreset|enotfound|socket hang up)/iu.test(
        `${message}\n${outputTail}`,
    );
}

async function globalNpmPrefix(): Promise<string | undefined> {
    if (!(await executableExists("npm"))) return undefined;
    try {
        const result = await execFileAsync("npm", ["prefix", "-g"], {
            timeout: 10_000,
            windowsHide: true,
            shell: process.platform === "win32",
        });
        const prefix = result.stdout.trim();
        return prefix || undefined;
    } catch {
        return undefined;
    }
}

/**
 * Where the launcher came from. `managed` runtimes are downloaded and cached
 * by this extension; everything else is a local toolchain discovery.
 */
type DshRuntimeSource =
    | { kind: "configured"; command: string; args: string[] }
    | { kind: "path"; command: string; args: string[] }
    | { kind: "npm-prefix"; command: string; args: string[] }
    | { kind: "npx"; command: string; args: string[] }
    | { kind: "pnpm"; command: string; args: string[] }
    | { kind: "managed"; command: string; args: string[]; version: string; target: string };

interface DshLauncher {
    command: string;
    args: string[];
    source: DshRuntimeSource;
    /** False when args already contain the complete fallback invocation. */
    usesConfiguredArgs?: boolean;
}

interface DiscoverDshOptions {
    storagePath: string | undefined;
    installWhenMissing: boolean;
    runtimeVersion: string;
    configuredArgs: string[];
    /** Permit the managed Runtime fallback (may download). Disabled during diagnosis. */
    allowManaged: boolean;
    /** HTTP(S) proxy URL, e.g. from the VS Code http.proxy setting. */
    proxy?: string;
    onLog?: (message: string) => void;
}

function isPackageManagerSource(source: DshRuntimeSource): source is Extract<DshRuntimeSource, { kind: "npx" | "pnpm" }> {
    return source.kind === "npx" || source.kind === "pnpm";
}

function isPackageManagerCommand(command: string): command is "npx" | "pnpm" {
    return command === "npx" || command === "pnpm";
}

/** Convert the packaged dlx invocation when falling back between pnpm and npx. */
function alternatePackageManagerArgs(
    fromCommand: string,
    toCommand: string,
    configuredArgs: string[],
): string[] | undefined {
    if (fromCommand === "pnpm" && toCommand === "npx") {
        const dlxIndex = configuredArgs.findIndex((argument) => argument === "dlx");
        if (dlxIndex < 0) return undefined;
        const pnpmOptions = configuredArgs.slice(0, dlxIndex);
        return [...pnpmOptions, "--yes", ...configuredArgs.slice(dlxIndex + 1)];
    }
    if (fromCommand === "npx" && toCommand === "pnpm") {
        const npxArgs = configuredArgs.filter((argument) => argument !== "-y" && argument !== "--yes");
        return ["dlx", ...npxArgs];
    }
    return undefined;
}

function npxArgsForDsh(configuredArgs: string[]): string[] {
    const dlxIndex = configuredArgs.findIndex((argument) => argument === "dlx");
    if (dlxIndex >= 0) {
        return ["--yes", ...configuredArgs.slice(dlxIndex + 1)];
    }

    const packageIndex = configuredArgs.findIndex((argument) =>
        /^@deepseek-ai\/dsh(?:@|$)/u.test(argument),
    );
    if (packageIndex >= 0) {
        const prefix = configuredArgs
            .slice(0, packageIndex)
            .filter((argument) => argument !== "-y" && argument !== "--yes");
        return [...prefix, "--yes", ...configuredArgs.slice(packageIndex)];
    }

    return ["--yes", "@deepseek-ai/dsh", ...configuredArgs.filter(
        (argument) => argument !== "-y" && argument !== "--yes",
    )];
}

function webProfileIndex(args: string[]): number {
    return args.findIndex((argument, index) =>
        argument === "web" ||
        argument === "--profile=web" ||
        (argument === "--profile" && args[index + 1] === "web"),
    );
}

function isWebProfileArgs(args: string[]): boolean {
    return webProfileIndex(args) >= 0;
}

/**
 * Insert a DSH launcher flag before the first Web-app argument. DSH stops
 * parsing its own flags at the first unknown token, so app flags such as
 * `--no-open` must not precede a later launcher-level `--patch`.
 */
function insertWebLauncherPatch(args: string[], patchPath: string): void {
    const profileIndex = webProfileIndex(args);
    if (profileIndex < 0) {
        args.push("--patch", patchPath);
        return;
    }

    let insertionIndex = profileIndex + 1;
    while (insertionIndex < args.length) {
        const argument = args[insertionIndex];
        if (argument === "--patch") {
            insertionIndex += 2;
            continue;
        }
        if (argument.startsWith("--patch=")) {
            insertionIndex += 1;
            continue;
        }
        if (argument === "--dump-config" || argument === "--dump-default-config") {
            insertionIndex += 1;
            continue;
        }
        break;
    }
    args.splice(insertionIndex, 0, "--patch", patchPath);
}

function ensureNoOpen(args: string[]): string[] {
    if (!isWebProfileArgs(args) || args.some((argument) => argument === "--no-open")) {
        return args;
    }
    return [...args, "--no-open"];
}

function packageManagerLauncher(
    command: "npx" | "pnpm",
    args: string[],
    usesConfiguredArgs = true,
): DshLauncher {
    return {
        command,
        args,
        source: command === "pnpm"
            ? { kind: "pnpm", command, args }
            : { kind: "npx", command, args },
        usesConfiguredArgs,
    };
}

function describeSource(source: DshRuntimeSource): string {
    switch (source.kind) {
        case "configured":
            return source.command;
        case "path":
            return "PATH";
        case "npm-prefix":
            return "npm global prefix";
        case "npx":
            return "npx";
        case "pnpm":
            return "pnpm dlx";
        case "managed":
            return t("managed Runtime {version} ({target})", { version: source.version, target: source.target });
    }
}

class CanceledError extends Error {
    constructor() {
        super(t("Canceled."));
    }
}

class RuntimeLaunchFailure extends Error {
    public constructor(
        public readonly outputTail: string,
        cause: unknown,
    ) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = "RuntimeLaunchFailure";
        this.cause = cause;
    }
}

function managedPhaseMessage(phase: RuntimeInstallPhase, version: string): string {
    switch (phase) {
        case "preparing":
            return t("Preparing DSH Runtime {version}…", { version });
        case "downloading":
            return t("Downloading DSH Runtime {version}…", { version });
        case "verifying":
            return t("Verifying the downloaded DSH Runtime…");
        case "installing":
            return t("Installing DSH Runtime {version}…", { version });
    }
}

function managedLauncher(runtime: ManagedRuntime): DshLauncher {
    return {
        command: runtime.launcherPath,
        args: [],
        source: {
            kind: "managed",
            command: runtime.launcherPath,
            args: [],
            version: runtime.version,
            target: runtime.target,
        },
    };
}

/**
 * Fall back to the managed Runtime: reuse the local cache when healthy, or
 * download and install it. Progress is shown in a cancellable notification.
 */
async function discoverManagedRuntime(options: DiscoverDshOptions): Promise<DshLauncher> {
    const storagePath = options.storagePath;
    if (storagePath === undefined) {
        throw new Error(t("The managed DSH Runtime requires a global storage directory."));
    }
    const version = options.runtimeVersion;
    const log = options.onLog ?? (() => undefined);
    const target = resolveTarget();

    // Cached runtimes launch directly without any progress UI.
    const cached = await checkInstalled(storagePath, target, version);
    if (cached) {
        log(`[dsh:runtime] using managed Runtime ${version} (${target})`);
        return managedLauncher(cached);
    }

    log(`[dsh:runtime] managed Runtime ${version} (${target}) not cached; downloading`);
    const controller = new AbortController();
    const managed = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: t("DSH Runtime"),
            cancellable: true,
        },
        async (progress, token) => {
            let reportedPercent = 0;
            if (token.isCancellationRequested) {
                controller.abort();
            } else {
                token.onCancellationRequested(() => controller.abort());
            }
            try {
                return await acquireManagedRuntime(storagePath, {
                    version,
                    target,
                    log,
                    signal: controller.signal,
                    onPhase: (phase) => progress.report({ message: managedPhaseMessage(phase, version) }),
                    onDownloadProgress: (received, total) => {
                        const percent = Math.min(100, Math.floor((received / total) * 100));
                        if (percent <= reportedPercent) return;
                        progress.report({
                            increment: percent - reportedPercent,
                        });
                        reportedPercent = percent;
                    },
                    onWaiting: () =>
                        progress.report({
                            message: t("Waiting for another window to finish installing DSH Runtime {version}…", { version }),
                        }),
                    proxy: options.proxy,
                });
            } catch (error) {
                if (controller.signal.aborted || token.isCancellationRequested) {
                    throw new CanceledError();
                }
                throw error;
            }
        },
    );
    log(`[dsh:runtime] using managed Runtime ${version} (${target})`);
    return managedLauncher(managed);
}

/**
 * Resolve the DSH launcher in order: configured command, PATH dsh, npm global
 * prefix, pnpm dlx/npx, and finally the managed Runtime (cached, then
 * downloaded). Every provider failure is aggregated into the final error so a
 * failed download is never masked as a generic "dsh not available".
 */
async function discoverDsh(command: string, options: DiscoverDshOptions): Promise<DshLauncher> {
    const failures: string[] = [];

    if (await executableExists(command)) {
        return isPackageManagerCommand(command)
            ? packageManagerLauncher(command, [])
            : { command, args: [], source: { kind: "configured", command, args: [] } };
    }
    // pnpm dlx and npx are interchangeable package-manager launchers for the
    // published DSH package. Prefer the other one when the configured default
    // is missing, converting the packaged arguments where possible.
    if (isPackageManagerCommand(command)) {
        failures.push(t("{command}: not found", { command }));
        const alternateCommand = command === "pnpm" ? "npx" : "pnpm";
        if (await executableExists(alternateCommand)) {
            const alternateArgs = alternatePackageManagerArgs(command, alternateCommand, options.configuredArgs);
            if (alternateArgs) {
                return packageManagerLauncher(alternateCommand, alternateArgs, false);
            }
            failures.push(t("{command}: cannot reuse the configured package-manager arguments", {
                command: alternateCommand,
            }));
        } else {
            failures.push(t("{command}: not found", { command: alternateCommand }));
        }
        if (options.allowManaged && options.storagePath && options.installWhenMissing) {
            try {
                return await discoverManagedRuntime(options);
            } catch (error) {
                if (error instanceof CanceledError) throw error;
                const target = (() => {
                    try {
                        return resolveTarget();
                    } catch {
                        return "<unknown>";
                    }
                })();
                failures.push(t("Managed Runtime {version} ({target}): {reason}", {
                    version: options.runtimeVersion,
                    target,
                    reason: error instanceof Error ? error.message : String(error),
                }));
            }
        } else if (options.allowManaged && !options.installWhenMissing) {
            failures.push(t("Managed Runtime download is disabled by the dsh.installWhenMissing setting."));
        }
        throw new Error(t("Unable to start DSH Runtime.\n\n{reasons}", { reasons: failures.join("\n") }));
    }
    if (command !== "dsh") {
        throw new Error(t("Start command “{command}” was not found. Configure an absolute dsh.command path or install the dsh CLI.", { command }));
    }
    failures.push(t("PATH dsh: not found"));

    if (await executableExists("dsh")) {
        return { command: "dsh", args: [], source: { kind: "path", command: "dsh", args: [] } };
    }

    let npmPrefixProbed = false;
    try {
        const result = await execFileAsync("npm", ["prefix", "-g"], {
            timeout: 10_000,
            windowsHide: true,
            shell: process.platform === "win32",
        });
        const prefix = result.stdout.trim();
        if (prefix) {
            npmPrefixProbed = true;
            const binDir = process.platform === "win32" ? prefix : join(prefix, "bin");
            for (const name of process.platform === "win32" ? ["dsh.cmd", "dsh.exe", "dsh.ps1", "dsh"] : ["dsh"]) {
                const candidate = join(binDir, name);
                if (await executableExists(candidate)) {
                    return { command: candidate, args: [], source: { kind: "npm-prefix", command: candidate, args: [] } };
                }
            }
        }
    } catch {
        failures.push(t("npm: unavailable"));
    }
    if (npmPrefixProbed) {
        failures.push(t("No dsh executable was found in the npm global prefix."));
    }

    if (await executableExists("pnpm")) {
        const pnpmArgs = alternatePackageManagerArgs("npx", "pnpm", npxArgsForDsh(options.configuredArgs));
        if (pnpmArgs) return packageManagerLauncher("pnpm", pnpmArgs, false);
    }
    failures.push(t("pnpm: not found"));

    if (await executableExists("npx")) {
        return packageManagerLauncher("npx", npxArgsForDsh(options.configuredArgs), false);
    }
    failures.push(t("npx: not found"));

    if (options.allowManaged && options.storagePath) {
        if (options.installWhenMissing) {
            try {
                return await discoverManagedRuntime(options);
            } catch (error) {
                if (error instanceof CanceledError) {
                    throw error;
                }
                let target = "<unknown>";
                try {
                    target = resolveTarget();
                } catch {
                    // the failure reason below already describes the platform
                }
                const reason = error instanceof Error ? error.message : String(error);
                failures.push(
                    t("Managed Runtime {version} ({target}): {reason}", {
                        version: options.runtimeVersion,
                        target,
                        reason,
                    }),
                );
            }
        } else {
            failures.push(t("Managed Runtime download is disabled by the dsh.installWhenMissing setting."));
        }
    }

    throw new Error(t("Unable to start DSH Runtime.\n\n{reasons}", { reasons: failures.join("\n") }));
}

export class DshRuntime implements vscode.Disposable {
    private readonly listeners = new Set<RuntimeListener>();
    private readonly harnessConnectedListeners = new Set<HarnessConnectedListener>();
    private readonly remoteEventListeners = new Set<RemoteEventListener>();
    private readonly apiClient: HarnessApiClient;
    private readonly harnessState: HarnessStateCoordinator;
    private child: ChildProcess | undefined;
    private baseUrl: string | undefined;
    private startPromise: Promise<string> | undefined;
    private startedByExtension = false;
    private runtimeLock: { handle: FileHandle; path: string; createdAt: number } | undefined;
    private runtimeLockWrite: Promise<void> = Promise.resolve();
    private compactionPatchPath: string | undefined;
    private disposed = false;
    private status: RuntimeStatus = { state: "stopped" };
    private hostDescription: HarnessHostDescription | undefined;

    public constructor(
        private readonly output: vscode.OutputChannel,
        private readonly storagePath: string,
    ) {
        this.apiClient = new HarnessApiClient({
            baseUrl: () => this.baseUrl,
            timeoutMs: () =>
                this.configuration().get<number>("requestTimeoutMs", 600_000),
            onDiagnostic: ({ channel, message, cause }) => {
                const suffix = cause === undefined ? "" : `: ${String(cause)}`;
                this.output.appendLine(`[dsh:${channel}] ${message}${suffix}`);
            },
        });
        this.harnessState = new HarnessStateCoordinator(this.apiClient, {
            onConnectionState: (state) =>
                this.output.appendLine(`[dsh:events] connection ${state}`),
            onHostDescription: (description) => {
                this.hostDescription = description;
                for (const listener of this.harnessConnectedListeners) listener();
            },
            onHostFrame: (frame) => {
                if (frame.type !== "host/remote-event") return;
                const event = (frame as { event?: unknown }).event;
                if (typeof event !== "string") return;
                for (const listener of this.remoteEventListeners) listener(event);
            },
            onDiagnostic: (diagnostic) => {
                let prefix: string;
                let cause: unknown;
                if ("channel" in diagnostic) {
                    prefix = diagnostic.channel;
                    cause = diagnostic.cause;
                } else {
                    prefix = diagnostic.code;
                    cause = diagnostic.value;
                }
                const suffix = cause === undefined ? "" : `: ${String(cause)}`;
                this.output.appendLine(`[dsh:${prefix}] ${diagnostic.message}${suffix}`);
            },
        });
    }

    public onDidChange(listener: RuntimeListener): vscode.Disposable {
        this.listeners.add(listener);
        return new vscode.Disposable(() => this.listeners.delete(listener));
    }

    /** Fires once for every fully connected mux/host stream generation. */
    public onDidHarnessConnect(listener: HarnessConnectedListener): vscode.Disposable {
        this.harnessConnectedListeners.add(listener);
        return new vscode.Disposable(() => this.harnessConnectedListeners.delete(listener));
    }

    /**
     * Fires for each forwarded host event, by its own cordis name. Consumers
     * treat these as invalidation signals and repull, because the forwarding
     * path carries no diff.
     */
    public onDidRemoteEvent(listener: RemoteEventListener): vscode.Disposable {
        this.remoteEventListeners.add(listener);
        return new vscode.Disposable(() => this.remoteEventListeners.delete(listener));
    }

    public getStatus(): RuntimeStatus {
        return { ...this.status };
    }

    public getUrl(): string | undefined {
        return this.baseUrl;
    }

    public getHostDescription(): HarnessHostDescription | undefined {
        return this.hostDescription ? { ...this.hostDescription } : undefined;
    }

    /** Returns a redacted, read-only environment report without starting dsh. */
    public async diagnoseEnvironment(workspaceRoot?: string): Promise<string> {
        const configuration = this.configuration();
        const command = configuration.get<string>("command", "dsh").trim() || "dsh";
        const configuredArgs = configuration.get<string[]>("commandArgs", ["web", "--no-open"]);
        const args = Array.isArray(configuredArgs)
            ? configuredArgs.filter((argument): argument is string => typeof argument === "string")
            : [];
        const serverUrl = configuration.get<string>("serverUrl", "").trim();
        const configuredPort = configuration.get<number>("serverPort", 0);
        const apiKeyRef = configuration.get<string>("apiKeyEnv", "DEEPSEEK_API_KEY").trim();
        const commandPath = await findExecutable(command);
        const dshPath = await findExecutable("dsh");
        const npxPath = await findExecutable("npx");
        const pnpmPath = await findExecutable("pnpm");
        const npmPath = await findExecutable("npm");
        const prefix = await globalNpmPrefix();

        const installWhenMissing = configuration.get<boolean>("installWhenMissing", true);
        const runtimeVersion = configuration.get<string>("runtimeVersion", RUNTIME_DEFAULT_VERSION) || RUNTIME_DEFAULT_VERSION;
        const npxTimeoutMs = configuration.get<number>("npxTimeoutMs", DEFAULT_NPX_TIMEOUT_MS);
        const npmRegistry = normalizeNpmRegistry(
            configuration.get<string>("npmRegistry", DEFAULT_NPM_REGISTRY),
        );
        const hasExplicitRegistry = hasNpmRegistryArgument(args);
        const activeRegistry = isPackageManagerCommand(command) && !hasExplicitRegistry
            ? await activeNpmRegistry(workspaceRoot, command)
            : undefined;
        const fallbackRegistry = hasExplicitRegistry
            ? undefined
            : alternateNpmRegistry(npmRegistry, activeRegistry);

        let discovery: string;
        try {
            const launcher = await discoverDsh(command, {
                storagePath: this.storagePath,
                installWhenMissing,
                runtimeVersion,
                configuredArgs: args,
                allowManaged: false,
                proxy: this.httpProxy(),
            });
            discovery = `${launcher.command} (${describeSource(launcher.source)})`;
        } catch (error) {
            discovery = `error: ${error instanceof Error ? error.message : String(error)}`;
        }

        let managedRuntime: string;
        if (installWhenMissing) {
            try {
                const target = resolveTarget();
                const cached = await checkInstalled(this.storagePath, target, runtimeVersion);
                managedRuntime = cached
                    ? `cached (${runtimeVersion}, ${target})`
                    : `available, not cached (${runtimeVersion}, ${target})`;
            } catch (error) {
                managedRuntime = `unsupported: ${error instanceof Error ? error.message : String(error)}`;
            }
        } else {
            managedRuntime = "disabled by dsh.installWhenMissing=false";
        }

        let health = "not running";
        if (this.baseUrl) {
            health = (await this.isHealthy(this.baseUrl)) ? "healthy" : "unreachable";
        }

        let hostDescription = this.hostDescription;
        let rpcHealth = "not checked";
        if (health === "healthy") {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3_000);
            try {
                hostDescription = await this.apiClient.describe(controller.signal);
                rpcHealth = "ok";
            } catch {
                rpcHealth = "failed";
            } finally {
                clearTimeout(timeout);
            }
        }

        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        const lines = [
            "DSH environment report",
            `Generated: ${new Date().toISOString()}`,
            `VS Code: ${vscode.version}`,
            `Node: ${process.versions.node}`,
            `Platform: ${process.platform} ${process.arch}`,
            `Workspace trusted: ${vscode.workspace.isTrusted ? "yes" : "no"}`,
            `Workspace root argument: ${workspaceRoot ?? "<none>"}`,
            `Workspace folders: ${workspaceFolders.length ? workspaceFolders.map((folder) => folder.uri.fsPath).join(" | ") : "<none>"}`,
            `Configured server URL: ${serverUrl ? redactUrl(serverUrl) : "<none>"}`,
            `Configured server port: ${configuredPort || "automatic"}`,
            `Configured command: ${command} ${redactArguments(args)}`.trim(),
            `package-manager startup timeout: ${npxTimeoutMs} ms`,
            `package-manager active registry: ${activeRegistry ? redactUrl(activeRegistry) : "<npm default>"}`,
            `package-manager fallback registry: ${fallbackRegistry ? redactUrl(fallbackRegistry) : "<disabled>"}`,
            `Resolved command: ${commandPath ?? "<not found>"}`,
            `Resolved dsh: ${dshPath ?? "<not found>"}`,
            `Resolved npx: ${npxPath ?? "<not found>"}`,
            `Resolved pnpm: ${pnpmPath ?? "<not found>"}`,
            `Resolved npm: ${npmPath ?? "<not found>"}`,
            `npm global prefix: ${prefix ?? "<unavailable>"}`,
            `Managed Runtime: ${managedRuntime}`,
            `Discovered launcher: ${discovery}`,
            `Runtime status: ${this.status.state}`,
            `Runtime URL: ${this.baseUrl ? redactUrl(this.baseUrl) : "<none>"}`,
            `Runtime health: ${health}`,
            `Public host.describe RPC: ${rpcHealth}`,
            `Host version: ${hostDescription?.version ?? "<unknown>"}`,
            `Host cwd: ${hostDescription?.cwd ?? "<unknown>"}`,
            `API key reference: ${apiKeyRef || "<empty>"}`,
            `API key environment variable present: ${apiKeyRef && process.env[apiKeyRef] ? "yes" : "no"}`,
        ];
        return lines.join("\n");
    }

    public getApiClient(): HarnessApiClient {
        return this.apiClient;
    }

    public getSessionStore(): HarnessStateCoordinator["sessions"] {
        return this.harnessState.sessions;
    }

    public getSessionCatalog(): HarnessStateCoordinator["catalog"] {
        return this.harnessState.catalog;
    }

    public syncSession(sessionId: string): Promise<void> {
        return this.harnessState.syncHistory(sessionId);
    }

    public async start(workspaceRoot?: string): Promise<string> {
        if (this.disposed) {
            throw new Error(t("The dsh-ide runtime has already been disposed."));
        }

        if (this.startPromise) {
            return this.startPromise;
        }

        this.startPromise = this.startInternal(workspaceRoot);
        try {
            return await this.startPromise;
        } finally {
            this.startPromise = undefined;
        }
    }

    public async restart(workspaceRoot?: string): Promise<string> {
        await this.stop();
        return this.start(workspaceRoot);
    }

    public async stop(): Promise<void> {
        await this.harnessState.stop();
        const child = this.child;
        this.child = undefined;
        this.baseUrl = undefined;
        this.hostDescription = undefined;

        if (child && this.startedByExtension) {
            await this.terminate(child);
        }

        await this.releaseRuntimeLock();

        this.startedByExtension = false;
        this.setStatus({ state: "stopped" });
    }

    public createWorkspace(path: string): Promise<DshWorkspaceCreateResult> {
        return this.apiClient.call("workspace.create", { path });
    }

    public async renameWorkspace(workspaceId: string, title: string): Promise<DshWorkspaceView> {
        const result = await this.apiClient.call("workspace.rename", { workspaceId, title });
        this.harnessState.catalog.upsertWorkspace(result.workspace);
        return result.workspace;
    }

    public async deleteWorkspace(workspaceId: string): Promise<void> {
        await this.apiClient.call("workspace.delete", { workspaceId });
        this.harnessState.catalog.removeWorkspace(workspaceId);
    }

    public async moveWorkspace(workspaceId: string, beforeWorkspaceId?: string): Promise<void> {
        const result = await this.apiClient.call("workspace.insertBefore", {
            workspaceId,
            ...(beforeWorkspaceId === undefined ? {} : { beforeWorkspaceId }),
        });
        this.harnessState.catalog.replaceWorkspaceOrder(result.workspaceIds);
    }

    public async moveWorkspaceSession(
        workspaceId: string,
        sessionId: string,
        beforeSessionId?: string,
    ): Promise<void> {
        const result = await this.apiClient.call("workspace.insertSessionBefore", {
            workspaceId,
            sessionId,
            ...(beforeSessionId === undefined ? {} : { beforeSessionId }),
        });
        this.harnessState.catalog.upsertWorkspace(result.workspace);
    }

    public async createSession(
        cwd: string | undefined,
        agentPreset?: string,
        workspaceId?: string,
    ): Promise<DshSessionCreateResult> {
        const result = await this.apiClient.call("session.create", {
            ...(workspaceId === undefined ? { cwd } : { workspaceId }),
            ...(agentPreset === undefined ? {} : { agentPreset }),
        });
        this.harnessState.catalog.upsertCreated(result.sessionId, cwd);
        return result;
    }

    public searchSessions(query: string, signal?: AbortSignal): Promise<DshSessionSearchResult> {
        return this.apiClient.call("session.search", { query }, signal);
    }

    public async renameSession(
        sessionId: string,
        title: string,
    ): Promise<DshSessionRenameResult> {
        const result = await this.apiClient.call("session.rename", { sessionId, title });
        this.harnessState.catalog.applyRename(sessionId, result.title, result.seq);
        return result;
    }

    public async forkSession(sessionId: string, atSeq?: number): Promise<DshSessionForkResult> {
        const result = await this.apiClient.call("session.fork", {
            sessionId,
            ...(atSeq === undefined ? {} : { atSeq }),
        });
        this.harnessState.catalog.upsertCreated(result.sessionId);
        return result;
    }

    public async archiveSession(sessionId: string): Promise<void> {
        const result = await this.apiClient.call("workspace.archiveSession", { sessionId });
        this.harnessState.catalog.replaceArchived(result.archivedSessionIds);
    }

    public async refreshSessions(): Promise<void> {
        await this.harnessState.refreshCatalog();
    }

    public async history(sessionId: string, maxMessages = 100): Promise<DshHistoryResult> {
        return this.apiClient.call("session.history", {
            sessionId,
            maxMessages,
        });
    }

    public async prompt(
        sessionId: string,
        text: string,
        mode: "queue" | "steer" = "queue",
        images: readonly DshImageUpload[] = [],
    ): Promise<DshSessionPromptResult> {
        return this.apiClient.call("session.prompt", {
            sessionId,
            mode,
            content: [
                ...images.map((image) => ({
                    type: "image" as const,
                    mediaType: image.mediaType,
                    data: image.data,
                    ...(image.name === undefined ? {} : { name: image.name }),
                })),
                ...(text ? [{ type: "text" as const, text }] : []),
            ],
        });
    }

    public attachment(sessionId: string, attachmentId: string): Promise<DshImageAttachmentResult> {
        return this.apiClient.call("session.attachment", { sessionId, attachmentId });
    }

    public models(sessionId: string): Promise<DshSessionModelsResult> {
        return this.apiClient.call("session.models", { sessionId });
    }

    public selectModel(selection: {
        sessionId: string;
        provider: string;
        model: string;
        reasoningEffort?: string;
    }): Promise<DshSessionSelectModelResult> {
        return this.apiClient.call("session.selectModel", selection);
    }

    public agentPresets(): Promise<DshAgentPresetListResult> {
        return this.apiClient.call("agentPreset.list", {});
    }

    public selectAgentPreset(sessionId: string, agentPreset: string): Promise<DshAgentPresetSelectResult> {
        return this.apiClient.call("agentPreset.select", { sessionId, agentPreset });
    }

    public readAgentPreset(agentPreset: string): Promise<DshAgentPresetReadResult> {
        return this.apiClient.call("agentPreset.read", { agentPreset });
    }

    public async copyAgentPreset(from: string, agentPreset: string, name?: string): Promise<string> {
        const result = await this.apiClient.call("agentPreset.copy", {
            from,
            agentPreset,
            ...(name === undefined ? {} : { name }),
        });
        return result.agentPreset;
    }

    public openAgentPresetDocument(agentPreset: string): Promise<DshAgentPresetOpenResult> {
        return this.apiClient.call("agentPreset.openDocument", { agentPreset });
    }

    public async removeAgentPreset(agentPreset: string): Promise<void> {
        await this.apiClient.call("agentPreset.remove", { agentPreset });
    }

    public async setDefaultAgentPreset(agentPreset: string): Promise<void> {
        await this.apiClient.call("settings.update", {
            ns: "agent-presets",
            patch: { default: agentPreset },
        });
    }

    public async cancel(sessionId: string): Promise<void> {
        await this.apiClient.call("session.cancel", { sessionId });
    }

    public async updateQueue(
        sessionId: string,
        itemId: string,
        action: HarnessQueueAction,
    ): Promise<void> {
        await this.apiClient.call("session.updateQueue", { sessionId, itemId, action });
    }

    public createGoal(
        sessionId: string,
        objective: string,
        maxGoalRounds?: number,
    ): Promise<DshGoalRefResult> {
        return this.apiClient.call("goal.create", {
            sessionId,
            objective,
            ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }),
        });
    }

    public editGoal(
        sessionId: string,
        ref: DshGoalRef,
        changes: HarnessGoalEditChanges,
    ): Promise<DshGoalRefResult> {
        return this.apiClient.call("goal.edit", { sessionId, ref, ...changes });
    }

    public pauseGoal(sessionId: string, ref: DshGoalRef): Promise<DshGoalRefResult> {
        return this.apiClient.call("goal.pause", { sessionId, ref });
    }

    public resumeGoal(sessionId: string, ref: DshGoalRef): Promise<DshGoalRefResult> {
        return this.apiClient.call("goal.resume", { sessionId, ref });
    }

    public completeGoal(sessionId: string, ref: DshGoalRef): Promise<DshGoalRefResult> {
        return this.apiClient.call("goal.complete", { sessionId, ref });
    }

    public clearGoal(sessionId: string, ref: DshGoalRef): Promise<{ cleared: true }> {
        return this.apiClient.call("goal.clear", { sessionId, ref });
    }

    public listSubagents(
        parentSessionId: string,
        signal?: AbortSignal,
    ): Promise<DshSubagentCatalog> {
        return this.apiClient.call("subagent.list", { parentSessionId }, signal);
    }

    public subagentHistory(
        address: DshSubagentAddress,
        beforeSeq?: number,
        maxMessages?: number,
        signal?: AbortSignal,
    ): Promise<DshSubagentHistoryResult> {
        return this.apiClient.call("subagent.history", {
            ...address,
            ...(beforeSeq === undefined ? {} : { beforeSeq }),
            ...(maxMessages === undefined ? {} : { maxMessages }),
        }, signal);
    }

    public promptSubagent(
        address: Extract<DshSubagentAddress, { mode: "continuable" }>,
        text: string,
        signal?: AbortSignal,
    ): Promise<DshSubagentPromptResult> {
        const clientTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return this.apiClient.call("subagent.prompt", {
            ...address,
            content: [{ type: "text", text }],
            ...(clientTimeZone ? { clientTimeZone } : {}),
        }, signal);
    }

    public interruptSubagent(
        address: Extract<DshSubagentAddress, { mode: "continuable" }>,
        signal?: AbortSignal,
    ): Promise<{ accepted: true }> {
        return this.apiClient.call("subagent.interrupt", address, signal);
    }

    public respond<T>(response: HarnessClientResponse<T>): Promise<DshRpcReceipt> {
        return this.apiClient.respond(response);
    }

    /** Stores a credential in the runtime-owned credential provider. */
    public async setCredential(ref: string, value: string): Promise<void> {
        await this.apiClient.call("credentials.set", { ref, value });
    }

    public listProviders(): Promise<DshProviderListResult> {
        return this.apiClient.call("llm.providers", {});
    }

    public describeSettings(): Promise<DshSettingsDescribeResult> {
        return this.apiClient.call("settings.describe", {});
    }

    public describeCredentials(refs: string[]): Promise<DshCredentialDescribeResult> {
        return this.apiClient.call("credentials.describe", { refs });
    }

    public async unsetCredential(ref: string): Promise<void> {
        await this.apiClient.call("credentials.unset", { ref });
    }

    public async openSettingsDocument(): Promise<void> {
        await this.apiClient.call("settings.openDocument", {});
    }

    public mutateSettings(
        ns: string,
        ops: DshSettingsPathOperation[],
        expectedRevision?: number,
    ): Promise<DshSettingsNamespaceView> {
        return this.apiClient.call("settings.mutate", {
            ns,
            ops,
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
        });
    }

    public async describeHost(): Promise<HarnessHostDescription> {
        return this.apiClient.describe();
    }

    public async listSkills(sessionId: string): Promise<DshSkillEntry[]> {
        const result = await this.apiClient.call("skill.list", {
            sessionId,
        });
        return result.skills;
    }

    /**
     * Host-registered slash commands for one session, or undefined when the
     * connected Runtime serves no command registry (the Gateway answers 404
     * for an endpoint no composed plugin claims). Callers degrade to their
     * IDE-local commands rather than surfacing the gap as an error.
     */
    public async listCommands(sessionId: string): Promise<DshCommandDescriptor[] | undefined> {
        try {
            const commands = await this.apiClient.call("commands/list", {
                args: { agentId: sessionId },
            });
            return [...commands];
        } catch (error) {
            if (error instanceof HarnessHttpError && error.status === 404) return undefined;
            throw error;
        }
    }

    /**
     * Runs one complete slash-command line against a session's agent. This is
     * pure admission: the resolved handler's outcome is also logged durably as
     * a `command/run` / `command/done` pair on the session. `undefined` means
     * the line resolved to no registered command.
     *
     * Images are handed over verbatim; the host executor enforces each
     * command's own `input.images` declaration and settles a non-declaring
     * invocation as an error before its handler runs.
     */
    public async executeCommand(
        sessionId: string,
        line: string,
        images: readonly DshImageUpload[] = [],
    ): Promise<DshCommandExecution | undefined> {
        return this.apiClient.call("commands/execute", {
            args: { agentId: sessionId, line, images },
        });
    }

    public async dispose(): Promise<void> {
        this.disposed = true;
        await this.stop();
    }

    private async startInternal(workspaceRoot?: string): Promise<string> {
        const configuration = this.configuration();
        const configuredUrl = configuration.get<string>("serverUrl", "").trim();
        const startupTimeout = configuration.get<number>("startupTimeoutMs", 30_000);

        if (!vscode.workspace.isTrusted) {
            const message = t("Trust the current workspace before dsh can run agent operations.");
            this.setStatus({ state: "error", message });
            throw new Error(message);
        }

        this.setStatus({ state: "starting", message: t("Connecting to dsh web...") });

        if (configuredUrl) {
            if (this.child && this.startedByExtension) {
                await this.stop();
                this.setStatus({ state: "starting", message: t("Connecting to dsh web...") });
            }
            const url = normalizeUrl(configuredUrl);
            await this.waitForReady(url, startupTimeout);
            this.baseUrl = url;
            this.startedByExtension = false;
            this.setStatus({ state: "running", url });
            this.harnessState.start();
            return url;
        }

        if (this.baseUrl && (await this.isHealthy(this.baseUrl))) {
            this.setStatus({ state: "running", url: this.baseUrl });
            this.harnessState.start();
            return this.baseUrl;
        }

        // Reuse a Runtime started by the CLI, another VS Code window, or a
        // previous extension instance before creating another writer process.
        // Harness's web profile defaults to port 3080; an explicit setting wins.
        const configuredPort = this.configuration().get<number>("serverPort", 0);
        const existingUrl = await this.findExistingRuntime(configuredPort);
        if (existingUrl) {
            this.baseUrl = existingUrl;
            this.startedByExtension = false;
            this.setStatus({ state: "running", url: existingUrl });
            this.harnessState.start();
            return existingUrl;
        }

        if (!workspaceRoot) {
            const message = t("Open a workspace before starting dsh with it as the working directory.");
            this.setStatus({ state: "error", message });
            throw new Error(message);
        }

        if (this.child && this.startedByExtension) {
            await this.stop();
            this.setStatus({ state: "starting", message: t("Starting dsh web...") });
        }

        let command = this.configuration().get<string>("command", "dsh").trim() || "dsh";
        const configuredArgs = this.configuration().get<string[]>("commandArgs", ["web", "--no-open"]);
        let args = [...configuredArgs];
        const enableCompaction = this.configuration().get<boolean>("enableCompaction", true);

        // Discovery may trigger a managed Runtime download. This deliberately
        // happens before the runtime start lock so one window can download or
        // reuse the cache while another window keeps using an installed runtime.
        let launcher: DshLauncher;
        try {
            launcher = await discoverDsh(command, {
                storagePath: this.storagePath,
                installWhenMissing: this.configuration().get<boolean>("installWhenMissing", true),
                runtimeVersion:
                    this.configuration().get<string>("runtimeVersion", RUNTIME_DEFAULT_VERSION) ||
                    RUNTIME_DEFAULT_VERSION,
                configuredArgs,
                allowManaged: true,
                proxy: this.httpProxy(),
                onLog: (message) => this.output.appendLine(message),
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.setStatus({ state: "error", message });
            throw error;
        }
        command = launcher.command;
        // The managed launcher is an absolute path to the standalone runtime
        // binary; package-manager commandArgs do not apply to it.
        args = launcher.usesConfiguredArgs === false
            ? [...launcher.args]
            : [...launcher.args, ...(launcher.source.kind === "managed" ? ["web", "--no-open"] : [...configuredArgs])];
        this.output.appendLine(`[dsh] discovered executable: ${command} (${describeSource(launcher.source)})`);

        if (!(await this.acquireRuntimeLock())) {
            const deadline = Date.now() + startupTimeout;
            while (Date.now() < deadline) {
                const url = await this.findExistingRuntime(configuredPort);
                if (url) {
                    this.baseUrl = url;
                    this.startedByExtension = false;
                    this.setStatus({ state: "running", url });
                    this.harnessState.start();
                    return url;
                }
                await delay(250);
            }
            const message = t("Another dsh runtime is starting, but it did not become available.");
            this.setStatus({ state: "error", message });
            throw new Error(message);
        }
        if (enableCompaction && isWebProfileArgs(args)) {
            this.compactionPatchPath = join(tmpdir(), `dsh-vscode-${process.pid}-compaction.patch.yml`);
            try {
                await writeFile(
                    this.compactionPatchPath,
                    "- id: compaction-basic\n  disabled: false\n\n- id: command-compact\n  disabled: false\n",
                    { encoding: "utf8", mode: 0o600 },
                );
            } catch (error) {
                await this.releaseRuntimeLock();
                throw error;
            }
            insertWebLauncherPatch(args, this.compactionPatchPath);
            this.output.appendLine(`[dsh] compaction command enabled with patch: ${this.compactionPatchPath}`);
        }
        args = ensureNoOpen(args);

        if (!args.some((argument) => argument === "--port" || argument === "-p" || argument.startsWith("--port="))) {
            // Port 0 asks Harness/the OS for a free port. This preserves the
            // normal 3080 default for discovery while still working when it is
            // occupied by another service or Runtime.
            args.push("--port", String(configuredPort > 0 ? configuredPort : 0));
        }

        const configuredNpxTimeout = configuration.get<number>("npxTimeoutMs", DEFAULT_NPX_TIMEOUT_MS);
        const npxTimeoutMs = Number.isFinite(configuredNpxTimeout) && configuredNpxTimeout > 0
            ? configuredNpxTimeout
            : DEFAULT_NPX_TIMEOUT_MS;
        const packageManagerFetchTimeoutMs = Math.min(npxTimeoutMs, DEFAULT_PACKAGE_MANAGER_FETCH_TIMEOUT_MS);
        const configuredNpmRegistry = normalizeNpmRegistry(
            configuration.get<string>("npmRegistry", DEFAULT_NPM_REGISTRY),
        );
        const hasExplicitRegistry = hasNpmRegistryArgument(args);
        const activeRegistry = isPackageManagerSource(launcher.source) && !hasExplicitRegistry
            ? await activeNpmRegistry(workspaceRoot, launcher.source.kind)
            : undefined;
        const npmRegistry = hasExplicitRegistry
            ? undefined
            : alternateNpmRegistry(configuredNpmRegistry, activeRegistry);
        const readinessTimeout = isPackageManagerSource(launcher.source) ? npxTimeoutMs : startupTimeout;

        if (isPackageManagerSource(launcher.source)) {
            this.output.appendLine(
                `[dsh] ${launcher.source.kind} registry: ${activeRegistry ? redactUrl(activeRegistry) : "<npm default>"}; fallback: ${npmRegistry ? redactUrl(npmRegistry) : "<disabled>"}`,
            );
            this.output.appendLine(
                `[dsh] ${launcher.source.kind} fetch timeout: ${packageManagerFetchTimeoutMs} ms; retries: 0 unless overridden by command or environment`,
            );
        }

        const launchAttempt = async (attemptArgs: string[]): Promise<string> => {
            const candidatePort = portFromArgs(attemptArgs);
            this.baseUrl = candidatePort
                ? `http://127.0.0.1:${candidatePort}`
                : undefined;

            this.output.appendLine(`[dsh] starting: ${command} ${attemptArgs.join(" ")}`);
            const launchEnv: NodeJS.ProcessEnv = { ...process.env };
            if (isPackageManagerSource(launcher.source)) {
                if ((launcher.source.kind !== "npx" || !hasNpmOptionArgument(attemptArgs, "--fetch-timeout"))
                    && !launchEnv.npm_config_fetch_timeout
                    && !launchEnv.NPM_CONFIG_FETCH_TIMEOUT) {
                    launchEnv.npm_config_fetch_timeout = String(packageManagerFetchTimeoutMs);
                }
                if ((launcher.source.kind !== "npx" || !hasNpmOptionArgument(attemptArgs, "--fetch-retries"))
                    && !launchEnv.npm_config_fetch_retries
                    && !launchEnv.NPM_CONFIG_FETCH_RETRIES) {
                    launchEnv.npm_config_fetch_retries = "0";
                }
            }
            const child = spawn(command, attemptArgs, {
                cwd: workspaceRoot,
                env: launchEnv,
                // Windows batch and PowerShell launchers fail with EINVAL unless
                // executed through the shell; native executables do not need it.
                shell: launcherNeedsShell(command),
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });
            this.child = child;
            this.startedByExtension = true;

            let exited = false;
            let launchError: Error | undefined;
            let outputTail = "";
            const recordOutput = (chunk: Buffer, stream: string): void => {
                const text = chunk.toString("utf8");
                outputTail = `${outputTail}${text}`.slice(-8_000);
                this.output.append(`[dsh:${stream}] ${text}`);

                const discoveredUrl = extractUrl(text);
                if (discoveredUrl && discoveredUrl !== this.baseUrl) {
                    this.baseUrl = discoveredUrl;
                    void this.publishRuntimeLockUrl(discoveredUrl).catch((error) => {
                        this.output.appendLine(`[dsh] failed to publish Runtime URL: ${String(error)}`);
                    });
                }
            };

            child.stdout?.on("data", (chunk: Buffer) => recordOutput(chunk, "out"));
            child.stderr?.on("data", (chunk: Buffer) => recordOutput(chunk, "err"));
            child.once("error", (error) => {
                launchError = error;
                exited = true;
            });
            child.once("close", (code, signal) => {
                exited = true;
                this.output.appendLine(`[dsh] exited: code=${code ?? "null"}, signal=${signal ?? "null"}`);
                if (this.child === child) {
                    this.child = undefined;
                }
            });

            const startedAt = Date.now();
            const heartbeat = isPackageManagerSource(launcher.source)
                ? setInterval(() => {
                    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1_000);
                    const timeoutSeconds = Math.ceil(readinessTimeout / 1_000);
                    this.output.appendLine(
                        `[dsh] ${launcher.source.kind} is still downloading/starting (${elapsedSeconds}s/${timeoutSeconds}s timeout)`,
                    );
                }, 15_000)
                : undefined;
            try {
                const url = await this.waitForReady(
                    undefined,
                    readinessTimeout,
                    () => exited,
                    () => launchError,
                    () => outputTail,
                );
                this.baseUrl = url;
                try {
                    await this.publishRuntimeLockUrl(url);
                } catch (error) {
                    this.output.appendLine(`[dsh] failed to publish Runtime URL: ${String(error)}`);
                }
                return url;
            } catch (error) {
                await this.terminate(child);
                this.child = undefined;
                this.baseUrl = undefined;
                this.startedByExtension = false;
                throw new RuntimeLaunchFailure(outputTail, error);
            } finally {
                if (heartbeat !== undefined) clearInterval(heartbeat);
            }
        };

        let url: string;
        try {
            try {
                url = await launchAttempt(args);
            } catch (error) {
                const registry = npmRegistry;
                if (!isPackageManagerSource(launcher.source) || registry === undefined) throw error;
                const mirrorArgs = withNpmRegistry(args, registry);
                if (!mirrorArgs || !isLikelyNpmDownloadFailure(error, error instanceof RuntimeLaunchFailure ? error.outputTail : "")) {
                    throw error;
                }

                this.output.appendLine(
                    `[dsh] ${launcher.source.kind} download/start failed; retrying with npm registry ${redactUrl(registry)}`,
                );
                try {
                    url = await launchAttempt(mirrorArgs);
                } catch (retryError) {
                    const firstMessage = error instanceof Error ? error.message : String(error);
                    const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
                    throw new Error(
                        `${firstMessage}\n\n${t("Retrying with the alternate npm registry also failed.")}\n\n${retryMessage}`,
                    );
                }
            }
        } catch (error) {
            await this.releaseRuntimeLock();
            let message = error instanceof Error ? error.message : String(error);
            if (launcher.source.kind === "managed") {
                // Keep the freshly installed runtime in place for diagnosis.
                message = t("Managed Runtime {version} ({target}) failed to become ready.\n\n{message}", {
                    version: launcher.source.version,
                    target: launcher.source.target,
                    message,
                });
            }
            this.setStatus({ state: "error", message });
            throw new Error(message);
        }

        this.baseUrl = url;
        this.setStatus({ state: "running", url });
        this.harnessState.start();
        return url;
    }

    private async waitForReady(
        initialUrl: string | undefined,
        timeoutMs: number,
        hasExited?: () => boolean,
        getLaunchError?: () => Error | undefined,
        getOutputTail?: () => string,
    ): Promise<string> {
        const deadline = Date.now() + timeoutMs;
        let lastError = "";

        while (Date.now() < deadline) {
            if (hasExited?.()) {
                const launchError = getLaunchError?.();
                if (launchError) {
                    throw new Error(t("Failed to start dsh: {message}", { message: launchError.message }));
                }

                const tail = getOutputTail?.().trim();
                throw new Error(
                    t("dsh web exited before becoming ready.{output}", {
                        output: tail ? `\n\n${t("Last output:")}\n${tail}` : "",
                    }),
                );
            }

            const url = initialUrl ?? this.baseUrl;
            if (url && (await this.isHealthy(url))) {
                return url;
            }

            if (url) {
                lastError = t("Unable to connect to {url}", { url });
            }
            await delay(250);
        }

        const tail = getOutputTail?.().trim();
        throw new Error(t("Timed out waiting for dsh web.{reason}{output}", {
            reason: lastError
                ? ` ${lastError}.`
                : ` ${t("No local service address was found in the process output.")}`,
            output: tail ? `\n\n${t("Last output:")}\n${tail}` : "",
        }));
    }

    private async isHealthy(url: string): Promise<boolean> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1_500);
        try {
            const response = await fetch(url, { signal: controller.signal });
            return response.ok;
        } catch {
            return false;
        } finally {
            clearTimeout(timeout);
        }
    }

    private async findExistingRuntime(configuredPort: number): Promise<string | undefined> {
        const advertisedUrl = await this.readRuntimeLockUrl();
        if (advertisedUrl && (await this.isHarnessHealthy(advertisedUrl))) {
            return advertisedUrl;
        }
        const ports = (configuredPort > 0 ? [configuredPort, 3080] : [3080]).filter(
            (port, index, all): port is number => Number.isInteger(port) && port > 0 && all.indexOf(port) === index,
        );
        for (const port of ports) {
            const url = `http://127.0.0.1:${port}`;
            if (await this.isHarnessHealthy(url)) return url;
        }
        return undefined;
    }

    private async isHarnessHealthy(url: string): Promise<boolean> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1_500);
        try {
            const response = await fetch(`${url}/api/host.describe`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    type: "client-request",
                    rpcId: `dsh-vscode-probe-${process.pid}`,
                    method: "host.describe",
                    payload: {},
                }),
                signal: controller.signal,
            });
            if (!response.ok) return false;
            const body: unknown = await response.json();
            return typeof body === "object" && body !== null
                && (body as { type?: unknown }).type === "server-response";
        } catch {
            return false;
        } finally {
            clearTimeout(timeout);
        }
    }

    private async acquireRuntimeLock(): Promise<boolean> {
        // A peer on the pre-rename lock cannot see ours, so check its file
        // first: deferring to a live legacy owner is what keeps the transition
        // from spawning two Runtimes.
        if (await this.legacyRuntimeLockOwnerAlive()) return false;
        const path = join(tmpdir(), RUNTIME_LOCK_FILE);
        try {
            const handle = await open(path, "wx", 0o600);
            const createdAt = Date.now();
            await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt }), "utf8");
            this.runtimeLock = { handle, path, createdAt };
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            try {
                const contents = await readFile(path, "utf8");
                const pid = Number((JSON.parse(contents) as { pid?: unknown }).pid);
                if (Number.isInteger(pid) && pid > 0) {
                    try {
                        process.kill(pid, 0);
                        return false;
                    } catch (probeError) {
                        if ((probeError as NodeJS.ErrnoException).code !== "ESRCH") return false;
                    }
                }
                await unlink(path);
                return this.acquireRuntimeLock();
            } catch (staleError) {
                if ((staleError as NodeJS.ErrnoException).code === "ENOENT") return this.acquireRuntimeLock();
                return false;
            }
        }
    }

    private async readRuntimeLockUrl(): Promise<string | undefined> {
        // The shared lock wins; the legacy one still answers for a peer that
        // has not updated yet.
        for (const name of [RUNTIME_LOCK_FILE, LEGACY_RUNTIME_LOCK_FILE]) {
            const url = await readLockRecordUrl(join(tmpdir(), name));
            if (url) return url;
        }
        return undefined;
    }

    /**
     * Whether a pre-rename peer is holding its own lock right now. A lock with
     * no readable live pid is stale and does not block us.
     */
    private async legacyRuntimeLockOwnerAlive(): Promise<boolean> {
        try {
            const contents = await readFile(join(tmpdir(), LEGACY_RUNTIME_LOCK_FILE), "utf8");
            const pid = Number((JSON.parse(contents) as { pid?: unknown }).pid);
            if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
            try {
                process.kill(pid, 0);
                return true;
            } catch (probeError) {
                return (probeError as NodeJS.ErrnoException).code !== "ESRCH";
            }
        } catch {
            return false;
        }
    }

    private publishRuntimeLockUrl(url: string): Promise<void> {
        const lock = this.runtimeLock;
        const advertisedUrl = loopbackRuntimeUrl(url);
        if (!lock || !advertisedUrl) return Promise.resolve();

        const write = this.runtimeLockWrite
            .catch(() => undefined)
            .then(async () => {
                if (this.runtimeLock !== lock) return;
                const contents = JSON.stringify({
                    pid: process.pid,
                    createdAt: lock.createdAt,
                    url: advertisedUrl,
                });
                await lock.handle.truncate(0);
                await lock.handle.write(contents, 0, "utf8");
                await lock.handle.sync();
            });
        this.runtimeLockWrite = write;
        return write;
    }

    private async releaseRuntimeLock(): Promise<void> {
        const lock = this.runtimeLock;
        this.runtimeLock = undefined;
        if (!lock) return;
        try {
            await this.runtimeLockWrite.catch(() => undefined);
            await lock.handle.close();
        } finally {
            await unlink(lock.path).catch(() => undefined);
        }
    }

    private async terminate(child: ChildProcess): Promise<void> {
        if (child.exitCode !== null || child.signalCode !== null) {
            return;
        }

        await new Promise<void>((resolve) => {
            let settled = false;
            const finish = (): void => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve();
            };

            child.once("close", finish);
            child.kill("SIGTERM");
            setTimeout(() => {
                if (!settled) {
                    child.kill("SIGKILL");
                    finish();
                }
            }, 2_000);
        });
    }

    private configuration(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration("dsh");
    }

    /** Read the VS Code http.proxy setting so downloads honor it like curl. */
    private httpProxy(): string | undefined {
        const value = vscode.workspace.getConfiguration("http").get<string>("proxy", "");
        return value.trim() || undefined;
    }

    private setStatus(status: RuntimeStatus): void {
        this.status = status;
        for (const listener of this.listeners) {
            listener({ ...status });
        }
    }
}
