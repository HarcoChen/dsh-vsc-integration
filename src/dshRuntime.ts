import { ChildProcess, execFile } from "node:child_process";
import { RuntimeDescendantOwnershipUnknownError, spawnOwnedRuntime, terminateOwnedRuntime, withinShutdownDeadline } from "./runtimeProcess";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, join, posix } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { RemoteConnectionController } from "./remote/connection";
import { parseRemoteServerResponse, remoteEndpointUrl } from "./remote/contracts";
import { RemoteHttpError, RemoteProtocolError } from "./remote/errors";
import { RemoteStateCoordinator } from "./remote/stateCoordinator";
import { RemoteUnaryClient } from "./remote/unaryClient";
import type {
    DshTeamView,
    DshCreateTeamTaskRequest,
    DshUpdateTeamTaskRequest,
    DshTeamTaskMutationResult,
} from "./agentTeamTypes";
import {
    acquireRuntimeStartupMutex, advertisedEndpointRefused, publishRuntimeAdvertisement,
    readRuntimeAdvertisements, removeRuntimeAdvertisement, type RuntimeAdvertisement,
} from "./runtimeAdvertisement";
import { compareRuntimeVersions } from "./runtimeVersion";

import { historyEntries as remoteHistoryEntries, projectionBlock as remoteProjectionBlock } from "./remote/sessionState";
import type { DebugContextTracker } from "./debugContext";
import { DebugLaunchOverlay } from "./debugLaunch";
import { t } from "./localize";
import { LocalRuntimeUpgradeCancelledError, offerLocalRuntimeUpgrade } from "./localRuntimeUpgrade";
import { buildComposition, patchPathsFromArgs, profileNameFromArgs } from "./recovery/composition";
import { RecoveryDiagnostics } from "./recovery/diagnostics";
import { FixExecutor } from "./recovery/fixExecutor";
import { HealthOracle } from "./recovery/healthOracle";
import { RecoveryLedgerCorruptError, RecoveryLedgerStore } from "./recovery/ledger";
import { RecoverySession } from "./recovery/recoverySession";
import { SandboxManager } from "./recovery/sandbox";
import type {
    CompositionDescriptor,
    RecoveryOutcome,
    RecoveryStatusView,
} from "./recovery/types";
import {
    RUNTIME_DEFAULT_VERSION, RUNTIME_MINIMUM_VERSION, isSupportedRuntimeVersion,
    acquireManagedRuntime,
    checkInstalled,
    resolveTarget,
} from "./managedRuntime";
import type { ManagedRuntime, RuntimeInstallPhase } from "./managedRuntime";
import {
    DshCommandDescriptor,
    DshCommandExecution,
    DshGoalRef,
    DshGoalActivationState,
    DshGoalRefResult,
    DshHistoryResult,
    DshSessionCreateResult,
    DshSessionForkResult,
    DshSessionPromptResult,
    DshImageAttachmentResult,
    DshImageUpload,
    DshFileDraft,
    DshSessionModelsResult,
    DshSessionSelectModelResult,
    DshAgentPresetListResult,
    DshAgentPresetOpenResult,
    DshAgentPresetReadResult,
    DshAgentPresetSelectResult,
    DshDynamicPluginRemoveResult,
    DshDynamicPluginResolveResult,
    DshDynamicPluginRow,
    DshDynamicPluginStopResult,
    DshPluginInventorySnapshot,
    DshSessionRenameResult,
    DshSessionSearchResult,
    DshFileReferenceCandidate,
    DshSessionReferenceCandidate,
    DshSkillEntry,
    DshSkillListResult,
    DshProviderListResult,
    DshLlmModelsResult,
    DshLlmDiscoverModelsResult,
    DshCredentialDescribeResult,
    DshDirectoryListing,
    DshSettingsDescribeResult,
    DshSettingsNamespaceView,
    DshSettingsPathOperation,
    DshSubagentAddress,
    DshSubagentCatalog,
    DshSubagentHistoryResult,
    DshSubagentPromptResult,
    DshMessageFeedbackDeleteRequest,
    DshMessageFeedbackDeleteResult,
    DshMessageFeedbackListRequest,
    DshMessageFeedbackListResult,
    DshMessageFeedbackPutRequest,
    DshMessageFeedbackPutResult,
    DshSessionFeedbackRecordRequest,
    DshSessionFeedbackRecordResult,
    DshWorkspaceCreateResult,
    DshWorkspaceView,
    HarnessGoalEditChanges,
    HarnessHostDescription,
    HarnessQueueAction,
    RuntimeStatus,
} from "./types";
import {
    normalizeFileReferenceCandidates,
    normalizeSessionReferenceCandidates,
} from "./referenceCandidates";
import { normalizeModelSelectionProjection } from "./modelSelection";
import {
    normalizeDynamicPluginInventory,
    normalizeDynamicPluginRemoveResult,
    normalizeDynamicPluginResolveResult,
    normalizeDynamicPluginStopResult,
} from "./dynamicPlugins";
import { normalizePluginInventory } from "./pluginInventory";
import { normalizeSessionFeedbackRecordResult } from "./sessionFeedback";
import { isRecord } from "./guards";
import { samePath } from "./paths";
import {
    DEFAULT_JEV_ADVISORY_TIMEOUT_MS,
    DEFAULT_JEV_ASK_THRESHOLD,
    DEFAULT_JEV_BASE_URL,
    DEFAULT_JEV_BLOCK_THRESHOLD,
    DEFAULT_JEV_DONE_GATE,
    DEFAULT_JEV_GUARDED_TOOLS,
    DEFAULT_JEV_LOOP_GUARD,
    DEFAULT_JEV_MODEL,
    DEFAULT_JEV_RESULT_SHAPER,
    DEFAULT_JEV_TIMEOUT_MS,
    prepareJevIntegrationPatch,
    type JevIntegrationConfig,
} from "./jevIntegration";

type RuntimeListener = (status: RuntimeStatus) => void;
type HarnessConnectedListener = () => void;
/** One allowlisted host cordis event forwarded verbatim by the Runtime. */
type RemoteEventListener = (event: string, args: readonly unknown[]) => void;
const execFileAsync = promisify(execFile);
const DEFAULT_NPX_TIMEOUT_MS = 120_000;
const DEFAULT_PACKAGE_MANAGER_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_NPM_REGISTRY = "https://registry.npmmirror.com";
const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org";
const NPM_REGISTRY_QUERY_TIMEOUT_MS = 5_000;
const DEFAULT_RUNTIME_PORT = 3_080;
/** Bounded recovery delays for a Runtime launched by this extension. */
const RUNTIME_RECOVERY_DELAYS_MS = [1_000, 5_000, 15_000] as const;
type PackageManager = "npx" | "pnpm";

/** The advertisement this editor owns, plus launch bookkeeping never published. */
type OwnedRuntimeRecord = Omit<RuntimeAdvertisement, "baseUrl"> & {
    url?: string; runtimeProcess?: "direct" | "wrapper"; recoverySessionId?: string;
};

/** A version string the Runtime comparator accepts, used to validate launch input. */
const exactRuntimeVersion = (value: unknown): value is string =>
    typeof value === "string" && compareRuntimeVersions(value, value) !== undefined;
function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Assign the conventional title for a forked Session. The Host deliberately
 * returns only the child id and preserves the source title; title disambiguation
 * is a client-side Session action.
 */
function increasedForkTitle(title: string): string {
    const ascii = /^(.*?)\((\d+)\)$/u.exec(title);
    if (ascii?.[1] !== undefined && ascii[2] !== undefined) {
        return `${ascii[1]}(${BigInt(ascii[2]) + 1n})`;
    }
    const fullWidth = /^(.*?)（(\d+)）$/u.exec(title);
    if (fullWidth?.[1] !== undefined && fullWidth[2] !== undefined) {
        return `${fullWidth[1]}（${BigInt(fullWidth[2]) + 1n}）`;
    }
    return `${title} (1)`;
}

function isRemoteRecord(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRemoteSeq(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= -1 && !Object.is(value, -0);
}

function remoteGoalRef(value: unknown): DshGoalRef | undefined {
    if (!isRemoteRecord(value) || typeof value.id !== "string" || value.id.length === 0) return undefined;
    return typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0
        ? { id: value.id, revision: value.revision }
        : undefined;
}

/** Keep the editor-facing goal facade stable while RC mutations return GoalView. */
function normalizeGoalRefResult(value: unknown, endpoint: string): DshGoalRefResult {
    const record = isRemoteRecord(value) ? value : undefined;
    const ref = remoteGoalRef(record?.ref) ?? remoteGoalRef(record);
    if (!ref) throw new RemoteProtocolError(`Remote ${endpoint} returned an invalid goal reference`);
    return { ref };
}

interface RuntimeEndpoint {
    /** URL used for HTTP requests; it never contains the launch token. */
    baseUrl: string;
    /** URL printed by dsh web, carrying the one-time launch token. */
    launchUrl?: string;
}

const AUTH_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/u;

function isLoopbackHostname(hostname: string): boolean {
    return hostname === "127.0.0.1" ||
        hostname === "localhost" ||
        hostname === "0.0.0.0" ||
        hostname === "[::1]";
}

function isInsecureRemoteRuntimeUrl(value: string): boolean {
    try {
        const url = new URL(value.trim());
        return url.protocol === "http:" && !isLoopbackHostname(url.hostname);
    } catch {
        return false;
    }
}

/** Parse a Runtime URL while keeping the launch token separate from requests. */
function parseRuntimeEndpoint(value: unknown, loopbackOnly = false): RuntimeEndpoint | undefined {
    if (typeof value !== "string") return undefined;
    try {
        const url = new URL(value.trim());
        if (
            (url.protocol !== "http:" && url.protocol !== "https:") ||
            url.username ||
            url.password ||
            url.hash ||
            (url.pathname !== "/" && url.pathname !== "") ||
            (loopbackOnly && (
                url.protocol !== "http:" ||
                !url.port ||
                !isLoopbackHostname(url.hostname)
            ))
        ) {
            return undefined;
        }

        const tokenValues = url.searchParams.getAll("token");
        if (
            [...url.searchParams.keys()].some((key) => key !== "token") ||
            tokenValues.length > 1 ||
            (tokenValues.length === 1 && !AUTH_TOKEN_PATTERN.test(tokenValues[0] ?? ""))
        ) {
            return undefined;
        }

        const base = new URL(url.href);
        base.search = "";
        base.hash = "";
        base.pathname = "/";
        if (loopbackOnly) {
            base.hostname = base.hostname === "[::1]" ? "[::1]" : "127.0.0.1";
        }
        const baseUrl = base.toString().replace(/\/$/u, "");
        if (tokenValues.length === 0) return { baseUrl };

        const launch = new URL(baseUrl);
        launch.searchParams.set("token", tokenValues[0] as string);
        return { baseUrl, launchUrl: launch.href };
    } catch {
        return undefined;
    }
}

/** Add a separately configured dsh web launch token to a parsed endpoint. */
function applyRuntimeToken(endpoint: RuntimeEndpoint, token: unknown): RuntimeEndpoint | undefined {
    if (typeof token !== "string") return endpoint;
    const normalized = token.trim();
    if (!normalized) return endpoint;
    if (!AUTH_TOKEN_PATTERN.test(normalized)) return undefined;

    const launch = new URL(endpoint.baseUrl);
    launch.searchParams.set("token", normalized);
    return {
        baseUrl: endpoint.baseUrl,
        launchUrl: launch.href,
    };
}

/** One lock file's advertised Runtime endpoint, or undefined when it has none. */
function advertisementEndpoint(record: { url?: unknown; launchUrl?: unknown }): RuntimeEndpoint | undefined {
    const advertised = parseRuntimeEndpoint(record.url, true);
    const launch = parseRuntimeEndpoint(record.launchUrl, true);
    const baseUrl = advertised?.baseUrl ?? launch?.baseUrl;
    if (!baseUrl) return undefined;
    const launchUrl = launch?.baseUrl === baseUrl
        ? launch.launchUrl
        : advertised?.baseUrl === baseUrl
            ? advertised.launchUrl
            : undefined;
    return { baseUrl, ...(launchUrl === undefined ? {} : { launchUrl }) };
}

function extractRuntimeEndpoint(value: string): RuntimeEndpoint | undefined {
    const match = value.match(
        /https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):\d+(?:\/\?token=[A-Za-z0-9_-]+)?/i,
    );
    return match ? parseRuntimeEndpoint(match[0], true) : undefined;
}

function portFromArgs(args: string[]): number | undefined {
    const invocation = dshPackageInvocation(args);
    if (invocation) args = args.slice(invocation.probeArgs.length);
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

/** Replace only the Web app's port, never an npx/pnpm package-selection `-p`. */
function withRuntimePort(args: string[], port: number): string[] {
    const result = [...args];
    const invocation = dshPackageInvocation(result);
    const start = invocation?.probeArgs.length ?? 0;
    for (let index = start; index < result.length; index += 1) {
        const argument = result[index];
        if (argument.startsWith("--port=")) {
            result[index] = `--port=${port}`;
            return result;
        }
        if (argument === "--port" || argument === "-p") {
            if (index + 1 < result.length) result[index + 1] = String(port);
            else result.push(String(port));
            return result;
        }
    }
    return [...result, "--port", String(port)];
}

/** Returns whether a launcher needs a shell on the current platform. */
function launcherNeedsShell(command: string): boolean {
    if (process.platform !== "win32") return false;
    return !/\.exe$/iu.test(command);
}

/** Node's shell mode joins the command without quoting its executable path. */
function launcherShellCommand(command: string): string {
    if (!launcherNeedsShell(command)) return command;
    // Quotes protect spaces and shell operators. Expansion markers cannot be
    // represented literally by this cmd.exe invocation, so fail closed rather
    // than execute a different path discovered from PATH or npm's prefix.
    if (/["%!\r\n]/u.test(command)) throw new Error("DSH launcher path cannot be safely invoked through the Windows shell");
    return `"${command}"`;
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

/** Resolve a package manager only when its shim can execute successfully. */
async function findUsablePackageManager(
    command: PackageManager,
    options: Pick<DiscoverDshOptions, "cwd" | "signal" | "onLog">,
): Promise<string | undefined> {
    const path = await findExecutable(command);
    if (!path) return undefined;
    options.signal?.throwIfAborted();
    try {
        const result = await execFileAsync(launcherShellCommand(path), ["--version"], {
            cwd: options.cwd,
            signal: options.signal,
            timeout: NPM_REGISTRY_QUERY_TIMEOUT_MS,
            windowsHide: true,
            shell: launcherNeedsShell(path),
        });
        if (result.stdout.trim() || result.stderr.trim()) return path;
    } catch (error) {
        options.signal?.throwIfAborted();
        options.onLog?.(`[dsh] ${command} at ${path} failed --version: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
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

function redactRuntimeOutput(value: string): string {
    return value.replace(/([?&]token=)[A-Za-z0-9_-]+/gu, "$1<redacted>");
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

interface RegistryArgument {
    value?: string;
    consumed: number;
}

function registryArgumentAt(
    args: string[],
    index: number,
    packageManager: PackageManager,
): RegistryArgument | undefined {
    const argument = args[index];
    if (argument === undefined) return undefined;

    const prefixes = packageManager === "pnpm"
        ? ["--registry=", "--config.registry="]
        : ["--registry="];
    const inlinePrefix = prefixes.find((prefix) => argument.startsWith(prefix));
    if (inlinePrefix !== undefined) {
        return {
            value: argument.slice(inlinePrefix.length),
            consumed: 1,
        };
    }

    const separated = packageManager === "pnpm"
        ? argument === "--registry" || argument === "--config.registry"
        : argument === "--registry";
    if (!separated) return undefined;

    const next = args[index + 1];
    return {
        ...(next !== undefined && !next.startsWith("-") ? { value: next } : {}),
        consumed: next !== undefined && !next.startsWith("-") ? 2 : 1,
    };
}

/** Returns whether arguments already select a registry for the active package manager. */
function hasNpmRegistryArgument(args: string[], packageManager?: PackageManager): boolean {
    if (packageManager === undefined) {
        return args.some((argument) => argument === "--registry" || argument.startsWith("--registry="));
    }
    return args.some((_, index) => registryArgumentAt(args, index, packageManager) !== undefined);
}

interface NormalizedRegistryArguments {
    args: string[];
    registryArgs: string[];
}

/** Converts registry flags while keeping their values as separate arguments. */
function normalizeRegistryArguments(
    args: string[],
    fromPackageManager: PackageManager,
    toPackageManager: PackageManager,
): NormalizedRegistryArguments {
    const remaining: string[] = [];
    const registryArgs: string[] = [];
    for (let index = 0; index < args.length;) {
        const registry = registryArgumentAt(args, index, fromPackageManager);
        if (registry === undefined) {
            remaining.push(args[index] as string);
            index += 1;
            continue;
        }

        if (toPackageManager === "pnpm") {
            registryArgs.push(
                registry.value === undefined ? "--config.registry" : `--config.registry=${registry.value}`,
            );
        } else if (registry.value === undefined) {
            registryArgs.push("--registry");
        } else {
            registryArgs.push("--registry", registry.value);
        }
        index += registry.consumed;
    }
    return { args: remaining, registryArgs };
}

function hasNpmOptionArgument(args: string[], option: string): boolean {
    return args.some((argument) => argument === option || argument.startsWith(`${option}=`));
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

function isDshWriterLockFailure(error: unknown): boolean {
    const output = error instanceof RuntimeLaunchFailure ? error.outputTail : String(error);
    return /atomic-write: timed out waiting for the writer lock at /u.test(output);
}

function isLikelyNpmDownloadFailure(error: unknown, outputTail = ""): boolean {
    if (isDshWriterLockFailure(error)) return false;
    if (isPackageManagerBootstrapFailure(error, outputTail)) return true;
    const message = error instanceof Error ? error.message : String(error);
    // Package-manager names in cached stack-trace paths are not download evidence.
    return /(?:^\s*(?:npm\s+(?:err(?:or)?|warn)\b|ERR_PNPM_[A-Z_]+)|fetch failed|network (?:error|request|timeout)|timed out waiting for dsh web|eai_again|etimedout|econnreset|enotfound|socket hang up)/imu.test(
        `${message}\n${outputTail}`,
    );
}

/** Detect a package-manager shim that points at a missing Corepack script. */
function isCorepackPackageManagerShimFailure(error: unknown, outputTail = ""): boolean {
    if (isDshWriterLockFailure(error)) return false;
    const message = error instanceof Error ? error.message : String(error);
    const output = `${message}\n${outputTail}`;
    return /Cannot find module ['"][^'"\r\n]*corepack[\\/][^'"\r\n]*(?:pnpm|npx)\.js['"]/iu.test(output) ||
        /MODULE_NOT_FOUND[\s\S]{0,400}corepack[\\/][\s\S]{0,240}(?:pnpm|npx)/iu.test(output);
}

/** Detect package-manager bootstrap failures that a registry retry cannot repair. */
function isPnpmDlxCacheFailure(error: unknown, outputTail = ""): boolean {
    if (isDshWriterLockFailure(error)) return false;
    const message = error instanceof Error ? error.message : String(error);
    const output = `${message}\n${outputTail}`;
    return /pnpm-cache[\\/]dlx[\\/]/iu.test(output) ||
        /(?:pnpm(?:\.mjs)?|corepack[\\/][^\r\n]*pnpm)[^\r\n]{0,240}(?:realpathSync|stat\b)[^\r\n]{0,240}(?:pkg|ENOENT|unknown error)/iu.test(output);
}

/** Store and cache roots that belong to a package manager, never to a project. */
const PACKAGE_MANAGER_STORE_PATH =
    /(?:[A-Za-z]:)?[\\/][^\r\n'"]*?(?:pnpm[\\/]store[\\/]v\d+|pnpm-store|pnpm-cache[\\/]dlx|[\\/]_npx)/iu;

/**
 * A package-manager store that resolves DSH itself but not its dependencies.
 * The download already succeeded, so retrying the registry just reproduces the
 * same layout: only a different package manager or a cleared store can help.
 */
function isPackageManagerCacheLayoutFailure(error: unknown, outputTail = ""): boolean {
    if (isDshWriterLockFailure(error)) return false;
    const message = error instanceof Error ? error.message : String(error);
    const output = `${message}\n${outputTail}`;
    if (!/\bERR_MODULE_NOT_FOUND\b|\bERR_PACKAGE_PATH_NOT_EXPORTED\b|Cannot find (?:package|module)\b/u.test(output)) {
        return false;
    }
    return PACKAGE_MANAGER_STORE_PATH.test(output);
}

/** The store root to name in cleanup guidance, when the output reveals one. */
function packageManagerStoreRoot(output: string): string | undefined {
    return PACKAGE_MANAGER_STORE_PATH.exec(output)?.[0];
}

function isPackageManagerBootstrapFailure(error: unknown, outputTail = ""): boolean {
    return isPnpmDlxCacheFailure(error, outputTail) || isCorepackPackageManagerShimFailure(error, outputTail) ||
        isPackageManagerCacheLayoutFailure(error, outputTail);
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
    skipLocal?: boolean;
    /** Startup only; diagnostics must never offer or perform upgrades. */
    onOutdatedLocal?: (command: string, actual: string | undefined) => Promise<string | undefined>;
    /** HTTP(S) proxy URL, e.g. from the VS Code http.proxy setting. */
    proxy?: string;
    onLog?: (message: string) => void;
    signal?: AbortSignal;
    cwd?: string;
}

/** Defaults follow the selected launcher; explicitly saved arguments stay authoritative. */
function configuredLaunchArgs(configuration: vscode.WorkspaceConfiguration, command: string): string[] {
    const inspected = configuration.inspect?.<string[]>("commandArgs");
    const explicit = inspected && [inspected.globalValue, inspected.workspaceValue, inspected.workspaceFolderValue,
        inspected.globalLanguageValue, inspected.workspaceLanguageValue, inspected.workspaceFolderLanguageValue]
        .some(value => value !== undefined);
    if (!inspected || explicit) return configuration.get<string[]>("commandArgs", ["web", "--no-open"]);
    if (command === "pnpm") return ["dlx", DSH_PACKAGE, "web", "--no-open"];
    if (command === "npx") return ["--yes", DSH_PACKAGE, "web", "--no-open"];
    return ["web", "--no-open"];
}

/** The requested download/upgrade version must meet the minimum compatibility version. */
function configuredRuntimeVersion(configuration: vscode.WorkspaceConfiguration): string {
    const version = configuration.get<string>("runtimeVersion", RUNTIME_DEFAULT_VERSION).trim() || RUNTIME_DEFAULT_VERSION;
    if (!isSupportedRuntimeVersion(version)) {
        throw new RemoteProtocolError(t(
            "dsh.runtimeVersion is {actual}; this extension only supports {expected}. Reset dsh.runtimeVersion before starting a local Runtime.",
            { actual: version, expected: t("{version} or newer", { version: RUNTIME_MINIMUM_VERSION }) },
        ));
    }
    return version;
}

/** Read the host-owned Jev launch defaults without trusting malformed settings. */
function configuredJevIntegration(configuration: vscode.WorkspaceConfiguration): JevIntegrationConfig {
    const text = (key: string, fallback: string): string => {
        const value = configuration.get<unknown>(key);
        return typeof value === "string" ? value : fallback;
    };
    const number = (key: string, fallback: number): number => {
        const value = configuration.get<unknown>(key);
        return typeof value === "number" ? value : fallback;
    };
    const boolean = (key: string, fallback: boolean): boolean => {
        const value = configuration.get<unknown>(key);
        return typeof value === "boolean" ? value : fallback;
    };
    const strings = (key: string, fallback: readonly string[]): string[] => {
        const value = configuration.get<unknown>(key);
        return Array.isArray(value)
            ? value.filter((item): item is string => typeof item === "string")
            : [...fallback];
    };
    const tools = configuration.get<unknown>("jev.guardedTools");
    return {
        enabled: configuration.get<unknown>("jev.enabled") === true,
        baseUrl: text("jev.baseUrl", DEFAULT_JEV_BASE_URL),
        model: text("jev.model", DEFAULT_JEV_MODEL),
        timeoutMs: number("jev.timeoutMs", DEFAULT_JEV_TIMEOUT_MS),
        advisoryTimeoutMs: number("jev.advisoryTimeoutMs", DEFAULT_JEV_ADVISORY_TIMEOUT_MS),
        askThreshold: number("jev.askThreshold", DEFAULT_JEV_ASK_THRESHOLD),
        blockThreshold: number("jev.blockThreshold", DEFAULT_JEV_BLOCK_THRESHOLD),
        guardedTools: Array.isArray(tools)
            ? tools.filter((tool): tool is string => typeof tool === "string")
            : DEFAULT_JEV_GUARDED_TOOLS,
        loopGuard: {
            enabled: boolean("jev.loopGuard.enabled", DEFAULT_JEV_LOOP_GUARD.enabled),
            triggerThreshold: number("jev.loopGuard.triggerThreshold", DEFAULT_JEV_LOOP_GUARD.triggerThreshold),
            noProgressThreshold: number("jev.loopGuard.noProgressThreshold", DEFAULT_JEV_LOOP_GUARD.noProgressThreshold),
            pLoopThreshold: number("jev.loopGuard.pLoopThreshold", DEFAULT_JEV_LOOP_GUARD.pLoopThreshold),
            minConfidence: number("jev.loopGuard.minConfidence", DEFAULT_JEV_LOOP_GUARD.minConfidence),
            cooldownSteps: number("jev.loopGuard.cooldownSteps", DEFAULT_JEV_LOOP_GUARD.cooldownSteps),
            maxHistory: number("jev.loopGuard.maxHistory", DEFAULT_JEV_LOOP_GUARD.maxHistory),
            deferExactRepeats: boolean("jev.loopGuard.deferExactRepeats", DEFAULT_JEV_LOOP_GUARD.deferExactRepeats),
            requestTimeoutMs: number("jev.loopGuard.requestTimeoutMs", DEFAULT_JEV_LOOP_GUARD.requestTimeoutMs),
            include: strings("jev.loopGuard.include", DEFAULT_JEV_LOOP_GUARD.include),
            exclude: strings("jev.loopGuard.exclude", DEFAULT_JEV_LOOP_GUARD.exclude),
        },
        resultShaper: {
            enabled: boolean("jev.resultShaper.enabled", DEFAULT_JEV_RESULT_SHAPER.enabled),
            shapeTools: strings("jev.resultShaper.shapeTools", DEFAULT_JEV_RESULT_SHAPER.shapeTools),
            thresholdChars: number("jev.resultShaper.thresholdChars", DEFAULT_JEV_RESULT_SHAPER.thresholdChars),
            maxPerTurn: number("jev.resultShaper.maxPerTurn", DEFAULT_JEV_RESULT_SHAPER.maxPerTurn),
            keepKinds: strings("jev.resultShaper.keepKinds", DEFAULT_JEV_RESULT_SHAPER.keepKinds),
            minKindConfidence: number("jev.resultShaper.minKindConfidence", DEFAULT_JEV_RESULT_SHAPER.minKindConfidence),
            maxClusters: number("jev.resultShaper.maxClusters", DEFAULT_JEV_RESULT_SHAPER.maxClusters),
            sampleChars: number("jev.resultShaper.sampleChars", DEFAULT_JEV_RESULT_SHAPER.sampleChars),
            requestTimeoutMs: number("jev.resultShaper.requestTimeoutMs", DEFAULT_JEV_RESULT_SHAPER.requestTimeoutMs),
        },
        doneGate: {
            enabled: boolean("jev.doneGate.enabled", DEFAULT_JEV_DONE_GATE.enabled),
            blockThreshold: number("jev.doneGate.blockThreshold", DEFAULT_JEV_DONE_GATE.blockThreshold),
            minEvidenceItems: number("jev.doneGate.minEvidenceItems", DEFAULT_JEV_DONE_GATE.minEvidenceItems),
            requestTimeoutMs: number("jev.doneGate.requestTimeoutMs", DEFAULT_JEV_DONE_GATE.requestTimeoutMs),
            maxClaimChars: number("jev.doneGate.maxClaimChars", DEFAULT_JEV_DONE_GATE.maxClaimChars),
            cooldownTurns: number("jev.doneGate.cooldownTurns", DEFAULT_JEV_DONE_GATE.cooldownTurns),
        },
    };
}

async function probeRuntimeVersion(command: string, options: { cwd?: string; signal?: AbortSignal; args?: string[]; timeout?: number }): Promise<string | undefined> {
    options.signal?.throwIfAborted();
    try {
        const result = await execFileAsync(launcherShellCommand(command), [...(options.args ?? []), "--version"], {
            cwd: options.cwd, signal: options.signal, timeout: options.timeout ?? 5_000,
            windowsHide: true, shell: launcherNeedsShell(command),
        });
        const version = result.stdout.trim();
        return exactRuntimeVersion(version) ? version : undefined;
    } catch {
        options.signal?.throwIfAborted();
        return undefined;
    }
}

function isPackageManagerSource(source: DshRuntimeSource): source is Extract<DshRuntimeSource, { kind: "npx" | "pnpm" }> {
    return source.kind === "npx" || source.kind === "pnpm";
}

function isPackageManagerCommand(command: string): command is "npx" | "pnpm" {
    return command === "npx" || command === "pnpm";
}

/** Convert a package-manager invocation while normalizing registry flags. */
function alternatePackageManagerArgs(
    fromCommand: PackageManager,
    toCommand: PackageManager,
    configuredArgs: string[],
): string[] | undefined {
    if (fromCommand === "pnpm" && toCommand === "npx") {
        const normalized = normalizeRegistryArguments(configuredArgs, fromCommand, toCommand);
        const dlxIndex = normalized.args.findIndex((argument) => argument === "dlx");
        if (dlxIndex < 0) return undefined;
        const pnpmOptions = normalized.args.slice(0, dlxIndex);
        return [
            ...normalized.registryArgs,
            ...pnpmOptions,
            "--yes",
            ...normalized.args.slice(dlxIndex + 1),
        ];
    }
    if (fromCommand === "npx" && toCommand === "pnpm") {
        const normalized = normalizeRegistryArguments(configuredArgs, fromCommand, toCommand);
        const npxArgs = normalized.args.filter((argument) => argument !== "-y" && argument !== "--yes");
        return [...normalized.registryArgs, "dlx", ...npxArgs];
    }
    return undefined;
}

const DSH_PACKAGE = "@deepseek-ai/dsh";

/**
 * Pin every package-manager invocation to the Runtime this build speaks.
 *
 * A bare `@deepseek-ai/dsh` resolves to the dist-tag `latest`, so publishing a
 * Runtime moves existing installations onto it at the next cold start — and a
 * Runtime release may replace the wire protocol wholesale. The pin is
 * validated against the minimum version; both automatic fallbacks and
 * explicit package-manager commands pass through this pin.
 *
 * An operator who wrote an explicit `@deepseek-ai/dsh@<version>` asked for that
 * version and keeps it; only the unpinned spec is rewritten.
 */
function pinDshPackageArgs(args: string[], version: string): string[] {
    return args.map((argument) =>
        argument === DSH_PACKAGE || argument === `--package=${DSH_PACKAGE}` || argument === `-p=${DSH_PACKAGE}`
            ? `${argument}@${version}` : argument,
    );
}

/** Locate positional DSH packages and npx --package/-p forms, retaining the executable for probes. */
function dshPackageInvocation(args: string[]): { index: number; spec: string; prefix: string; probeArgs: string[] } | undefined {
    for (let index = 0; index < args.length; index += 1) {
        const prefix = /^(?:--package|-p)=/u.exec(args[index])?.[0] ?? "";
        const spec = args[index].slice(prefix.length);
        if (spec !== DSH_PACKAGE && !spec.startsWith(`${DSH_PACKAGE}@`)) continue;
        const packageOption = prefix !== "" || args[index - 1] === "--package" || args[index - 1] === "-p";
        const executable = packageOption ? args.indexOf("dsh", index + 1) : index;
        if (executable < 0) return undefined;
        return { index, spec, prefix, probeArgs: args.slice(0, executable + 1) };
    }
    return undefined;
}

function npxArgsForDsh(configuredArgs: string[]): string[] {
    const normalized = normalizeRegistryArguments(configuredArgs, "pnpm", "npx");
    const dlxIndex = normalized.args.findIndex((argument) => argument === "dlx");
    if (dlxIndex >= 0) {
        return [
            ...normalized.registryArgs,
            "--yes",
            ...normalized.args.slice(dlxIndex + 1),
        ];
    }

    const packageIndex = normalized.args.findIndex((argument) =>
        /^@deepseek-ai\/dsh(?:@|$)/u.test(argument),
    );
    if (packageIndex >= 0) {
        const prefix = normalized.args
            .slice(0, packageIndex)
            .filter((argument) => argument !== "-y" && argument !== "--yes");
        return [...normalized.registryArgs, ...prefix, "--yes", ...normalized.args.slice(packageIndex)];
    }

    return [
        ...normalized.registryArgs,
        "--yes",
        DSH_PACKAGE,
        ...normalized.args.filter(
            (argument) => argument !== "-y" && argument !== "--yes",
        ),
    ];
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
    executableCommand: string = command,
): DshLauncher {
    return {
        command: executableCommand,
        args,
        source: command === "pnpm"
            ? { kind: "pnpm", command: executableCommand, args }
            : { kind: "npx", command: executableCommand, args },
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

function isAddressInUseFailure(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const output = error instanceof RuntimeLaunchFailure ? error.outputTail : "";
    return /\bEADDRINUSE\b|address already in use|only one usage of each socket address/iu.test(
        `${message}\n${output}`,
    );
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
    options.signal?.throwIfAborted();
    const storagePath = options.storagePath;
    if (storagePath === undefined) {
        throw new Error(t("The managed DSH Runtime requires a global storage directory."));
    }
    const version = options.runtimeVersion;
    const log = options.onLog ?? (() => undefined);
    const target = resolveTarget();

    // Cached runtimes launch directly without any progress UI.
    const cached = await checkInstalled(storagePath, target, version);
    options.signal?.throwIfAborted();
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
                    signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
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
 * Auto resolves compatible PATH/npm-global dsh, then pinned pnpm/npx, then
 * managed Runtime. An incompatible local launcher gets an upgrade choice
 * before package-manager fallback. Explicit package-manager commands keep
 * their requested startup path. Every provider failure is aggregated so a
 * failed download is never masked as a generic "dsh not available".
 */
async function discoverDsh(command: string, options: DiscoverDshOptions): Promise<DshLauncher> {
    const failures: string[] = [];

    options.signal?.throwIfAborted();
    if (command !== "auto" && isPackageManagerCommand(command)) {
        const executable = await findUsablePackageManager(command, options);
        if (executable) return packageManagerLauncher(command, [], true, executable);
    } else if (command !== "auto" && await executableExists(command)) {
        const path = await findExecutable(command);
        let version = await probeRuntimeVersion(command, options);
        if (!isSupportedRuntimeVersion(version) && options.onOutdatedLocal && path) {
            version = await options.onOutdatedLocal(path, version) ?? version;
            if (!isSupportedRuntimeVersion(version)) {
                return discoverDsh("auto", { ...options, skipLocal: true });
            }
        }
        return { command, args: [], source: { kind: "configured", command, args: [] } };
    }
    // pnpm dlx and npx are interchangeable package-manager launchers for the
    // published DSH package. Prefer the other one when the configured default
    // is missing, converting the packaged arguments where possible.
    if (isPackageManagerCommand(command)) {
        failures.push(t("{command}: not found or could not run --version", { command }));
        const alternateCommand = command === "pnpm" ? "npx" : "pnpm";
        const alternateExecutable = await findUsablePackageManager(alternateCommand, options);
        if (alternateExecutable) {
            const alternateArgs = alternatePackageManagerArgs(command, alternateCommand, options.configuredArgs);
            if (alternateArgs) {
                return packageManagerLauncher(alternateCommand, alternateArgs, false, alternateExecutable);
            }
            failures.push(t("{command}: cannot reuse the configured package-manager arguments", {
                command: alternateCommand,
            }));
        } else {
            failures.push(t("{command}: not found or could not run --version", { command: alternateCommand }));
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
    if (command !== "auto") {
        throw new Error(t("Start command “{command}” was not found. Configure an absolute dsh.command path or install the dsh CLI.", { command }));
    }
    // Accept old saved package-manager arguments in auto mode, but never pass
    // dlx/package/registry prefixes to the native CLI. An explicit different
    // package version must reach the usual compatibility error, not be ignored.
    const packageIndex = options.configuredArgs.findIndex(arg => /^@deepseek-ai\/dsh(?:@|$)/u.test(arg));
    const packageSpec = packageIndex < 0 ? undefined : options.configuredArgs[packageIndex];
    const localArgs = packageIndex < 0 ? options.configuredArgs : options.configuredArgs.slice(packageIndex + 1);
    const permitsLocal = packageSpec === undefined || packageSpec === DSH_PACKAGE;
    const checked = new Set<string>();
    const compatibleLocal = async (path: string, kind: "path" | "npm-prefix"): Promise<DshLauncher | undefined> => {
        if (options.skipLocal || !permitsLocal || checked.has(path)) return undefined;
        checked.add(path);
        let version = await probeRuntimeVersion(path, options);
        if (!isSupportedRuntimeVersion(version) && options.onOutdatedLocal) {
            version = await options.onOutdatedLocal(path, version) ?? version;
        }
        if (!isSupportedRuntimeVersion(version)) {
            const reason = `[dsh] skipped local CLI ${path}: version ${version ?? "unknown"}; requires ${RUNTIME_MINIMUM_VERSION} or newer`;
            failures.push(reason);
            options.onLog?.(reason);
            return undefined;
        }
        options.onLog?.(`[dsh] compatible local CLI ${path}: ${version}`);
        return { command: path, args: [...localArgs], usesConfiguredArgs: false,
            source: { kind, command: path, args: [] } };
    };
    const localPath = await findExecutable("dsh");
    if (localPath) {
        const launcher = await compatibleLocal(localPath, "path");
        if (launcher) return launcher;
    } else failures.push(t("PATH dsh: not found"));

    let npmPrefixProbed = false;
    try {
        const result = await execFileAsync("npm", ["prefix", "-g"], {
            cwd: options.cwd, signal: options.signal, timeout: 5_000,
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
                    const launcher = await compatibleLocal(candidate, "npm-prefix");
                    if (launcher) return launcher;
                }
            }
        }
    } catch (error) {
        if (error instanceof CanceledError) throw error;
        options.signal?.throwIfAborted();
        failures.push(t("npm: unavailable"));
    }
    if (npmPrefixProbed) {
        failures.push(t("No dsh executable was found in the npm global prefix."));
    }

    const pnpmExecutable = await findUsablePackageManager("pnpm", options);
    if (pnpmExecutable) {
        const pnpmArgs = alternatePackageManagerArgs("npx", "pnpm", npxArgsForDsh(options.configuredArgs));
        if (pnpmArgs) return packageManagerLauncher("pnpm", pnpmArgs, false, pnpmExecutable);
    }
    failures.push(t("pnpm: not found or could not run --version"));

    const npxExecutable = await findUsablePackageManager("npx", options);
    if (npxExecutable) {
        return packageManagerLauncher("npx", npxArgsForDsh(options.configuredArgs), false, npxExecutable);
    }
    failures.push(t("npx: not found or could not run --version"));

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
    private readonly apiClient: RemoteUnaryClient;
    private readonly remoteConnection: RemoteConnectionController;
    private readonly harnessState: RemoteStateCoordinator;
    private readonly subagentHistoryCursors = new Map<string, number>();
    private child: ChildProcess | undefined;
    private baseUrl: string | undefined;
    private launchUrl: string | undefined;
    private authCookie: string | undefined;
    private authPromise: Promise<void> | undefined;
    private startPromise: Promise<string> | undefined;
    private startAbort: AbortController | undefined;
    private stopPromise: Promise<void> | undefined;
    private disposePromise: Promise<void> | undefined;
    private resourceCleanupDepth = 0;
    private startedByExtension = false;
    private ownedRuntime: { record: OwnedRuntimeRecord } | undefined;
    private sharedCompositionHash: string | undefined;
    private advertisementWrite: Promise<void> = Promise.resolve();
    private compactionPatchPath: string | undefined;
    private jevIntegrationPatchPath: string | undefined;
    private debugOverlay: DebugLaunchOverlay | undefined;
    private disposed = false;
    private status: RuntimeStatus = { state: "stopped" };
    private hostDescription: HarnessHostDescription | undefined;
    private runtimeRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
    private runtimeRecoveryAttempts = 0;
    private runtimeRecoveryGeneration = 0;
    private runtimeRecoveryInFlight = false;
    private readonly recoveryLedger: RecoveryLedgerStore;
    private readonly recoveryDiagnostics: RecoveryDiagnostics;
    private readonly recoveryFixes: FixExecutor;
    private readonly recoverySession: RecoverySession;
    private lastRecoveryComposition: CompositionDescriptor | undefined;
    private automaticRecoveryInFlight = false;

    public constructor(
        private readonly output: vscode.OutputChannel,
        private readonly storagePath: string,
        /** Shared with the context store so one DAP view backs both snapshots and tools. */
        private readonly debugContextTracker?: DebugContextTracker,
        /** Installed extension root containing the optional vendored Jev package. */
        private readonly extensionPath: string = join(__dirname, ".."),
        /** Extension-managed Jev credential, kept out of settings and launch patches. */
        private readonly jevApiKeyProvider?: () => Thenable<string | undefined>,
    ) {
        this.recoveryLedger = new RecoveryLedgerStore(storagePath);
        this.recoveryDiagnostics = new RecoveryDiagnostics(storagePath);
        this.recoveryFixes = new FixExecutor(this.recoveryLedger, output);
        this.recoverySession = new RecoverySession({
            oracle: new HealthOracle(new SandboxManager(), {
                diagnostics: this.recoveryDiagnostics,
                onOutput: (message) => this.output.appendLine(`[dsh:recovery] ${message}`),
            }),
            ledger: this.recoveryLedger,
            fixes: this.recoveryFixes,
            maxBoots: 8,
            allowBundleIsolation: () => this.configuration().get<boolean>("recovery.autoPersistBundleIsolation", true),
            onStatus: (status) => this.publishRecoveryStatus(status),
            onLog: (message) => this.output.appendLine(`[dsh:recovery] ${message}`),
        });
        this.apiClient = new RemoteUnaryClient({
            baseUrl: () => this.baseUrl,
            requestHeaders: () => this.requestHeaders(),
            timeoutMs: () =>
                this.configuration().get<number>("requestTimeoutMs", 600_000),
            onDiagnostic: (message, cause) => {
                const suffix = cause === undefined ? "" : `: ${String(cause)}`;
                this.output.appendLine(`[dsh:rpc] ${message}${suffix}`);
            },
        });
        this.remoteConnection = new RemoteConnectionController({
            baseUrl: () => this.baseUrl,
            requestHeaders: () => this.requestHeaders(),
            unary: this.apiClient,
            onDiagnostic: (message, cause) => {
                const suffix = cause === undefined ? "" : `: ${String(cause)}`;
                this.output.appendLine(`[dsh:remote] ${message}${suffix}`);
            },
        });
        this.harnessState = new RemoteStateCoordinator(this.remoteConnection, {
            onConnectionState: (state) => this.output.appendLine(`[dsh:remote] connection ${state}`),
            onHostDescription: (description) => {
                this.hostDescription = {
                    ...description,
                    canOpenPath: description.canOpenPath,
                };
                // A follow/page cut is generation-scoped. Any subagent page
                // request after reconnect must reopen its follow snapshot
                // instead of reusing a cursor from the dead carrier.
                this.subagentHistoryCursors.clear();
                for (const listener of this.harnessConnectedListeners) listener();
            },
            onHostFrame: (frame) => {
                if (frame.type !== "host/remote-event") return;
                const event = (frame as { event?: unknown }).event;
                if (typeof event !== "string") return;
                const args = (frame as { args?: unknown }).args;
                for (const listener of this.remoteEventListeners) listener(event, Array.isArray(args) ? args : []);
            },
            onDiagnostic: (message, cause) => {
                const suffix = cause === undefined ? "" : `: ${String(cause)}`;
                this.output.appendLine(`[dsh:remote] ${message}${suffix}`);
            },
        }, { runtimeVersion: RUNTIME_DEFAULT_VERSION });
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
     * Fires for each forwarded host event with its original Cordis arguments.
     * Consumers may apply event payloads or use them as cache invalidations.
     */
    public onDidRemoteEvent(listener: RemoteEventListener): vscode.Disposable {
        this.remoteEventListeners.add(listener);
        return new vscode.Disposable(() => this.remoteEventListeners.delete(listener));
    }

    public getStatus(): RuntimeStatus {
        return { ...this.status };
    }

    public getRecoveryStatus(): RecoveryStatusView | undefined {
        return this.recoverySession.getStatus();
    }

    /** Root of the per-session recovery logs (`recovery/logs/<sessionId>/`). */
    public getRecoveryLogsDirectory(): string {
        return this.recoveryDiagnostics.logsDirectory;
    }

    public cancelRecovery(): void {
        this.recoverySession.cancel();
    }

    public async exportRecoveryDiagnostics(): Promise<string> {
        const loaded = await this.recoveryLedger.read();
        return this.recoveryDiagnostics.export(loaded.state, this.lastRecoveryComposition, loaded.corrupt);
    }

    public async restoreRecovery(): Promise<string[]> {
        if (this.child || this.baseUrl) {
            throw new Error(t("Stop dsh Runtime before restoring automatic recovery changes."));
        }
        // Command discovery keeps `startPromise` live while `child`/`baseUrl` are still
        // unset, and an automatic recovery can be mid-flight; restoring then would race
        // those paths over the ledger and the profile manifest.
        if (this.startPromise || this.stopPromise || this.automaticRecoveryInFlight) {
            throw new Error(t("Stop dsh Runtime before restoring automatic recovery changes."));
        }
        const restored = await this.recoveryFixes.restore();
        if (restored.length) {
            this.output.appendLine(`[dsh:recovery] restored fixes: ${restored.join(", ")}`);
        }
        return restored;
    }

    public getUrl(): string | undefined {
        return this.baseUrl;
    }

    /** URL suitable for opening in a browser, including the launch token. */
    public getBrowserUrl(): string | undefined {
        return this.launchUrl ?? this.baseUrl;
    }

    public getHostDescription(): HarnessHostDescription | undefined {
        return this.hostDescription ? { ...this.hostDescription } : undefined;
    }

    /** Returns a redacted, read-only environment report without starting dsh. */
    public async diagnoseEnvironment(workspaceRoot?: string): Promise<string> {
        const configuration = this.configuration();
        const runtimeVersion = configuredRuntimeVersion(configuration);
        const command = configuration.get<string>("command", "auto").trim() || "auto";
        const configuredArgs = configuredLaunchArgs(configuration, command);
        const args = Array.isArray(configuredArgs)
            ? configuredArgs.filter((argument): argument is string => typeof argument === "string")
            : [];
        const serverUrl = configuration.get<string>("serverUrl", "").trim();
        const serverToken = configuration.get<string>("serverToken", "").trim();
        const configuredPort = configuration.get<number>("serverPort", 0);
        const apiKeyRef = configuration.get<string>("apiKeyEnv", "DEEPSEEK_API_KEY").trim();
        const commandPath = await findExecutable(command);
        const dshPath = await findExecutable("dsh");
        const npxPath = await findExecutable("npx");
        const pnpmPath = await findExecutable("pnpm");
        const npmPath = await findExecutable("npm");
        const prefix = await globalNpmPrefix();

        const installWhenMissing = configuration.get<boolean>("installWhenMissing", true);
        const npxTimeoutMs = configuration.get<number>("npxTimeoutMs", DEFAULT_NPX_TIMEOUT_MS);
        const npmRegistry = normalizeNpmRegistry(
            configuration.get<string>("npmRegistry", DEFAULT_NPM_REGISTRY),
        );
        const packageManager = isPackageManagerCommand(command) ? command : undefined;
        const hasExplicitRegistry = hasNpmRegistryArgument(args, packageManager);
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
                cwd: workspaceRoot,
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
                await this.apiClient.probe(controller.signal);
                hostDescription = this.hostDescription;
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
            `Configured server token: ${serverToken ? "<set>" : "<none>"}`,
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
            `Runtime recovery attempts: ${this.runtimeRecoveryAttempts}/${RUNTIME_RECOVERY_DELAYS_MS.length}; pending: ${this.runtimeRecoveryTimer !== undefined || this.runtimeRecoveryInFlight ? "yes" : "no"}`,
            `Remote RPC probe: ${rpcHealth}`,
            `Remote protocol: RC Remote v1 (generation ${this.remoteConnection.currentGeneration || "<none>"})`,
            `Configured Runtime version: ${runtimeVersion}`,
            `Host version: ${hostDescription?.version ?? "<unknown>"}`,
            `Host cwd: ${hostDescription?.cwd ?? "<unknown>"}`,
            `API key reference: ${apiKeyRef || "<empty>"}`,
            `API key environment variable present: ${apiKeyRef && process.env[apiKeyRef] ? "yes" : "no"}`,
        ];
        return lines.join("\n");
    }

    public getApiClient(): RemoteUnaryClient {
        return this.apiClient;
    }

    public getSessionStore(): RemoteStateCoordinator["sessions"] {
        return this.harnessState.sessions;
    }

    public getSessionCatalog(): RemoteStateCoordinator["catalog"] {
        return this.harnessState.catalog;
    }

    public syncSession(sessionId: string): Promise<void> {
        return this.harnessState.syncHistory(sessionId);
    }

    public async start(workspaceRoot?: string): Promise<string> {
        return this.startWithRecovery(workspaceRoot, false);
    }

    /**
     * Start the Runtime, optionally preserving the recovery budget for an
     * automatic retry. A user-triggered start cancels a pending retry so it
     * cannot race the explicit action.
     */
    private async startWithRecovery(workspaceRoot: string | undefined, fromRecovery: boolean): Promise<string> {
        if (this.stopPromise) await this.stopPromise;
        if (this.disposed) {
            throw new Error(t("The dsh-ide runtime has already been disposed."));
        }

        if (!fromRecovery) this.cancelRuntimeRecovery();

        if (this.startPromise) {
            if (this.startAbort?.signal.aborted) {
                // A stop cancels asynchronous discovery without waiting for it.
                // An explicit subsequent start must wait for that cancelled work
                // to unwind before acquiring a fresh lock and launch generation.
                await this.startPromise.catch(() => undefined);
                return this.startWithRecovery(workspaceRoot, fromRecovery);
            }
            return this.startPromise;
        }

        const abort = new AbortController();
        this.startAbort = abort;
        this.startPromise = this.startInternal(workspaceRoot, abort.signal);
        try {
            return await this.startPromise;
        } catch (error) {
            if (abort.signal.aborted) throw error;
            if (isDshWriterLockFailure(error)) {
                this.lastRecoveryComposition = undefined;
                this.output.appendLine("[dsh] startup blocked by a DSH writer lock; bundle isolation cannot repair this lock.");
            }
            if (isPackageManagerCacheLayoutFailure(error, error instanceof RuntimeLaunchFailure ? error.outputTail : "")) {
                // Every bundle set resolves through the same broken store, so a
                // search would only repeat the failure once per candidate.
                this.lastRecoveryComposition = undefined;
                this.output.appendLine("[dsh] startup blocked by an unusable package-manager store; bundle isolation cannot repair it.");
            }
            if (!fromRecovery && this.recoveryEnabled() && this.lastRecoveryComposition) {
                try {
                    const outcome = await this.runAutomaticRecovery(
                        workspaceRoot,
                        error instanceof Error ? error.message : String(error),
                        abort.signal,
                    );
                    if (outcome.status === "retry" || outcome.status === "candidate") {
                        try {
                            const url = await this.startInternal(workspaceRoot, abort.signal);
                            await this.recoverySession.confirm(
                                this.lastRecoveryComposition ?? outcome.composition!,
                                outcome.attribution,
                            );
                            this.runtimeRecoveryAttempts = 0;
                            return url;
                        } catch (retryError) {
                            await this.recoverySession.fail(
                                retryError instanceof Error ? retryError.message : String(retryError),
                            );
                            error = retryError;
                        }
                    }
                } catch (recoveryError) {
                    this.output.appendLine(`[dsh:recovery] automatic recovery failed: ${String(recoveryError)}`);
                }
            }
            if (!this.startedByExtension) {
                this.baseUrl = undefined;
                this.launchUrl = undefined;
                this.clearRuntimeAuthentication();
            }
            this.setStatus({
                state: "error",
                message: error instanceof Error ? error.message : String(error),
                recovery: this.recoverySession.getStatus(),
            });
            throw error;
        } finally {
            this.startPromise = undefined;
            if (this.startAbort === abort) this.startAbort = undefined;
        }
    }

    public async restart(workspaceRoot?: string): Promise<string> {
        await this.stop();
        return this.start(workspaceRoot);
    }

    public stop(): Promise<void> {
        if (this.stopPromise) return this.stopPromise;
        this.cancelRuntimeRecovery();
        this.startAbort?.abort(new Error("DSH Runtime startup was cancelled"));
        const stopping = this.stopResources();
        this.stopPromise = stopping;
        void stopping.finally(() => {
            if (this.stopPromise === stopping) this.stopPromise = undefined;
        }).catch(() => undefined);
        return stopping;
    }

    private async stopResources(): Promise<void> {
        ++this.resourceCleanupDepth;
        this.subagentHistoryCursors.clear();
        const child = this.child;
        this.baseUrl = undefined;
        this.launchUrl = undefined;
        this.authCookie = undefined;
        this.authPromise = undefined;
        this.hostDescription = undefined;

        const results = await Promise.allSettled([
            withinShutdownDeadline(this.harnessState.stop(), "Remote state shutdown"),
            child && this.startedByExtension ? this.terminate(child) : Promise.resolve(),
            this.releaseDebugOverlay(),
        ]);
        if (results[1]?.status === "fulfilled") {
            if (this.child === child) this.child = undefined;
            try {
                await withinShutdownDeadline(this.releaseOwnedRuntime(), "Runtime advertisement release", 1_500);
            } catch (error) { results.push({ status: "rejected", reason: error }); }
        }
        --this.resourceCleanupDepth;
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failures.length) {
            const error = new AggregateError(failures.map(result => result.reason), "DSH Runtime shutdown failed");
            this.output.appendLine(`[dsh] ${error.message}: ${failures.map(result => String(result.reason)).join("; ")}`);
            this.setStatus({ state: "error", message: error.message });
            throw error;
        }
        this.startedByExtension = false;
        this.setStatus({ state: "stopped" });
    }

    /** Closes the debug MCP endpoint and removes the patch file this launch wrote. */
    private async releaseDebugOverlay(): Promise<void> {
        const overlay = this.debugOverlay;
        this.debugOverlay = undefined;
        if (!overlay) return;
        try {
            await overlay.dispose();
        } catch (error) {
            this.output.appendLine(`[dsh:debug] overlay cleanup failed: ${String(error)}`);
        }
    }

    public createWorkspace(path: string): Promise<DshWorkspaceCreateResult> {
        return this.apiClient.call("workspace/create", { request: { path } });
    }

    public async renameWorkspace(workspaceId: string, title: string): Promise<DshWorkspaceView> {
        const result = await this.apiClient.call<{ workspace: DshWorkspaceView }>("workspace/rename", {
            request: { workspaceId, title },
        });
        this.harnessState.catalog.upsertWorkspace(result.workspace);
        return result.workspace;
    }

    public async deleteWorkspace(workspaceId: string): Promise<void> {
        await this.apiClient.call("workspace/delete", { request: { workspaceId } });
        this.harnessState.catalog.removeWorkspace(workspaceId);
    }

    public async moveWorkspace(workspaceId: string, beforeWorkspaceId?: string): Promise<void> {
        const result = await this.apiClient.call<{ workspaceIds: string[] }>("workspace/insertBefore", {
            request: {
                workspaceId,
                ...(beforeWorkspaceId === undefined ? {} : { beforeWorkspaceId }),
            },
        });
        this.harnessState.catalog.replaceWorkspaceOrder(result.workspaceIds);
    }

    public async moveWorkspaceSession(
        workspaceId: string,
        sessionId: string,
        beforeSessionId?: string,
    ): Promise<void> {
        const result = await this.apiClient.call<{ workspace: DshWorkspaceView }>("workspace/insertSessionBefore", {
            request: {
                workspaceId,
                sessionId,
                ...(beforeSessionId === undefined ? {} : { beforeSessionId }),
            },
        });
        this.harnessState.catalog.upsertWorkspace(result.workspace);
    }

    public async createSession(
        cwd: string | undefined,
        agentPreset?: string,
        workspaceId?: string,
    ): Promise<DshSessionCreateResult> {
        const result = await this.apiClient.call<DshSessionCreateResult>("session/create", {
            request: {
                // DSH resolves the directory from the selected Workspace.
                ...(workspaceId !== undefined ? { workspaceId } : cwd === undefined ? {} : { cwd }),
                ...(agentPreset === undefined ? {} : { agentPreset }),
            },
        });
        const sessionCwd = workspaceId === undefined ? cwd : this.harnessState.catalog.snapshot()
            .workspaces.find((workspace) => workspace.workspaceId === workspaceId)?.path;
        this.harnessState.catalog.upsertCreated(result.sessionId, sessionCwd, {
            ...(result.agentPreset === undefined ? {} : { agentPreset: result.agentPreset }),
        });
        this.harnessState.watchSession(result.sessionId);
        return result;
    }

    public searchSessions(query: string, signal?: AbortSignal): Promise<DshSessionSearchResult> {
        return this.apiClient.call("session/search", { request: { query } }, signal);
    }

    /** Resolve Runtime-owned files and directories for the active Composer @ menu. */
    public async listFileReferences(
        sessionId: string,
        query: string,
        signal?: AbortSignal,
    ): Promise<DshFileReferenceCandidate[] | undefined> {
        try {
            const value = await this.apiClient.call("fileReferences/list", {
                agentId: sessionId,
                query,
            }, signal);
            const candidates = normalizeFileReferenceCandidates(value);
            if (!candidates) {
                throw new RemoteProtocolError(
                    "Remote fileReferences/list returned an invalid candidate list",
                );
            }
            return candidates;
        } catch (error) {
            // RC1 clients can connect to an older Runtime that has no file
            // reference provider. The Composer will use its local index then.
            if (error instanceof RemoteHttpError && error.status === 404) return undefined;
            throw error;
        }
    }

    /** Resolve canonical cross-session mentions for the active Composer @ menu. */
    public async listSessionReferenceCandidates(
        sessionId: string,
        query: string,
        signal?: AbortSignal,
    ): Promise<DshSessionReferenceCandidate[] | undefined> {
        try {
            const value = await this.apiClient.call("sessionReferenceResolver/candidates", {
                agentId: sessionId,
                query,
            }, signal);
            const candidates = normalizeSessionReferenceCandidates(value);
            if (!candidates) {
                throw new RemoteProtocolError(
                    "Remote sessionReferenceResolver/candidates returned an invalid candidate list",
                );
            }
            return candidates;
        } catch (error) {
            // Keep older Runtime versions useful by retaining the local catalog
            // and session/search fallback when the optional Remote is absent.
            if (error instanceof RemoteHttpError && error.status === 404) return undefined;
            throw error;
        }
    }

    public async renameSession(
        sessionId: string,
        title: string,
    ): Promise<DshSessionRenameResult> {
        const result = await this.apiClient.call<DshSessionRenameResult>("session/rename", {
            request: { sessionId, title },
        });
        this.harnessState.catalog.applyRename(sessionId, result.title, result.seq);
        return result;
    }

    public async forkSession(sessionId: string, atSeq?: number): Promise<DshSessionForkResult> {
        const source = this.harnessState.catalog
            .snapshot()
            .sessions.find((session) => session.sessionId === sessionId);
        const sourceCwd = source?.cwd;
        const sourceProjectionTitle = this.harnessState.sessions
            .get(sessionId)
            ?.projections.find((projection) => projection.key === "title")?.value;
        const sourceTitle = source?.title?.trim() ||
            (typeof sourceProjectionTitle === "string" && sourceProjectionTitle.trim()
                ? sourceProjectionTitle.trim()
                : undefined);
        const result = await this.apiClient.call<DshSessionForkResult>("session/fork", {
            request: {
                sessionId,
                ...(atSeq === undefined ? {} : { atSeq }),
            },
        });
        // The fork response intentionally contains only the child id. Seed the
        // local catalog with the source metadata so switching immediately after
        // the RPC does not lose the workspace lineage or mark a non-empty child
        // as a blank session. The upsert merges with a host/session-added frame
        // if that frame won the race against the RPC response.
        this.harnessState.catalog.upsertCreated(result.sessionId, sourceCwd, {
            blank: false,
            parentSessionId: sessionId,
        });
        if (sourceTitle !== undefined) {
            // Host fork preserves the inherited title. Rename the child after
            // creation to match the client contract (e.g. Helo -> Helo (1)).
            // Disambiguation is cosmetic and the fork itself already succeeded,
            // so a rename failure must not reject the child id away.
            try {
                await this.renameSession(result.sessionId, increasedForkTitle(sourceTitle));
            } catch (error) {
                this.output.appendLine(
                    `[dsh] fork title update failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
        return result;
    }

    public async archiveSession(sessionId: string): Promise<void> {
        const result = await this.apiClient.call<{ archivedSessionIds: string[] }>("workspace/archiveSession", {
            request: { sessionId },
        });
        this.harnessState.catalog.replaceArchived(result.archivedSessionIds);
    }

    /** Report whether the composed Runtime can open a Session workspace path. */
    public async canOpenWorkspacePath(signal?: AbortSignal): Promise<boolean> {
        const value = await this.apiClient.call<unknown>("session/canOpenWorkspacePath", {}, signal);
        if (typeof value !== "boolean") {
            throw new RemoteProtocolError("Remote session/canOpenWorkspacePath returned an invalid value");
        }
        return value;
    }

    /** Open a Session-aware path through the Runtime's native opener. */
    public async openWorkspacePath(path: string, signal?: AbortSignal): Promise<{ opened: true }> {
        const value = await this.apiClient.call<unknown>("session/openWorkspacePath", {
            request: { path },
        }, signal);
        if (!isRemoteRecord(value) || value.opened !== true) {
            throw new RemoteProtocolError("Remote session/openWorkspacePath returned an invalid value");
        }
        return { opened: true };
    }

    /** Pick a directory when the Runtime composes a native picker capability. */
    public pickDirectory(signal?: AbortSignal): Promise<string | null> {
        return this.apiClient.call("directoryPicker/pick", {}, signal);
    }

    /** List one directory level through the Runtime's browse capability. */
    public listDirectory(path?: string, signal?: AbortSignal): Promise<DshDirectoryListing> {
        return this.apiClient.call("directoryPicker/list", path === undefined ? {} : { path }, signal);
    }

    /** Create one child directory through the Runtime's browse capability. */
    public createDirectory(path: string, name: string, signal?: AbortSignal): Promise<string> {
        return this.apiClient.call("directoryPicker/createDirectory", { path, name }, signal);
    }

    public async refreshSessions(): Promise<void> {
        await this.harnessState.refreshCatalog();
    }

    public async history(sessionId: string, maxMessages = 100): Promise<DshHistoryResult> {
        await this.harnessState.syncHistory(sessionId);
        const snapshot = this.harnessState.sessions.get(sessionId);
        const events = snapshot?.events.slice(-Math.max(1, maxMessages)).map((entry) => ({
            event: entry.event,
            ...(entry.view === undefined ? {} : { view: entry.view }),
        })) ?? [];
        const projections = snapshot
            ? snapshot.projections.length > 0
                ? {
                      asOfSeq: Math.max(...snapshot.projections.map((cell) => cell.seq), -1),
                      values: Object.fromEntries(snapshot.projections.map((cell) => [cell.key, cell.value])),
                  }
                : undefined
            : undefined;
        return { events, hasMore: false, ...(projections === undefined ? {} : { projections }) };
    }

    public async prompt(
        sessionId: string,
        text: string,
        mode: "queue" | "steer" = "queue",
        images: readonly DshImageUpload[] = [],
        requestId: string = randomUUID(),
        files: readonly DshFileDraft[] = [],
    ): Promise<DshSessionPromptResult> {
        const receiptIds: string[] = [];
        for (const file of files) {
            receiptIds.push(await this.uploadFile(sessionId, file.name, Buffer.from(file.data, "base64")));
        }
        return this.apiClient.call("session/prompt", {
            request: {
                requestId,
                sessionId,
                mode,
                content: [
                    ...(text ? [{ type: "text" as const, text }] : []),
                    ...images.map((image) => ({
                        type: "image" as const,
                        mediaType: image.mediaType,
                        data: image.data,
                        ...(image.name === undefined ? {} : { name: image.name }),
                    })),
                    ...receiptIds.map((receiptId) => ({
                        type: "file" as const,
                        receiptId,
                    })),
                ],
                ...(Intl.DateTimeFormat().resolvedOptions().timeZone
                    ? { clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
                    : {}),
            },
        });
    }

    /** The binary route returns a session-scoped receipt, never a client-derived path. */
    private async uploadFile(sessionId: string, name: string, data: Uint8Array): Promise<string> {
        const base = this.getUrl();
        if (!base) throw new Error(t("The dsh Runtime is not running, so the file cannot be uploaded."));
        const leaf = posix.basename(name.replaceAll("\\", "/")).slice(0, 255);
        if (!leaf) throw new Error(t("A file to upload needs a name."));
        if (data.byteLength === 0) throw new Error(t("Attached file {name} is empty.", { name }));
        await this.ensureAuthenticated();
        const url = new URL("/api/session/uploadFileBinary", base);
        url.searchParams.set("sessionId", sessionId);
        url.searchParams.set("name", leaf);
        let response: Response;
        try {
            response = await fetch(url, {
                method: "POST",
                headers: { ...this.requestHeaders(), "content-type": "application/octet-stream" },
                body: data as BodyInit,
                signal: AbortSignal.timeout(this.configuration().get<number>("requestTimeoutMs", 600_000)),
            });
        } catch (cause) {
            throw new Error(t("The file upload could not reach the dsh Runtime."), { cause });
        }
        if (!response.ok) {
            throw new Error(t("The dsh Runtime refused the upload (HTTP {status}).", { status: response.status }));
        }
        let envelope: unknown;
        try {
            envelope = await response.json();
        } catch (cause) {
            throw new Error(t("The upload response was not JSON."), { cause });
        }
        if (!isRecord(envelope)) throw new Error(t("The upload response was malformed."));
        // Business failures also use HTTP 200.
        if (envelope.ok === false) {
            const message = isRecord(envelope.error) ? envelope.error.message : undefined;
            throw new Error(typeof message === "string" && message
                ? message
                : t("The dsh Runtime refused the upload."));
        }
        const result = envelope.value;
        if (
            envelope.ok !== true || !isRecord(result) ||
            typeof result.receiptId !== "string" || !result.receiptId ||
            !isRecord(result.file) || typeof result.file.attachmentId !== "string" ||
            typeof result.file.name !== "string" || !result.file.name || /[/\\]/u.test(result.file.name) ||
            typeof result.file.bytes !== "number" || !Number.isSafeInteger(result.file.bytes) || result.file.bytes < 0
        ) throw new Error(t("The dsh Runtime returned an unusable upload receipt."));
        if (result.file.bytes !== data.byteLength) {
            throw new Error(t("The dsh Runtime stored {stored} bytes for a {expected} byte file.", {
                stored: result.file.bytes.toLocaleString(),
                expected: data.byteLength.toLocaleString(),
            }));
        }
        return result.receiptId;
    }

    public attachment(sessionId: string, attachmentId: string): Promise<DshImageAttachmentResult> {
        return this.apiClient.call("session/attachment", { request: { sessionId, attachmentId } });
    }

    public async models(sessionId: string): Promise<DshSessionModelsResult> {
        const catalog = await this.apiClient.call<{
            default: { provider: string; model: string; reasoningEffort?: string };
            routableProviders: string[];
            groups: DshSessionModelsResult["groups"];
            failures: DshSessionModelsResult["failures"];
        }>("session/modelCatalog", {});
        const selection = normalizeModelSelectionProjection(
            this.harnessState.sessions.get(sessionId)?.projections
                .find((cell) => cell.key === "modelSelection")?.value,
        );
        const current = selection ?? catalog.default;
        return {
            current,
            routable: catalog.routableProviders.includes(current.provider),
            groups: catalog.groups,
            failures: catalog.failures,
        };
    }

    public selectModel(selection: {
        sessionId: string;
        provider: string;
        model: string;
        reasoningEffort?: string;
    }): Promise<DshSessionSelectModelResult> {
        return this.apiClient.call("session/selectModel", { request: selection });
    }

    public async agentPresets(): Promise<DshAgentPresetListResult> {
        const result = await this.apiClient.call<Partial<DshAgentPresetListResult>>("agentPresets/list", {});
        return {
            presets: result.presets ?? [],
            authorable: result.authorable === true,
            hasDocument: result.hasDocument ?? result.authorable === true,
            modeSelectionEnabled: result.modeSelectionEnabled !== false,
        };
    }

    public async pluginInventory(): Promise<DshPluginInventorySnapshot> {
        const value = await this.apiClient.call<unknown>("pluginInventory/list", {});
        const inventory = normalizePluginInventory(value);
        if (!inventory) {
            throw new RemoteProtocolError("Remote pluginInventory/list returned an invalid value");
        }
        return inventory;
    }

    /** Reads the optional frame-wide dynamic Cordis plugin registry. */
    public async dynamicPluginInventory(): Promise<DshDynamicPluginRow[] | undefined> {
        try {
            const value = await this.apiClient.call<unknown>("dynamicCordisRunner/inventory", {});
            const rows = normalizeDynamicPluginInventory(value);
            if (!rows) {
                throw new RemoteProtocolError(
                    "Remote dynamicCordisRunner/inventory returned an invalid value",
                );
            }
            return rows;
        } catch (error) {
            // The dynamic runner is an optional composition. Older or minimal
            // Runtimes simply do not mount this namespace.
            if (error instanceof RemoteHttpError && error.status === 404) return undefined;
            throw error;
        }
    }

    public async stopDynamicPlugin(
        sessionId: string,
        pluginId: string,
    ): Promise<DshDynamicPluginStopResult> {
        const value = await this.apiClient.call<unknown>("dynamicCordisRunner/stopFromPanel", {
            agentId: sessionId,
            pluginId,
        });
        const result = normalizeDynamicPluginStopResult(value);
        if (!result) {
            throw new RemoteProtocolError(
                "Remote dynamicCordisRunner/stopFromPanel returned an invalid value",
            );
        }
        return result;
    }

    public async removeDynamicPlugin(
        sessionId: string,
        pluginId: string,
    ): Promise<DshDynamicPluginRemoveResult> {
        const value = await this.apiClient.call<unknown>("dynamicCordisRunner/undefineFromPanel", {
            agentId: sessionId,
            pluginId,
        });
        const result = normalizeDynamicPluginRemoveResult(value);
        if (!result) {
            throw new RemoteProtocolError(
                "Remote dynamicCordisRunner/undefineFromPanel returned an invalid value",
            );
        }
        return result;
    }

    /** Declines a pending browser Client activation without executing plugin code. */
    public async declineDynamicPlugin(
        requestId: string,
        pluginRunId?: string,
    ): Promise<DshDynamicPluginResolveResult> {
        const value = await this.apiClient.call<unknown>("dynamicCordisRunner/resolveRequestRun", {
            requestId,
            resolution: {
                ok: false,
                reason: "rejected",
                ...(pluginRunId === undefined ? {} : { pluginRunId }),
            },
        });
        const result = normalizeDynamicPluginResolveResult(value);
        if (!result) {
            throw new RemoteProtocolError(
                "Remote dynamicCordisRunner/resolveRequestRun returned an invalid value",
            );
        }
        return result;
    }

    public async selectAgentPreset(sessionId: string, agentPreset: string): Promise<DshAgentPresetSelectResult> {
        const selected = await this.apiClient.call<string>("agentPresets/select", {
            agentId: sessionId,
            agentPreset,
        });
        return { agentPreset: selected };
    }

    public readAgentPreset(agentPreset: string): Promise<DshAgentPresetReadResult> {
        return this.apiClient.call("agentPresets/read", { agentPreset });
    }

    public async copyAgentPreset(from: string, agentPreset: string, name?: string): Promise<string> {
        await this.apiClient.call("agentPresets/copy", {
            from,
            id: agentPreset,
            ...(name === undefined ? {} : { name }),
        });
        return agentPreset;
    }

    public openAgentPresetDocument(agentPreset: string): Promise<DshAgentPresetOpenResult> {
        return this.apiClient.call("settings/openAgentPresetDirectory", { agentPreset });
    }

    /** Report whether this Runtime can open the Harness-owned Agent Preset directory. */
    public async canOpenAgentPresetDirectory(signal?: AbortSignal): Promise<boolean | undefined> {
        try {
            const value = await this.apiClient.call<unknown>(
                "settings/canOpenAgentPresetDirectory",
                {},
                signal,
            );
            if (typeof value !== "boolean") {
                throw new RemoteProtocolError(
                    "Remote settings/canOpenAgentPresetDirectory returned an invalid value",
                );
            }
            return value;
        } catch (error) {
            // The probe is optional on older/minimally composed Runtimes.
            if (error instanceof RemoteHttpError && error.status === 404) return undefined;
            throw error;
        }
    }

    public async removeAgentPreset(agentPreset: string): Promise<void> {
        await this.apiClient.call("agentPresets/deletePreset", { id: agentPreset });
    }

    public async setDefaultAgentPreset(agentPreset: string): Promise<void> {
        await this.apiClient.call("settings/update", {
            ns: "agent-presets",
            patch: { default: agentPreset },
        });
    }

    public async cancel(sessionId: string): Promise<void> {
        await this.apiClient.call("session/cancel", { request: { sessionId } });
    }

    public async updateQueue(
        sessionId: string,
        itemId: string,
        action: HarnessQueueAction,
    ): Promise<void> {
        await this.apiClient.call("session/updateQueue", { request: { sessionId, itemId, action } });
    }

    public async getGoalActivation(sessionId: string): Promise<DshGoalActivationState | undefined> {
        const value = await this.apiClient.call("goals/get", { agentId: sessionId });
        // The harness omits absent results; also accept an explicit JSON null.
        if (value === undefined || value === null) return undefined;
        const ref = remoteGoalRef(value);
        if (!ref || !isRemoteRecord(value) || (value.activation !== "armed" && value.activation !== "disarmed")) {
            throw new RemoteProtocolError("Remote goals/get returned an invalid goal activation");
        }
        return { ...ref, activation: value.activation };
    }

    public createGoal(
        sessionId: string,
        objective: string,
        maxGoalRounds?: number,
    ): Promise<DshGoalRefResult> {
        return this.apiClient.call("goals/create", {
            agentId: sessionId,
            request: {
                objective,
                ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }),
            },
        }).then((value) => normalizeGoalRefResult(value, "goals/create"));
    }

    public editGoal(
        sessionId: string,
        ref: DshGoalRef,
        changes: HarnessGoalEditChanges,
    ): Promise<DshGoalRefResult> {
        return this.apiClient
            .call("goals/edit", { agentId: sessionId, ref, request: changes })
            .then((value) => normalizeGoalRefResult(value, "goals/edit"));
    }

    public pauseGoal(sessionId: string, ref: DshGoalRef): Promise<DshGoalRefResult> {
        return this.apiClient
            .call("goals/pause", { agentId: sessionId, ref })
            .then((value) => normalizeGoalRefResult(value, "goals/pause"));
    }

    public resumeGoal(sessionId: string, ref: DshGoalRef): Promise<DshGoalRefResult> {
        return this.apiClient
            .call("goals/resume", { agentId: sessionId, ref })
            .then((value) => normalizeGoalRefResult(value, "goals/resume"));
    }

    public completeGoal(sessionId: string, ref: DshGoalRef): Promise<DshGoalRefResult> {
        return this.apiClient
            .call("goals/complete", { agentId: sessionId, ref })
            .then((value) => normalizeGoalRefResult(value, "goals/complete"));
    }

    public async clearGoal(sessionId: string, ref: DshGoalRef): Promise<{ cleared: true }> {
        const value = await this.apiClient.call("goals/clear", { agentId: sessionId, ref });
        // RC returns the tombstone GoalRef; the editor facade keeps its
        // historical `{ cleared: true }` acknowledgement shape.
        normalizeGoalRefResult(value, "goals/clear");
        return { cleared: true };
    }

    /** Internal opt-in Team API; no UI registration or background probing. */
    public getAgentTeam(sessionId: string, signal?: AbortSignal): Promise<DshTeamView> {
        return this.apiClient.call("agentTeams/view", { agentId: sessionId }, signal);
    }

    public createAgentTeamTask(
        sessionId: string,
        request: DshCreateTeamTaskRequest,
        signal?: AbortSignal,
    ): Promise<DshTeamTaskMutationResult> {
        return this.apiClient.call("agentTeams/createTask", { agentId: sessionId, request }, signal);
    }

    /** Preserve expectedRevision and typed conflicts; never retry a stale mutation. */
    public updateAgentTeamTask(
        sessionId: string,
        request: DshUpdateTeamTaskRequest,
        signal?: AbortSignal,
    ): Promise<DshTeamTaskMutationResult> {
        return this.apiClient.call("agentTeams/updateTask", { agentId: sessionId, request }, signal);
    }

    public listSubagents(
        parentSessionId: string,
        signal?: AbortSignal,
    ): Promise<DshSubagentCatalog> {
        return this.apiClient.call("subagents/list", { parentSessionId }, signal);
    }

    public async subagentHistory(
        address: DshSubagentAddress,
        beforeSeq?: number,
        maxMessages?: number,
        signal?: AbortSignal,
    ): Promise<DshSubagentHistoryResult> {
        const wireAddress = {
            kind: "subagent" as const,
            parentSessionId: address.parentSessionId,
            childSessionId: address.childSessionId,
            mode: address.mode,
        };
        const cacheKey = `${address.parentSessionId}:${address.childSessionId}:${address.mode}`;
        let throughSeq = this.subagentHistoryCursors.get(cacheKey);

        // The first page is opened through the addressed follow stream. This
        // supplies both the message-aligned tail and the cursor that must stay
        // fixed for subsequent backwards pagination.
        if (beforeSeq === undefined || throughSeq === undefined) {
            const oneShot = new AbortController();
            const followSignal = signal === undefined
                ? oneShot.signal
                : AbortSignal.any([signal, oneShot.signal]);
            let snapshot: { records: unknown[]; hasMore: boolean; projections?: unknown; cursor: number } | undefined;
            try {
                for await (const value of this.remoteConnection.open("session/follow", {
                    request: {
                        address: wireAddress,
                        ...(maxMessages === undefined ? {} : { maxMessages }),
                    },
                }, followSignal)) {
                    if (!isRemoteRecord(value) || value.type !== "snapshot") {
                        throw new RemoteProtocolError("Remote subagent follow did not begin with a snapshot");
                    }
                    if (!isSafeRemoteSeq(value.cursor)) throw new RemoteProtocolError("Remote subagent follow returned an invalid cursor");
                    if (!Array.isArray(value.records) || typeof value.hasMore !== "boolean") {
                        throw new RemoteProtocolError("Remote subagent follow snapshot is malformed");
                    }
                    snapshot = {
                        records: value.records,
                        hasMore: value.hasMore,
                        ...(value.projections === undefined ? {} : { projections: value.projections }),
                        cursor: value.cursor,
                    };
                    break;
                }
            } finally {
                oneShot.abort();
            }
            if (!snapshot) throw new Error(`Remote subagent ${address.childSessionId} did not provide a follow snapshot`);
            throughSeq = snapshot.cursor;
            this.subagentHistoryCursors.set(cacheKey, throughSeq);
            this.harnessState.watchSubagent(wireAddress);
            if (beforeSeq === undefined) {
                return {
                    events: remoteHistoryEntries(snapshot.records),
                    hasMore: snapshot.hasMore,
                    ...(snapshot.projections === undefined ? {} : { projections: remoteProjectionBlock(snapshot.projections) }),
                };
            }
        }

        const page = await this.apiClient.call<unknown>("session/page", {
            request: {
                address: wireAddress,
                throughSeq,
                beforeSeq,
                ...(maxMessages === undefined ? {} : { maxMessages }),
            },
        }, signal);
        if (!isRemoteRecord(page) || !Array.isArray(page.records) || typeof page.hasMore !== "boolean") {
            throw new RemoteProtocolError("Remote subagent page is malformed");
        }
        const records = page.records;
        const events = remoteHistoryEntries(records);
        if (beforeSeq !== undefined) {
            for (const entry of events) {
                if (typeof entry.event.seq !== "number" || entry.event.seq >= beforeSeq) {
                    throw new RemoteProtocolError("Remote subagent page contains an out-of-range sequence");
                }
            }
            if (page.hasMore && events.length === 0) {
                throw new RemoteProtocolError("Remote subagent page advertised more history without records");
            }
        }
        return {
            events,
            hasMore: page.hasMore,
        };
    }

    public promptSubagent(
        address: Extract<DshSubagentAddress, { mode: "continuable" }>,
        text: string,
        signal?: AbortSignal,
    ): Promise<DshSubagentPromptResult> {
        const clientTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return this.apiClient.call("subagents/prompt", {
            request: {
                parentSessionId: address.parentSessionId,
                childSessionId: address.childSessionId,
                mode: address.mode,
                delivery: "queue",
                requestId: randomUUID(),
                content: [{ type: "text", text }],
                ...(clientTimeZone ? { clientTimeZone } : {}),
            },
        }, signal);
    }

    public interruptSubagent(
        address: Extract<DshSubagentAddress, { mode: "continuable" }>,
        signal?: AbortSignal,
    ): Promise<{ accepted: true }> {
        return this.apiClient.call("subagents/interruptByParent", address, signal);
    }

    /** Reads the Host projection of persisted per-message feedback for one Session. */
    public async listMessageFeedback(
        sessionId: string,
        signal?: AbortSignal,
    ): Promise<DshMessageFeedbackListResult | undefined> {
        try {
            return await this.apiClient.call("messageFeedback/list", {
                request: { sessionId } satisfies DshMessageFeedbackListRequest,
            }, signal);
        } catch (error) {
            // Feedback is optional on minimally composed Runtimes.
            if (error instanceof RemoteHttpError && error.status === 404) return undefined;
            throw error;
        }
    }

    /** Creates or replaces one feedback item using its observed CAS version. */
    public async putMessageFeedback(
        request: DshMessageFeedbackPutRequest,
        signal?: AbortSignal,
    ): Promise<DshMessageFeedbackPutResult | undefined> {
        try {
            return await this.apiClient.call("messageFeedback/put", { request }, signal);
        } catch (error) {
            if (error instanceof RemoteHttpError && error.status === 404) return undefined;
            throw error;
        }
    }

    /** Removes one feedback item after observing its current CAS version. */
    public async deleteMessageFeedback(
        request: DshMessageFeedbackDeleteRequest,
        signal?: AbortSignal,
    ): Promise<DshMessageFeedbackDeleteResult | undefined> {
        try {
            return await this.apiClient.call("messageFeedback/delete", { request }, signal);
        } catch (error) {
            if (error instanceof RemoteHttpError && error.status === 404) return undefined;
            throw error;
        }
    }

    /** Records optional Session-level feedback as a log-only event. */
    public async recordSessionFeedback(
        request: DshSessionFeedbackRecordRequest,
        signal?: AbortSignal,
    ): Promise<DshSessionFeedbackRecordResult | undefined> {
        try {
            const value = await this.apiClient.call<unknown>("sessionFeedback/record", { request }, signal);
            const result = normalizeSessionFeedbackRecordResult(value);
            if (!result) {
                throw new RemoteProtocolError(
                    "Remote sessionFeedback/record returned an invalid value",
                );
            }
            return result;
        } catch (error) {
            // Session-level feedback is an optional Remote on older Runtimes.
            if (error instanceof RemoteHttpError && error.status === 404) return undefined;
            throw error;
        }
    }

    public async respondRemoteEvent(
        eventId: string,
        outcome: import("./remote/contracts").RemoteEventOutcome,
    ): Promise<void> {
        await this.remoteConnection.answerRemoteEvent(eventId, outcome);
    }

    /** Stores a credential in the runtime-owned credential provider. */
    public async setCredential(ref: string, value: string): Promise<void> {
        await this.apiClient.call("credentials/set", { ref, value });
    }

    public listProviders(): Promise<DshProviderListResult> {
        return Promise.all([
            this.apiClient.call<readonly { id: string }[]>("llm/listProviders", {}),
            this.apiClient.call<readonly {
                provider: string;
                displayName: string;
                settingsNs: string;
                settingsPath: string[];
                declared?: boolean;
            }[]>(
                "llm/listConfigurableProviders",
                {},
            ),
        ]).then(([activeProviders, configurableProviders]) => {
            const active = new Set(activeProviders.map((provider) => provider.id));
            return {
                providers: configurableProviders.map((provider) => ({
                    ...provider,
                    active: active.has(provider.provider),
                })),
            };
        });
    }

    /** Returns the host-scoped catalog used by provider configuration surfaces. */
    public listLlmModels(): Promise<DshLlmModelsResult> {
        return this.apiClient.call("session/modelCatalog", {}).then((result) => ({
            groups: (result as { groups?: DshLlmModelsResult["groups"] }).groups ?? [],
            failures: (result as { failures?: DshLlmModelsResult["failures"] }).failures ?? [],
        }));
    }

    /** Interrogates a provider endpoint using an unsaved configuration draft. */
    public discoverLlmModels(
        payload: {
            settingsNs: string;
            provider?: string;
            baseURL?: string;
            api?: string;
            apiKey?: string;
        },
        signal?: AbortSignal,
    ): Promise<DshLlmDiscoverModelsResult> {
        const { settingsNs, ...request } = payload;
        return this.apiClient.call<DshLlmDiscoverModelsResult["models"]>("llm/discoverModels", {
            settingsNs,
            request,
        }, signal).then((models) => ({ models }));
    }

    public describeSettings(): Promise<DshSettingsDescribeResult> {
        return this.apiClient.call("settings/describe", {});
    }

    public describeCredentials(refs: string[]): Promise<DshCredentialDescribeResult> {
        return this.apiClient.call("credentials/describe", { refs });
    }

    public async unsetCredential(ref: string): Promise<void> {
        await this.apiClient.call("credentials/unset", { ref });
    }

    public async openSettingsDocument(): Promise<void> {
        await this.apiClient.call("settings/openSettingsDocument", {});
    }

    public mutateSettings(
        ns: string,
        ops: DshSettingsPathOperation[],
        expectedRevision?: number,
    ): Promise<DshSettingsNamespaceView> {
        return this.apiClient.call("settings/mutate", {
            ns,
            ops,
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
        });
    }

    public async describeHost(): Promise<HarnessHostDescription> {
        return this.hostDescription ?? {
            version: RUNTIME_DEFAULT_VERSION,
            cwd: "",
            attachedSessions: this.harnessState.catalog.snapshot().sessions.length,
            canOpenPath: true,
        };
    }

    public async listSkills(sessionId: string): Promise<DshSkillEntry[]> {
        const result = await this.apiClient.call<{ skills: DshSkillEntry[] }>("skills/list", { request: { sessionId } });
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
            const commands = await this.apiClient.call<readonly DshCommandDescriptor[]>("commands/list", { agentId: sessionId });
            return [...commands];
        } catch (error) {
            if (error instanceof RemoteHttpError && error.status === 404) return undefined;
            throw error;
        }
    }

    /**
     * Runs one complete slash-command line against a session's agent. This is
     * pure admission: the resolved handler's outcome is also logged durably as
     * a `command/run` / `command/done` pair on the session. `undefined` means
     * the line resolved to no registered command.
     *
     * Images are tagged as submitted attachments; the host executor enforces each
     * command's own `input.attachments` declaration and settles a non-declaring
     * invocation as an error before its handler runs.
     */
    public async executeCommand(
        sessionId: string,
        line: string,
        images: readonly DshImageUpload[] = [],
    ): Promise<DshCommandExecution | undefined> {
        return this.apiClient.call("commands/execute", {
            agentId: sessionId,
            line,
            submittedAttachments: images.map((image) => ({ type: "image", ...image })),
        });
    }

    public dispose(): Promise<void> {
        if (this.disposePromise) return this.disposePromise;
        this.disposed = true;
        this.disposePromise = this.stop();
        return this.disposePromise;
    }

    private async startInternal(workspaceRoot?: string, signal: AbortSignal = new AbortController().signal): Promise<string> {
        const checkStarting = (): void => signal.throwIfAborted();
        checkStarting();
        const configuration = this.configuration();
        const configuredUrl = configuration.get<string>("serverUrl", "").trim();
        const configuredToken = configuration.get<string>("serverToken", "").trim();
        const startupTimeout = configuration.get<number>("startupTimeoutMs", 30_000);

        if (!vscode.workspace.isTrusted) {
            const message = t("Trust the current workspace before dsh can run agent operations.");
            this.setStatus({ state: "error", message });
            throw new Error(message);
        }

        if (configuredUrl && isInsecureRemoteRuntimeUrl(configuredUrl)) {
            const message = t("Remote dsh Runtime URLs must use HTTPS.");
            this.setStatus({ state: "error", message });
            throw new Error(message);
        }

        this.setStatus({ state: "starting", message: t("Connecting to dsh web...") });

        if (configuredUrl) {
            if (this.child && this.startedByExtension) {
                await this.stopResources();
                checkStarting();
                this.setStatus({ state: "starting", message: t("Connecting to dsh web...") });
            }
            const parsedEndpoint = parseRuntimeEndpoint(configuredUrl);
            if (!parsedEndpoint) {
                const message = t("Invalid dsh Runtime URL.");
                this.setStatus({ state: "error", message });
                throw new Error(message);
            }
            const endpoint = applyRuntimeToken(parsedEndpoint, configuredToken);
            if (!endpoint) {
                const message = t("Invalid dsh Runtime token.");
                this.setStatus({ state: "error", message });
                throw new Error(message);
            }
            const url = endpoint.baseUrl;
            // A manually configured address is authoritative. In particular,
            // clearing dsh.serverToken must not keep a launch token discovered
            // during an earlier connection to the same origin.
            this.setRuntimeEndpoint(endpoint, false);
            await this.waitForReady(url, startupTimeout);
            checkStarting();
            this.baseUrl = url;
            this.startedByExtension = false;
            this.setStatus({ state: "running", url });
            this.harnessState.start();
            return url;
        }

        const runtimeVersion = configuredRuntimeVersion(configuration);
        if (this.baseUrl && this.startedByExtension &&
            isSupportedRuntimeVersion(this.ownedRuntime?.record.runtimeVersion) &&
            (await this.isHarnessHealthy(this.baseUrl))) {
            checkStarting();
            this.setStatus({ state: "running", url: this.baseUrl });
            this.harnessState.start();
            return this.baseUrl;
        }

        // Reuse a Runtime started by the CLI, another VS Code window, or a
        // previous extension instance before creating another writer process.
        // Harness's web profile defaults to port 3080; an explicit setting wins.
        const configuredPort = this.configuration().get<number>("serverPort", 0);
        const autonomousDebugging = configuration.get<boolean>("autonomousDebugging", false);
        const existingEndpoint = await this.findExistingRuntime(configuredPort, signal);
        checkStarting();
        if (existingEndpoint) {
            await this.releaseDebugOverlay();
            if (autonomousDebugging) {
                this.output.appendLine(
                    "[dsh:debug] autonomous debugging only mounts on a Runtime this window started; the adopted Runtime has no debug tools.",
                );
            }
            this.setRuntimeEndpoint(existingEndpoint);
            this.startedByExtension = false;
            this.setStatus({ state: "running", url: existingEndpoint.baseUrl });
            this.harnessState.start();
            return existingEndpoint.baseUrl;
        }

        if (!workspaceRoot) {
            const message = t("Open a workspace before starting dsh with it as the working directory.");
            this.setStatus({ state: "error", message });
            throw new Error(message);
        }

        if (this.child && this.startedByExtension) {
            await this.stopResources();
            checkStarting();
            this.setStatus({ state: "starting", message: t("Starting dsh web...") });
        }

        this.lastRecoveryComposition = undefined;
        let command = configuration.get<string>("command", "auto").trim() || "auto";
        const configuredArgs = configuredLaunchArgs(configuration, command);
        let args = [...configuredArgs];
        const enableCompaction = this.configuration().get<boolean>("enableCompaction", true);

        // Discovery may trigger a managed Runtime download. This deliberately
        // happens before the runtime start lock so one window can download or
        // reuse the cache while another window keeps using an installed runtime.
        let upgradeOffered = false;
        const onOutdatedLocal = async (path: string, actual: string | undefined): Promise<string | undefined> => {
            if (upgradeOffered) return undefined;
            upgradeOffered = true;
            try {
                return await offerLocalRuntimeUpgrade({
                    command: path, actual, target: runtimeVersion,
                    npm: await findExecutable("npm"), node: await findExecutable("node"), prefix: await globalNpmPrefix(),
                    registry: normalizeNpmRegistry(configuration.get<string>("npmRegistry")),
                    timeout: configuration.get<number>("npxTimeoutMs", DEFAULT_NPX_TIMEOUT_MS),
                    signal, probe: () => probeRuntimeVersion(path, { cwd: workspaceRoot, signal }),
                    log: message => this.output.appendLine(message),
                });
            } catch (error) {
                if (error instanceof LocalRuntimeUpgradeCancelledError) throw new CanceledError();
                throw error;
            }
        };
        let launcher: DshLauncher;
        try {
            launcher = await discoverDsh(command, {
                storagePath: this.storagePath,
                installWhenMissing: this.configuration().get<boolean>("installWhenMissing", true),
                runtimeVersion,
                configuredArgs,
                allowManaged: true,
                onOutdatedLocal,
                cwd: workspaceRoot,
                signal,
                proxy: this.httpProxy(),
                onLog: (message) => { if (!signal.aborted) this.output.appendLine(message); },
            });
        } catch (error) {
            checkStarting();
            const message = error instanceof Error ? error.message : String(error);
            this.setStatus({ state: "error", message });
            throw error;
        }
        checkStarting();
        command = launcher.command;
        // The managed launcher is an absolute path to the standalone runtime
        // binary; package-manager commandArgs do not apply to it.
        const launchArgs = launcher.usesConfiguredArgs === false
            ? [...launcher.args]
            : [...launcher.args, ...(launcher.source.kind === "managed" ? ["web", "--no-open"] : [...configuredArgs])];
        // Every launcher path lands here — the manifest default, a user's own
        // commandArgs, the pnpm/npx conversion, and the discovery fallback — so
        // this is the one place the pin cannot be routed around.
        args = isPackageManagerSource(launcher.source) ? pinDshPackageArgs(launchArgs, runtimeVersion) : launchArgs;
        this.output.appendLine(`[dsh] discovered executable: ${command} (${describeSource(launcher.source)})`);
        if (isPackageManagerSource(launcher.source)) {
            const packageSpec = dshPackageInvocation(args)?.spec;
            this.output.appendLine(`[dsh] DSH package spec: ${packageSpec ?? "<not detected>"}; target: ${runtimeVersion}`);
        }

        // Never label an arbitrary installed binary with the extension's target version.
        let launchVersion: string | undefined;
        if (isPackageManagerSource(launcher.source)) {
            const invocation = dshPackageInvocation(args);
            const spec = invocation?.spec;
            const version = spec?.slice(DSH_PACKAGE.length + 1);
            if (exactRuntimeVersion(version)) {
                launchVersion = version;
            } else if (invocation) {
                // Dist-tags (including next/latest) are selectors, not Runtime versions.
                // Probe the selected package without starting the Web app, then freeze
                // that selection so a moving tag cannot change the version in the lock.
                const timeout = configuration.get<number>("npxTimeoutMs", DEFAULT_NPX_TIMEOUT_MS);
                launchVersion = await probeRuntimeVersion(command, {
                    cwd: workspaceRoot, signal, args: invocation.probeArgs,
                    timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_NPX_TIMEOUT_MS,
                });
                if (launchVersion) {
                    args[invocation.index] = `${invocation.prefix}${DSH_PACKAGE}@${launchVersion}`;
                    this.output.appendLine(`[dsh] resolved ${spec} to ${launchVersion}`);
                }
            }
        } else if (launcher.source.kind === "managed") {
            launchVersion = launcher.source.version;
        } else {
            launchVersion = await probeRuntimeVersion(command, { cwd: workspaceRoot, signal });
            if (!isSupportedRuntimeVersion(launchVersion)) {
                const path = await findExecutable(command);
                if (path) launchVersion = await onOutdatedLocal(path, launchVersion) ?? launchVersion;
            }
        }
        checkStarting();
        this.requireRuntimeVersion(launchVersion);
        this.harnessState.setRuntimeVersion(launchVersion!);

        const configuredNpxTimeout = configuration.get<number>("npxTimeoutMs", DEFAULT_NPX_TIMEOUT_MS);
        const npxTimeoutMs = Number.isFinite(configuredNpxTimeout) && configuredNpxTimeout > 0
            ? configuredNpxTimeout : DEFAULT_NPX_TIMEOUT_MS;
        // Ownership is local process bookkeeping, independent of discovery files.
        this.ownedRuntime = { record: {
            pid: process.pid, createdAt: Date.now(), ownerId: randomUUID(), runtimeVersion: launchVersion!,
        } };
        checkStarting();
        let automaticLaunchPort: number | undefined;
        this.jevIntegrationPatchPath = undefined;
        if (isWebProfileArgs(args)) {
            try {
                this.jevIntegrationPatchPath = await prepareJevIntegrationPatch({
                    extensionPath: this.extensionPath,
                    outputDirectory: this.recoveryLedger.directory,
                    config: configuredJevIntegration(configuration),
                    onDiagnostic: (message) => this.output.appendLine(message),
                });
            } catch (error) {
                // Jev is an optional internal integration. A malformed or
                // unavailable vendor checkout must not make the base Runtime
                // unusable; the diagnostic gives the host a clear remedy.
                this.output.appendLine(`[dsh:jev] unable to prepare built-in integration: ${String(error)}`);
            }
            if (this.jevIntegrationPatchPath !== undefined) {
                insertWebLauncherPatch(args, this.jevIntegrationPatchPath);
            }
        }
        if (enableCompaction && isWebProfileArgs(args)) {
            this.compactionPatchPath = join(this.recoveryLedger.directory, "compaction.patch.yml");
            try {
                await mkdir(this.recoveryLedger.directory, { recursive: true });
                await writeFile(
                    this.compactionPatchPath,
                    "- id: compaction-basic\n  disabled: false\n\n- id: command-compact\n  disabled: false\n",
                    { encoding: "utf8", mode: 0o600 },
                );
            } catch (error) {
                await this.releaseOwnedRuntime();
                throw error;
            }
            insertWebLauncherPatch(args, this.compactionPatchPath);
            this.output.appendLine(`[dsh] compaction command enabled with patch: ${this.compactionPatchPath}`);
        }
        if (autonomousDebugging && isWebProfileArgs(args)) {
            const ownerId = this.ownedRuntime?.record.ownerId;
            if (!ownerId || !this.debugContextTracker) {
                this.output.appendLine("[dsh:debug] autonomous debugging needs this launch's owner id and debug tracker; skipped.");
            } else {
                try {
                    await this.releaseDebugOverlay();
                    this.debugOverlay = await DebugLaunchOverlay.create({
                        directory: this.recoveryLedger.directory,
                        ownerId,
                        tracker: this.debugContextTracker,
                        maxContextBytes: configuration.get<number>("maxContextBytes", 120_000),
                        log: (message) => this.output.appendLine(`[dsh:debug] ${message}`),
                    });
                } catch (error) {
                    await this.releaseDebugOverlay();
                    await this.releaseOwnedRuntime();
                    throw error;
                }
                insertWebLauncherPatch(args, this.debugOverlay.patchPath);
            }
        }
        args = ensureNoOpen(args);

        const packageInvocation = isPackageManagerSource(launcher.source) ? dshPackageInvocation(args) : undefined;
        const appArgs = packageInvocation ? args.slice(packageInvocation.probeArgs.length) : args;
        if (!appArgs.some(argument => argument === "--port" || argument === "-p" || argument.startsWith("--port="))) {
            automaticLaunchPort = configuredPort > 0 ? configuredPort : 0;
            args.push("--port", String(automaticLaunchPort));
        }
        if (!appArgs.some(argument => argument === "--host" || argument.startsWith("--host="))) {
            args.push("--host", "127.0.0.1");
        }
        try {
            args = await this.recoveryFixes.filterLaunchArgs(args);
        } catch (error) {
            if (!(error instanceof RecoveryLedgerCorruptError)) throw error;
            // Preserve a damaged ledger and let the original launch remain available.
            this.output.appendLine(`[dsh:recovery] ignoring damaged recovery ledger: ${error.message}`);
        }
        try {
            const patchPaths = patchPathsFromArgs(args);
            const extensionOverlays = [
                this.jevIntegrationPatchPath,
                this.compactionPatchPath,
                this.debugOverlay?.patchPath,
            ]
                .filter((overlay): overlay is string =>
                    overlay !== undefined && patchPaths.some((path) => samePath(path, overlay)));
            this.lastRecoveryComposition = await buildComposition({
                command,
                resolvedPath: await findExecutable(command),
                source: describeSource(launcher.source),
                version: launchVersion,
                launcherArgs: launcher.args,
                appArgs: args,
                workspaceRoot,
                dshHome: process.env.DSH_HOME || join(homedir(), ".dsh"),
                profile: profileNameFromArgs(args),
                extensionOverlayPaths: extensionOverlays,
            });
            if (this.ownedRuntime) {
                this.ownedRuntime.record.compositionHash = this.lastRecoveryComposition.compositionHash;
                const recoverySessionId = this.recoverySession.getSessionId();
                if (recoverySessionId) this.ownedRuntime.record.recoverySessionId = recoverySessionId;
                await this.publishAdvertisement();
            }
        } catch (error) {
            this.lastRecoveryComposition = undefined;
            this.output.appendLine(`[dsh:recovery] unable to capture launch composition: ${String(error)}`);
        }

        const packageManagerFetchTimeoutMs = Math.min(npxTimeoutMs, DEFAULT_PACKAGE_MANAGER_FETCH_TIMEOUT_MS);
        const configuredNpmRegistry = normalizeNpmRegistry(
            configuration.get<string>("npmRegistry", DEFAULT_NPM_REGISTRY),
        );
        const packageManager = isPackageManagerSource(launcher.source) ? launcher.source.kind : undefined;
        const hasExplicitRegistry = hasNpmRegistryArgument(args, packageManager);
        const activeRegistry = isPackageManagerSource(launcher.source) && !hasExplicitRegistry
            ? await activeNpmRegistry(workspaceRoot, launcher.source.kind)
            : undefined;
        checkStarting();
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

        const packageManagerNotice = isPackageManagerSource(launcher.source)
            ? {
                title: t("DSH Runtime"),
                message: t("Downloading DSH Runtime via {command}…", {
                    command: describeSource(launcher.source),
                }),
            }
            : undefined;
        if (packageManagerNotice) {
            this.setStatus({ state: "starting", message: packageManagerNotice.message });
        }

        type LaunchOverride = { command: string; source: DshRuntimeSource };
        const launchAttempt = async (
            attemptArgs: string[],
            registryOverride?: string,
            launchOverride?: LaunchOverride,
        ): Promise<string> => {
            checkStarting();
            // Coordinate briefly and recheck, but never wait for a peer's
            // download/startup or require a mutex to launch a private Runtime.
            const releaseStartup = await acquireRuntimeStartupMutex(signal).catch(() => undefined);
            try {
                const shared = await this.findExistingRuntime(configuredPort, signal);
                checkStarting();
                if (shared) {
                    releaseStartup?.();
                    await this.releaseOwnedRuntime();
                    if (this.debugOverlay) {
                        await this.releaseDebugOverlay();
                        this.output.appendLine(
                            "[dsh:debug] a peer Runtime answered last moment; its launch carries no debug tools, so this window's endpoint was closed.",
                        );
                    }
                    this.setRuntimeEndpoint(shared);
                    this.startedByExtension = false;
                    return shared.baseUrl;
                }
            } catch (error) { releaseStartup?.(); throw error; }
            this.output.appendLine("[dsh] Shared runtime unavailable; using an isolated runtime for this editor.");
            const launchCommand = launchOverride?.command ?? command;
            const launchSource = launchOverride?.source ?? launcher.source;
            const candidatePort = portFromArgs(attemptArgs);
            this.baseUrl = candidatePort
                ? `http://127.0.0.1:${candidatePort}`
                : undefined;
            this.launchUrl = undefined;
            this.authCookie = undefined;
            this.authPromise = undefined;

            this.output.appendLine(`[dsh] starting: ${launchCommand} ${attemptArgs.join(" ")}`);
            const launchEnv: NodeJS.ProcessEnv = { ...process.env };
            if (configuredJevIntegration(configuration).enabled) {
                try {
                    const jevApiKey = (await this.jevApiKeyProvider?.())?.trim();
                    if (jevApiKey) launchEnv.TYPESAFE_API_KEY = jevApiKey;
                } catch (error) {
                    // Credential lookup must not prevent the base Runtime from
                    // starting; Jev will report the missing credential on demand.
                    this.output.appendLine(`[dsh:jev] unable to load extension-managed API key: ${String(error)}`);
                }
            }
            if (this.debugOverlay) {
                // The patch file interpolates this token at boot; it never sits on disk.
                Object.assign(launchEnv, this.debugOverlay.environment);
            }
            if (isPackageManagerSource(launchSource)) {
                if (registryOverride !== undefined) {
                    // npm and pnpm both honor the npm_config_registry key. Set
                    // both common casings because Windows environments can
                    // preserve either spelling from the parent process.
                    launchEnv.npm_config_registry = registryOverride;
                    launchEnv.NPM_CONFIG_REGISTRY = registryOverride;
                }
                if ((launchSource.kind !== "npx" || !hasNpmOptionArgument(attemptArgs, "--fetch-timeout"))
                    && !launchEnv.npm_config_fetch_timeout
                    && !launchEnv.NPM_CONFIG_FETCH_TIMEOUT) {
                    launchEnv.npm_config_fetch_timeout = String(packageManagerFetchTimeoutMs);
                }
                if ((launchSource.kind !== "npx" || !hasNpmOptionArgument(attemptArgs, "--fetch-retries"))
                    && !launchEnv.npm_config_fetch_retries
                    && !launchEnv.NPM_CONFIG_FETCH_RETRIES) {
                    launchEnv.npm_config_fetch_retries = "0";
                }
            }
            let child: ChildProcess;
            try { child = spawnOwnedRuntime(launcherShellCommand(launchCommand), attemptArgs, {
                cwd: workspaceRoot,
                env: launchEnv,
                // Windows batch and PowerShell launchers fail with EINVAL unless
                // executed through the shell; native executables do not need it.
                shell: launcherNeedsShell(launchCommand),
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            }); } finally { releaseStartup?.(); }
            this.child = child;
            this.startedByExtension = true;
            if (this.ownedRuntime && child.pid !== undefined) {
                this.ownedRuntime.record.runtimePid = child.pid;
                this.ownedRuntime.record.runtimeProcess = isPackageManagerSource(launchSource) || launcherNeedsShell(launchCommand)
                    ? "wrapper" : "direct";
                // A new launcher must not inherit the previous attempt's port as liveness evidence.
                delete this.ownedRuntime.record.url;
                delete this.ownedRuntime.record.launchUrl;
            }

            let exited = false;
            let launchError: Error | undefined;
            let outputTail = "";
            const recordOutput = (chunk: Buffer, stream: string): void => {
                if (signal.aborted || this.child !== child) return;
                const text = chunk.toString("utf8");
                const safeText = redactRuntimeOutput(text);
                outputTail = `${outputTail}${safeText}`.slice(-8_000);
                this.output.append(`[dsh:${stream}] ${safeText}`);

                const discoveredEndpoint = extractRuntimeEndpoint(text);
                if (discoveredEndpoint && (
                    discoveredEndpoint.baseUrl !== this.baseUrl ||
                    discoveredEndpoint.launchUrl !== this.launchUrl
                )) {
                    this.setRuntimeEndpoint(discoveredEndpoint);

                }
            };

            child.stdout?.on("data", (chunk: Buffer) => recordOutput(chunk, "out"));
            child.stderr?.on("data", (chunk: Buffer) => recordOutput(chunk, "err"));
            child.once("error", (error) => {
                launchError = error;
                exited = true;
            });
            let ready = false;
            child.once("exit", (code, exitSignal) => {
                exited = true;
                this.output.appendLine(`[dsh] exited: code=${code ?? "null"}, signal=${exitSignal ?? "null"}`);
                const shouldRecover = ready &&
                    this.child === child &&
                    this.startedByExtension &&
                    !signal.aborted && !this.stopPromise && this.resourceCleanupDepth === 0 &&
                    !this.disposed;
                const recoveryGeneration = this.runtimeRecoveryGeneration;
                if (shouldRecover) {
                    void this.terminate(child).catch(error => {
                        if (!(error instanceof RuntimeDescendantOwnershipUnknownError) ||
                            this.ownedRuntime?.record.runtimePid !== child.pid ||
                            this.ownedRuntime?.record.runtimeProcess !== "wrapper") throw error;
                        // Recovery still checks/reuses the shared endpoint and
                        // cannot replace a lock whose Runtime may remain alive.
                        this.output.appendLine(`[dsh] exited wrapper descendants unverified; continuing guarded recovery: ${String(error)}`);
                    }).then(async () => {
                        if (this.child !== child) return;
                        this.child = undefined;
                        await this.handleUnexpectedRuntimeExit(workspaceRoot, code, exitSignal, recoveryGeneration);
                    }).catch(error => {
                        this.output.appendLine(`[dsh] failed to clean up exited Runtime descendants: ${String(error)}`);
                        this.setStatus({ state: "error", message: String(error) });
                    });
                }
            });

            const startedAt = Date.now();
            const heartbeat = isPackageManagerSource(launchSource)
                ? setInterval(() => {
                    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1_000);
                    const timeoutSeconds = Math.ceil(readinessTimeout / 1_000);
                    this.output.appendLine(
                        `[dsh] ${launchSource.kind} is still downloading/starting (${elapsedSeconds}s/${timeoutSeconds}s timeout)`,
                    );
                }, 15_000)
                : undefined;
            try {
                // Persist the spawned PID before waiting for HTTP readiness or attempting a retry.
                await this.publishAdvertisement();
                checkStarting();
                const url = await this.waitForReady(
                    undefined,
                    readinessTimeout,
                    () => exited || signal.aborted,
                    () => signal.aborted ? new Error("DSH Runtime startup was cancelled") : launchError,
                    () => outputTail,
                );
                checkStarting();
                ready = true;
                this.baseUrl = url;
                try {
                    await this.publishAdvertisement({
                        baseUrl: url,
                        ...(this.launchUrl === undefined ? {} : { launchUrl: this.launchUrl }),
                    });
                } catch (error) {
                    this.output.appendLine(`[dsh] failed to publish Runtime URL: ${String(error)}`);
                }
                return url;
            } catch (error) {
                try {
                    await this.terminate(child);
                } catch (cleanupError) {
                    // The launch/readiness error is the primary diagnosis.
                    // In particular, an exited Windows wrapper cannot prove
                    // descendant ownership, so that cleanup limitation must
                    // never replace the real DSH stderr or exit reason.
                    // A surviving Runtime must never race automatic profile edits.
                    this.lastRecoveryComposition = undefined;
                    this.output.appendLine(
                        `[dsh] launch cleanup was not fully verified; automatic recovery disabled: ${String(cleanupError)}`,
                    );
                    if (!(cleanupError instanceof RuntimeDescendantOwnershipUnknownError)) {
                        this.output.appendLine(`[dsh] preserving primary Runtime launch failure: ${String(error)}`);
                    }
                }
                // Endpoint publication is intentionally fire-and-forget while
                // stdout is consumed. Drain it before deciding that this was
                // a URL-less bootstrap failure, otherwise a late publication
                // could race the guarded lock release.
                await this.advertisementWrite.catch(() => undefined);
                if (this.child === child) this.child = undefined;
                this.baseUrl = undefined;
                this.launchUrl = undefined;
                this.authCookie = undefined;
                this.authPromise = undefined;
                this.startedByExtension = false;
                throw new RuntimeLaunchFailure(outputTail, error);
            } finally {
                if (heartbeat !== undefined) clearInterval(heartbeat);
            }
        };

        const launchAttemptWithPortFallback = async (
            attemptArgs: string[],
            registryOverride?: string,
            launchOverride?: LaunchOverride,
        ): Promise<string> => {
            const effectiveArgs = automaticLaunchPort === undefined
                ? attemptArgs
                : withRuntimePort(attemptArgs, automaticLaunchPort);
            try {
                return await launchAttempt(effectiveArgs, registryOverride, launchOverride);
            } catch (error) {
                if (!portFromArgs(effectiveArgs) || !isAddressInUseFailure(error)) throw error;
                // The port was free during the probe but another process won
                // the bind race. Preserve lock ownership and retry once with
                // Harness/OS-assigned port selection.
                automaticLaunchPort = 0;
                this.output.appendLine(
                    "[dsh] requested port is occupied; retrying on an OS-assigned port",
                );
                return launchAttempt(withRuntimePort(attemptArgs, 0), registryOverride, launchOverride);
            }
        };

        const launchWithFallback = async (
            progress?: vscode.Progress<{ message?: string; increment?: number }>,
        ): Promise<string> => {
            try {
                return await launchAttemptWithPortFallback(args);
            } catch (error) {
                checkStarting();
                const registry = npmRegistry;
                if (!isPackageManagerSource(launcher.source) ||
                    !isLikelyNpmDownloadFailure(error, error instanceof RuntimeLaunchFailure ? error.outputTail : "")) {
                    throw error;
                }

                const outputTail = error instanceof RuntimeLaunchFailure ? error.outputTail : "";
                if (isPackageManagerCacheLayoutFailure(error, outputTail)) {
                    const store = packageManagerStoreRoot(`${error instanceof Error ? error.message : String(error)}\n${outputTail}`);
                    this.output.appendLine(
                        `[dsh] ${launcher.source.kind} resolved DSH but not its dependencies${store ? ` in ${store}` : ""}; ` +
                        "the store layout is unusable and a registry retry cannot repair it",
                    );
                }
                if (launcher.source.kind === "pnpm" && isPackageManagerBootstrapFailure(error, outputTail)) {
                    const npxCommand = await findUsablePackageManager("npx", {
                        cwd: workspaceRoot,
                        signal,
                        onLog: message => this.output.appendLine(message),
                    });
                    const npxBaseArgs = automaticLaunchPort === undefined
                        ? args
                        : withRuntimePort(args, automaticLaunchPort);
                    const npxArgs = npxCommand
                        ? alternatePackageManagerArgs("pnpm", "npx", npxBaseArgs)
                        : undefined;
                    if (npxCommand && npxArgs) {
                        const npxSource: DshRuntimeSource = { kind: "npx", command: npxCommand, args: npxArgs };
                        this.output.appendLine(
                            `[dsh] pnpm bootstrap failed; retrying via npx${registry ? ` with npm registry ${redactUrl(registry)}` : ""}`,
                        );
                        progress?.report({
                            message: t("Retrying DSH Runtime download via {command}…", {
                                command: describeSource(npxSource),
                            }),
                        });
                        try {
                            return await launchAttemptWithPortFallback(
                                npxArgs,
                                registry,
                                { command: npxCommand, source: npxSource },
                            );
                        } catch (retryError) {
                            const firstMessage = error instanceof Error ? error.message : String(error);
                            const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
                            throw new RuntimeLaunchFailure(outputTail, new Error(
                                `${firstMessage}\n\nRetrying DSH Runtime via npx also failed.\n\n${retryMessage}`,
                            ));
                        }
                    }
                    this.output.appendLine("[dsh] pnpm bootstrap failed, but npx was not found; continuing with registry retry");
                }

                if (registry === undefined) throw error;

                this.output.appendLine(
                    `[dsh] ${launcher.source.kind} download/start failed; retrying with npm registry ${redactUrl(registry)}`,
                );
                progress?.report({
                    message: t("Retrying DSH Runtime download via {command}…", {
                        command: describeSource(launcher.source),
                    }),
                });
                try {
                    // Registry overrides travel through the environment. pnpm
                    // treats --registry/--config.registry as dlx arguments on
                    // some versions and exits with "Unknown option".
                    return await launchAttemptWithPortFallback(args, registry);
                } catch (retryError) {
                    const firstMessage = error instanceof Error ? error.message : String(error);
                    const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
                    throw new RuntimeLaunchFailure(outputTail, new Error(
                        `${firstMessage}\n\n${t("Retrying with the alternate npm registry also failed.")}\n\n${retryMessage}`,
                    ));
                }
            }
        };

        let url: string;
        try {
            url = packageManagerNotice
                ? await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: packageManagerNotice.title,
                        cancellable: false,
                    },
                    async (progress) => {
                        progress.report({ message: packageManagerNotice.message });
                        return launchWithFallback(progress);
                    },
                )
                : await launchWithFallback();
        } catch (error) {
            await this.releaseDebugOverlay();
            await this.releaseOwnedRuntime();
            checkStarting();
            let message = error instanceof Error ? error.message : String(error);
            const failureTail = error instanceof RuntimeLaunchFailure ? error.outputTail : "";
            if (isPackageManagerSource(launcher.source) && isPackageManagerCacheLayoutFailure(error, failureTail)) {
                const store = packageManagerStoreRoot(`${message}\n${failureTail}`);
                message = store
                    ? t("The {manager} store at {path} resolved DSH but not its dependencies, so downloading it again cannot repair the layout. Clear that store and retry, or set dsh.command to a different package manager.\n\n{message}", {
                        manager: launcher.source.kind, path: store, message,
                    })
                    : t("The {manager} store resolved DSH but not its dependencies, so downloading it again cannot repair the layout. Clear it and retry, or set dsh.command to a different package manager.\n\n{message}", {
                        manager: launcher.source.kind, message,
                    });
            }
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

        checkStarting();
        this.baseUrl = url;
        this.setStatus({ state: "running", url });
        this.harnessState.start();
        if (this.lastRecoveryComposition) {
            try {
                await this.recoverySession.reconcileHealthyStart(this.lastRecoveryComposition);
            } catch (error) {
                this.output.appendLine(`[dsh:recovery] unable to close interrupted recovery: ${String(error)}`);
            }
        }
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
            if (url && (await this.isHarnessHealthy(url, initialUrl !== undefined))) {
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

    private setRuntimeEndpoint(endpoint: RuntimeEndpoint, preservePreviousLaunchUrl = true): void {
        const previousBaseUrl = this.baseUrl;
        const previousLaunchUrl = this.launchUrl;
        const launchUrl = endpoint.launchUrl ?? (
            preservePreviousLaunchUrl && previousBaseUrl === endpoint.baseUrl ? previousLaunchUrl : undefined
        );
        this.baseUrl = endpoint.baseUrl;
        this.launchUrl = launchUrl;
        if (previousBaseUrl !== this.baseUrl || previousLaunchUrl !== this.launchUrl) {
            this.authCookie = undefined;
            this.authPromise = undefined;
        }
    }

    private requestHeaders(): Record<string, string> {
        return this.authCookie === undefined ? {} : { cookie: this.authCookie };
    }

    private clearRuntimeAuthentication(): void {
        this.authCookie = undefined;
        this.authPromise = undefined;
    }

    /** Exchange dsh web's launch token for its authority-bound session cookie. */
    private async ensureAuthenticated(signal?: AbortSignal): Promise<void> {
        const launchUrl = this.launchUrl;
        if (!launchUrl || this.authCookie !== undefined) return;
        if (this.authPromise) return this.authPromise;

        const exchange = async (): Promise<void> => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 1_500);
            const relayAbort = (): void => controller.abort(signal?.reason);
            signal?.addEventListener("abort", relayAbort, { once: true });
            try {
                const response = await fetch(launchUrl, {
                    redirect: "manual",
                    headers: { accept: "text/plain" },
                    signal: controller.signal,
                });
                if (response.status === 303) {
                    const setCookie = response.headers.get("set-cookie");
                    const cookie = setCookie?.split(";", 1)[0]?.trim();
                    if (!cookie || !/^[^=;]+=[^;]*$/u.test(cookie)) {
                        throw new Error("dsh web authentication did not return a session cookie");
                    }
                    if (this.launchUrl === launchUrl) {
                        this.authCookie = cookie;
                    }
                    return;
                }
                // Pre-0.1.2 runtimes did not require authentication. Keep the
                // compatibility path so an existing local server still works.
                if (response.ok) return;
                throw new Error(`dsh web authentication returned HTTP ${response.status}`);
            } finally {
                clearTimeout(timeout);
                signal?.removeEventListener("abort", relayAbort);
            }
        };

        const promise = exchange();
        this.authPromise = promise;
        try {
            await promise;
        } finally {
            if (this.authPromise === promise) this.authPromise = undefined;
        }
    }

    private async isHealthy(url: string): Promise<boolean> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1_500);
        try {
            await this.ensureAuthenticated(controller.signal);
            const response = await fetch(url, {
                headers: this.requestHeaders(),
                signal: controller.signal,
            });
            return response.ok;
        } catch {
            return false;
        } finally {
            clearTimeout(timeout);
        }
    }

    private async findExistingRuntime(configuredPort: number, signal?: AbortSignal): Promise<RuntimeEndpoint | undefined> {
        this.sharedCompositionHash = undefined;
        const excludedOrigins = new Set<string>();
        const candidates: { endpoint: RuntimeEndpoint; version?: string; compositionHash?: string }[] = [];
        try {
            for (const raw of await readRuntimeAdvertisements()) {
                if (!isRecord(raw)) continue;
                const endpoint = advertisementEndpoint({ url: raw.baseUrl ?? raw.url, launchUrl: raw.launchUrl });
                if (endpoint && typeof raw.runtimeVersion === "string" && !isSupportedRuntimeVersion(raw.runtimeVersion)) {
                    excludedOrigins.add(endpoint.baseUrl);
                    continue;
                }
                if (endpoint) candidates.push({ endpoint,
                    version: typeof raw.runtimeVersion === "string" ? raw.runtimeVersion : undefined,
                    compositionHash: typeof raw.compositionHash === "string" ? raw.compositionHash : undefined,
                });
            }
        } catch { /* Discovery metadata never vetoes startup. */ }
        for (const port of new Set([configuredPort, DEFAULT_RUNTIME_PORT])) {
            if (Number.isInteger(port) && port > 0 && port <= 65535 && !excludedOrigins.has(`http://127.0.0.1:${port}`)) candidates.push({ endpoint: { baseUrl: `http://127.0.0.1:${port}` } });
        }
        // Keep a bounded discovery budget even after many crashed editors.
        const deadline = Date.now() + 2_000;
        const seen = new Set<string>();
        let selected = false;
        try {
            for (const candidate of candidates) {
                signal?.throwIfAborted();
                if (Date.now() >= deadline) break;
                const key = candidate.endpoint.launchUrl ?? candidate.endpoint.baseUrl;
                if (seen.has(key)) continue;
                seen.add(key);
                this.setRuntimeEndpoint(candidate.endpoint, false);
                try {
                    if (await this.isHarnessHealthy(candidate.endpoint.baseUrl, false, true)) {
                        signal?.throwIfAborted();
                        this.harnessState.setRuntimeVersion(candidate.version ?? "unknown");
                        this.sharedCompositionHash = candidate.compositionHash;
                        selected = true;
                        return candidate.endpoint;
                    }
                } catch { signal?.throwIfAborted(); }
            }
            return undefined;
        } finally {
            // Preserve authentication only for a successfully selected candidate.
            if (!selected) {
                this.baseUrl = undefined;
                this.launchUrl = undefined;
                this.clearRuntimeAuthentication();
            }
        }
    }

    private async isHarnessHealthy(url: string, failFast = false, requireSessionList = false): Promise<boolean> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1_500);
        const rpcId = `dsh-remote-probe-${process.pid}-${randomUUID()}`;
        try {
            try {
                await this.ensureAuthenticated(controller.signal);
            } catch (error) {
                if (failFast && error instanceof Error && /HTTP 401\b/u.test(error.message)) {
                    throw new RemoteHttpError("session/list", 401);
                }
                if (failFast && error instanceof Error && /HTTP 403\b/u.test(error.message)) {
                    throw new RemoteHttpError("session/list", 403);
                }
                if (failFast) throw error;
                return false;
            }
            const response = await fetch(remoteEndpointUrl(url, "session/list"), {
                method: "POST",
                headers: {
                    ...this.requestHeaders(),
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    type: "client-request",
                    rpcId,
                    method: "session/list",
                    // RC's session.list descriptor names this reserved
                    // parameter `_request` (the DTO is intentionally empty).
                    payload: { args: { _request: {} } },
                }),
                signal: controller.signal,
            });
            if (!response.ok) {
                if (failFast && (response.status === 401 || response.status === 403)) {
                    throw new RemoteHttpError("session/list", response.status);
                }
                if (failFast && response.status === 404) {
                    throw new RemoteProtocolError(
                        t("Configured dsh Runtime does not expose RC Remote RPC (HTTP 404). Upgrade dsh to {version}.", { version: RUNTIME_DEFAULT_VERSION }),
                    );
                }
                return false;
            }
            let body: unknown;
            try {
                body = await response.json();
            } catch (error) {
                if (failFast) {
                    throw new RemoteProtocolError(
                        t("Configured dsh Runtime returned invalid JSON from its RPC endpoint."),
                        { cause: error },
                    );
                }
                return false;
            }
            let envelope;
            try {
                envelope = parseRemoteServerResponse(body);
            } catch (error) {
                if (failFast) {
                    throw new RemoteProtocolError(
                        t("Configured dsh Runtime returned an incompatible RPC response."),
                        { cause: error },
                    );
                }
                return false;
            }
            // A structurally valid Remote failure is still proof that the
            // target speaks RC Remote v1; capability/domain failure is handled
            // by the actual facade call, not misclassified as an old protocol.
            if (envelope.rpcId !== rpcId) {
                if (failFast) {
                    throw new RemoteProtocolError(t("Configured dsh Runtime returned a mismatched RPC id."));
                }
                return false;
            }
            // Discovery must demonstrate a usable operation, not merely an RPC
            // error envelope from an incompatible or incompletely started host.
            return !requireSessionList || (envelope.result.ok &&
                isRecord(envelope.result.value) && Array.isArray(envelope.result.value.items));
        } catch (error) {
            if (!failFast) return false;
            if (error instanceof RemoteHttpError || error instanceof RemoteProtocolError) throw error;
            // A transport failure can mean that the Runtime is still starting;
            // let waitForReady retry until its startup deadline. Protocol-level
            // failures above remain fail-fast so incompatible endpoints surface
            // immediately.
            return false;
        } finally {
            clearTimeout(timeout);
        }
    }

    private requireRuntimeVersion(version: string | undefined): void {
        if (isSupportedRuntimeVersion(version)) return;
        throw new RemoteProtocolError(t(
            "DSH Runtime version is {actual}; this extension requires {expected}. Stop or upgrade the existing Runtime in its owning editor, then restart DSH. No process was stopped.",
            { actual: version ?? t("unknown (unversioned advertisement or launcher)"), expected: t("{version} or newer", { version: RUNTIME_MINIMUM_VERSION }) },
        ));
    }

    /** Publish only ready endpoints; a failed write cannot fail Runtime startup. */
    private publishAdvertisement(endpoint?: RuntimeEndpoint): Promise<void> {
        const owned = this.ownedRuntime;
        if (!owned) return Promise.resolve();
        if (endpoint) {
            owned.record.url = endpoint.baseUrl;
            owned.record.launchUrl = endpoint.launchUrl;
        }
        if (!owned.record.url || !owned.record.ownerId) return Promise.resolve();
        const record = { ...owned.record };
        const write = this.advertisementWrite.catch(() => undefined).then(async () => {
            if (this.ownedRuntime !== owned) return;
            try {
                await publishRuntimeAdvertisement({
                    ownerId: record.ownerId!, pid: record.pid, createdAt: record.createdAt ?? Date.now(),
                    runtimePid: record.runtimePid, runtimeVersion: record.runtimeVersion,
                    baseUrl: record.url!, launchUrl: record.launchUrl, compositionHash: record.compositionHash,
                });
            } catch {
                this.output.appendLine("[dsh] Runtime advertisement unavailable; continuing with this editor's private Runtime.");
            }
        });
        this.advertisementWrite = write;
        return write;
    }

    /**
     * Ownership is in-process bookkeeping; the advertisement describes an
     * endpoint. A package-manager wrapper can exit while the Runtime it started
     * keeps serving, so an unexpected exit drops ownership but leaves a
     * published endpoint discoverable: recovery and peer editors health-check
     * every candidate, so at worst this costs one failed probe, and adopting a
     * survivor is what prevents a second Runtime for the same machine.
     */
    private async releaseOwnedRuntime(retainPublishedEndpoint = false): Promise<void> {
        const owned = this.ownedRuntime;
        this.ownedRuntime = undefined;
        await this.advertisementWrite.catch(() => undefined);
        if (!owned?.record.ownerId) return;
        if (retainPublishedEndpoint && owned.record.url &&
            !await advertisedEndpointRefused(owned.record.url).catch(() => false)) {
            this.output.appendLine(
                "[dsh] launcher exited but its endpoint still answers; keeping its advertisement for discovery",
            );
            return;
        }
        await removeRuntimeAdvertisement(owned.record.ownerId);
    }

    /** Cancel automatic recovery when an explicit lifecycle action takes over. */
    private cancelRuntimeRecovery(): void {
        // Abort the in-flight session too: otherwise recover() still resolves as
        // retry/candidate and restarts the Runtime, undoing the user's stop.
        this.recoverySession.cancel();
        ++this.runtimeRecoveryGeneration;
        if (this.runtimeRecoveryTimer !== undefined) {
            clearTimeout(this.runtimeRecoveryTimer);
            this.runtimeRecoveryTimer = undefined;
        }
        this.runtimeRecoveryInFlight = false;
        this.runtimeRecoveryAttempts = 0;
    }

    /**
     * Recover only an extension-owned child. The process lock is released
     * before retrying, allowing another window to publish a healthy endpoint
     * that this window can reuse instead of spawning a second Runtime.
     */
    private async handleUnexpectedRuntimeExit(
        workspaceRoot: string | undefined,
        code: number | null,
        signal: NodeJS.Signals | null,
        recoveryGeneration: number,
    ): Promise<void> {
        if (
            this.disposed ||
            this.runtimeRecoveryGeneration !== recoveryGeneration ||
            !this.startedByExtension ||
            this.child !== undefined
        ) return;

        this.output.appendLine(
            `[dsh] extension-owned Runtime exited unexpectedly: code=${code ?? "null"}, signal=${signal ?? "null"}`,
        );
        this.baseUrl = undefined;
        this.launchUrl = undefined;
        this.authCookie = undefined;
        this.authPromise = undefined;
        this.hostDescription = undefined;
        this.subagentHistoryCursors.clear();

        try {
            await this.harnessState.stop();
        } catch (error) {
            this.output.appendLine(`[dsh] failed to stop Remote state after Runtime exit: ${String(error)}`);
        }

        // A manual start/stop may have won while the Remote streams were
        // shutting down. Never withdraw its advertisement or change its ownership.
        if (
            this.disposed ||
            this.runtimeRecoveryGeneration !== recoveryGeneration ||
            this.child !== undefined ||
            !this.startedByExtension
        ) return;
        await this.releaseOwnedRuntime(true);
        this.startedByExtension = false;
        // A retry attempt may have been starting when this new child died.
        // Let the exit schedule the next attempt; the old start promise will
        // observe the generation change and cannot reset the budget.
        this.runtimeRecoveryInFlight = false;
        this.scheduleRuntimeRecovery(workspaceRoot);
    }

    /** Schedule one bounded, generation-guarded recovery attempt. */
    private scheduleRuntimeRecovery(workspaceRoot: string | undefined): void {
        if (this.disposed || this.runtimeRecoveryTimer !== undefined || this.runtimeRecoveryInFlight) return;
        if (!workspaceRoot) {
            const message = t("dsh web exited unexpectedly, but no workspace is available for recovery.");
            this.setStatus({ state: "error", message });
            return;
        }

        const maxAttempts = RUNTIME_RECOVERY_DELAYS_MS.length;
        if (this.runtimeRecoveryAttempts >= maxAttempts) {
            const message = t("dsh web exited unexpectedly after {attempts} recovery attempts. Run DSH: Restart dsh Web to try again.", {
                attempts: maxAttempts,
            });
            this.output.appendLine(`[dsh] Runtime recovery exhausted after ${maxAttempts} attempts`);
            this.beginUnexpectedExitRecovery(workspaceRoot);
            if (!this.automaticRecoveryInFlight) this.setStatus({ state: "error", message });
            return;
        }

        const attempt = ++this.runtimeRecoveryAttempts;
        const delayMs = RUNTIME_RECOVERY_DELAYS_MS[attempt - 1];
        const generation = ++this.runtimeRecoveryGeneration;
        const seconds = Math.ceil(delayMs / 1_000);
        this.output.appendLine(
            `[dsh] scheduling Runtime recovery attempt ${attempt}/${maxAttempts} in ${seconds}s`,
        );
        this.setStatus({
            state: "starting",
            message: t("dsh web exited unexpectedly; retrying in {seconds}s (attempt {attempt} of {max}).", {
                seconds,
                attempt,
                max: maxAttempts,
            }),
        });

        this.runtimeRecoveryTimer = setTimeout(() => {
            if (this.runtimeRecoveryGeneration !== generation || this.disposed) return;
            this.runtimeRecoveryTimer = undefined;
            this.runtimeRecoveryInFlight = true;
            void this.startWithRecovery(workspaceRoot, true)
                .then(() => {
                    if (this.runtimeRecoveryGeneration === generation && this.status.state === "running") {
                        this.runtimeRecoveryAttempts = 0;
                    }
                })
                .catch((error: unknown) => {
                    if (this.runtimeRecoveryGeneration !== generation || this.disposed) return;
                    this.output.appendLine(`[dsh] Runtime recovery attempt ${attempt} failed: ${String(error)}`);
                    this.runtimeRecoveryInFlight = false;
                    this.scheduleRuntimeRecovery(workspaceRoot);
                })
                .finally(() => {
                    if (this.runtimeRecoveryGeneration === generation) this.runtimeRecoveryInFlight = false;
                });
        }, delayMs);
    }

    private async terminate(child: ChildProcess): Promise<void> {
        const lock = this.ownedRuntime;
        // An exited Windows wrapper has untraceable descendants. An exited
        // direct Runtime can instead be proved absent by its PID and endpoint,
        // without taskkill or minting process-tree termination evidence.
        if (process.platform === "win32" && (child.exitCode !== null || child.signalCode !== null) &&
            lock?.record.runtimePid === child.pid && lock?.record.runtimeProcess === "direct" &&
            child.exitCode !== null) return;
        await terminateOwnedRuntime(child);

    }

    private recoveryEnabled(): boolean {
        return this.configuration().get<boolean>("recovery.enabled", true);
    }

    private async runAutomaticRecovery(
        workspaceRoot: string | undefined,
        failureMessage: string,
        signal?: AbortSignal,
    ): Promise<RecoveryOutcome> {
        if (!workspaceRoot || !this.lastRecoveryComposition) {
            return {
                status: "unrecoverable",
                sessionId: "composition-unavailable",
                message: "Automatic recovery could not capture the local launch composition.",
            };
        }
        if (this.automaticRecoveryInFlight) {
            return {
                status: "unrecoverable",
                sessionId: this.recoverySession.getSessionId() ?? "recovery-busy",
                message: "Another automatic recovery session is already running.",
            };
        }
        this.automaticRecoveryInFlight = true;
        this.output.appendLine(`[dsh:recovery] starting automatic recovery: ${failureMessage}`);
        try {
            return await this.recoverySession.recover(
                this.lastRecoveryComposition,
                failureMessage,
                signal,
            );
        } finally {
            this.automaticRecoveryInFlight = false;
        }
    }

    /** Adopt only a healthy Runtime with matching composition evidence. */
    private async adoptExistingRuntime(composition: CompositionDescriptor): Promise<boolean> {
        const generation = this.runtimeRecoveryGeneration;
        const configuredPort = this.configuration().get<number>("serverPort", 0);
        let endpoint: RuntimeEndpoint | undefined;
        try {
            endpoint = await this.findExistingRuntime(configuredPort);
        } catch (error) {
            this.output.appendLine(`[dsh:recovery] adoption probe failed: ${String(error)}`);
            return false;
        }
        if (!endpoint || this.disposed || generation !== this.runtimeRecoveryGeneration) return false;
        const recorded = this.sharedCompositionHash;
        if (recorded === undefined) {
            this.output.appendLine(
                "[dsh:recovery] a healthy Runtime answered but carries no composition evidence; " +
                "it is reported, not adopted.",
            );
            return false;
        }
        if (recorded !== composition.compositionHash) {
            this.output.appendLine(
                "[dsh:recovery] a healthy Runtime answered for a different composition; " +
                "adoption is ambiguous, so recovery search continues.",
            );
            return false;
        }
        this.setRuntimeEndpoint(endpoint);
        this.startedByExtension = false;
        this.setStatus({ state: "running", url: endpoint.baseUrl });
        this.harnessState.start();
        await this.recoverySession.confirm(composition);
        this.output.appendLine(`[dsh:recovery] adopted an already-healthy Runtime at ${endpoint.baseUrl}`);
        return true;
    }
    private beginUnexpectedExitRecovery(workspaceRoot: string | undefined): void {
        if (
            this.disposed ||
            this.automaticRecoveryInFlight ||
            !this.recoveryEnabled() ||
            !workspaceRoot ||
            !this.lastRecoveryComposition
        ) {
            return;
        }
        const composition = this.lastRecoveryComposition;
        const generation = this.runtimeRecoveryGeneration;
        this.automaticRecoveryInFlight = true;
        void (async () => {
            const failure = t("dsh web exited unexpectedly after {attempts} recovery attempts.", {
                attempts: RUNTIME_RECOVERY_DELAYS_MS.length,
            });
            try {
                if (await this.adoptExistingRuntime(composition)) {
                    return;
                }
                if (this.disposed || generation !== this.runtimeRecoveryGeneration) return;
                const outcome = await this.recoverySession.recover(composition, failure);
                if (this.disposed || generation !== this.runtimeRecoveryGeneration) {
                    await this.recoverySession.fail("Recovery interrupted by a lifecycle action.");
                    return;
                }
                if (outcome.status !== "retry" && outcome.status !== "candidate") {
                    this.setStatus({
                        state: "error",
                        message: outcome.message,
                        recovery: this.recoverySession.getStatus(),
                    });
                    return;
                }
                try {
                    await this.startWithRecovery(workspaceRoot, true);
                    await this.recoverySession.confirm(
                        this.lastRecoveryComposition ?? outcome.composition ?? composition,
                        outcome.attribution,
                    );
                    this.runtimeRecoveryAttempts = 0;
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    await this.recoverySession.fail(message);
                    this.setStatus({
                        state: "error",
                        message,
                        recovery: this.recoverySession.getStatus(),
                    });
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.output.appendLine(`[dsh:recovery] unexpected-exit recovery failed: ${message}`);
                this.setStatus({ state: "error", message });
            } finally {
                this.automaticRecoveryInFlight = false;
            }
        })();
    }

    private publishRecoveryStatus(status: RecoveryStatusView): void {
        const state: RuntimeStatus["state"] =
            status.phase === "recovered"
                ? "running"
                : status.phase === "unrecoverable" || status.phase === "cancelled"
                    ? "error"
                    : "recovering";
        this.setStatus({
            state,
            message: status.summary,
            recovery: { ...status },
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
