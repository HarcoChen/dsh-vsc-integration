import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { DshRuntime } from "./dshRuntime";
import type { RuntimeTerminalEnvironment, RuntimeTerminalInfo } from "./runtimeTerminalClient";
import { errorMessage } from "./errors";
import { t } from "./localize";
import { RemoteHttpError } from "./remote/errors";

/** One VS Code terminal occurrence, bound to an exact Runtime and Host terminal identity. */
class RuntimePty implements vscode.Pseudoterminal, vscode.Disposable {
    private readonly output = new vscode.EventEmitter<string>();
    public readonly onDidWrite = this.output.event;
    private readonly names = new vscode.EventEmitter<string>();
    public readonly onDidChangeName = this.names.event;
    private controller?: AbortController;
    private attachmentId?: string;
    private writable = false;
    private disposed = false;
    private opened = false;
    private dimensions?: vscode.TerminalDimensions;
    private writes = Promise.resolve();
    private queuedBytes = 0;
    private controls = Promise.resolve();
    private readonly subscriptions: vscode.Disposable[];

    public constructor(private readonly runtime: DshRuntime, readonly endpoint: string, readonly sessionId: string,
        readonly info: RuntimeTerminalInfo, private readonly limits: RuntimeTerminalEnvironment,
        private readonly closeHost: () => void) {
        this.subscriptions = [
            runtime.onDidHarnessConnect(() => this.connect()),
            runtime.onDidChange(status => {
                if (status.state === "stopped" || status.state === "error") this.detach();
            }),
        ];
    }

    public open(dimensions?: vscode.TerminalDimensions): void {
        this.opened = true;
        this.dimensions = dimensions;
        this.connect();
    }

    public reconnect(): void { this.connect(); }

    private available(): boolean {
        return !this.disposed && this.runtime.getUrl() === this.endpoint;
    }

    private connect(): void {
        if (!this.opened || this.disposed) return;
        this.detach();
        if (!this.available()) {
            this.output.fire(`\r\n${t("The connected Runtime changed. Open a new Runtime terminal.")}\r\n`);
            return;
        }
        const controller = new AbortController();
        this.controller = controller;
        const attachmentId = randomUUID();
        this.attachmentId = attachmentId;
        let acknowledge!: () => void;
        let reject!: (error: unknown) => void;
        const retained = new Promise<void>((resolve, fail) => { acknowledge = resolve; reject = fail; });
        void (async () => {
            let ready = false;
            for await (const _ of this.runtime.terminals.retain(this.sessionId, this.info.id, controller.signal)) {
                ready = true;
                acknowledge();
            }
            if (!controller.signal.aborted) throw new Error(t("Runtime terminal retention ended. Reopen the terminal to reconnect."));
            if (!ready) reject(controller.signal.reason);
        })().catch(error => {
            reject(error);
            this.fail(controller, error);
        });
        void (async () => {
            await retained;
            controller.signal.throwIfAborted();
            for await (const frame of this.runtime.terminals.follow(this.sessionId, this.info.id, attachmentId, controller.signal)) {
                if (!this.available() || this.controller !== controller) return;
                if (frame.type !== "output") {
                    if (frame.info.id !== this.info.id) throw new Error("Runtime terminal identity changed");
                    this.writable = frame.info.state === "running" && frame.info.controllerId === attachmentId;
                    this.names.fire(`DSH · ${frame.info.title}${this.writable ? "" : ` (${t("Read only")})`}`);
                }
                if (frame.type === "snapshot") {
                    this.output.fire(`\x1b[2J\x1b[H${frame.screen}`);
                    if (this.dimensions) this.setDimensions(this.dimensions);
                } else if (frame.type === "output") this.output.fire(frame.data);
            }
            this.writable = false;
        })().catch(error => this.fail(controller, error));
    }

    private fail(controller: AbortController, error: unknown): void {
        if (this.controller !== controller || controller.signal.aborted || this.disposed) return;
        this.writable = false;
        controller.abort();
        this.output.fire(`\r\n${t("Runtime terminal disconnected: {message}", { message: errorMessage(error) })}\r\n`);
    }

    public handleInput(data: string): void {
        const attachmentId = this.attachmentId;
        if (!this.writable || !attachmentId || !this.available()) return;
        const bytes = Buffer.byteLength(data, "utf8");
        if (this.queuedBytes + bytes > this.limits.maxInputBytes) {
            this.output.fire(`\r\n${t("Terminal input exceeds the Runtime limit. Send smaller chunks.")}\r\n`);
            return;
        }
        this.queuedBytes += bytes;
        this.writes = this.writes.then(async () => {
            if (this.attachmentId !== attachmentId || !this.writable || !this.available()) return;
            await this.runtime.terminals.write(this.sessionId, this.info.id, attachmentId, data);
        }).catch(error => {
            if (this.attachmentId === attachmentId && this.controller) this.fail(this.controller, error);
        }).finally(() => { this.queuedBytes -= bytes; });
    }

    public setDimensions(dimensions: vscode.TerminalDimensions): void {
        this.dimensions = dimensions;
        const attachmentId = this.attachmentId;
        const controller = this.controller;
        if (!this.writable || !attachmentId || !controller || !this.available()) return;
        this.controls = this.controls.then(async () => {
            if (this.attachmentId !== attachmentId || !this.writable || !this.available()) return;
            await this.runtime.terminals.resize(this.sessionId, this.info.id, attachmentId,
                Math.max(1, Math.min(dimensions.columns, this.limits.maxCols)),
                Math.max(1, Math.min(dimensions.rows, this.limits.maxRows)),
            );
        }).catch(error => this.fail(controller, error));
    }

    public close(): void {
        if (this.disposed) return;
        this.closeHost();
        this.dispose();
    }

    private detach(): void {
        this.writable = false;
        this.attachmentId = undefined;
        this.controller?.abort();
        this.controller = undefined;
    }

    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.detach();
        for (const subscription of this.subscriptions) subscription.dispose();
        this.output.dispose();
        this.names.dispose();
    }
}

/** Retained PTYs survive switching chats; closing a terminal requests Host process cleanup. */
export class RuntimeTerminalManager implements vscode.Disposable {
    private readonly terminals = new Map<string, { terminal: vscode.Terminal; pty: RuntimePty }>();
    private readonly closing = new Map<string, { endpoint: string; sessionId: string; id: string }>();
    private readonly reconnect: vscode.Disposable;
    private opening = false;
    private flushing = false;
    private disposed = false;

    public constructor(private readonly runtime: DshRuntime, private readonly output: vscode.OutputChannel) {
        this.reconnect = runtime.onDidHarnessConnect(() => { void this.flushCloses(); });
    }

    public async open(sessionId: string): Promise<void> {
        if (this.opening || this.disposed) return;
        this.opening = true;
        try {
            await this.flushCloses();
            const endpoint = this.runtime.getUrl();
            if (!endpoint) throw new Error(t("The Runtime is not connected."));
            const limits = await this.runtime.terminals.environment(sessionId);
            if (this.disposed || this.runtime.getUrl() !== endpoint) return;
            const retained = await this.runtime.terminals.list(sessionId);
            if (this.disposed || this.runtime.getUrl() !== endpoint) return;
            const selected = await vscode.window.showQuickPick([
                { label: `$(add) ${t("New Runtime terminal")}`, info: undefined as RuntimeTerminalInfo | undefined },
                ...retained.filter(info => !this.closing.has(this.key(endpoint, sessionId, info.id))).map(info => ({
                    label: `$(terminal) ${info.title}`, description: `${info.state} · ${info.cwd}`, info,
                })),
            ], { title: t("Runtime terminals"), placeHolder: t("Open a retained terminal or start a new user shell") });
            if (!selected || this.disposed || this.runtime.getUrl() !== endpoint) return;
            const info = selected.info ?? await this.runtime.terminals.create(sessionId, randomUUID(),
                Math.min(100, limits.maxCols), Math.min(30, limits.maxRows));
            if (this.disposed || this.runtime.getUrl() !== endpoint) return;
            const key = this.key(endpoint, sessionId, info.id);
            const known = this.terminals.get(key);
            if (known) { known.terminal.show(); known.pty.reconnect(); return; }
            const pty = new RuntimePty(this.runtime, endpoint, sessionId, info, limits, () => {
                this.terminals.delete(key);
                this.closing.set(key, { endpoint, sessionId, id: info.id });
                void this.flushCloses();
            });
            try {
                const terminal = vscode.window.createTerminal({ name: `DSH · ${info.title}`, pty });
                this.terminals.set(key, { terminal, pty });
                terminal.show();
            } catch (error) {
                pty.dispose();
                if (!selected.info) {
                    this.closing.set(key, { endpoint, sessionId, id: info.id });
                    void this.flushCloses();
                }
                throw error;
            }
        } catch (error) {
            if (error instanceof RemoteHttpError && error.status === 404) {
                throw new Error(t("This Runtime does not expose interactive terminals. Use a compatible Web profile."));
            }
            throw error;
        } finally { this.opening = false; }
    }

    private key(endpoint: string, sessionId: string, id: string): string { return JSON.stringify([endpoint, sessionId, id]); }

    private async flushCloses(): Promise<void> {
        if (this.flushing || this.disposed) return;
        this.flushing = true;
        try {
            for (const [key, target] of this.closing) {
                if (this.disposed || this.runtime.getUrl() !== target.endpoint || this.runtime.getStatus().state !== "running") continue;
                try {
                    await this.runtime.terminals.close(target.sessionId, target.id);
                    this.closing.delete(key);
                } catch (error) {
                    this.output.appendLine(`[dsh:terminal] close failed: ${errorMessage(error)}`);
                    void vscode.window.showWarningMessage(t("The Runtime could not finish terminal cleanup: {message}. Open Runtime terminals to retry.", {
                        message: errorMessage(error),
                    }));
                }
            }
        } finally { this.flushing = false; }
    }

    public dispose(): void {
        this.disposed = true;
        this.reconnect.dispose();
        for (const { pty, terminal } of this.terminals.values()) {
            pty.dispose();
            terminal.dispose();
        }
        this.terminals.clear();
        this.closing.clear();
    }
}
