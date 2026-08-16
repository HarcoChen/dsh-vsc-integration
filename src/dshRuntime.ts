import { ChildProcess, execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, open, readFile, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, extname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { HarnessApiClient } from "./harnessClient";
import {
    HarnessClientResponse,
    HarnessHostDescription,
    HarnessGoalEditChanges,
    HarnessQueueAction,
} from "./harnessProtocol";
import { HarnessStateCoordinator } from "./harnessState";
import { t } from "./localize";
import {
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
const execFileAsync = promisify(execFile);

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeUrl(value: string): string {
    return value.trim().replace(/\/+$/, "");
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

type DshLauncherSource = "configured" | "path" | "npm-prefix" | "npx";
interface DshLauncher {
    command: string;
    args: string[];
    source: DshLauncherSource;
}

async function discoverDsh(command: string): Promise<DshLauncher> {
    if (await executableExists(command)) {
        return { command, args: [], source: "configured" };
    }
    if (command !== "dsh") {
        throw new Error(t("Start command “{command}” was not found. Configure an absolute dsh.command path or install the dsh CLI.", { command }));
    }

    if (await executableExists("dsh")) {
        return { command: "dsh", args: [], source: "path" };
    }

    try {
        const result = await execFileAsync("npm", ["prefix", "-g"], {
            timeout: 10_000,
            windowsHide: true,
            shell: process.platform === "win32",
        });
        const prefix = result.stdout.trim();
        const binDir = process.platform === "win32" ? prefix : join(prefix, "bin");
        for (const name of process.platform === "win32" ? ["dsh.cmd", "dsh.exe", "dsh.ps1", "dsh"] : ["dsh"]) {
            const candidate = join(binDir, name);
            if (await executableExists(candidate)) {
                return { command: candidate, args: [], source: "npm-prefix" };
            }
        }
    } catch {
        // npm is optional; continue to the non-installing npx probe.
    }

    if (await executableExists("npx")) {
        return { command: "npx", args: ["--no-install", "@deepseek-ai/dsh"], source: "npx" };
    }
    throw new Error(t("No dsh executable was found in PATH, the npm global prefix, or npx. Configure an absolute dsh.command path or install the dsh CLI."));
}

export class DshRuntime implements vscode.Disposable {
    private readonly listeners = new Set<RuntimeListener>();
    private readonly harnessConnectedListeners = new Set<HarnessConnectedListener>();
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

    public constructor(private readonly output: vscode.OutputChannel) {
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
        const configuredArgs = configuration.get<string[]>("commandArgs", ["web"]);
        const args = Array.isArray(configuredArgs)
            ? configuredArgs.filter((argument): argument is string => typeof argument === "string")
            : [];
        const serverUrl = configuration.get<string>("serverUrl", "").trim();
        const configuredPort = configuration.get<number>("serverPort", 0);
        const apiKeyRef = configuration.get<string>("apiKeyEnv", "DEEPSEEK_API_KEY").trim();
        const commandPath = await findExecutable(command);
        const dshPath = await findExecutable("dsh");
        const npxPath = await findExecutable("npx");
        const npmPath = await findExecutable("npm");
        const prefix = await globalNpmPrefix();

        let discovery: string;
        try {
            const launcher = await discoverDsh(command);
            discovery = `${launcher.command} (${launcher.source})`;
        } catch (error) {
            discovery = `error: ${error instanceof Error ? error.message : String(error)}`;
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
            `Resolved command: ${commandPath ?? "<not found>"}`,
            `Resolved dsh: ${dshPath ?? "<not found>"}`,
            `Resolved npx: ${npxPath ?? "<not found>"}`,
            `Resolved npm: ${npmPath ?? "<not found>"}`,
            `npm global prefix: ${prefix ?? "<unavailable>"}`,
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

    public async dispose(): Promise<void> {
        this.disposed = true;
        await this.stop();
    }

    private async startInternal(workspaceRoot?: string): Promise<string> {
        const configuredUrl = this.configuration().get<string>("serverUrl", "").trim();
        const startupTimeout = this.configuration().get<number>("startupTimeoutMs", 30_000);

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
        const configuredArgs = this.configuration().get<string[]>("commandArgs", ["web"]);
        let args = [...configuredArgs];
        const enableCompaction = this.configuration().get<boolean>("enableCompaction", true);

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

        let launcher: DshLauncher;
        try {
            launcher = await discoverDsh(command);
        } catch (error) {
            await this.releaseRuntimeLock();
            const message = error instanceof Error ? error.message : String(error);
            this.setStatus({ state: "error", message });
            throw error;
        }
        command = launcher.command;
        args = [...launcher.args, ...args];
        this.output.appendLine(`[dsh] discovered executable: ${command} (${launcher.source})`);
        if (enableCompaction && args.includes("web")) {
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
            args.push("--patch", this.compactionPatchPath);
            this.output.appendLine(`[dsh] compaction command enabled with patch: ${this.compactionPatchPath}`);
        }

        if (!args.some((argument) => argument === "--port" || argument === "-p" || argument.startsWith("--port="))) {
            // Port 0 asks Harness/the OS for a free port. This preserves the
            // normal 3080 default for discovery while still working when it is
            // occupied by another service or Runtime.
            args.push("--port", String(configuredPort > 0 ? configuredPort : 0));
        }

        const candidatePort = portFromArgs(args);
        this.baseUrl = candidatePort
            ? `http://127.0.0.1:${candidatePort}`
            : undefined;

        this.output.appendLine(`[dsh] starting: ${command} ${args.join(" ")}`);
        const child = spawn(command, args, {
            cwd: workspaceRoot,
            env: process.env,
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

        try {
            const url = await this.waitForReady(
                undefined,
                startupTimeout,
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
            this.setStatus({ state: "running", url });
            this.harnessState.start();
            return url;
        } catch (error) {
            await this.terminate(child);
            this.child = undefined;
            this.baseUrl = undefined;
            this.startedByExtension = false;
            await this.releaseRuntimeLock();
            const message = error instanceof Error ? error.message : String(error);
            this.setStatus({ state: "error", message });
            throw error;
        }
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
        const path = join(tmpdir(), "dsh-vscode-runtime.lock");
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
        try {
            const contents = await readFile(join(tmpdir(), "dsh-vscode-runtime.lock"), "utf8");
            const record = JSON.parse(contents) as { url?: unknown };
            return loopbackRuntimeUrl(record.url);
        } catch {
            // A missing, legacy, or concurrently updated lock has no advertised URL yet.
            return undefined;
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

    private setStatus(status: RuntimeStatus): void {
        this.status = status;
        for (const listener of this.listeners) {
            listener({ ...status });
        }
    }
}
