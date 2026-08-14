import { randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import * as vscode from "vscode";
import { DeepSeekBalanceService } from "./balanceService";
import {
    highestKnownSeq,
    hiddenViewBadge,
    focusChatMessages,
    OptimisticPrompt,
    promptDisplayText,
    projectChatMessages,
    projectTurnStatus,
    queueDockItems,
    resolvePromptMode,
} from "./chatState";
import {
    ChatViewAction,
    CHAT_WEBVIEW_PROTOCOL_VERSION,
    parseChatViewAction,
    validateQuestionAnswers,
} from "./chatViewProtocol";
import { ContextStore } from "./contextStore";
import { ChangeReviewStore } from "./changeReviewStore";
import { DshRuntime } from "./dshRuntime";
import { HarnessRpcError } from "./harnessClient";
import { presentHostBaseline } from "./hostState";
import { t } from "./localize";
import {
    isCopyableCode,
    parseSafeHttpUrl,
    renderMarkdownMessage,
    renderSafeMarkdown,
} from "./safeMarkdown";
import {
    GoalMutationGate,
    normalizeGoalRef,
    normalizeSubagentCatalog,
    parseGoalProjection,
    presentGoalHud,
    presentJobCenter,
    presentPlanReview,
    projectSubagentHistory,
    SubagentTreeStore,
} from "./sessionFeatures";
import {
    ChatViewState,
    ChatMessage,
    DshApprovalResponse,
    DshContextItem,
    DshHistoryEntry,
    DshQuestionResponse,
    DshSubagentAddress,
    DshSubagentCatalog,
    PermissionProjectionView,
    SubagentHistoryPreview,
    SubagentTreeNodeView,
} from "./types";
import { projectTokenUsage, SelectedModelSnapshot } from "./tokenUsage";
import { openWorkspaceFileLocation } from "./workspaceNavigation";

interface PersistedSession {
    sessionId: string;
    cwd: string;
}

export type QuickTaskKind = "explain" | "fix" | "review" | "docs";

const EDITOR_TASK_PROMPTS: Readonly<Record<QuickTaskKind, (reference: string) => string>> = {
    explain: (reference) =>
        t("Explain the implementation, key data flow, and important edge cases in {reference}.", { reference }),
    fix: (reference) =>
        t("Inspect and fix issues in {reference}. Explain the issues and proposed changes before implementing them.", { reference }),
    review: (reference) =>
        t("Review {reference}, focusing on correctness, regression risk, security, and maintainability.", { reference }),
    docs: (reference) =>
        t("Generate or improve documentation for {reference}, following the project's existing style.", { reference }),
};

const GIT_DIFF_TASK_PROMPTS: Readonly<Record<QuickTaskKind, () => string>> = {
    explain: () => t("Explain the purpose, implementation, and impact of the attached Git diff."),
    fix: () => t("Inspect and fix issues in the attached Git diff. Explain the issues and proposed changes before implementing them."),
    review: () => t("Review the attached Git diff, focusing on defects, regression risk, security, and omissions."),
    docs: () => t("Generate or update relevant documentation from the attached Git diff, following the project's existing style."),
};


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

function permissionProjection(value: unknown): PermissionProjectionView | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.currentValue !== "string" || !Array.isArray(record.options)) return undefined;
    const options = record.options.flatMap((option): PermissionProjectionView["options"] => {
        if (!option || typeof option !== "object" || Array.isArray(option)) return [];
        const item = option as Record<string, unknown>;
        if (typeof item.value !== "string" || typeof item.name !== "string") return [];
        return [{
            value: item.value,
            label: item.name,
            ...(typeof item.description === "string" ? { description: item.description } : {}),
        }];
    });
    const current = options.find((option) => option.value === record.currentValue);
    if (!current) return undefined;
    return {
        currentValue: record.currentValue,
        currentLabel: current.label,
        options,
    };
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = "dsh.chatView";

    private view: vscode.WebviewView | undefined;
    private viewMessageDisposable: vscode.Disposable | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly optimisticPrompts: OptimisticPrompt[] = [];
    private readonly markdownCache = new Map<string, {
        source: string;
        reasoningSource?: string;
        html: string;
        renderId: string;
        codeBlocks: ReadonlyMap<string, string>;
        reasoningHtml?: string;
        reasoningRenderId?: string;
    }>();
    private readonly copyableCodeByRenderId = new Map<string, ReadonlyMap<string, string>>();
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
    private focusMode = false;
    private fileReferenceCandidates: string[] = [];
    private pendingComposerUpdate: { type: "insertText" | "setText"; text: string } | undefined;
    private webviewReady = false;
    private restoringPersistedSession: Promise<void> | undefined;
    private stateUpdateTimer: ReturnType<typeof setTimeout> | undefined;
    private subagentRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly observedRunning = new Map<string, boolean>();
    private readonly completedWhileHidden = new Set<string>();
    private readonly selectedModels = new Map<string, SelectedModelSnapshot>();
    private readonly changeReviews: ChangeReviewStore;

    public constructor(
        private readonly extensionContext: vscode.ExtensionContext,
        private readonly extensionUri: vscode.Uri,
        private readonly runtime: DshRuntime,
        private readonly contextStore: ContextStore,
        private readonly output: vscode.OutputChannel,
        private readonly balanceService?: DeepSeekBalanceService,
    ) {
        this.changeReviews = new ChangeReviewStore(output);
        const unsubscribeSession = runtime.getSessionStore().onDidChange((sessionId, snapshot) => {
            const catalogSession = runtime.getSessionCatalog().snapshot().sessions.find(
                (item) => item.sessionId === sessionId,
            );
            if (!catalogSession?.parentSessionId && catalogSession?.origin !== "subagent") {
                this.changeReviews.observe(
                    sessionId,
                    catalogSession?.cwd ?? (sessionId === this.sessionId ? this.sessionCwd : undefined),
                    snapshot,
                );
            }
            if (sessionId === this.sessionId) {
                this.goalMutations.observe(
                    sessionId,
                    snapshot.projections.find((cell) => cell.key === "goal"),
                );
                this.schedulePostState();
            }
        });
        const unsubscribeCatalog = runtime.getSessionCatalog().onDidChange(() => {
            this.observeSessionTransitions();
            this.schedulePostState();
            this.scheduleSubagentRefresh();
        });
        this.disposables.push(
            runtime.onDidChange(() => this.schedulePostState()),
            runtime.onDidHarnessConnect(() => {
                void this.restorePersistedSession(this.workspaceRoot()).then(() => {
                    if (this.sessionId) void this.refreshSubagentTree(this.sessionId);
                });
            }),
            contextStore.onDidChange(() => this.schedulePostState()),
            vscode.window.onDidChangeActiveTextEditor(() => this.schedulePostState()),
            vscode.window.onDidChangeTextEditorSelection(() => this.schedulePostState()),
            this.changeReviews.onDidUpdate(() => this.schedulePostState()),
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
        this.webviewReady = false;
        this.seedObservedRunning();
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
            webviewView.onDidChangeVisibility(() => {
                if (webviewView.visible) this.completedWhileHidden.clear();
                this.updateViewBadge();
            }),
            webviewView.onDidDispose(() => {
                if (this.view === webviewView) {
                    this.view = undefined;
                    this.webviewReady = false;
                }
            }),
        );
        this.postState();
    }

    public insertEditorReference(): void {
        const reference = this.contextStore.getActiveEditorReference();
        if (!reference) {
            this.reportError(new Error(t("There is no current editor to reference.")));
            return;
        }

        this.insertComposerText(reference);
    }

    /** Prefills a safe, workspace-scoped prompt for an Explorer resource. */
    public async askAboutResource(resource?: vscode.Uri): Promise<void> {
        if (!vscode.workspace.isTrusted) {
            throw new Error(t("Trust the current workspace before asking about a resource."));
        }
        if (!resource || resource.scheme !== "file") {
            throw new Error(t("Select a file or directory inside a workspace first."));
        }
        const folder = vscode.workspace.getWorkspaceFolder(resource);
        if (!folder) {
            throw new Error(t("The selected resource is outside the current workspace."));
        }

        const relativePath = relative(folder.uri.fsPath, resource.fsPath).replace(/\\/gu, "/");
        if (
            !relativePath ||
            relativePath === ".." ||
            relativePath.startsWith("../") ||
            isAbsolute(relativePath)
        ) {
            throw new Error(t("The selected resource is outside the current workspace."));
        }

        let resourceType = t("Workspace resource");
        try {
            const stat = await vscode.workspace.fs.stat(resource);
            resourceType = stat.type & vscode.FileType.Directory ? t("Directory") : t("File");
        } catch {
            // The prompt remains useful when the Explorer item disappears during the command.
        }

        const cleanPath = relativePath.replace(/[\r\n]/gu, " ");
        this.setComposerText([
            t("Inspect this workspace resource and help me with it."),
            `${t("Workspace root")}: ${folder.uri.fsPath}`,
            `${t("Target path")}: ${cleanPath}`,
            `${t("Target type")}: ${resourceType}`,
        ].join("\n"));
    }

    public async prefillEditorTask(kind: QuickTaskKind): Promise<void> {
        const reference = this.contextStore.getActiveEditorReference();
        if (!reference) {
            throw new Error(t("There is no current editor for this quick task."));
        }

        this.setComposerText(EDITOR_TASK_PROMPTS[kind](reference));
    }

    public async prefillGitDiffTask(kind: QuickTaskKind): Promise<void> {
        await this.contextStore.addGitDiff();
        this.setComposerText(GIT_DIFF_TASK_PROMPTS[kind]());
    }

    public async configureApiKey(): Promise<void> {
        const configuration = vscode.workspace.getConfiguration("dsh");
        const ref = configuration.get<string>("apiKeyEnv", "DEEPSEEK_API_KEY").trim();
        if (!ref) {
            throw new Error(t("dsh.apiKeyEnv cannot be empty. Configure a credential reference name first."));
        }

        const key = await vscode.window.showInputBox({
            title: t("Configure {reference}", { reference: ref }),
            prompt: t("The API Key is passed to the dsh runtime and encrypted in VS Code SecretStorage for balance queries. It is never written to extension state or logs."),
            password: true,
            ignoreFocusOut: true,
            validateInput: (value) => (value.trim() ? undefined : t("Enter an API Key.")),
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
            void vscode.window.showWarningMessage(t("DSH: The chat key was saved, but balance caching failed: {message}", { message }));
        }
        void vscode.window.showInformationMessage(t("DSH: {reference} was saved. You can retry the task.", { reference: ref }));
        this.reveal();
    }

    public async openIdeContextPicker(): Promise<void> {
        const hasSelection = Boolean(this.contextStore.getCurrentSelectionMetadata());
        const choice = await vscode.window.showQuickPick(
            [
                ...(hasSelection
                    ? [{ actionId: "selection" as const, label: `$(selection) ${t("Selection")}`, detail: t("Enable the current selection and read it again when sending") }]
                    : []),
                { actionId: "workspace-file" as const, label: `$(search) ${t("Workspace file")}`, detail: t("Fuzzy-search and insert an @file reference") },
                { actionId: "current-file" as const, label: `$(file-code) ${t("Current file")}`, detail: t("Insert an @file reference without copying its contents") },
                { actionId: "diagnostics" as const, label: `$(warning) ${t("Diagnostics")}`, detail: t("Attach once to this turn") },
                { actionId: "git-diff" as const, label: "$(git-compare) Git diff", detail: t("Attach once to this turn") },
                {
                    actionId: "toggle-selection" as const,
                    label: this.selectionEnabled
                        ? `$(eye-closed) ${t("Disable selection")}`
                        : `$(eye) ${t("Enable selection")}`,
                    detail: this.selectionEnabled ? t("Do not attach the current selection automatically") : t("Attach the current selection automatically"),
                },
            ],
            { placeHolder: t("Choose IDE context for this turn or adjust the selection policy") },
        );
        if (!choice) {
            return;
        }

        if (choice.actionId === "selection") {
            this.selectionEnabled = true;
        } else if (choice.actionId === "workspace-file") {
            await this.openWorkspaceFileReferencePicker();
            return;
        } else if (choice.actionId === "current-file") {
            this.insertEditorReference();
            return;
        } else if (choice.actionId === "diagnostics") {
            await this.runContextAction(() => this.contextStore.addDiagnostics());
            return;
        } else if (choice.actionId === "git-diff") {
            await this.runContextAction(() => this.contextStore.addGitDiff());
            return;
        } else {
            this.selectionEnabled = !this.selectionEnabled;
        }
        this.reveal();
    }

    private async openWorkspaceFileReferencePicker(): Promise<void> {
        const uris = await vscode.workspace.findFiles(
            "**/*",
            "**/{.git,node_modules,.DS_Store}/**",
            2_000,
        );
        const items = uris.map((uri) => {
            const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
            return {
                label: `$(file) ${relativePath.split("/").pop() ?? relativePath}`,
                description: relativePath,
                uri,
            };
        });
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: t("Search workspace files and insert @path"),
            matchOnDescription: true,
        });
        if (!selected) return;
        this.insertComposerText(`@${vscode.workspace.asRelativePath(selected.uri, false).replace(/\\/g, "/")}`);
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
        this.changeReviews.dispose();
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
                    this.webviewReady = true;
                    this.postState();
                    this.flushPendingComposerUpdate();
                    if (this.sessionId) void this.refreshSubagentTree(this.sessionId);
                    break;
                case "sendPrompt":
                    await this.sendPrompt(message.text ?? "", message.mode);
                    break;
                case "retryPrompt":
                    await this.retryPrompt(message.id);
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
                case "fileReferenceQuery":
                    await this.updateFileReferenceCandidates(message.query);
                    break;
                case "toggleSelection":
                    this.selectionEnabled = !this.selectionEnabled;
                    this.postState();
                    break;
                case "toggleFocus":
                    this.focusMode = !this.focusMode;
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
                case "openExternalLink": {
                    const url = parseSafeHttpUrl(message.url);
                    if (!url) throw new Error(t("Only explicit HTTP(S) links can be opened."));
                    const opened = await vscode.env.openExternal(vscode.Uri.parse(url, true));
                    if (!opened) throw new Error(t("VS Code could not open the link."));
                    break;
                }
                case "openFileLocation":
                    await openWorkspaceFileLocation(
                        message,
                        this.sessionCwd ?? this.workspaceRoot(),
                    );
                    break;
                case "copyCode":
                    await this.copyCodeBlock(message.renderId, message.codeBlockId);
                    break;
                case "openTrace":
                    if (this.sessionId) {
                        await vscode.commands.executeCommand("dsh.openTrace", {
                            sessionId: this.sessionId,
                            ...(message.seq === undefined ? {} : { seq: message.seq }),
                        });
                    }
                    break;
                case "openChangeDiff":
                    if (this.sessionId) {
                        await this.changeReviews.openDiff(this.sessionId, message.turn, message.fileId);
                    }
                    break;
                case "restoreTurnChanges":
                    if (this.selectedSessionRunning()) {
                        throw new Error(t("Wait for the current turn to finish before restoring changes."));
                    }
                    if (this.sessionId) await this.changeReviews.restore(this.sessionId, message.turn);
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
                case "selectModel":
                    await this.selectModel();
                    break;
                case "selectAgentPreset":
                    await this.selectAgentPreset(message.agentPreset);
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

    private async updateFileReferenceCandidates(query: string): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder || !query.trim()) {
            this.fileReferenceCandidates = [];
            this.postState();
            return;
        }
        const normalizedQuery = query.trim().replaceAll("\\", "/").toLowerCase();
        const uris = await vscode.workspace.findFiles("**/*", "**/{.git,node_modules,.DS_Store}/**", 2_000);
        const active = vscode.window.activeTextEditor?.document.uri;
        const candidates = uris
            .map((uri) => vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/"))
            .filter((relative) => relative.toLowerCase().includes(normalizedQuery));
        const activeRelative = active
            ? vscode.workspace.asRelativePath(active, false).replaceAll("\\", "/")
            : undefined;
        const ordered = activeRelative && activeRelative.toLowerCase().includes(normalizedQuery)
            ? [activeRelative, ...candidates.filter((candidate) => candidate !== activeRelative)]
            : candidates;
        this.fileReferenceCandidates = ordered.slice(0, 40);
        this.postState();
    }

    private async sendPrompt(rawText: string, requestedMode: "queue" | "steer"): Promise<void> {
        const text = rawText.trim();
        if (!text || this.submitting) {
            return;
        }

        const workspaceRoot = this.workspaceRoot();
        if (!workspaceRoot) {
            this.reportError(new Error(t("Open a workspace before sending a task to dsh.")));
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
                throw new Error(t("dsh web is not running. Enable dsh.autoStart or run “DSH: Start dsh Web Runtime”."));
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
                throw new Error(t("@selection has no current selection. Select text in the active editor first."));
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
            const mode = resolvePromptMode(requestedMode, this.selectedSessionRunning());
            const promptResult = await this.runtime.prompt(session, prompt, mode);
            if (promptResult.accepted === false) {
                throw new Error(t("The dsh runtime rejected this prompt. Check the current model and API Key configuration."));
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

    private async retryPrompt(id: string): Promise<void> {
        if (this.submitting || !this.sessionId) return;
        const optimistic = this.optimisticPrompts.find(
            (item) => item.id === id && item.sessionId === this.sessionId && item.error !== undefined,
        );
        if (!optimistic) return;
        this.submitting = true;
        optimistic.error = undefined;
        optimistic.afterSeq = highestKnownSeq(this.runtime.getSessionStore().get(this.sessionId));
        optimistic.createdAt = Date.now();
        this.postState();
        try {
            const result = await this.runtime.prompt(this.sessionId, optimistic.wireText, "queue");
            if (result.accepted === false) throw new Error(t("The dsh runtime rejected this retry."));
        } catch (error) {
            optimistic.error = errorMessage(error);
            this.reportError(error);
        } finally {
            this.submitting = false;
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
        await this.restorePersistedSession(workspaceRoot);

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

    private restorePersistedSession(workspaceRoot: string | undefined): Promise<void> {
        if (!workspaceRoot) {
            return Promise.resolve();
        }
        if (this.restoringPersistedSession) {
            return this.restoringPersistedSession;
        }
        if (this.sessionId) {
            return Promise.resolve();
        }

        const restore = this.restorePersistedSessionInternal(workspaceRoot).finally(() => {
            if (this.restoringPersistedSession === restore) {
                this.restoringPersistedSession = undefined;
            }
        });
        this.restoringPersistedSession = restore;
        return restore;
    }

    private async restorePersistedSessionInternal(workspaceRoot: string): Promise<void> {
        const persist = vscode.workspace.getConfiguration("dsh").get<boolean>("persistSession", true);
        const persisted = this.extensionContext.workspaceState.get<PersistedSession>("session");
        if (!persist || !persisted || persisted.cwd !== workspaceRoot) {
            return;
        }

        try {
            await this.runtime.history(persisted.sessionId, 1);
            if (this.sessionId) {
                return;
            }
            this.sessionId = persisted.sessionId;
            this.sessionCwd = workspaceRoot;
            this.postState();
            await this.runtime.syncSession(persisted.sessionId);
        } catch (error) {
            const latest = this.extensionContext.workspaceState.get<PersistedSession>("session");
            if (latest?.sessionId === persisted.sessionId && latest.cwd === persisted.cwd) {
                await this.extensionContext.workspaceState.update("session", undefined);
            }
            this.output.appendLine(
                `[dsh] persisted session ${persisted.sessionId} could not be restored: ${errorMessage(error)}`,
            );
        }
    }

    public async newSession(agentPreset?: string): Promise<void> {
        const workspaceRoot = this.workspaceRoot();
        if (!workspaceRoot) throw new Error(t("Open a workspace first."));
        await this.runtime.start(workspaceRoot);
        const created = await this.runtime.createSession(workspaceRoot, agentPreset);
        await this.switchSession(created.sessionId);
        this.reveal();
    }

    public async searchSession(): Promise<void> {
        await this.runtime.start(this.workspaceRoot());
        const query = await vscode.window.showInputBox({
            title: t("Search dsh sessions"),
            prompt: t("Search session message content"),
            ignoreFocusOut: true,
            validateInput: (value) => (value.trim() ? undefined : t("Enter a search query.")),
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
                placeHolder: result.hasMore ? t("Select a session (results truncated)") : t("Select a session"),
                matchOnDescription: true,
                matchOnDetail: true,
            },
        );
        if (choice) await this.switchSession(choice.sessionId);
    }

    public async selectModel(): Promise<void> {
        if (!this.sessionId) throw new Error(t("There is no current session."));
        if (!this.runtime.getUrl()) await this.runtime.start(this.workspaceRoot());
        const catalog = await this.runtime.models(this.sessionId);
        this.selectedModels.set(this.sessionId, {
            selection: catalog.current,
            asOfSeq: highestKnownSeq(this.runtime.getSessionStore().get(this.sessionId)),
        });
        this.schedulePostState();
        if (!catalog.routable) {
            throw new Error(t("The current session has no routable model."));
        }
        const items = catalog.groups.flatMap((group) => group.models.map((model) => ({
            label: `${group.name || group.provider} / ${model.name || model.id}`,
            description: group.provider === catalog.current.provider && model.id === catalog.current.model
                ? t("Current model")
                : model.id,
            provider: group.provider,
            model: model.id,
            efforts: model.reasoningEfforts ?? [],
        })));
        if (items.length === 0) throw new Error(t("Harness returned no available models."));
        const picked = await vscode.window.showQuickPick(items, {
            title: t("Select Harness model"),
            placeHolder: `${catalog.current.provider} / ${catalog.current.model}`,
        });
        if (!picked) return;
        let reasoningEffort: string | undefined;
        if (picked.efforts.length > 0) {
            reasoningEffort = await vscode.window.showQuickPick(picked.efforts, {
                title: t("Select reasoning effort"),
                placeHolder: catalog.current.reasoningEffort ?? t("Default"),
            });
            if (reasoningEffort === undefined) return;
        }
        const result = await this.runtime.selectModel({
            sessionId: this.sessionId,
            provider: picked.provider,
            model: picked.model,
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        });
        this.selectedModels.set(this.sessionId, {
            selection: result.selected,
            asOfSeq: highestKnownSeq(this.runtime.getSessionStore().get(this.sessionId)),
        });
        this.output.appendLine(`[dsh:model] selected ${result.selected.provider}/${result.selected.model}`);
        this.postState();
    }

    public async selectAgentPreset(requestedPreset?: string): Promise<void> {
        if (!this.sessionId) throw new Error(t("There is no current session."));
        if (!this.runtime.getUrl()) await this.runtime.start(this.workspaceRoot());
        const catalog = await this.runtime.agentPresets();
        const available = catalog.presets.filter((preset) => !preset.broken);
        if (available.length === 0) throw new Error(t("Harness returned no available agent modes."));

        let target = requestedPreset
            ? available.find((preset) => preset.id === requestedPreset)
            : undefined;
        if (requestedPreset && !target) {
            throw new Error(t("Agent mode “{preset}” does not exist. Available modes: {available}.", {
                preset: requestedPreset,
                available: available.map((preset) => preset.id).join(", "),
            }));
        }
        if (!target) {
            const current = this.runtime.getSessionCatalog().snapshot().sessions
                .find((session) => session.sessionId === this.sessionId)?.agentPreset;
            target = await vscode.window.showQuickPick(
                available.map((preset) => ({
                    label: preset.name || preset.id,
                    description: preset.id === current ? t("Current mode") : preset.id,
                    detail: preset.description,
                    preset,
                })),
                { title: t("Select Harness agent mode"), placeHolder: current || t("Select mode") },
            ).then((picked) => picked?.preset);
        }
        if (!target) return;

        const currentSession = this.runtime.getSessionCatalog().snapshot().sessions
            .find((session) => session.sessionId === this.sessionId);
        if (currentSession?.blank === false) {
            const createWithMode = t("Create a session with {mode}", { mode: target.name || target.id });
            const choice = await vscode.window.showWarningMessage(
                t("The current session has already started, so its agent mode cannot be changed."),
                createWithMode,
            );
            if (choice) await this.newSession(target.id);
            return;
        }

        let result;
        try {
            result = await this.runtime.selectAgentPreset(this.sessionId, target.id);
        } catch (error) {
            if (!(error instanceof HarnessRpcError) || error.rpcError.code !== "agent-preset-locked") {
                throw error;
            }
            const createWithMode = t("Create a session with {mode}", { mode: target.name || target.id });
            const choice = await vscode.window.showWarningMessage(
                t("The current session has already started, so its agent mode cannot be changed."),
                createWithMode,
            );
            if (choice) await this.newSession(target.id);
            return;
        }
        this.output.appendLine(`[dsh:agent-preset] selected ${result.agentPreset}`);
        await this.runtime.refreshSessions();
        this.postState();
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
            { placeHolder: t("Select a dsh session"), matchOnDescription: true, matchOnDetail: true },
        );
        if (choice) await this.switchSession(choice.sessionId);
    }

    public async renameSession(): Promise<void> {
        if (!this.sessionId) throw new Error(t("There is no current session."));
        const current = this.runtime
            .getSessionCatalog()
            .snapshot()
            .sessions.find((item) => item.sessionId === this.sessionId);
        const title = await vscode.window.showInputBox({
            title: t("Rename dsh session"),
            value: current?.title ?? "",
            ignoreFocusOut: true,
            validateInput: (value) => (value.trim() ? undefined : t("The title cannot be empty.")),
        });
        if (title === undefined) return;
        await this.runtime.renameSession(this.sessionId, title);
    }

    public async forkSession(): Promise<void> {
        if (!this.sessionId) throw new Error(t("There is no current session."));
        const forked = await this.runtime.forkSession(this.sessionId);
        await this.switchSession(forked.sessionId);
    }

    public async archiveSession(): Promise<void> {
        if (!this.sessionId) throw new Error(t("There is no current session."));
        const archiveAction = t("Archive");
        const confirmation = await vscode.window.showWarningMessage(
            t("Archive the current session and hide it from the DSH IDE session list? Archived sessions can be managed in the official dsh Web UI."),
            { modal: true },
            archiveAction,
        );
        if (confirmation !== archiveAction) return;
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
            throw new Error(t("The current Harness does not provide a goal projection, so the Goal HUD remains hidden."));
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
                    throw new Error(t("A replacement Goal can only be created when the current Goal is empty or complete."));
                }
                const result = await this.runtime.createGoal(
                    sessionId,
                    action.objective,
                    action.maxGoalRounds,
                );
                const ref = normalizeGoalRef(result.ref);
                if (!ref) throw new Error(t("Harness returned an invalid goal.create ref."));
                this.goalMutations.acknowledgeRef(sessionId, ref);
            } else {
                if (parsed.value === null) throw new Error(t("The current session has no actionable Goal."));
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
                    if (!nextRef) throw new Error(t("Harness returned an invalid goal.edit ref."));
                    this.goalMutations.acknowledgeRef(sessionId, nextRef);
                } else if (action.type === "goalPause") {
                    const result = await this.runtime.pauseGoal(sessionId, ref);
                    const nextRef = normalizeGoalRef(result.ref);
                    if (!nextRef) throw new Error(t("Harness returned an invalid goal.pause ref."));
                    this.goalMutations.acknowledgeRef(sessionId, nextRef);
                } else if (action.type === "goalResume") {
                    const result = await this.runtime.resumeGoal(sessionId, ref);
                    const nextRef = normalizeGoalRef(result.ref);
                    if (!nextRef) throw new Error(t("Harness returned an invalid goal.resume ref."));
                    this.goalMutations.acknowledgeRef(sessionId, nextRef);
                } else if (action.type === "goalComplete") {
                    const result = await this.runtime.completeGoal(sessionId, ref);
                    const nextRef = normalizeGoalRef(result.ref);
                    if (!nextRef) throw new Error(t("Harness returned an invalid goal.complete ref."));
                    this.goalMutations.acknowledgeRef(sessionId, nextRef);
                } else if (action.type === "goalClear") {
                    const result = await this.runtime.clearGoal(sessionId, ref);
                    if (result.cleared !== true) {
                        throw new Error(t("Harness returned an invalid goal.clear acknowledgement."));
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
                    throw new Error(t("Harness returned an invalid subagent.list for {sessionId}.", { sessionId: parentSessionId }));
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
                        error: t("This subagent is no longer in the current official catalog."),
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
                throw new Error(t("Subagent {sessionId} history pagination did not provide an earlier seq.", { sessionId: address.childSessionId }));
            }
            const page = await this.runtime.subagentHistory(address, beforeSeq, 100, signal);
            pages.push(page.events);
            const nextBeforeSeq = lowestEventSeq(page.events);
            if (page.hasMore && (nextBeforeSeq === undefined || nextBeforeSeq >= beforeSeq)) {
                throw new Error(t("Subagent {sessionId} history pagination did not advance.", { sessionId: address.childSessionId }));
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
                throw new Error(t("Harness returned an invalid subagent.prompt acknowledgement."));
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
                throw new Error(t("Harness returned an invalid subagent.interrupt acknowledgement."));
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
        if (invalid) throw new Error(t("{message} Sending was refused.", { message: invalid }));
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
            const configureKeyAction = t("Configure API Key");
            const openWebUiAction = t("Open dsh Web UI");
            void vscode.window
                .showErrorMessage(`DSH: ${message}`, configureKeyAction, openWebUiAction)
                .then((action) => {
                    if (action === configureKeyAction) {
                        void this.configureApiKey().catch((configureError) =>
                            this.reportError(configureError),
                        );
                    } else if (action === openWebUiAction) {
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
        this.pendingComposerUpdate = { type: "insertText", text };
        this.reveal();
        this.flushPendingComposerUpdate();
    }

    private setComposerText(text: string): void {
        this.pendingComposerUpdate = { type: "setText", text };
        this.reveal();
        this.flushPendingComposerUpdate();
    }

    private flushPendingComposerUpdate(): void {
        if (!this.view || !this.webviewReady || !this.pendingComposerUpdate) {
            return;
        }
        const update = this.pendingComposerUpdate;
        this.pendingComposerUpdate = undefined;
        void this.view.webview.postMessage(update);
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
        const permissionsCell = session?.projections.find((cell) => cell.key === "permissions");
        const host = presentHostBaseline(this.runtime.getHostDescription());
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
            messages: this.renderMessages(
                focusChatMessages(
                    projectChatMessages(session, this.optimisticPrompts),
                    this.focusMode,
                ),
                `session:${this.sessionId ?? "none"}`,
            ),
            context: this.contextStore.snapshot(),
            fileReferenceCandidates: this.fileReferenceCandidates,
            selection: this.contextStore.getCurrentSelectionMetadata(),
            selectionEnabled: this.selectionEnabled,
            status: this.runtime.getStatus(),
            busy: selected?.running === true,
            submitting: this.submitting,
            cancelling: this.cancelRequested && selected?.running === true,
            focusMode: this.focusMode,
            workspaceName: workspaceFolder?.name,
            host,
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
                      turn: projectTurnStatus(
                          session,
                          selected.running === true,
                          selected.lastAgentError,
                      ),
                      ...(selected.lastAgentError === undefined
                          ? {}
                          : { error: selected.lastAgentError }),
                  }
                : undefined,
            tokenUsage: projectTokenUsage(
                session,
                this.sessionId ? this.selectedModels.get(this.sessionId) : undefined,
                host,
            ),
            permissions: permissionProjection(permissionsCell?.value),
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
                    : (() => {
                          const review = presentPlanReview(interaction.questions);
                          return review
                              ? {
                                    key: interaction.key,
                                    kind: "plan-review" as const,
                                    status: interaction.status,
                                    review,
                                    planHtml: renderSafeMarkdown(review.plan),
                                    ...(interaction.outcome === undefined
                                        ? {}
                                        : { outcome: interaction.outcome }),
                                    ...(interaction.error === undefined
                                        ? {}
                                        : { error: interaction.error }),
                                }
                              : {
                                    key: interaction.key,
                                    kind: "question" as const,
                                    status: interaction.status,
                                    questions: [...interaction.questions],
                                    ...(interaction.outcome === undefined
                                        ? {}
                                        : { outcome: interaction.outcome }),
                                    ...(interaction.error === undefined
                                        ? {}
                                        : { error: interaction.error }),
                                };
                      })(),
            ),
            queue: queueDockItems(session?.queue.items ?? []),
            goal: this.sessionId
                ? presentGoalHud(goalCell, this.goalMutations.snapshot(this.sessionId))
                : undefined,
            subagents: this.sessionId ? this.subagentTrees.get(this.sessionId) : undefined,
            subagentPreview:
                this.sessionId && this.subagentPreview?.rootSessionId === this.sessionId
                    ? {
                          ...this.subagentPreview,
                          messages: this.renderMessages(
                              this.subagentPreview.messages,
                              `subagent:${this.subagentPreview.childSessionId}`,
                          ),
                      }
                    : undefined,
            jobs: this.sessionId
                ? presentJobCenter(this.sessionId, session?.jobs.items ?? [])
                : [],
            changeReviews: this.changeReviews.view(this.sessionId),
        };
        void this.view.webview.postMessage({
            type: "state",
            protocol: CHAT_WEBVIEW_PROTOCOL_VERSION,
            state,
        });
        this.updateViewBadge(catalog.sessions);
    }

    private seedObservedRunning(): void {
        for (const session of this.runtime.getSessionCatalog().snapshot().sessions) {
            this.observedRunning.set(session.sessionId, session.running === true);
        }
    }

    private observeSessionTransitions(): void {
        const sessions = this.runtime.getSessionCatalog().snapshot().sessions;
        for (const session of sessions) {
            const running = session.running === true;
            const previous = this.observedRunning.get(session.sessionId);
            if (previous === true && !running && this.view && !this.view.visible) {
                this.completedWhileHidden.add(session.sessionId);
            }
            this.observedRunning.set(session.sessionId, running);
        }
        const currentIds = new Set(sessions.map((session) => session.sessionId));
        for (const sessionId of this.observedRunning.keys()) {
            if (!currentIds.has(sessionId)) this.observedRunning.delete(sessionId);
        }
        this.updateViewBadge(sessions);
    }

    private updateViewBadge(sessions = this.runtime.getSessionCatalog().snapshot().sessions): void {
        if (!this.view) return;
        if (this.view.visible) {
            this.completedWhileHidden.clear();
            this.view.badge = undefined;
            return;
        }
        this.view.badge = hiddenViewBadge(sessions, this.completedWhileHidden);
    }

    private renderMessages(messages: readonly ChatMessage[], scope: string): ChatMessage[] {
        return messages.map((message) => {
            const key = `${scope}:${message.role}:${message.id}`;
            const reasoningSource = message.role === "assistant" && message.reasoning
                ? message.reasoning
                : undefined;
            const cached = this.markdownCache.get(key);
            if (
                cached?.source === message.text &&
                cached.reasoningSource === reasoningSource
            ) {
                return {
                    ...message,
                    renderedHtml: cached.html,
                    renderId: cached.renderId,
                    ...(cached.reasoningHtml === undefined
                        ? {}
                        : { renderedReasoningHtml: cached.reasoningHtml }),
                    ...(cached.reasoningRenderId === undefined
                        ? {}
                        : { reasoningRenderId: cached.reasoningRenderId }),
                };
            }
            const rendered = renderMarkdownMessage(message.text);
            const renderedReasoning = reasoningSource === undefined
                ? undefined
                : renderMarkdownMessage(reasoningSource);
            const html = rendered.html;
            if (!cached && this.markdownCache.size >= 2_000) {
                const oldest = this.markdownCache.keys().next().value as string | undefined;
                if (oldest !== undefined) {
                    const evicted = this.markdownCache.get(oldest);
                    if (evicted) this.discardMarkdownPayloads(evicted);
                    this.markdownCache.delete(oldest);
                }
            }
            if (cached) this.discardMarkdownPayloads(cached);
            const renderId = randomUUID().replace(/-/gu, "");
            const codeBlocks = new Map(rendered.codeBlocks.map((block) => [block.id, block.text]));
            const reasoningRenderId = renderedReasoning === undefined
                ? undefined
                : randomUUID().replace(/-/gu, "");
            const reasoningCodeBlocks = renderedReasoning === undefined
                ? undefined
                : new Map(renderedReasoning.codeBlocks.map((block) => [block.id, block.text]));
            this.markdownCache.set(key, {
                source: message.text,
                ...(reasoningSource === undefined ? {} : { reasoningSource }),
                html,
                renderId,
                codeBlocks,
                ...(renderedReasoning === undefined
                    ? {}
                    : { reasoningHtml: renderedReasoning.html }),
                ...(reasoningRenderId === undefined ? {} : { reasoningRenderId }),
            });
            this.copyableCodeByRenderId.set(renderId, codeBlocks);
            if (reasoningRenderId && reasoningCodeBlocks) {
                this.copyableCodeByRenderId.set(reasoningRenderId, reasoningCodeBlocks);
            }
            return {
                ...message,
                renderedHtml: html,
                renderId,
                ...(renderedReasoning === undefined
                    ? {}
                    : { renderedReasoningHtml: renderedReasoning.html }),
                ...(reasoningRenderId === undefined ? {} : { reasoningRenderId }),
            };
        });
    }

    private discardMarkdownPayloads(cached: {
        renderId: string;
        reasoningRenderId?: string;
    }): void {
        this.copyableCodeByRenderId.delete(cached.renderId);
        if (cached.reasoningRenderId) {
            this.copyableCodeByRenderId.delete(cached.reasoningRenderId);
        }
    }

    private async copyCodeBlock(renderId: string, codeBlockId: string): Promise<void> {
        const text = this.copyableCodeByRenderId.get(renderId)?.get(codeBlockId);
        if (text === undefined || !isCopyableCode(text)) {
            throw new Error(t("The code block does not exist or exceeds the copy size limit."));
        }
        await vscode.env.clipboard.writeText(text);
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
        const language = vscode.env.language.replace(/[^a-z0-9-]/giu, "") || "en";
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, "webview", "dist", "main.js"),
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, "webview", "dist", "main.css"),
        );
        return `<!DOCTYPE html>
<html lang="${language}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${styleUri}">
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
