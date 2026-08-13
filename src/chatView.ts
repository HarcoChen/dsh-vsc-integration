import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { DeepSeekBalanceService } from "./balanceService";
import {
    highestKnownSeq,
    OptimisticPrompt,
    promptDisplayText,
    projectChatMessages,
    queueDockItems,
} from "./chatState";
import {
    ChatViewAction,
    parseChatViewAction,
    validateQuestionAnswers,
} from "./chatViewProtocol";
import { ContextStore } from "./contextStore";
import { DshRuntime } from "./dshRuntime";
import {
    GoalMutationGate,
    normalizeGoalRef,
    normalizeSubagentCatalog,
    parseGoalProjection,
    presentGoalHud,
    presentJobCenter,
    projectSubagentHistory,
    SubagentTreeStore,
} from "./sessionFeatures";
import {
    ChatViewState,
    DshApprovalResponse,
    DshContextItem,
    DshHistoryEntry,
    DshQuestionResponse,
    DshSubagentAddress,
    DshSubagentCatalog,
    SubagentHistoryPreview,
    SubagentTreeNodeView,
} from "./types";

interface PersistedSession {
    sessionId: string;
    cwd: string;
}


function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function referencesSelection(text: string): boolean {
    return /(^|\s)@selection(?=$|\s|[,.;:!?])/u.test(text);
}

function lowestEventSeq(entries: readonly DshHistoryEntry[]): number | undefined {
    let lowest: number | undefined;
    for (const entry of entries) {
        const seq = entry.event.seq;
        if (typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0) {
            lowest = lowest === undefined ? seq : Math.min(lowest, seq);
        }
    }
    return lowest;
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
    private readonly optimisticPrompts: OptimisticPrompt[] = [];
    private readonly goalMutations = new GoalMutationGate();
    private readonly subagentTrees = new SubagentTreeStore();
    private readonly subagentTreeAborts = new Map<string, AbortController>();
    private subagentPreview: SubagentHistoryPreview | undefined;
    private subagentPreviewAbort: AbortController | undefined;
    private subagentPreviewGeneration = 0;
    private sessionId: string | undefined;
    private sessionCwd: string | undefined;
    private submitting = false;
    private cancelRequested = false;
    private selectionEnabled = true;
    private pendingInsertText: string | undefined;
    private stateUpdateTimer: ReturnType<typeof setTimeout> | undefined;
    private subagentRefreshTimer: ReturnType<typeof setTimeout> | undefined;

    public constructor(
        private readonly extensionContext: vscode.ExtensionContext,
        private readonly extensionUri: vscode.Uri,
        private readonly runtime: DshRuntime,
        private readonly contextStore: ContextStore,
        private readonly output: vscode.OutputChannel,
        private readonly balanceService?: DeepSeekBalanceService,
    ) {
        const unsubscribeSession = runtime.getSessionStore().onDidChange((sessionId, snapshot) => {
            if (sessionId === this.sessionId) {
                this.goalMutations.observe(
                    sessionId,
                    snapshot.projections.find((cell) => cell.key === "goal"),
                );
                this.schedulePostState();
            }
        });
        const unsubscribeCatalog = runtime.getSessionCatalog().onDidChange(() => {
            this.schedulePostState();
            this.scheduleSubagentRefresh();
        });
        this.disposables.push(
            runtime.onDidChange(() => this.schedulePostState()),
            runtime.onDidHarnessConnect(() => {
                if (this.sessionId) void this.refreshSubagentTree(this.sessionId);
            }),
            contextStore.onDidChange(() => this.schedulePostState()),
            vscode.window.onDidChangeActiveTextEditor(() => this.schedulePostState()),
            vscode.window.onDidChangeTextEditorSelection(() => this.schedulePostState()),
            new vscode.Disposable(unsubscribeSession),
            new vscode.Disposable(unsubscribeCatalog),
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
        this.viewMessageDisposable = webviewView.webview.onDidReceiveMessage((message: unknown) =>
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

    public getCurrentSessionId(): string | undefined {
        return this.sessionId;
    }

    public async openBrowser(): Promise<void> {
        const url = this.runtime.getUrl() ?? (await this.runtime.start(this.workspaceRoot()));
        await vscode.env.openExternal(vscode.Uri.parse(url));
    }

    public dispose(): void {
        this.viewMessageDisposable?.dispose();
        if (this.stateUpdateTimer) clearTimeout(this.stateUpdateTimer);
        if (this.subagentRefreshTimer) clearTimeout(this.subagentRefreshTimer);
        for (const controller of this.subagentTreeAborts.values()) controller.abort();
        this.subagentPreviewAbort?.abort();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    private async handleMessage(value: unknown): Promise<void> {
        const message = parseChatViewAction(value);
        if (!message) {
            this.output.appendLine("[dsh:webview] ignored malformed message");
            return;
        }
        try {
            switch (message.type) {
                case "ready":
                    this.postState();
                    this.flushPendingInsert();
                    if (this.sessionId) void this.refreshSubagentTree(this.sessionId);
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
                    this.contextStore.remove(message.id);
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
                case "openTrace":
                    if (this.sessionId) {
                        await vscode.commands.executeCommand("dsh.openTrace", {
                            sessionId: this.sessionId,
                            ...(message.seq === undefined ? {} : { seq: message.seq }),
                        });
                    }
                    break;
                case "switchSession":
                    await this.switchSession(message.sessionId);
                    break;
                case "newSession":
                    await this.newSession();
                    break;
                case "searchSession":
                    await this.searchSession();
                    break;
                case "renameSession":
                    await this.renameSession();
                    break;
                case "forkSession":
                    await this.forkSession();
                    break;
                case "archiveSession":
                    await this.archiveSession();
                    break;
                case "goalCreate":
                case "goalEdit":
                case "goalPause":
                case "goalResume":
                case "goalComplete":
                case "goalClear":
                    await this.mutateGoal(message);
                    break;
                case "refreshSubagents":
                    if (this.sessionId) await this.refreshSubagentTree(this.sessionId);
                    break;
                case "openSubagent":
                    await this.openSubagentHistory(message.childSessionId);
                    break;
                case "closeSubagent":
                    this.closeSubagentHistory();
                    break;
                case "followUpSubagent":
                    await this.followUpSubagent(message.childSessionId, message.text);
                    break;
                case "interruptSubagent":
                    await this.interruptSubagent(message.childSessionId);
                    break;
                case "answerApproval":
                    await this.answerApproval(message);
                    break;
                case "answerQuestion":
                    await this.answerQuestion(message);
                    break;
                case "updateQueue":
                    await this.updateQueue(message);
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
        if (!text || this.submitting) {
            return;
        }

        const workspaceRoot = this.workspaceRoot();
        if (!workspaceRoot) {
            this.reportError(new Error("请先打开一个工作区，再向 dsh 发送任务。"));
            return;
        }

        this.submitting = true;
        this.cancelRequested = false;
        this.postState();

        let optimistic: OptimisticPrompt | undefined;
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

            const explicitlyReferencesSelection = referencesSelection(text);
            const capture = this.contextStore.capturePromptContext({
                includeCurrentSelection:
                    this.selectionEnabled || explicitlyReferencesSelection,
            });
            if (explicitlyReferencesSelection && !capture.items.some((item) => item.kind === "selection")) {
                throw new Error("@selection 没有可用的当前选区。请先在活动编辑器中选择文本。");
            }
            const prompt = capture.text ? `${text}\n\n${capture.text}` : text;
            optimistic = {
                id: `optimistic:${randomUUID()}`,
                sessionId: session,
                displayText: text,
                wireText: prompt,
                afterSeq: highestKnownSeq(this.runtime.getSessionStore().get(session)),
                createdAt: Date.now(),
            };
            this.optimisticPrompts.push(optimistic);
            this.postState();
            const promptResult = await this.runtime.prompt(session, prompt);
            if (promptResult.accepted === false) {
                throw new Error("dsh runtime 拒绝了本次 prompt。请检查当前模型和 API Key 配置。");
            }
            this.contextStore.consumeCapturedOneShots(capture.capturedOneShotIds);
        } catch (error) {
            if (optimistic) {
                optimistic.error = errorMessage(error);
            }
            if (!this.cancelRequested) {
                this.reportError(error);
            }
        } finally {
            this.submitting = false;
            this.cancelRequested = false;
            this.postState();
        }
    }

    private async cancel(): Promise<void> {
        if (!this.sessionId || !this.selectedSessionRunning()) {
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
                void this.runtime.syncSession(persisted.sessionId);
                void this.refreshSubagentTree(persisted.sessionId);
            } catch {
                await this.extensionContext.workspaceState.update("session", undefined);
            }
        }

        if (!this.sessionId || this.sessionCwd !== workspaceRoot) {
            const created = await this.runtime.createSession(workspaceRoot);
            if (this.sessionId !== created.sessionId) this.discardSubagentPreview();
            this.sessionId = created.sessionId;
            this.sessionCwd = workspaceRoot;
            if (persist) {
                await this.extensionContext.workspaceState.update("session", {
                    sessionId: created.sessionId,
                    cwd: workspaceRoot,
                } satisfies PersistedSession);
            }
            void this.refreshSubagentTree(created.sessionId);
        }

        return this.sessionId;
    }

    public async newSession(): Promise<void> {
        const workspaceRoot = this.workspaceRoot();
        if (!workspaceRoot) throw new Error("请先打开一个工作区。");
        await this.runtime.start(workspaceRoot);
        const created = await this.runtime.createSession(workspaceRoot);
        await this.switchSession(created.sessionId);
        this.reveal();
    }

    public async searchSession(): Promise<void> {
        await this.runtime.start(this.workspaceRoot());
        const query = await vscode.window.showInputBox({
            title: "搜索 dsh 会话",
            prompt: "搜索会话消息内容",
            ignoreFocusOut: true,
            validateInput: (value) => (value.trim() ? undefined : "请输入搜索内容。"),
        });
        if (query === undefined) return;
        const result = await this.runtime.searchSessions(query.trim());
        const catalog = this.runtime.getSessionCatalog().snapshot();
        const choice = await vscode.window.showQuickPick(
            result.items.map((item) => {
                const session = catalog.sessions.find((candidate) => candidate.sessionId === item.sessionId);
                return {
                    label: session?.title || item.sessionId,
                    description: item.sessionId,
                    detail: item.snippet,
                    sessionId: item.sessionId,
                };
            }),
            {
                placeHolder: result.hasMore ? "选择会话（结果已截断）" : "选择会话",
                matchOnDescription: true,
                matchOnDetail: true,
            },
        );
        if (choice) await this.switchSession(choice.sessionId);
    }

    public async chooseSession(): Promise<void> {
        await this.runtime.start(this.workspaceRoot());
        const catalog = this.runtime.getSessionCatalog().snapshot();
        const archived = new Set(catalog.archivedSessionIds);
        const choice = await vscode.window.showQuickPick(
            catalog.sessions
                .filter((item) => !archived.has(item.sessionId))
                .map((item) => ({
                    label: `${item.running ? "$(sync~spin)" : "$(comment-discussion)"} ${item.title || item.sessionId}`,
                    description: item.sessionId,
                    detail: item.cwd,
                    sessionId: item.sessionId,
                })),
            { placeHolder: "选择 dsh 会话", matchOnDescription: true, matchOnDetail: true },
        );
        if (choice) await this.switchSession(choice.sessionId);
    }

    public async renameSession(): Promise<void> {
        if (!this.sessionId) throw new Error("当前没有会话。");
        const current = this.runtime
            .getSessionCatalog()
            .snapshot()
            .sessions.find((item) => item.sessionId === this.sessionId);
        const title = await vscode.window.showInputBox({
            title: "重命名 dsh 会话",
            value: current?.title ?? "",
            ignoreFocusOut: true,
            validateInput: (value) => (value.trim() ? undefined : "标题不能为空。"),
        });
        if (title === undefined) return;
        await this.runtime.renameSession(this.sessionId, title);
    }

    public async forkSession(): Promise<void> {
        if (!this.sessionId) throw new Error("当前没有会话。");
        const forked = await this.runtime.forkSession(this.sessionId);
        await this.switchSession(forked.sessionId);
    }

    public async archiveSession(): Promise<void> {
        if (!this.sessionId) throw new Error("当前没有会话。");
        const confirmation = await vscode.window.showWarningMessage(
            "将当前会话归档并从 DSH IDE 会话列表隐藏？可在官方 dsh Web UI 中管理归档会话。",
            { modal: true },
            "归档",
        );
        if (confirmation !== "归档") return;
        const archived = this.sessionId;
        await this.runtime.archiveSession(archived);
        const next = this.runtime
            .getSessionCatalog()
            .snapshot()
            .sessions.find(
                (item) =>
                    item.sessionId !== archived &&
                    !this.runtime.getSessionCatalog().snapshot().archivedSessionIds.includes(item.sessionId),
            );
        this.sessionId = undefined;
        this.sessionCwd = undefined;
        this.discardSubagentPreview();
        await this.extensionContext.workspaceState.update("session", undefined);
        if (next) await this.switchSession(next.sessionId);
        this.postState();
    }

    private async switchSession(sessionId: string): Promise<void> {
        const catalog = this.runtime.getSessionCatalog().snapshot();
        const session = catalog.sessions.find((item) => item.sessionId === sessionId);
        if (this.sessionId !== sessionId) this.discardSubagentPreview();
        this.sessionId = sessionId;
        this.sessionCwd = session?.cwd ?? this.workspaceRoot();
        if (vscode.workspace.getConfiguration("dsh").get<boolean>("persistSession", true)) {
            await this.extensionContext.workspaceState.update("session", {
                sessionId,
                cwd: this.sessionCwd ?? "",
            } satisfies PersistedSession);
        }
        await this.runtime.syncSession(sessionId);
        void this.refreshSubagentTree(sessionId);
        this.reveal();
    }

    private async mutateGoal(action: ChatViewAction): Promise<void> {
        const sessionId = this.sessionId;
        if (!sessionId) return;
        const goalCell = this.runtime
            .getSessionStore()
            .get(sessionId)
            ?.projections.find((cell) => cell.key === "goal");
        if (!goalCell) {
            throw new Error("当前 Harness 未提供 goal projection，Goal HUD 已保持关闭。");
        }
        const parsed = parseGoalProjection(goalCell.value);
        if (!parsed.ok) throw new Error(parsed.error);

        const operation =
            action.type === "goalCreate" ? "create" :
            action.type === "goalEdit" ? "edit" :
            action.type === "goalPause" ? "pause" :
            action.type === "goalResume" ? "resume" :
            action.type === "goalComplete" ? "complete" :
            action.type === "goalClear" ? "clear" : undefined;
        if (!operation || !this.goalMutations.claim(sessionId, operation, goalCell.seq)) return;
        this.postState();

        try {
            if (action.type === "goalCreate") {
                if (parsed.value !== null && parsed.value.goal.phase !== "complete") {
                    throw new Error("只有空 Goal 或已完成 Goal 可以创建替代目标。");
                }
                const result = await this.runtime.createGoal(
                    sessionId,
                    action.objective,
                    action.maxGoalRounds,
                );
                const ref = normalizeGoalRef(result.ref);
                if (!ref) throw new Error("Harness 返回了无效的 goal.create ref。");
                this.goalMutations.acknowledgeRef(sessionId, ref);
            } else {
                if (parsed.value === null) throw new Error("当前会话没有可操作的 Goal。");
                const ref = {
                    id: parsed.value.goal.id,
                    revision: parsed.value.goal.revision,
                };
                if (action.type === "goalEdit") {
                    const result = await this.runtime.editGoal(
                        sessionId,
                        ref,
                        action.objective !== undefined
                            ? {
                                  objective: action.objective,
                                  ...(action.maxGoalRounds === undefined
                                      ? {}
                                      : { maxGoalRounds: action.maxGoalRounds }),
                              }
                            : { maxGoalRounds: action.maxGoalRounds },
                    );
                    const nextRef = normalizeGoalRef(result.ref);
                    if (!nextRef) throw new Error("Harness 返回了无效的 goal.edit ref。");
                    this.goalMutations.acknowledgeRef(sessionId, nextRef);
                } else if (action.type === "goalPause") {
                    const result = await this.runtime.pauseGoal(sessionId, ref);
                    const nextRef = normalizeGoalRef(result.ref);
                    if (!nextRef) throw new Error("Harness 返回了无效的 goal.pause ref。");
                    this.goalMutations.acknowledgeRef(sessionId, nextRef);
                } else if (action.type === "goalResume") {
                    const result = await this.runtime.resumeGoal(sessionId, ref);
                    const nextRef = normalizeGoalRef(result.ref);
                    if (!nextRef) throw new Error("Harness 返回了无效的 goal.resume ref。");
                    this.goalMutations.acknowledgeRef(sessionId, nextRef);
                } else if (action.type === "goalComplete") {
                    const result = await this.runtime.completeGoal(sessionId, ref);
                    const nextRef = normalizeGoalRef(result.ref);
                    if (!nextRef) throw new Error("Harness 返回了无效的 goal.complete ref。");
                    this.goalMutations.acknowledgeRef(sessionId, nextRef);
                } else if (action.type === "goalClear") {
                    const result = await this.runtime.clearGoal(sessionId, ref);
                    if (result.cleared !== true) {
                        throw new Error("Harness 返回了无效的 goal.clear acknowledgement。");
                    }
                    this.goalMutations.acknowledgeClear(sessionId);
                }
            }
            const latestGoalCell = this.runtime
                .getSessionStore()
                .get(sessionId)
                ?.projections.find((cell) => cell.key === "goal");
            this.goalMutations.observe(sessionId, latestGoalCell);
        } catch (error) {
            this.goalMutations.fail(sessionId, errorMessage(error));
            throw error;
        } finally {
            this.postState();
        }
    }

    private async refreshSubagentTree(rootSessionId: string): Promise<void> {
        this.subagentTreeAborts.get(rootSessionId)?.abort();
        const controller = new AbortController();
        this.subagentTreeAborts.set(rootSessionId, controller);
        const generation = this.subagentTrees.begin(rootSessionId);
        if (rootSessionId === this.sessionId) this.postState();

        try {
            const catalogs = new Map<string, DshSubagentCatalog>();
            const pending = [rootSessionId];
            const visited = new Set<string>();
            while (pending.length > 0) {
                const parentSessionId = pending.shift();
                if (!parentSessionId || visited.has(parentSessionId)) continue;
                visited.add(parentSessionId);
                const raw = await this.runtime.listSubagents(parentSessionId, controller.signal);
                const catalog = normalizeSubagentCatalog(raw);
                if (!catalog) {
                    throw new Error(`Harness 返回了无效的 subagent.list：${parentSessionId}`);
                }
                catalogs.set(parentSessionId, catalog);
                for (const entry of catalog.entries) {
                    if (entry.kind === "child" && entry.hasChildren && !visited.has(entry.id)) {
                        pending.push(entry.id);
                    }
                }
            }
            const applied = this.subagentTrees.resolve(rootSessionId, generation, catalogs);
            if (applied && this.subagentPreview?.rootSessionId === rootSessionId) {
                const refreshed = this.subagentTrees
                    .get(rootSessionId)
                    ?.nodes.find(
                        (node) =>
                            node.kind === "child" &&
                            node.id === this.subagentPreview?.childSessionId,
                    );
                if (
                    refreshed &&
                    (refreshed.mode === "one-shot" || refreshed.mode === "continuable") &&
                    (refreshed.activity === "running" || refreshed.activity === "inactive")
                ) {
                    this.subagentPreview = {
                        ...this.subagentPreview,
                        label: refreshed.label ?? refreshed.id,
                        mode: refreshed.mode,
                        activity: refreshed.activity,
                        parentAvailable: refreshed.parentAvailable,
                    };
                } else {
                    this.subagentPreview = {
                        ...this.subagentPreview,
                        state: "error",
                        error: "该 subagent 已不在当前官方目录中。",
                    };
                }
            }
        } catch (error) {
            if (!controller.signal.aborted) {
                this.subagentTrees.fail(rootSessionId, generation, errorMessage(error));
            }
        } finally {
            if (this.subagentTreeAborts.get(rootSessionId) === controller) {
                this.subagentTreeAborts.delete(rootSessionId);
            }
            if (rootSessionId === this.sessionId) this.postState();
        }
    }

    private selectedSubagent(childSessionId: string): SubagentTreeNodeView | undefined {
        const rootSessionId = this.sessionId;
        if (!rootSessionId) return undefined;
        const matches = this.subagentTrees
            .get(rootSessionId)
            ?.nodes.filter((node) => node.kind === "child" && node.id === childSessionId) ?? [];
        return matches.length === 1 ? matches[0] : undefined;
    }

    private subagentAddress(node: SubagentTreeNodeView): DshSubagentAddress | undefined {
        if (node.kind !== "child" || (node.mode !== "one-shot" && node.mode !== "continuable")) {
            return undefined;
        }
        return {
            parentSessionId: node.parentSessionId,
            childSessionId: node.id,
            mode: node.mode,
        };
    }

    private async readCompleteSubagentHistory(
        address: DshSubagentAddress,
        signal: AbortSignal,
    ) {
        const tail = await this.runtime.subagentHistory(address, undefined, 100, signal);
        const pages = [tail.events];
        let hasMore = tail.hasMore;
        let beforeSeq = lowestEventSeq(tail.events);
        while (hasMore) {
            if (beforeSeq === undefined || beforeSeq <= 0) {
                throw new Error(`Subagent ${address.childSessionId} history 分页未提供更早 seq。`);
            }
            const page = await this.runtime.subagentHistory(address, beforeSeq, 100, signal);
            pages.push(page.events);
            const nextBeforeSeq = lowestEventSeq(page.events);
            if (page.hasMore && (nextBeforeSeq === undefined || nextBeforeSeq >= beforeSeq)) {
                throw new Error(`Subagent ${address.childSessionId} history 分页没有前进。`);
            }
            beforeSeq = nextBeforeSeq;
            hasMore = page.hasMore;
        }
        return {
            events: pages.flat(),
            hasMore: false,
            ...(tail.projections === undefined ? {} : { projections: tail.projections }),
        };
    }

    private async openSubagentHistory(childSessionId: string): Promise<void> {
        const rootSessionId = this.sessionId;
        const node = this.selectedSubagent(childSessionId);
        const address = node && this.subagentAddress(node);
        if (
            !rootSessionId ||
            !node ||
            !address ||
            (node.activity !== "running" && node.activity !== "inactive")
        ) return;

        this.subagentPreviewAbort?.abort();
        const controller = new AbortController();
        this.subagentPreviewAbort = controller;
        const generation = ++this.subagentPreviewGeneration;
        this.subagentPreview = {
            rootSessionId,
            childSessionId,
            label: node.label ?? childSessionId,
            mode: address.mode,
            parentAvailable: node.parentAvailable,
            activity: node.activity,
            state: "loading",
            messages: [],
        };
        this.postState();

        try {
            const history = await this.readCompleteSubagentHistory(address, controller.signal);
            if (
                controller.signal.aborted ||
                generation !== this.subagentPreviewGeneration ||
                rootSessionId !== this.sessionId
            ) return;
            this.subagentPreview = {
                ...this.subagentPreview,
                rootSessionId,
                childSessionId,
                label: node.label ?? childSessionId,
                mode: address.mode,
                parentAvailable: node.parentAvailable,
                activity: node.activity,
                state: "ready",
                messages: projectSubagentHistory(childSessionId, history),
            };
        } catch (error) {
            if (
                !controller.signal.aborted &&
                generation === this.subagentPreviewGeneration &&
                rootSessionId === this.sessionId
            ) {
                this.subagentPreview = {
                    ...this.subagentPreview,
                    rootSessionId,
                    childSessionId,
                    label: node.label ?? childSessionId,
                    mode: address.mode,
                    parentAvailable: node.parentAvailable,
                    activity: node.activity,
                    state: "error",
                    messages: [],
                    error: errorMessage(error),
                };
            }
        } finally {
            if (this.subagentPreviewAbort === controller) this.subagentPreviewAbort = undefined;
            if (rootSessionId === this.sessionId) this.postState();
        }
    }

    private closeSubagentHistory(): void {
        this.discardSubagentPreview();
        this.postState();
    }

    private discardSubagentPreview(): void {
        this.subagentPreviewAbort?.abort();
        this.subagentPreviewAbort = undefined;
        this.subagentPreviewGeneration += 1;
        this.subagentPreview = undefined;
    }

    private async followUpSubagent(childSessionId: string, text: string): Promise<void> {
        const rootSessionId = this.sessionId;
        const node = this.selectedSubagent(childSessionId);
        const preview = this.subagentPreview;
        if (
            !rootSessionId ||
            !node ||
            node.mode !== "continuable" ||
            !node.parentAvailable ||
            !preview ||
            preview.rootSessionId !== rootSessionId ||
            preview.childSessionId !== childSessionId ||
            preview.pendingAction
        ) return;
        const previewGeneration = this.subagentPreviewGeneration;
        this.subagentPreview = { ...preview, pendingAction: "follow-up", error: undefined };
        this.postState();
        try {
            const result = await this.runtime.promptSubagent({
                parentSessionId: node.parentSessionId,
                childSessionId,
                mode: "continuable",
            }, text);
            if (typeof result.messageId !== "string") {
                throw new Error("Harness 返回了无效的 subagent.prompt acknowledgement。");
            }
            await this.refreshSubagentTree(rootSessionId);
            if (
                this.sessionId === rootSessionId &&
                this.subagentPreviewGeneration === previewGeneration &&
                this.subagentPreview?.childSessionId === childSessionId
            ) await this.openSubagentHistory(childSessionId);
        } catch (error) {
            if (this.sessionId === rootSessionId && this.subagentPreview?.childSessionId === childSessionId) {
                this.subagentPreview = {
                    ...this.subagentPreview,
                    pendingAction: undefined,
                    error: errorMessage(error),
                };
                this.postState();
            }
        }
    }

    private async interruptSubagent(childSessionId: string): Promise<void> {
        const rootSessionId = this.sessionId;
        const node = this.selectedSubagent(childSessionId);
        const preview = this.subagentPreview;
        if (
            !rootSessionId ||
            !node ||
            node.mode !== "continuable" ||
            !preview ||
            preview.rootSessionId !== rootSessionId ||
            preview.childSessionId !== childSessionId ||
            preview.pendingAction
        ) return;
        const previewGeneration = this.subagentPreviewGeneration;
        this.subagentPreview = { ...preview, pendingAction: "interrupt", error: undefined };
        this.postState();
        try {
            const result = await this.runtime.interruptSubagent({
                parentSessionId: node.parentSessionId,
                childSessionId,
                mode: "continuable",
            });
            if (result.accepted !== true) {
                throw new Error("Harness 返回了无效的 subagent.interrupt acknowledgement。");
            }
            await this.refreshSubagentTree(rootSessionId);
            if (
                this.sessionId === rootSessionId &&
                this.subagentPreviewGeneration === previewGeneration &&
                this.subagentPreview?.childSessionId === childSessionId
            ) await this.openSubagentHistory(childSessionId);
        } catch (error) {
            if (this.sessionId === rootSessionId && this.subagentPreview?.childSessionId === childSessionId) {
                this.subagentPreview = {
                    ...this.subagentPreview,
                    pendingAction: undefined,
                    error: errorMessage(error),
                };
                this.postState();
            }
        }
    }

    private async answerApproval(
        action: Extract<ChatViewAction, { type: "answerApproval" }>,
    ): Promise<void> {
        const sessionId = this.sessionId;
        if (!sessionId) return;
        const interaction = this.runtime.getSessionStore().claimInteraction(sessionId, action.key);
        if (!interaction || interaction.kind !== "approval") return;
        try {
            const receipt = await this.runtime.respond<DshApprovalResponse>({
                type: "client-response",
                rpcId: interaction.rpcId,
                result: {
                    ok: true,
                    value: {
                        sessionId,
                        approvalId: interaction.approvalId,
                        outcome: action.outcome,
                    },
                },
            });
            this.runtime.getSessionStore().settleInteractionReceipt(sessionId, action.key, receipt);
        } catch (error) {
            this.runtime
                .getSessionStore()
                .failInteraction(sessionId, action.key, errorMessage(error));
            this.reportError(error);
        }
    }

    private async answerQuestion(
        action: Extract<ChatViewAction, { type: "answerQuestion" }>,
    ): Promise<void> {
        const sessionId = this.sessionId;
        if (!sessionId) return;
        const current = this.runtime
            .getSessionStore()
            .get(sessionId)
            ?.interactions.find((item) => item.key === action.key);
        if (!current || current.kind !== "question" || current.status !== "pending") return;
        const invalid = validateQuestionAnswers(current.questions, action.answers);
        if (invalid) throw new Error(`${invalid} 已拒绝发送。`);
        const interaction = this.runtime.getSessionStore().claimInteraction(sessionId, action.key);
        if (!interaction || interaction.kind !== "question") return;
        try {
            const receipt = await this.runtime.respond<DshQuestionResponse>({
                type: "client-response",
                rpcId: interaction.rpcId,
                result: {
                    ok: true,
                    value: { sessionId, answer: { answers: action.answers } },
                },
            });
            this.runtime.getSessionStore().settleInteractionReceipt(sessionId, action.key, receipt);
        } catch (error) {
            this.runtime
                .getSessionStore()
                .failInteraction(sessionId, action.key, errorMessage(error));
            this.reportError(error);
        }
    }

    private async updateQueue(
        action: Extract<ChatViewAction, { type: "updateQueue" }>,
    ): Promise<void> {
        const sessionId = this.sessionId;
        if (!sessionId) return;
        const item = this.runtime
            .getSessionStore()
            .get(sessionId)
            ?.queue.items.find((candidate) => candidate.id === action.itemId);
        if (!item || item.placement === "context") return;
        const dockItem = queueDockItems([item])[0];
        await this.runtime.updateQueue(
            sessionId,
            action.itemId,
            action.action === "edit"
                ? { kind: "edit", content: [{ type: "text", text: action.text ?? "" }] }
                : { kind: action.action },
        );
        if (dockItem?.editableText !== undefined) {
            let optimisticIndex = -1;
            for (let index = this.optimisticPrompts.length - 1; index >= 0; index -= 1) {
                const candidate = this.optimisticPrompts[index];
                if (
                    candidate?.sessionId === sessionId &&
                    candidate.wireText === dockItem.editableText
                ) {
                    optimisticIndex = index;
                    break;
                }
            }
            const optimistic = this.optimisticPrompts[optimisticIndex];
            if (optimistic && action.action === "edit" && action.text !== undefined) {
                optimistic.wireText = action.text;
                optimistic.displayText = promptDisplayText(action.text);
            } else if (optimisticIndex >= 0 && action.action === "remove") {
                this.optimisticPrompts.splice(optimisticIndex, 1);
            }
            this.postState();
        }
    }

    private selectedSessionRunning(): boolean {
        if (!this.sessionId) return false;
        return this.runtime
            .getSessionCatalog()
            .snapshot()
            .sessions.find((item) => item.sessionId === this.sessionId)?.running === true;
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

    private postState(): void {
        if (!this.view) {
            return;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const catalog = this.runtime.getSessionCatalog().snapshot();
        const archived = new Set(catalog.archivedSessionIds);
        const selected = catalog.sessions.find((item) => item.sessionId === this.sessionId);
        const session = this.sessionId
            ? this.runtime.getSessionStore().get(this.sessionId)
            : undefined;
        const goalCell = session?.projections.find((cell) => cell.key === "goal");
        if (this.sessionId) this.goalMutations.observe(this.sessionId, goalCell);
        const activeInteractions = session?.interactions.filter(
            (interaction) =>
                interaction.status === "pending" ||
                interaction.status === "submitting" ||
                interaction.status === "failed" ||
                interaction.status === "unavailable" ||
                interaction.status === "resolved",
        ) ?? [];
        const state: ChatViewState = {
            messages: projectChatMessages(session, this.optimisticPrompts),
            context: this.contextStore.snapshot(),
            selection: this.contextStore.getCurrentSelectionMetadata(),
            selectionEnabled: this.selectionEnabled,
            status: this.runtime.getStatus(),
            busy: selected?.running === true,
            submitting: this.submitting,
            workspaceName: workspaceFolder?.name,
            sessionId: this.sessionId,
            sessions: catalog.sessions
                .filter((item) => !archived.has(item.sessionId))
                .map((item) => ({
                    sessionId: item.sessionId,
                    title: item.title || item.sessionId.slice(0, 12),
                    running: item.running === true,
                    attention: item.pendingInteraction !== undefined,
                    archived: false,
                })),
            sessionStatus: selected
                ? {
                      running: selected.running === true,
                      attention: activeInteractions.some(
                          (interaction) =>
                              interaction.status === "pending" ||
                              interaction.status === "submitting",
                      ),
                      ...(selected.lastAgentError === undefined
                          ? {}
                          : { error: selected.lastAgentError }),
                  }
                : undefined,
            interactions: activeInteractions.map((interaction) =>
                interaction.kind === "approval"
                    ? {
                          key: interaction.key,
                          kind: "approval",
                          status: interaction.status,
                          toolName: interaction.toolName,
                          ...(interaction.reason === undefined
                              ? {}
                              : { reason: interaction.reason }),
                          ...(interaction.outcome === undefined
                              ? {}
                              : { outcome: interaction.outcome }),
                          ...(interaction.error === undefined
                              ? {}
                              : { error: interaction.error }),
                      }
                    : {
                          key: interaction.key,
                          kind: "question",
                          status: interaction.status,
                          questions: [...interaction.questions],
                          ...(interaction.outcome === undefined
                              ? {}
                              : { outcome: interaction.outcome }),
                          ...(interaction.error === undefined
                              ? {}
                              : { error: interaction.error }),
                      },
            ),
            queue: queueDockItems(session?.queue.items ?? []),
            goal: this.sessionId
                ? presentGoalHud(goalCell, this.goalMutations.snapshot(this.sessionId))
                : undefined,
            subagents: this.sessionId ? this.subagentTrees.get(this.sessionId) : undefined,
            subagentPreview:
                this.sessionId && this.subagentPreview?.rootSessionId === this.sessionId
                    ? { ...this.subagentPreview, messages: [...this.subagentPreview.messages] }
                    : undefined,
            jobs: this.sessionId
                ? presentJobCenter(this.sessionId, session?.jobs.items ?? [])
                : [],
        };
        void this.view.webview.postMessage({ type: "state", state });
    }

    private schedulePostState(): void {
        if (this.stateUpdateTimer) return;
        this.stateUpdateTimer = setTimeout(() => {
            this.stateUpdateTimer = undefined;
            this.postState();
        }, 16);
    }

    private scheduleSubagentRefresh(): void {
        if (this.subagentRefreshTimer || !this.sessionId || !this.runtime.getUrl()) return;
        this.subagentRefreshTimer = setTimeout(() => {
            this.subagentRefreshTimer = undefined;
            if (this.sessionId) void this.refreshSubagentTree(this.sessionId);
        }, 75);
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
        .message-trace { float: right; padding: 0 3px; color: var(--vscode-descriptionForeground); background: transparent; font-size: 10px; }
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
        .session-bar { display: flex; gap: 5px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
        .session-bar select { flex: 1; min-width: 0; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); }
        .session-bar button { padding: 3px 6px; font-size: 10px; }
        .dock { padding: 0 10px 7px; }
        .dock-title { color: var(--vscode-descriptionForeground); font-size: 11px; margin: 4px 0; }
        .card { margin: 6px 0; padding: 8px; border: 1px solid var(--vscode-panel-border); border-radius: 5px; background: var(--vscode-editorWidget-background); }
        .card-title { font-weight: 600; margin-bottom: 5px; }
        .card-detail, .card-error { color: var(--vscode-descriptionForeground); font-size: 11px; white-space: pre-wrap; }
        .card-error { color: var(--vscode-errorForeground); }
        .card-actions { display: flex; gap: 5px; margin-top: 7px; }
        .question { margin: 7px 0; }
        .question-title { margin-bottom: 4px; }
        .option { display: block; margin: 3px 0; font-size: 12px; }
        .custom-answer { width: 100%; padding: 5px; margin-top: 4px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
        .queue-row { display: grid; grid-template-columns: 1fr auto; gap: 6px; align-items: center; padding: 5px 0; border-top: 1px solid var(--vscode-panel-border); }
        .queue-preview { overflow-wrap: anywhere; font-size: 11px; }
        .queue-actions { display: flex; gap: 3px; }
        .queue-actions button { padding: 2px 5px; font-size: 10px; }
        .feature-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
        .feature-head .dock-title { flex: 1; }
        .feature-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 7px; }
        .feature-actions button { padding: 3px 6px; font-size: 10px; }
        .goal-objective { white-space: pre-wrap; overflow-wrap: anywhere; margin-bottom: 5px; }
        .tree-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; align-items: center; padding: 5px 0; border-top: 1px solid var(--vscode-panel-border); }
        .tree-label { overflow-wrap: anywhere; }
        .tree-meta, .job-meta { color: var(--vscode-descriptionForeground); font-size: 10px; overflow-wrap: anywhere; }
        .subagent-transcript { max-height: 220px; overflow: auto; margin-top: 7px; padding: 6px; border: 1px solid var(--vscode-panel-border); }
        .subagent-transcript .message { margin-bottom: 8px; }
        .follow-up { display: flex; gap: 5px; margin-top: 7px; }
        .follow-up input { flex: 1; min-width: 0; padding: 5px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
        .job-row { padding: 5px 0; border-top: 1px solid var(--vscode-panel-border); }
        .job-summary { margin-top: 3px; font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; }
        .streaming::after { content: ' ●'; color: var(--vscode-progressBar-background); }
        .pending { opacity: .7; }
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
        <div class="session-bar">
            <select id="sessionSelect" title="切换会话"></select>
            <button id="newSession" class="secondary" title="新建会话">＋</button>
            <button id="searchSession" class="secondary" title="搜索会话">⌕</button>
            <button id="renameSession" class="secondary" title="重命名会话">改</button>
            <button id="forkSession" class="secondary" title="Fork 会话">分</button>
            <button id="archiveSession" class="secondary" title="归档会话">归</button>
            <button id="openTrace" class="secondary" title="打开当前会话 Trace">脉</button>
        </div>
        <div id="goal" class="dock"></div>
        <div id="messages" class="messages"></div>
        <div id="interactions" class="dock"></div>
        <div id="queue" class="dock"></div>
        <div id="subagents" class="dock"></div>
        <div id="jobs" class="dock"></div>
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
        let state = { messages: [], context: [], sessions: [], interactions: [], queue: [], jobs: [], selectionEnabled: true, status: { state: 'stopped' }, busy: false, submitting: false };

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
            const sessionStatus = state.sessionStatus || {};
            dot.className = 'dot ' + (sessionStatus.error ? 'error' : (sessionStatus.attention ? 'starting' : status.state));
            document.getElementById('statusText').textContent = sessionStatus.error ? '会话错误' : (sessionStatus.attention ? '等待操作' : (sessionStatus.running ? '生成中' : statusLabel(status)));
            const runtimeButton = document.getElementById('runtimeButton');
            runtimeButton.textContent = status.state === 'running' || status.state === 'starting' ? '停止' : '启动';
            runtimeButton.disabled = status.state === 'starting';

            const sessionSelect = document.getElementById('sessionSelect');
            const sessions = state.sessions || [];
            sessionSelect.innerHTML = sessions.length
                ? sessions.map((session) => '<option value="' + escapeHtml(session.sessionId) + '">' + (session.attention ? '● ' : (session.running ? '▶ ' : '')) + escapeHtml(session.title) + '</option>').join('')
                : '<option value="">暂无会话</option>';
            sessionSelect.value = state.sessionId || '';
            sessionSelect.disabled = sessions.length === 0;
            document.getElementById('renameSession').disabled = !state.sessionId;
            document.getElementById('forkSession').disabled = !state.sessionId;
            document.getElementById('archiveSession').disabled = !state.sessionId;
            document.getElementById('openTrace').disabled = !state.sessionId;

            const goal = document.getElementById('goal');
            const goalState = state.goal;
            if (!goalState) {
                goal.innerHTML = '';
            } else if (goalState.state === 'invalid') {
                goal.innerHTML = '<div class="dock-title">Goal</div><div class="card"><div class="card-error">' + escapeHtml(goalState.error || 'Goal projection 无效') + '</div></div>';
            } else if (goalState.state === 'empty') {
                goal.innerHTML = '<div class="feature-head"><div class="dock-title">Goal</div></div><div class="card"><div class="card-detail">当前会话尚未创建 Goal。</div>' + (goalState.error ? '<div class="card-error">' + escapeHtml(goalState.error) + '</div>' : '') + '<div class="feature-actions"><button data-goal-action="create"' + (goalState.pending ? ' disabled' : '') + '>创建 Goal</button></div></div>';
            } else {
                const currentGoal = goalState.goal || {};
                const blocked = currentGoal.blockedReason ? '<div class="card-error">' + escapeHtml(currentGoal.blockedReason.code + ' · ' + currentGoal.blockedReason.message) + '</div>' : '';
                const pending = goalState.pending ? '<div class="card-detail">正在执行 ' + escapeHtml(goalState.pendingOperation || 'mutation') + '，等待 projection 收敛…</div>' : '';
                const disabled = goalState.pending ? ' disabled' : '';
                const canResume = (currentGoal.phase === 'active' || currentGoal.phase === 'paused' || currentGoal.phase === 'blocked') && Number(goalState.roundsStarted || 0) < Number(currentGoal.maxGoalRounds || 0);
                const actions = '<button data-goal-action="edit"' + disabled + '>编辑</button>'
                    + (currentGoal.phase === 'active' ? '<button class="secondary" data-goal-action="pause"' + disabled + '>暂停</button>' : '')
                    + (canResume ? '<button class="secondary" data-goal-action="resume"' + disabled + '>继续</button>' : '')
                    + (currentGoal.phase !== 'complete' ? '<button class="secondary" data-goal-action="complete"' + disabled + '>完成</button>' : '<button data-goal-action="create"' + disabled + '>新 Goal</button>')
                    + '<button class="secondary" data-goal-action="clear"' + disabled + '>清除</button>';
                goal.innerHTML = '<div class="dock-title">Goal HUD</div><div class="card"><div class="goal-objective">' + escapeHtml(currentGoal.objective || '') + '</div><div class="card-detail">阶段 ' + escapeHtml(currentGoal.phase || '') + ' · revision ' + escapeHtml(currentGoal.revision || '') + ' · round ' + escapeHtml(goalState.roundsStarted || 0) + '/' + escapeHtml(currentGoal.maxGoalRounds || '') + '</div>' + blocked + pending + (goalState.error ? '<div class="card-error">' + escapeHtml(goalState.error) + '</div>' : '') + '<div class="feature-actions">' + actions + '</div></div>';
            }

            const messages = document.getElementById('messages');
            if (!state.messages || state.messages.length === 0) {
                messages.innerHTML = '<div class="empty">直接描述任务。<br>当前选区会自动附加，也可以用 @ 引用文件。</div>';
            } else {
                messages.innerHTML = state.messages.map((message) => {
                    const label = message.role === 'user' ? '你' : (message.role === 'assistant' ? 'dsh' : '系统');
                    const stateClass = message.state === 'streaming' ? ' streaming' : (message.state === 'pending' ? ' pending' : '');
                    const stateLabel = message.state === 'pending' ? ' · 等待接收' : (message.state === 'streaming' ? ' · 流式生成' : '');
                    const trace = Number.isSafeInteger(message.seq) && message.seq >= 0 ? '<button class="message-trace" data-trace-seq="' + message.seq + '" title="在 Trace 中定位">trace</button>' : '';
                    return '<div class="message ' + message.role + stateClass + '"><div class="message-label">' + label + stateLabel + trace + '</div><div class="message-body">' + escapeHtml(message.text) + '</div></div>';
                }).join('');
                messages.scrollTop = messages.scrollHeight;
            }

            const interactions = document.getElementById('interactions');
            interactions.innerHTML = (state.interactions || []).map((interaction) => {
                const disabled = interaction.status !== 'pending' ? ' disabled' : '';
                const statusText = interaction.status === 'submitting' ? '正在提交…' : (interaction.status === 'resolved' ? ('已处理：' + (interaction.outcome || '完成')) : (interaction.status === 'unavailable' ? '请求已失效' : (interaction.status === 'failed' ? '提交结果不确定，等待重连确认' : '')));
                if (interaction.kind === 'approval') {
                    return '<div class="card interaction" data-key="' + escapeHtml(interaction.key) + '"><div class="card-title">需要批准：' + escapeHtml(interaction.toolName || '工具调用') + '</div>' + (interaction.reason ? '<div class="card-detail">' + escapeHtml(interaction.reason) + '</div>' : '') + (statusText ? '<div class="card-detail">' + escapeHtml(statusText) + '</div>' : '') + (interaction.error ? '<div class="card-error">' + escapeHtml(interaction.error) + '</div>' : '') + '<div class="card-actions"><button data-outcome="allowed-once"' + disabled + '>仅允许本次</button><button class="secondary" data-outcome="rejected"' + disabled + '>拒绝</button></div></div>';
                }
                const questions = (interaction.questions || []).map((question) => {
                    const inputType = question.multiSelect ? 'checkbox' : 'radio';
                    const options = (question.options || []).map((option) => '<label class="option"><input type="' + inputType + '" name="' + escapeHtml(interaction.key + ':' + question.id) + '" value="' + escapeHtml(option.label) + '"' + disabled + '> ' + escapeHtml(option.label) + (option.description ? ' — ' + escapeHtml(option.description) : '') + '</label>').join('');
                    return '<div class="question" data-question-id="' + escapeHtml(question.id) + '"><div class="question-title">' + escapeHtml(question.header || question.question) + '</div>' + (question.detail ? '<div class="card-detail">' + escapeHtml(question.detail) + '</div>' : '') + options + '<input class="custom-answer" placeholder="' + (options ? '其他回答（可选）' : '输入回答') + '"' + disabled + '></div>';
                }).join('');
                return '<div class="card interaction" data-key="' + escapeHtml(interaction.key) + '"><div class="card-title">dsh 需要你的回答</div>' + questions + (statusText ? '<div class="card-detail">' + escapeHtml(statusText) + '</div>' : '') + (interaction.error ? '<div class="card-error">' + escapeHtml(interaction.error) + '</div>' : '') + '<div class="card-actions"><button class="question-submit"' + disabled + '>提交回答</button></div></div>';
            }).join('');

            const queue = document.getElementById('queue');
            const queueRows = state.queue || [];
            queue.innerHTML = queueRows.length ? '<div class="dock-title">Queue</div>' + queueRows.map((item) => '<div class="queue-row" data-item-id="' + escapeHtml(item.id) + '" data-editable="' + escapeHtml(item.editableText === undefined ? '' : item.editableText) + '"><div class="queue-preview">' + (item.placement === 'steering' ? '↪ ' : '') + escapeHtml(item.preview || '（无文本内容）') + '</div><div class="queue-actions">' + (item.editableText === undefined ? '' : '<button class="secondary" data-action="edit">编辑</button>') + '<button class="secondary" data-action="remove">移除</button><button class="secondary" data-action="steer"' + (sessionStatus.running ? '' : ' disabled') + '>立即转向</button></div></div>').join('') : '';

            const subagents = document.getElementById('subagents');
            const tree = state.subagents;
            if (!tree || !state.sessionId) {
                subagents.innerHTML = '';
            } else {
                const treeStatus = tree.state === 'loading' ? '加载中…' : (tree.state === 'error' ? escapeHtml(tree.error || '加载失败') : ((tree.nodes || []).length ? '' : '暂无 subagent'));
                const rows = (tree.nodes || []).map((node) => {
                    const indent = Math.max(0, Number(node.depth || 1) - 1) * 12;
                    if (node.kind === 'diagnostic') {
                        return '<div class="tree-row" style="padding-left:' + indent + 'px"><div><div class="tree-label">' + escapeHtml(node.id) + '</div><div class="tree-meta">diagnostic · ' + escapeHtml(node.reason || '') + ' · parent ' + escapeHtml(node.parentSessionId) + '</div></div></div>';
                    }
                    const meta = [node.mode, node.activity, node.hasChildren ? 'has children' : 'leaf', node.parentAvailable ? 'parent available' : 'parent unavailable'].filter(Boolean).join(' · ');
                    return '<div class="tree-row" style="padding-left:' + indent + 'px"><div><div class="tree-label">' + escapeHtml(node.label || node.id) + '</div><div class="tree-meta">' + escapeHtml(meta) + '<br>parent ' + escapeHtml(node.parentSessionId) + '</div></div><button class="secondary" data-subagent-open="' + escapeHtml(node.id) + '">历史</button></div>';
                }).join('');
                const preview = state.subagentPreview && state.subagentPreview.rootSessionId === state.sessionId ? state.subagentPreview : undefined;
                let previewHtml = '';
                if (preview) {
                    const transcript = (preview.messages || []).map((message) => '<div class="message ' + escapeHtml(message.role) + '"><div class="message-label">' + (message.role === 'assistant' ? 'subagent' : (message.role === 'user' ? '你' : '系统')) + '</div><div class="message-body">' + escapeHtml(message.text) + '</div></div>').join('');
                    const pendingAction = preview.pendingAction ? '正在执行 ' + preview.pendingAction + '…' : '';
                    const followUp = preview.mode === 'continuable' ? '<div class="follow-up"><input id="subagentFollowUp" placeholder="给 continuable subagent 追加任务"' + (!preview.parentAvailable || preview.pendingAction ? ' disabled' : '') + '><button data-subagent-follow="' + escapeHtml(preview.childSessionId) + '"' + (!preview.parentAvailable || preview.pendingAction ? ' disabled' : '') + '>发送</button></div>' : '';
                    const interrupt = preview.mode === 'continuable' && preview.activity === 'running' ? '<button class="secondary" data-subagent-interrupt="' + escapeHtml(preview.childSessionId) + '"' + (preview.pendingAction ? ' disabled' : '') + '>中断</button>' : '';
                    previewHtml = '<div class="card"><div class="feature-head"><div class="card-title">' + escapeHtml(preview.label) + '</div><button class="secondary" data-subagent-close>关闭</button></div><div class="card-detail">' + escapeHtml(preview.mode + ' · ' + preview.activity + ' · ' + (preview.parentAvailable ? 'parent available' : 'parent unavailable')) + '</div>' + (preview.state === 'loading' ? '<div class="card-detail">加载 history…</div>' : '') + (preview.error ? '<div class="card-error">' + escapeHtml(preview.error) + '</div>' : '') + (pendingAction ? '<div class="card-detail">' + escapeHtml(pendingAction) + '</div>' : '') + (transcript ? '<div class="subagent-transcript">' + transcript + '</div>' : '') + followUp + '<div class="feature-actions">' + interrupt + '</div></div>';
                }
                subagents.innerHTML = '<div class="feature-head"><div class="dock-title">Subagent Tree</div><button class="secondary" data-subagent-refresh' + (tree.state === 'loading' ? ' disabled' : '') + '>刷新</button></div>' + (treeStatus ? '<div class="card-detail">' + treeStatus + '</div>' : '') + rows + previewHtml;
            }

            const jobs = document.getElementById('jobs');
            const jobRows = state.jobs || [];
            jobs.innerHTML = jobRows.length ? '<div class="dock-title">Job Center · 只读</div>' + jobRows.map((job) => '<div class="job-row"><div>' + escapeHtml(job.label) + '</div><div class="job-meta">' + escapeHtml(job.kind + ' · ' + job.status + ' · owner ' + job.ownerSessionId) + '</div>' + (job.outputSummary ? '<div class="job-summary">' + escapeHtml(job.outputSummary) + '</div>' : '') + '</div>').join('') : '';

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

            document.getElementById('cancel').classList.toggle('hidden', !state.busy);
            document.getElementById('send').disabled = Boolean(state.submitting);
            document.getElementById('prompt').disabled = Boolean(state.submitting);
            document.getElementById('send').textContent = state.busy ? '排队' : '发送';
        }

        function post(type, payload = {}) {
            vscode.postMessage(Object.assign({ type }, payload));
        }

        function askGoalRounds(initialValue) {
            const raw = window.prompt('最大 Goal rounds（留空使用 Harness 默认值）', initialValue === undefined ? '' : String(initialValue));
            if (raw === null) return { cancelled: true };
            if (!raw.trim()) return { value: undefined };
            const value = Number(raw);
            if (!Number.isSafeInteger(value) || value <= 0) {
                window.alert('Goal rounds 必须是正整数。');
                return { cancelled: true };
            }
            return { value };
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
        document.getElementById('sessionSelect').addEventListener('change', (event) => {
            if (event.target.value) post('switchSession', { sessionId: event.target.value });
        });
        document.getElementById('newSession').addEventListener('click', () => post('newSession'));
        document.getElementById('searchSession').addEventListener('click', () => post('searchSession'));
        document.getElementById('renameSession').addEventListener('click', () => post('renameSession'));
        document.getElementById('forkSession').addEventListener('click', () => post('forkSession'));
        document.getElementById('archiveSession').addEventListener('click', () => post('archiveSession'));
        document.getElementById('openTrace').addEventListener('click', () => post('openTrace'));
        document.getElementById('messages').addEventListener('click', (event) => {
            const button = event.target.closest('[data-trace-seq]');
            if (button) post('openTrace', { seq: Number(button.dataset.traceSeq) });
        });
        document.getElementById('goal').addEventListener('click', (event) => {
            const button = event.target.closest('[data-goal-action]');
            if (!button || button.disabled) return;
            const action = button.dataset.goalAction;
            if (action === 'create') {
                const objective = window.prompt('Goal objective', '');
                if (objective === null || !objective.trim()) return;
                const rounds = askGoalRounds(undefined);
                if (rounds.cancelled) return;
                for (const control of document.querySelectorAll('#goal button')) control.disabled = true;
                post('goalCreate', { objective: objective.trim(), maxGoalRounds: rounds.value });
                return;
            }
            if (action === 'edit') {
                const current = state.goal && state.goal.goal;
                if (!current) return;
                const objective = window.prompt('编辑 Goal objective', current.objective || '');
                if (objective === null || !objective.trim()) return;
                const rounds = askGoalRounds(current.maxGoalRounds);
                if (rounds.cancelled) return;
                for (const control of document.querySelectorAll('#goal button')) control.disabled = true;
                post('goalEdit', { objective: objective.trim(), maxGoalRounds: rounds.value });
                return;
            }
            if (action === 'clear' && !window.confirm('清除当前 Goal？')) return;
            for (const control of document.querySelectorAll('#goal button')) control.disabled = true;
            post('goal' + action.charAt(0).toUpperCase() + action.slice(1));
        });
        document.getElementById('addContext').addEventListener('click', () => post('openIdeContextPicker'));
        document.getElementById('contextItems').addEventListener('click', (event) => {
            if (event.target.closest('.selection-toggle')) {
                post('toggleSelection');
                return;
            }
            const target = event.target.closest('.chip-remove');
            if (target) post('removeContext', { id: target.dataset.id });
        });
        document.getElementById('interactions').addEventListener('click', (event) => {
            const card = event.target.closest('.interaction');
            if (!card) return;
            const approval = event.target.closest('[data-outcome]');
            if (approval && !approval.disabled) {
                for (const button of card.querySelectorAll('button')) button.disabled = true;
                post('answerApproval', { key: card.dataset.key, outcome: approval.dataset.outcome });
                return;
            }
            const submit = event.target.closest('.question-submit');
            if (!submit || submit.disabled) return;
            const answers = Array.from(card.querySelectorAll('.question')).map((question) => ({
                id: question.dataset.questionId,
                selected: Array.from(question.querySelectorAll('input[type="radio"]:checked,input[type="checkbox"]:checked')).map((input) => input.value),
                custom: question.querySelector('.custom-answer').value || undefined,
            }));
            for (const control of card.querySelectorAll('button,input')) control.disabled = true;
            post('answerQuestion', { key: card.dataset.key, answers });
        });
        document.getElementById('queue').addEventListener('click', (event) => {
            const button = event.target.closest('[data-action]');
            const row = event.target.closest('.queue-row');
            if (!button || !row || button.disabled) return;
            let text;
            if (button.dataset.action === 'edit') {
                text = window.prompt('编辑排队消息', row.dataset.editable || '');
                if (text === null || !text.trim()) return;
            }
            button.disabled = true;
            post('updateQueue', { itemId: row.dataset.itemId, action: button.dataset.action, text });
        });
        document.getElementById('subagents').addEventListener('click', (event) => {
            const refresh = event.target.closest('[data-subagent-refresh]');
            if (refresh && !refresh.disabled) {
                refresh.disabled = true;
                post('refreshSubagents');
                return;
            }
            if (event.target.closest('[data-subagent-close]')) {
                post('closeSubagent');
                return;
            }
            const open = event.target.closest('[data-subagent-open]');
            if (open && !open.disabled) {
                open.disabled = true;
                post('openSubagent', { childSessionId: open.dataset.subagentOpen });
                return;
            }
            const follow = event.target.closest('[data-subagent-follow]');
            if (follow && !follow.disabled) {
                const input = document.getElementById('subagentFollowUp');
                const text = input && input.value ? input.value.trim() : '';
                if (!text) return;
                follow.disabled = true;
                input.disabled = true;
                post('followUpSubagent', { childSessionId: follow.dataset.subagentFollow, text });
                return;
            }
            const interrupt = event.target.closest('[data-subagent-interrupt]');
            if (interrupt && !interrupt.disabled) {
                interrupt.disabled = true;
                post('interruptSubagent', { childSessionId: interrupt.dataset.subagentInterrupt });
            }
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
