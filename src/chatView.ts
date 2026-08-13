import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { DeepSeekBalanceService } from "./balanceService";
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

function referencesSelection(text: string): boolean {
    return /(^|\s)@selection(?=$|\s|[,.;:!?])/u.test(text);
}

function maxEventSeq(entries: DshHistoryEntry[]): number {
    return entries.reduce(
        (maximum, entry) =>
            typeof entry.event.seq === "number" ? Math.max(maximum, entry.event.seq) : maximum,
        -1,
    );
}

function terminalTurnFailure(
    entries: DshHistoryEntry[],
    afterSeq: number,
): Error | undefined {
    for (const entry of entries) {
        const event = entry.event;
        if (event.type !== "turn/end" || typeof event.seq !== "number" || event.seq <= afterSeq) {
            continue;
        }

        const data = record(event.data);
        const reason = record(data?.reason);
        if (!reason || (reason.kind !== "error" && reason.kind !== "blocked")) {
            continue;
        }

        const failure = record(reason.error) ?? reason;
        const code = typeof failure?.code === "string" ? failure.code : undefined;
        const message =
            typeof failure?.message === "string"
                ? failure.message
                : "dsh agent 在生成回复前结束了本轮任务。";
        return new Error(code ? `[${code}] ${message}` : message);
    }
    return undefined;
}

function isCredentialIssue(error: unknown): boolean {
    const message = errorMessage(error).toLowerCase();
    return /missing[_ -]?credential|api[ _-]?key|\bauth\b|authentication|unauthori[sz]ed|\b401\b|credential.*(unset|missing|not configured)/u.test(
        message,
    );
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
    private selectionEnabled = true;
    private pendingInsertText: string | undefined;

    public constructor(
        private readonly extensionContext: vscode.ExtensionContext,
        private readonly extensionUri: vscode.Uri,
        private readonly runtime: DshRuntime,
        private readonly contextStore: ContextStore,
        private readonly output: vscode.OutputChannel,
        private readonly balanceService?: DeepSeekBalanceService,
    ) {
        this.disposables.push(
            runtime.onDidChange((status) => this.postState(status)),
            contextStore.onDidChange(() => this.postState()),
            vscode.window.onDidChangeActiveTextEditor(() => this.postState()),
            vscode.window.onDidChangeTextEditorSelection(() => this.postState()),
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

    public insertEditorReference(): void {
        const reference = this.contextStore.getActiveEditorReference();
        if (!reference) {
            this.reportError(new Error("当前没有可引用的编辑器。"));
            return;
        }

        this.insertComposerText(reference);
    }

    public async configureApiKey(): Promise<void> {
        const configuration = vscode.workspace.getConfiguration("dsh");
        const ref = configuration.get<string>("apiKeyEnv", "DEEPSEEK_API_KEY").trim();
        if (!ref) {
            throw new Error("dsh.apiKeyEnv 不能为空，请先配置凭据引用名。");
        }

        const key = await vscode.window.showInputBox({
            title: `配置 ${ref}`,
            prompt: "API Key 会交给 dsh runtime，并以 VS Code SecretStorage 加密保存一份供余额查询；不会写入扩展状态或日志。",
            password: true,
            ignoreFocusOut: true,
            validateInput: (value) => (value.trim() ? undefined : "请输入 API Key。"),
        });
        if (key === undefined) {
            return;
        }

        await this.runtime.start(this.workspaceRoot());
        await this.runtime.setCredential(ref, key.trim());
        try {
            await this.balanceService?.storeApiKey(key.trim());
        } catch (error) {
            const message = errorMessage(error);
            void vscode.window.showWarningMessage(`DSH：聊天 Key 已保存，但余额缓存失败：${message}`);
        }
        void vscode.window.showInformationMessage(`DSH：${ref} 已保存，可重新发送任务。`);
        this.reveal();
    }

    public async openIdeContextPicker(): Promise<void> {
        const hasSelection = Boolean(this.contextStore.getCurrentSelectionMetadata());
        const choice = await vscode.window.showQuickPick(
            [
                ...(hasSelection
                    ? [{ label: "$(selection) Selection", detail: "启用当前选区，发送时重新读取" }]
                    : []),
                { label: "$(file-code) Current file", detail: "插入 @文件引用，不复制正文" },
                { label: "$(warning) Diagnostics", detail: "作为本轮一次性附件" },
                { label: "$(git-compare) Git diff", detail: "作为本轮一次性附件" },
                {
                    label: this.selectionEnabled
                        ? "$(eye-closed) Disable selection"
                        : "$(eye) Enable selection",
                    detail: this.selectionEnabled ? "不自动附加当前选区" : "自动附加当前选区",
                },
            ],
            { placeHolder: "选择本轮 IDE context 或调整选区策略" },
        );
        if (!choice) {
            return;
        }

        if (choice.label.includes("Selection")) {
            this.selectionEnabled = true;
        } else if (choice.label.includes("Current file")) {
            this.insertEditorReference();
            return;
        } else if (choice.label.includes("Diagnostics")) {
            await this.runContextAction(() => this.contextStore.addDiagnostics());
            return;
        } else if (choice.label.includes("Git diff")) {
            await this.runContextAction(() => this.contextStore.addGitDiff());
            return;
        } else {
            this.selectionEnabled = !this.selectionEnabled;
        }
        this.reveal();
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
                    this.flushPendingInsert();
                    break;
                case "sendPrompt":
                    await this.sendPrompt(message.text ?? "");
                    break;
                case "cancel":
                    await this.cancel();
                    break;
                case "configureApiKey":
                    await this.configureApiKey();
                    break;
                case "openIdeContextPicker":
                    await this.openIdeContextPicker();
                    break;
                case "removeContext":
                    if (message.id) {
                        this.contextStore.remove(message.id);
                    }
                    break;
                case "toggleSelection":
                    this.selectionEnabled = !this.selectionEnabled;
                    this.postState();
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
        this.postState();

        try {
            const autoStart = vscode.workspace.getConfiguration("dsh").get<boolean>("autoStart", true);
            if (autoStart || this.runtime.getUrl()) {
                await this.runtime.start(workspaceRoot);
            } else {
                throw new Error("dsh web 尚未启动。请开启 dsh.autoStart 或执行“DSH: Start Web Runtime”。");
            }

            const session = await this.getOrCreateSession(workspaceRoot);
            if (/^\/ide(?:$|[\t\n\r ])/u.test(text)) {
                await this.openIdeContextPicker();
                return;
            }

            this.messages.push({
                id: randomUUID(),
                role: "user",
                text,
                createdAt: Date.now(),
            });
            const explicitlyReferencesSelection = referencesSelection(text);
            const capture = this.contextStore.capturePromptContext({
                includeCurrentSelection:
                    this.selectionEnabled || explicitlyReferencesSelection,
            });
            if (explicitlyReferencesSelection && !capture.items.some((item) => item.kind === "selection")) {
                throw new Error("@selection 没有可用的当前选区。请先在活动编辑器中选择文本。");
            }
            const prompt = capture.text ? `${text}\n\n${capture.text}` : text;
            const before = await this.runtime.history(session, 100);
            const promptResult = await this.runtime.prompt(session, prompt);
            if (promptResult.accepted === false) {
                throw new Error("dsh runtime 拒绝了本次 prompt。请检查当前模型和 API Key 配置。");
            }
            this.contextStore.consumeCapturedOneShots(capture.capturedOneShotIds);
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
        const beforeSeq = maxEventSeq(before.events);
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
            const failure = terminalTurnFailure(history.events, beforeSeq);
            if (failure) {
                throw failure;
            }
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

    private async runContextAction(
        action: () => DshContextItem | Promise<DshContextItem>,
    ): Promise<void> {
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
        if (isCredentialIssue(error)) {
            void vscode.window
                .showErrorMessage(`DSH: ${message}`, "配置 API Key", "打开 dsh Web UI")
                .then((action) => {
                    if (action === "配置 API Key") {
                        void this.configureApiKey().catch((configureError) =>
                            this.reportError(configureError),
                        );
                    } else if (action === "打开 dsh Web UI") {
                        void this.openBrowser().catch((openError) => this.reportError(openError));
                    }
                });
        } else {
            void vscode.window.showErrorMessage(`DSH: ${message}`);
        }
        this.postState();
    }

    private workspaceRoot(): string | undefined {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    private insertComposerText(text: string): void {
        this.pendingInsertText = text;
        this.reveal();
        this.flushPendingInsert();
    }

    private flushPendingInsert(): void {
        if (!this.view || !this.pendingInsertText) {
            return;
        }
        const text = this.pendingInsertText;
        this.pendingInsertText = undefined;
        void this.view.webview.postMessage({ type: "insertText", text });
    }

    private postState(status?: RuntimeStatus): void {
        if (!this.view) {
            return;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const state: ChatViewState = {
            messages: [...this.messages],
            context: this.contextStore.snapshot(),
            selection: this.contextStore.getCurrentSelectionMetadata(),
            selectionEnabled: this.selectionEnabled,
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
        .composer-shell { padding: 7px 10px 10px; border-top: 1px solid var(--vscode-panel-border); }
        .context-items { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px; }
        .chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 3px 6px; border: 1px solid var(--vscode-input-border); border-radius: 10px; background: var(--vscode-input-background); font-size: 11px; }
        .chip.selection-disabled { opacity: .58; }
        .chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .chip-remove { padding: 0 2px; color: var(--vscode-descriptionForeground); background: transparent; }
        .composer { display: flex; gap: 6px; align-items: flex-end; }
        .add-context { min-width: 30px; min-height: 34px; padding: 5px; font-size: 17px; }
        textarea { flex: 1; min-height: 68px; max-height: 180px; resize: vertical; padding: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 4px; font: inherit; }
        textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
        .send { min-width: 54px; min-height: 34px; }
        .hint { padding-top: 6px; color: var(--vscode-descriptionForeground); font-size: 10px; }
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
                <button id="keyButton" class="secondary" title="配置 dsh API Key">Key</button>
                <button id="logsButton" class="secondary" title="打开运行日志">日志</button>
            </div>
        </div>
        <div id="messages" class="messages"></div>
        <div class="composer-shell">
            <div id="contextItems" class="context-items"></div>
            <div class="composer">
                <button id="addContext" class="add-context secondary" title="添加一次性 IDE context（/ide）">+</button>
                <textarea id="prompt" placeholder="描述任务，使用 @ 引用文件或选区…"></textarea>
                <button id="send" class="send">发送</button>
                <button id="cancel" class="send secondary hidden">停止</button>
            </div>
            <div class="hint">Ctrl/Cmd + Enter 发送 · 当前选区会在发送时重新读取</div>
        </div>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        let state = { messages: [], context: [], selectionEnabled: true, status: { state: 'stopped' }, busy: false };

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
                messages.innerHTML = '<div class="empty">直接描述任务。<br>当前选区会自动附加，也可以用 @ 引用文件。</div>';
            } else {
                messages.innerHTML = state.messages.map((message) => {
                    const label = message.role === 'user' ? '你' : (message.role === 'assistant' ? 'dsh' : '系统');
                    return '<div class="message ' + message.role + '"><div class="message-label">' + label + '</div><div class="message-body">' + escapeHtml(message.text) + '</div></div>';
                }).join('');
                messages.scrollTop = messages.scrollHeight;
            }

            const contextItems = document.getElementById('contextItems');
            const chips = [];
            if (state.selection) {
                const range = state.selection.range || {};
                const lineCount = Math.max(1, (range.endLine || 1) - (range.startLine || 1) + 1);
                const selectionClass = state.selectionEnabled ? '' : ' selection-disabled';
                const eye = state.selectionEnabled ? '◉' : '○';
                chips.push('<div class="chip' + selectionClass + '" title="发送时重新读取当前选区"><span class="chip-label">Selection · ' + escapeHtml(state.selection.label) + ' · ' + lineCount + ' lines</span><button class="chip-remove selection-toggle" title="启用或关闭自动选区">' + eye + '</button></div>');
            }
            for (const item of (state.context || [])) {
                chips.push('<div class="chip" title="本轮一次性附件"><span class="chip-label">' + escapeHtml(item.label) + '</span><button class="chip-remove" data-id="' + escapeHtml(item.id) + '">×</button></div>');
            }
            contextItems.innerHTML = chips.join('');

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
        document.getElementById('keyButton').addEventListener('click', () => post('configureApiKey'));
        document.getElementById('logsButton').addEventListener('click', () => post('openLogs'));
        document.getElementById('addContext').addEventListener('click', () => post('openIdeContextPicker'));
        document.getElementById('contextItems').addEventListener('click', (event) => {
            if (event.target.closest('.selection-toggle')) {
                post('toggleSelection');
                return;
            }
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
            } else if (event.data && event.data.type === 'insertText') {
                const prompt = document.getElementById('prompt');
                const insertion = event.data.text || '';
                const start = prompt.selectionStart;
                const end = prompt.selectionEnd;
                const before = prompt.value.slice(0, start);
                const separator = before && !/\s$/.test(before) ? ' ' : '';
                prompt.value = before + separator + insertion + prompt.value.slice(end);
                const cursor = start + separator.length + insertion.length;
                prompt.setSelectionRange(cursor, cursor);
                prompt.focus();
            }
        });
        render();
        post('ready');
    </script>
</body>
</html>`;
    }
}
