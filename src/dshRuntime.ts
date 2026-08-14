import { ChildProcess, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join } from "node:path";
import * as vscode from "vscode";
import { HarnessApiClient } from "./harnessClient";
import {
    HarnessClientResponse,
    HarnessHostDescription,
    HarnessGoalEditChanges,
    HarnessQueueAction,
} from "./harnessProtocol";
import { HarnessStateCoordinator } from "./harnessState";
import {
    DshGoalRef,
    DshGoalRefResult,
    DshHistoryResult,
    DshSessionCreateResult,
    DshSessionForkResult,
    DshSessionPromptResult,
    DshSessionModelsResult,
    DshSessionSelectModelResult,
    DshAgentPresetListResult,
    DshAgentPresetSelectResult,
    DshSessionRenameResult,
    DshSessionSearchResult,
    DshSkillEntry,
    DshSkillListResult,
    DshSubagentAddress,
    DshSubagentCatalog,
    DshSubagentHistoryResult,
    DshSubagentPromptResult,
    DshRpcReceipt,
    RuntimeStatus,
} from "./types";

type RuntimeListener = (status: RuntimeStatus) => void;
type HarnessConnectedListener = () => void;

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeUrl(value: string): string {
    return value.trim().replace(/\/+$/, "");
}

function extractUrl(value: string): string | undefined {
    const match = value.match(
        /https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):\d+/i,
    );
    return match ? normalizeUrl(match[0]) : undefined;
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

async function executableExists(command: string): Promise<boolean> {
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
            return true;
        } catch {
            // Try the next PATH entry.
        }
    }
    return false;
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
    private disposed = false;
    private status: RuntimeStatus = { state: "stopped" };

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
            onHostDescription: () => {
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
            throw new Error("dsh-ide runtime 已经被释放。");
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

        if (child && this.startedByExtension) {
            await this.terminate(child);
        }

        this.startedByExtension = false;
        this.setStatus({ state: "stopped" });
    }

    public async createSession(cwd: string, agentPreset?: string): Promise<DshSessionCreateResult> {
        const result = await this.apiClient.call("session.create", {
            cwd,
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
    ): Promise<DshSessionPromptResult> {
        return this.apiClient.call("session.prompt", {
            sessionId,
            mode,
            content: [{ type: "text", text }],
        });
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
            const message = "请先信任当前工作区，dsh 才能执行 agent 操作。";
            this.setStatus({ state: "error", message });
            throw new Error(message);
        }

        this.setStatus({ state: "starting", message: "正在连接 dsh web…" });

        if (configuredUrl) {
            if (this.child && this.startedByExtension) {
                await this.stop();
                this.setStatus({ state: "starting", message: "正在连接 dsh web…" });
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

        if (!workspaceRoot) {
            const message = "请先打开一个工作区，dsh 才能以该目录作为工作目录启动。";
            this.setStatus({ state: "error", message });
            throw new Error(message);
        }

        if (this.child && this.startedByExtension) {
            await this.stop();
            this.setStatus({ state: "starting", message: "正在启动 dsh web…" });
        }

        let command = this.configuration().get<string>("command", "dsh").trim() || "dsh";
        const configuredArgs = this.configuration().get<string[]>("commandArgs", ["web"]);
        let args = [...configuredArgs];
        const configuredPort = this.configuration().get<number>("serverPort", 0);

        if (!(await executableExists(command))) {
            const installWhenMissing = this.configuration().get<boolean>("installWhenMissing", true);
            if (command !== "dsh" || !installWhenMissing) {
                const message = `找不到启动命令“${command}”。请安装 Node.js/npm、配置 dsh.command 的绝对路径，或手动安装 dsh CLI。官方 npm 入口是 npx @deepseek-ai/dsh web。`;
                this.setStatus({ state: "error", message });
                throw new Error(message);
            }
            if (!(await executableExists("npx"))) {
                const message =
                    "未找到 dsh，也未找到可用于安装回退的 npx。请先安装 Node.js/npm，或配置 dsh.command 的绝对路径。";
                this.setStatus({ state: "error", message });
                throw new Error(message);
            }

            command = "npx";
            args = ["-y", "@deepseek-ai/dsh", ...args];
            this.setStatus({ state: "starting", message: "未找到 dsh，正在通过 npx 获取并启动…" });
            this.output.appendLine("[dsh] executable not found; falling back to npx -y @deepseek-ai/dsh");
        }

        if (!args.some((argument) => argument === "--port" || argument === "-p" || argument.startsWith("--port="))) {
            args.push("--port", String(configuredPort));
        }

        const candidatePort = portFromArgs(args);
        this.baseUrl = candidatePort
            ? `http://127.0.0.1:${candidatePort}`
            : undefined;

        this.output.appendLine(`[dsh] starting: ${command} ${args.join(" ")}`);
        const child = spawn(command, args, {
            cwd: workspaceRoot,
            env: process.env,
            shell: false,
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
            if (discoveredUrl) {
                this.baseUrl = discoveredUrl;
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
            this.setStatus({ state: "running", url });
            this.harnessState.start();
            return url;
        } catch (error) {
            await this.terminate(child);
            this.child = undefined;
            this.baseUrl = undefined;
            this.startedByExtension = false;
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
                    throw new Error(`启动 dsh 失败：${launchError.message}`);
                }

                const tail = getOutputTail?.().trim();
                throw new Error(
                    `dsh web 在就绪前退出。${tail ? `\n\n最后输出：\n${tail}` : ""}`,
                );
            }

            const url = initialUrl ?? this.baseUrl;
            if (url && (await this.isHealthy(url))) {
                return url;
            }

            if (url) {
                lastError = `无法连接 ${url}`;
            }
            await delay(250);
        }

        const tail = getOutputTail?.().trim();
        throw new Error(
            `等待 dsh web 超时。${lastError ? ` ${lastError}。` : " 未从进程输出中发现本地服务地址。"}${
                tail ? `\n\n最后输出：\n${tail}` : ""
            }`,
        );
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
