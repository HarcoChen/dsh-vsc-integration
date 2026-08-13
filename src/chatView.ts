import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { ContextStore } from "./contextStore";
import { DshRuntime } from "./dshRuntime";
import {
    ChatMessage,
    ChatViewState,
    DshAssistantMessage,
    DshContextItem,
    DshHistoryEntry,
    RuntimeStatus,
} from "./types";

interface WebviewMessage {
    type?: string;
    text?: string;
    id?: string;
}

interface PersistedSession {
    sessionId: string;
    cwd: string;
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function contentText(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }

    if (!Array.isArray(value)) {
        const object = record(value);
        return typeof object?.text === "string" ? object.text : "";
    }

    return value
        .map((part) => {
            const object = record(part);
            if (!object) {
                return "";
            }
            if (object.type === "text" && typeof object.text === "string") {
                return object.text;
            }
            return "";
        })
        .filter(Boolean)
        .join("");
}

function extractAssistantMessages(entries: DshHistoryEntry[]): DshAssistantMessage[] {
    const messages: DshAssistantMessage[] = [];

    for (const entry of entries) {
        const event = entry.event;
        const eventData = record(event.data);
        const message = record(eventData?.message) ?? eventData;
        const role = message?.role;
        const type = event.type ?? "";
        const isAssistant =
            type === "assistant/message" ||
            type.endsWith("/assistant/message") ||
            role === "assistant";

        if (!isAssistant || !message) {
            continue;
        }

        const text = contentText(message.content ?? eventData?.content ?? message.text);
        if (text) {
            messages.push({ text, seq: event.seq });
        }
    }

    return messages;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = "dsh.chatView";

    private view: vscode.WebviewView | undefined;
    private viewMessageDisposable: vscode.Disposable | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly messages: ChatMessage[] = [];
    private sessionId: string | undefined;
    private sessionCwd: string | undefined;
    private busy = false;
    private cancelRequested = false;

    public constructor(
        private readonly extensionContext: vscode.ExtensionContext,
        private readonly extensionUri: vscode.Uri,
        private readonly runtime: DshRuntime,
        private readonly contextStore: ContextStore,
        private readonly output: vscode.OutputChannel,
    ) {
        this.disposables.push(
            runtime.onDidChange((status) => this.postState(status)),
            contextStore.onDidChange(() => this.postState()),
        );
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };
        webviewView.webview.html = this.getHtml(webviewView.webview);
        this.viewMessageDisposable?.dispose();
        this.viewMessageDisposable = webviewView.webview.onDidReceiveMessage((message: WebviewMessage) =>
            this.handleMessage(message),
        );
        this.disposables.push(
            webviewView.onDidDispose(() => {
                if (this.view === webviewView) {
                    this.view = undefined;
                }
            }),
        );
        this.postState();
    }

    public async addActiveEditorToContext(): Promise<void> {
        await this.runContextAction(async () => {
            const item = await this.contextStore.addActiveEditor();
            if (!item) {
                throw new Error("没有可添加的编辑器内容。");
            }
            return item;
        });
    }

    public async addSelectionToContext(): Promise<void> {
        await this.runContextAction(() => this.contextStore.addSelection());
    }

    public async addFileToContext(uri?: vscode.Uri): Promise<void> {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target) {
            throw new Error("当前没有可添加的文件。");
        }
        await this.runContextAction(() => this.contextStore.addFile(target));
    }

    public async addFolderToContext(uri?: vscode.Uri): Promise<void> {
        const target = uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!target) {
            throw new Error("当前没有可添加的文件夹。");
        }
        await this.runContextAction(async () => {
            const stat = await vscode.workspace.fs.stat(target);
            if ((stat.type & vscode.FileType.Directory) === 0) {
                throw new Error("选择的资源不是文件夹，请使用“Add File to Context”。");
            }
            return this.contextStore.addFolder(target);
        });
    }

    public async addDiagnosticsToContext(): Promise<void> {
        await this.runContextAction(() => this.contextStore.addDiagnostics());
    }

    public async addGitDiffToContext(): Promise<void> {
        await this.runContextAction(() => this.contextStore.addGitDiff());
    }

    public clearContext(): void {
        this.contextStore.clear();
        this.reveal();
    }

    public async showContext(): Promise<void> {
        const content = this.contextStore.buildPromptContext() || "No IDE context is attached.";
        const document = await vscode.workspace.openTextDocument({
            language: "markdown",
            content,
        });
        await vscode.window.showTextDocument(document, { preview: true });
    }

    public async copyContext(): Promise<void> {
        const content = this.contextStore.buildPromptContext();
        await vscode.env.clipboard.writeText(content);
        void vscode.window.showInformationMessage(
            content ? "DSH prompt context 已复制。" : "当前没有 IDE context。",
        );
    }

    public reveal(): void {
        void vscode.commands.executeCommand("workbench.view.extension.dsh");
        this.view?.show?.(false);
        this.postState();
    }

    public async openBrowser(): Promise<void> {
        const url = this.runtime.getUrl() ?? (await this.runtime.start(this.workspaceRoot()));
        await vscode.env.openExternal(vscode.Uri.parse(url));
    }

    public dispose(): void {
        this.viewMessageDisposable?.dispose();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    private async handleMessage(message: WebviewMessage): Promise<void> {
        try {
            switch (message.type) {
                case "ready":
                    this.postState();
                    break;
                case "sendPrompt":
                    await this.sendPrompt(message.text ?? "");
                    break;
                case "cancel":
                    await this.cancel();
                    break;
                case "addActiveEditor":
                    await this.addActiveEditorToContext();
                    break;
                case "addSelection":
                    await this.addSelectionToContext();
                    break;
                case "addDiagnostics":
                    await this.addDiagnosticsToContext();
                    break;
                case "addGitDiff":
                    await this.addGitDiffToContext();
                    break;
                case "removeContext":
                    if (message.id) {
                        this.contextStore.remove(message.id);
                    }
                    break;
                case "clearContext":
                    this.clearContext();
                    break;
                case "start":
                    await this.runtime.start(this.workspaceRoot());
                    break;
                case "stop":
                    await this.runtime.stop();
                    break;
                case "openLogs":
                    this.output.show(true);
                    break;
                case "openBrowser":
                    if (this.runtime.getUrl()) {
                        await vscode.env.openExternal(vscode.Uri.parse(this.runtime.getUrl() as string));
                    }
                    break;
                default:
                    break;
            }
        } catch (error) {
            this.reportError(error);
        }
    }

    private async sendPrompt(rawText: string): Promise<void> {
        const text = rawText.trim();
        if (!text || this.busy) {
            return;
        }

        const workspaceRoot = this.workspaceRoot();
        if (!workspaceRoot) {
            this.reportError(new Error("请先打开一个工作区，再向 dsh 发送任务。"));
            return;
        }

        this.busy = true;
        this.cancelRequested = false;
        const userMessage: ChatMessage = {
            id: randomUUID(),
            role: "user",
            text,
            createdAt: Date.now(),
        };
        this.messages.push(userMessage);
        this.postState();

        try {
            const autoStart = vscode.workspace.getConfiguration("dsh").get<boolean>("autoStart", true);
            if (autoStart || this.runtime.getUrl()) {
                await this.runtime.start(workspaceRoot);
            } else {
                throw new Error("dsh web 尚未启动。请开启 dsh.autoStart 或执行“DSH: Start Web Runtime”。");
            }

            const session = await this.getOrCreateSession(workspaceRoot);
            const prompt = this.withIdeContext(text);
            const before = await this.runtime.history(session, 100);
            await this.runtime.prompt(session, prompt);
            const reply = await this.waitForReply(session, before);
            this.messages.push({
                id: randomUUID(),
                role: "assistant",
                text: reply,
                createdAt: Date.now(),
            });
        } catch (error) {
            if (!this.cancelRequested) {
                this.messages.push({
                    id: randomUUID(),
                    role: "system",
                    text: `请求失败：${errorMessage(error)}`,
                    createdAt: Date.now(),
                });
                this.reportError(error);
            }
        } finally {
            this.busy = false;
            this.cancelRequested = false;
            this.postState();
        }
    }

    private async cancel(): Promise<void> {
        if (!this.busy || !this.sessionId) {
            return;
        }

        this.cancelRequested = true;
        try {
            await this.runtime.cancel(this.sessionId);
        } catch (error) {
            this.output.appendLine(`[dsh] cancel failed: ${errorMessage(error)}`);
        }
        this.postState();
    }

    private async getOrCreateSession(workspaceRoot: string): Promise<string> {
        const configuration = vscode.workspace.getConfiguration("dsh");
        const persist = configuration.get<boolean>("persistSession", true);
        const persisted = this.extensionContext.workspaceState.get<PersistedSession>("session");

        if (!this.sessionId && persist && persisted?.cwd === workspaceRoot) {
            try {
                await this.runtime.history(persisted.sessionId, 1);
                this.sessionId = persisted.sessionId;
                this.sessionCwd = workspaceRoot;
            } catch {
                await this.extensionContext.workspaceState.update("session", undefined);
            }
        }

        if (!this.sessionId || this.sessionCwd !== workspaceRoot) {
            const created = await this.runtime.createSession(workspaceRoot);
            this.sessionId = created.sessionId;
            this.sessionCwd = workspaceRoot;
            if (persist) {
                await this.extensionContext.workspaceState.update("session", {
                    sessionId: created.sessionId,
                    cwd: workspaceRoot,
                } satisfies PersistedSession);
            }
        }

        return this.sessionId;
    }

    private async waitForReply(sessionId: string, before: { events: DshHistoryEntry[] }): Promise<string> {
        const beforeMessages = extractAssistantMessages(before.events);
        const beforeCount = beforeMessages.length;
        const beforeLast = beforeMessages.at(-1);
        const pollInterval = vscode.workspace.getConfiguration("dsh").get<number>("pollIntervalMs", 500);
        const timeoutMs = vscode.workspace.getConfiguration("dsh").get<number>("requestTimeoutMs", 600_000);
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            if (this.cancelRequested) {
                throw new Error("任务已取消。");
            }

            const history = await this.runtime.history(sessionId, 100);
            const currentMessages = extractAssistantMessages(history.events);
            const latest = currentMessages.at(-1);
            const hasNewMessage = currentMessages.length > beforeCount;
            const hasChangedMessage = Boolean(
                latest &&
                    beforeLast &&
                    (latest.seq !== undefined
                        ? latest.seq !== beforeLast.seq
                        : latest.text !== beforeLast.text),
            );

            if (latest && (hasNewMessage || hasChangedMessage)) {
                return latest.text;
            }

            await delay(pollInterval);
        }

        throw new Error("等待 dsh agent 回复超时。");
    }

    private withIdeContext(text: string): string {
        const context = this.contextStore.buildPromptContext();
        return context ? `${text}\n\n${context}` : text;
    }

    private async runContextAction(action: () => Promise<DshContextItem>): Promise<void> {
        try {
            await action();
            this.reveal();
        } catch (error) {
            this.reportError(error);
        }
    }

    private reportError(error: unknown): void {
        const message = errorMessage(error);
        this.output.appendLine(`[dsh] ${message}`);
        void vscode.window.showErrorMessage(`DSH: ${message}`);
        this.postState();
    }

    private workspaceRoot(): string | undefined {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    private postState(status?: RuntimeStatus): void {
        if (!this.view) {
            return;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const state: ChatViewState = {
            messages: [...this.messages],
            context: this.contextStore.snapshot(),
            status: status ?? this.runtime.getStatus(),
            busy: this.busy,
            workspaceName: workspaceFolder?.name,
        };
        void this.view.webview.postMessage({ type: "state", state });
    }

    private getHtml(webview: vscode.Webview): string {
        const nonce = randomUUID().replace(/-/g, "");
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <style>
        :root { color-scheme: light dark; }
        * { box-sizing: border-box; }
        body { padding: 0; margin: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
        button { border: 0; border-radius: 4px; padding: 5px 8px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        button.secondary { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
        button:disabled { opacity: .55; cursor: default; }
        .shell { display: flex; flex-direction: column; min-height: 100vh; }
        .header { display: flex; align-items: center; gap: 7px; padding: 9px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
        .brand { font-weight: 700; flex: 1; }
        .status { display: inline-flex; align-items: center; gap: 5px; color: var(--vscode-descriptionForeground); font-size: 11px; }
        .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
        .dot.running { background: #4ec994; }
        .dot.starting { background: #e5b567; }
        .dot.error { background: #f14c4c; }
        .messages { flex: 1; overflow: auto; padding: 12px 10px 8px; }
        .empty { color: var(--vscode-descriptionForeground); text-align: center; padding: 30px 12px; line-height: 1.6; }
        .message { margin: 0 0 12px; }
        .message-label { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 3px; }
        .message-body { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.45; }
        .message.user .message-body { padding: 8px 9px; border-radius: 6px; background: var(--vscode-textBlockQuote-background); border: 1px solid var(--vscode-textBlockQuote-border); }
        .message.system .message-body { color: var(--vscode-errorForeground); }
        .context { padding: 8px 10px; border-top: 1px solid var(--vscode-panel-border); }
        .section-title { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; color: var(--vscode-descriptionForeground); font-size: 11px; }
        .section-title span { flex: 1; }
        .context-items { display: flex; flex-wrap: wrap; gap: 5px; }
        .chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 3px 6px; border: 1px solid var(--vscode-input-border); border-radius: 10px; background: var(--vscode-input-background); font-size: 11px; }
        .chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .chip-remove { padding: 0 2px; color: var(--vscode-descriptionForeground); background: transparent; }
        .quick-actions { display: flex; flex-wrap: wrap; gap: 5px; padding: 8px 10px 5px; }
        .quick-actions button { font-size: 11px; }
        .composer { display: flex; gap: 6px; align-items: flex-end; padding: 5px 10px 10px; }
        textarea { flex: 1; min-height: 68px; max-height: 180px; resize: vertical; padding: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 4px; font: inherit; }
        textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
        .send { min-width: 54px; min-height: 34px; }
        .hint { padding: 0 10px 8px; color: var(--vscode-descriptionForeground); font-size: 10px; }
        .runtime-actions { display: flex; gap: 4px; }
        .runtime-actions button { padding: 3px 6px; font-size: 10px; }
        .hidden { display: none; }
    </style>
</head>
<body>
    <div class="shell">
        <div class="header">
            <div class="brand">DeepSeek Harness</div>
            <div class="status"><span id="statusDot" class="dot"></span><span id="statusText">未启动</span></div>
            <div class="runtime-actions">
                <button id="runtimeButton" class="secondary" title="启动或停止 dsh web">启动</button>
                <button id="logsButton" class="secondary" title="打开运行日志">日志</button>
            </div>
        </div>
        <div id="messages" class="messages"></div>
        <div class="context">
            <div class="section-title"><span>IDE context</span><button id="clearContext" class="secondary">清空</button></div>
            <div id="contextItems" class="context-items"></div>
        </div>
        <div class="quick-actions">
            <button id="addEditor" class="secondary">当前文件</button>
            <button id="addSelection" class="secondary">选区</button>
            <button id="addDiagnostics" class="secondary">诊断</button>
            <button id="addDiff" class="secondary">Git diff</button>
        </div>
        <div class="composer">
            <textarea id="prompt" placeholder="让 dsh 处理当前工作区…"></textarea>
            <button id="send" class="send">发送</button>
            <button id="cancel" class="send secondary hidden">停止</button>
        </div>
        <div class="hint">Ctrl/Cmd + Enter 发送 · 内容会在发送前附加到当前会话</div>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let state = { messages: [], context: [], status: { state: 'stopped' }, busy: false };

        function escapeHtml(value) {
            return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
        }

        function statusLabel(status) {
            if (status.state === 'running') return '运行中';
            if (status.state === 'starting') return '启动中';
            if (status.state === 'error') return '错误';
            return '未启动';
        }

        function render() {
            const status = state.status || { state: 'stopped' };
            const dot = document.getElementById('statusDot');
            dot.className = 'dot ' + status.state;
            document.getElementById('statusText').textContent = statusLabel(status);
            const runtimeButton = document.getElementById('runtimeButton');
            runtimeButton.textContent = status.state === 'running' || status.state === 'starting' ? '停止' : '启动';
            runtimeButton.disabled = status.state === 'starting';

            const messages = document.getElementById('messages');
            if (!state.messages || state.messages.length === 0) {
                messages.innerHTML = '<div class="empty">先把代码、选区或 Git diff 加入 context，<br>然后直接描述你想让 dsh 完成的任务。</div>';
            } else {
                messages.innerHTML = state.messages.map((message) => {
                    const label = message.role === 'user' ? '你' : (message.role === 'assistant' ? 'dsh' : '系统');
                    return '<div class="message ' + message.role + '"><div class="message-label">' + label + '</div><div class="message-body">' + escapeHtml(message.text) + '</div></div>';
                }).join('');
                messages.scrollTop = messages.scrollHeight;
            }

            const contextItems = document.getElementById('contextItems');
            contextItems.innerHTML = (state.context || []).map((item) => {
                const preview = item.kind === 'folder' ? '📁 ' : '';
                return '<div class="chip" title="' + escapeHtml(item.content || item.label) + '"><span class="chip-label">' + preview + escapeHtml(item.label) + '</span><button class="chip-remove" data-id="' + escapeHtml(item.id) + '">×</button></div>';
            }).join('') || '<span class="hint">未附加内容</span>';

            document.getElementById('send').classList.toggle('hidden', Boolean(state.busy));
            document.getElementById('cancel').classList.toggle('hidden', !state.busy);
            document.getElementById('send').disabled = Boolean(state.busy);
            document.getElementById('prompt').disabled = Boolean(state.busy);
        }

        function post(type, payload = {}) {
            vscode.postMessage(Object.assign({ type }, payload));
        }

        document.getElementById('send').addEventListener('click', () => {
            const prompt = document.getElementById('prompt');
            if (prompt.value.trim()) {
                post('sendPrompt', { text: prompt.value });
                prompt.value = '';
            }
        });
        document.getElementById('cancel').addEventListener('click', () => post('cancel'));
        document.getElementById('runtimeButton').addEventListener('click', () => post(state.status.state === 'running' ? 'stop' : 'start'));
        document.getElementById('logsButton').addEventListener('click', () => post('openLogs'));
        document.getElementById('clearContext').addEventListener('click', () => post('clearContext'));
        document.getElementById('addEditor').addEventListener('click', () => post('addActiveEditor'));
        document.getElementById('addSelection').addEventListener('click', () => post('addSelection'));
        document.getElementById('addDiagnostics').addEventListener('click', () => post('addDiagnostics'));
        document.getElementById('addDiff').addEventListener('click', () => post('addGitDiff'));
        document.getElementById('contextItems').addEventListener('click', (event) => {
            const target = event.target.closest('.chip-remove');
            if (target) post('removeContext', { id: target.dataset.id });
        });
        document.getElementById('prompt').addEventListener('keydown', (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                document.getElementById('send').click();
            }
        });
        window.addEventListener('message', (event) => {
            if (event.data && event.data.type === 'state') {
                state = event.data.state;
                render();
            }
        });
        render();
        post('ready');
    </script>
</body>
</html>`;
    }
}
