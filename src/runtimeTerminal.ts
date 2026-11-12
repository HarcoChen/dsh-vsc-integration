import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { DshRuntime } from "./dshRuntime";
import type { RuntimeTerminalAttachment, RuntimeTerminalEnvironment, RuntimeTerminalInfo } from "./runtimeTerminalClient";
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
    private attachment?: RuntimeTerminalAttachment;
    private writable = false;
    private disposed = false;
    private opened = false;
    private dimensions?: vscode.TerminalDimensions;
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
            const attachment = this.runtime.terminals.attach(this.sessionId, this.info.id, this.limits, controller.signal);
            this.attachment = attachment;
            for await (const frame of attachment) {
                if (!this.available() || this.controller !== controller) return;
                this.writable = attachment.writable;
                if (frame.type === "ack") continue;
                if (frame.type !== "output") {
                    if (frame.info.id !== this.info.id) throw new Error("Runtime terminal identity changed");
                    this.names.fire(`DSH · ${frame.info.title}${frame.info.control === "agent" ? ` (${t("Agent control")})` : ""}${this.writable ? "" : ` (${t("Read only")})`}`);
                }
                if (frame.type === "snapshot") {
                    this.output.fire(`\x1b[2J\x1b[H${frame.screen}`);
                    if (this.dimensions) this.setDimensions(this.dimensions);
                } else if (frame.type === "output") this.output.fire(frame.data);
            }
            if (this.controller === controller) throw new Error(t("Runtime terminal attachment ended. Reopen the terminal to reconnect."));
        })().catch(error => this.fail(controller, error));
    }

    private fail(controller: AbortController, error: unknown): void {
        if (this.controller !== controller || controller.signal.aborted || this.disposed) return;
        this.writable = false;
        controller.abort();
        this.output.fire(`\r\n${t("Runtime terminal disconnected: {message}", { message: errorMessage(error) })}\r\n`);
    }

    public handleInput(data: string): void {
        if (!data || !this.writable || !this.available()) return;
        if (!this.attachment?.write(data, this.runtime.isRuntimeAtLeast("0.2.2-rc.2"))) this.inputFull();
    }

    public setDimensions(dimensions: vscode.TerminalDimensions): void {
        this.dimensions = dimensions;
        if (!this.writable || !this.available()) return;
        if (!this.attachment?.resize(dimensions.columns, dimensions.rows)) this.inputFull();
    }

    private inputFull(): void {
        if (this.controller) this.fail(this.controller, new Error(t("Terminal input exceeds the Runtime limit. Send smaller chunks.")));
    }

    public close(): void {
        if (this.disposed) return;
        this.closeHost();
        this.dispose();
    }

    private detach(): void {
        this.writable = false;
        this.attachment = undefined;
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
            const choices = (roster: RuntimeTerminalInfo[]) => [
                { label: `$(add) ${t("New Runtime terminal")}`, info: undefined as RuntimeTerminalInfo | undefined },
                ...roster.filter(info => !this.closing.has(this.key(endpoint, sessionId, info.id))).map(info => ({
                    label: `$(terminal) ${info.title}`, description: [info.origin === "agent" ? t("Agent terminal") : t("User terminal"), info.state, info.cwd, info.sandboxMode].filter(Boolean).join(" · "), info,
                })),
            ];
            const picker = vscode.window.createQuickPick<vscode.QuickPickItem & { info?: RuntimeTerminalInfo }>();
            picker.title = t("Runtime terminals"); picker.placeholder = t("Open a retained terminal or start a new user shell"); picker.items = choices(retained);
            const rosterAbort = new AbortController();
            if (this.runtime.isRuntimeAtLeast("0.2.2-rc.2")) void (async () => {
                for await (const roster of this.runtime.terminals.watch(sessionId, rosterAbort.signal)) {
                    if (this.runtime.getUrl() !== endpoint) { picker.hide(); return; }
                    const active = picker.activeItems[0]?.info?.id;
                    picker.items = choices(roster);
                    if (active) picker.activeItems = picker.items.filter(item => item.info?.id === active);
                }
            })().catch(error => { if (!rosterAbort.signal.aborted) this.output.appendLine(`[dsh:terminal] ${errorMessage(error)}`); });
            let selected: (vscode.QuickPickItem & { info?: RuntimeTerminalInfo }) | undefined;
            try {
                selected = await new Promise(resolve => {
                    const accept = picker.onDidAccept(() => { selected = picker.selectedItems[0]; picker.hide(); });
                    const hide = picker.onDidHide(() => { accept.dispose(); hide.dispose(); resolve(selected); }); picker.show();
                });
            } finally { rosterAbort.abort(); picker.dispose(); }
            if (!selected || this.disposed || this.runtime.getUrl() !== endpoint) return;
            if (selected.info && this.runtime.supportsHostSchedules()) {
                const action = await vscode.window.showQuickPick([t("Open terminal"), t("Rename terminal")], { title: selected.info.title });
                if (!action) return;
                if (action === t("Rename terminal")) {
                    const title = await vscode.window.showInputBox({ title: t("Terminal title"), value: selected.info.title,
                        validateInput: value => !value.trim() || value.trim().length > 120 ? t("Enter a title from 1 to 120 characters.") : undefined });
                    if (!title || this.runtime.getUrl() !== endpoint) return;
                    await this.runtime.terminals.rename(sessionId, selected.info.id, title.trim());
                    selected.info = { ...selected.info, title: title.trim() };
                }
            }
            let shell: string | undefined;
            if (!selected.info && this.runtime.supportsHostSchedules()) {
                const shells = await this.runtime.terminals.shells(sessionId);
                const choice = await vscode.window.showQuickPick(shells.map(item => ({ label: item.label, id: item.id })), { title: t("Choose terminal shell") });
                if (!choice || this.runtime.getUrl() !== endpoint) return;
                shell = choice.id;
            }
            const info = selected.info ?? await this.runtime.terminals.create(sessionId, randomUUID(),
                Math.min(100, limits.maxCols), Math.min(30, limits.maxRows), shell);
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
