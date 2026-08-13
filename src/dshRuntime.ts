import { ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import {
    DshHistoryResult,
    DshRpcEnvelope,
    DshSessionCreateResult,
    DshSessionPromptResult,
    RuntimeStatus,
} from "./types";

type RuntimeListener = (status: RuntimeStatus) => void;

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

export class DshRuntime implements vscode.Disposable {
    private readonly listeners = new Set<RuntimeListener>();
    private child: ChildProcess | undefined;
    private baseUrl: string | undefined;
    private startPromise: Promise<string> | undefined;
    private startedByExtension = false;
    private disposed = false;
    private status: RuntimeStatus = { state: "stopped" };

    public constructor(private readonly output: vscode.OutputChannel) {}

    public onDidChange(listener: RuntimeListener): vscode.Disposable {
        this.listeners.add(listener);
        return new vscode.Disposable(() => this.listeners.delete(listener));
    }

    public getStatus(): RuntimeStatus {
        return { ...this.status };
    }

    public getUrl(): string | undefined {
        return this.baseUrl;
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
        const child = this.child;
        this.child = undefined;
        this.baseUrl = undefined;

        if (child && this.startedByExtension) {
            await this.terminate(child);
        }

        this.startedByExtension = false;
        this.setStatus({ state: "stopped" });
    }

    public async createSession(cwd: string): Promise<DshSessionCreateResult> {
        return this.request<DshSessionCreateResult>("session.create", { cwd });
    }

    public async history(sessionId: string, maxMessages = 100): Promise<DshHistoryResult> {
        return this.request<DshHistoryResult>("session.history", {
            sessionId,
            maxMessages,
        });
    }

    public async prompt(
        sessionId: string,
        text: string,
        mode: "queue" | "steer" = "queue",
    ): Promise<DshSessionPromptResult> {
        return this.request<DshSessionPromptResult>("session.prompt", {
            sessionId,
            mode,
            content: [{ type: "text", text }],
        });
    }

    public async cancel(sessionId: string): Promise<void> {
        await this.request("session.cancel", { sessionId });
    }

    public async request<T>(method: string, payload: unknown): Promise<T> {
        const baseUrl = this.baseUrl;
        if (!baseUrl) {
            throw new Error("dsh web 尚未启动。");
        }

        const requestTimeout = this.configuration().get<number>("requestTimeoutMs", 600_000);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), requestTimeout);

        try {
            const response = await fetch(`${baseUrl}/api/${method}`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    type: "client-request",
                    rpcId: randomUUID(),
                    method,
                    payload,
                }),
                signal: controller.signal,
            });

            const body = (await response.json()) as DshRpcEnvelope<T>;
            if (!response.ok) {
                throw new Error(`dsh API ${method} 返回 HTTP ${response.status}。`);
            }

            if (!body.result?.ok) {
                throw new Error(this.formatRpcError(method, body.result?.error));
            }

            return body.result.value as T;
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") {
                throw new Error(`dsh API ${method} 请求超时。`);
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
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
            return url;
        }

        if (this.baseUrl && (await this.isHealthy(this.baseUrl))) {
            this.setStatus({ state: "running", url: this.baseUrl });
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

        const command = this.configuration().get<string>("command", "dsh").trim() || "dsh";
        const configuredArgs = this.configuration().get<string[]>("commandArgs", ["web"]);
        const args = [...configuredArgs];
        const configuredPort = this.configuration().get<number>("serverPort", 0);

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

    private formatRpcError(method: string, error: unknown): string {
        if (typeof error === "string") {
            return `dsh API ${method} 失败：${error}`;
        }

        if (error && typeof error === "object") {
            const record = error as Record<string, unknown>;
            const message = record.message ?? record.code ?? JSON.stringify(error);
            return `dsh API ${method} 失败：${String(message)}`;
        }

        return `dsh API ${method} 失败。`;
    }

    private setStatus(status: RuntimeStatus): void {
        this.status = status;
        for (const listener of this.listeners) {
            listener({ ...status });
        }
    }
}
