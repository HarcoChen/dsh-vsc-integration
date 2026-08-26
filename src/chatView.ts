import { randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import * as vscode from "vscode";
import { AgentStatusPresentationRegistry } from "./agentStatusPresentation";
import { captureAppShot as captureNativeAppShot } from "./appShot";
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
import { goalActionAllowed, goalOperationFor } from "./goalActions";
import { isImageMediaType } from "./guards";
import { manageProviders as runProviderManagement } from "./providerManagement";
import {
    applyCodeBlock,
    copyCodeBlock,
    insertCodeBlock,
    openCodeBlock,
} from "./codeBlockActions";
import { MarkdownRenderCache } from "./markdownRenderCache";
import { samePath } from "./paths";
import { projectionCell, projectionValue } from "./sessionStore";
import { HarnessRpcError } from "./harnessClient";
import { presentHostBaseline } from "./hostState";
import { t } from "./localize";
import {
    imageLimitsProjection,
    permissionProjection,
    prepareImageUploads,
    presentSettingsPanel,
    settingsMutationOps,
    reasoningEffortOptions,
    sessionStatsProjection,
    todoProjection,
} from "./chatViewPresentation";
import {
    parseSafeHttpUrl,
    renderSafeMarkdown,
} from "./safeMarkdown";
import {
    GoalMutationGate,
    type GoalMutationOperation,
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
    ChatImageView,
    ChatMessage,
    DshAgentPresetEntry,
    DshApprovalResponse,
    DshContextItem,
    DshHistoryEntry,
    DshImageLimitsView,
    DshImageUpload,
    DshQuestionResponse,
    DshReferenceCandidate,
    DshReasoningEffortOption,
    DshSessionSearchItem,
    DshSessionModelsResult,
    DshSettingFieldType,
    DshSettingFieldView,
    DshSettingsCardView,
    DshSettingsPanelView,
    DshSettingsNamespaceView,
    DshSkillEntry,
    DshSubagentAddress,
    DshSubagentCatalog,
    DshTodoItemView,
    DshWorkspaceView,
    PermissionProjectionView,
    SessionStatsView,
    SubagentHistoryPreview,
    SubagentTreeNodeView,
} from "./types";
import { projectTokenUsage, SelectedModelSnapshot } from "./tokenUsage";
import { openWorkspaceFileLocation } from "./workspaceNavigation";
import { errorMessage } from "./errors";

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

const AGENT_PRESET_ID = /^[a-z0-9][a-z0-9-]*$/u;
const AGENT_PRESET_DOCUMENT_SCHEME = "dsh-agent-preset";
const DEFAULT_AGENT_STATUS_LABELS = [
    "大肥鱼正在深潜…",
    "大肥鱼摆摆尾巴，想想办法…",
    "大肥鱼翻了个身，继续思考…",
    "大肥鱼正在吞吐上下文…",
    "大肥鱼在鱼缸里转圈…",
    "大肥鱼：这题我会…",
] as const;


type PromptCommandName = "compact" | "goal";

interface PromptCommandResult {
    accepted?: boolean;
    command?: unknown;
}

function assertPromptCommandSuccess(
    commandResult: PromptCommandResult,
    commandName: PromptCommandName,
): void {
    if (commandResult.accepted === false) {
        throw new Error(t("The dsh runtime rejected this command."));
    }
    const messages = commandName === "compact"
        ? {
              unavailable: t("The connected dsh server does not expose the /compact command. Update dsh or enable the command-compact package."),
              rejected: t("The dsh server rejected the /compact command."),
              invalid: t("The connected dsh server returned an invalid /compact command result."),
          }
        : {
              unavailable: t("The connected dsh server does not expose the /goal command. Update dsh or enable the command-goal package."),
              rejected: t("The dsh server rejected the /goal command."),
              invalid: t("The connected dsh server returned an invalid /goal command result."),
          };
    const command = commandResult.command;
    if (!command || typeof command !== "object" || Array.isArray(command)) {
        throw new Error(messages.unavailable);
    }
    const commandRecord = command as Record<string, unknown>;
    if (commandRecord.kind === "error") {
        const message = typeof commandRecord.text === "string" && commandRecord.text.trim()
            ? commandRecord.text
            : messages.rejected;
        throw new Error(message);
    }
    if (commandRecord.kind !== "success") {
        throw new Error(messages.invalid);
    }
}

const GOAL_RPC_ERROR_PREFIX = /^Harness RPC goal\.(?:create|edit|pause|resume|complete|clear) failed:\s*[^:]+:\s*/u;

function goalErrorCode(error: unknown): string | undefined {
    if (!(error instanceof HarnessRpcError)) return undefined;
    const details = error.rpcError.details;
    if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
    const code = (details as { goalCode?: unknown }).goalCode;
    return typeof code === "string" ? code : undefined;
}

function goalErrorForHud(error: unknown, operation: GoalMutationOperation): string {
    const raw = errorMessage(error).trim();
    const normalized = raw
        .replace(GOAL_RPC_ERROR_PREFIX, "")
        .replace(/^GoalError:\s*/iu, "")
        .trim();
    const lower = normalized.toLowerCase();
    const code = goalErrorCode(error);
    let summary = normalized || raw;
    if (operation === "resume" && /\b(active|running)\b/u.test(lower)) {
        summary = t("Goal is already active; resume is not needed.");
    } else if (operation === "resume" && /\b(max(?:imum)?|limit|exhausted|no more).*round|round.*(max(?:imum)?|limit|exhausted)/u.test(lower)) {
        summary = t("Goal has reached its maximum rounds and cannot be resumed.");
    } else if (operation === "resume" && /\bblocked\b/u.test(lower)) {
        summary = t("Goal is blocked; resolve the blocking reason before resuming.");
    } else if (operation === "resume" && /\bcomplete(?:d)?\b/u.test(lower)) {
        summary = t("Goal is already completed.");
    } else if (operation === "pause" && /\bpaused\b/u.test(lower)) {
        summary = t("Goal is already paused.");
    } else if (operation === "complete" && /\bcomplete(?:d)?\b/u.test(lower)) {
        summary = t("Goal is already completed.");
    } else if (code === "GOAL_NOT_FOUND" || /not found|does not exist|no goal|missing/u.test(lower)) {
        summary = t("The current session has no Goal to change.");
    } else if (code === "GOAL_STALE_REVISION" || /revision|stale|conflict|compare[- ]and[- ]set|\bcas\b/u.test(lower)) {
        summary = t("Goal changed elsewhere; refresh and try again.");
    }
    return summary === raw ? summary : `${summary}\n${raw}`;
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

/**
 * Default sprite image used as the reasoning effort slider knob, e.g. the
 * 8-frame "chibi runner" strip from the dsh-reasoning-effort plugin.
 * Applied to every effort unless overridden per-id below.
 */
const REASONING_EFFORT_KNOB_IMAGE = "chibi-runner-strip.png";

/**
 * Per-effort knob image overrides.
 * Maps an effort id (e.g. "low") to an image file inside `resources/`.
 */
const REASONING_EFFORT_IMAGES: Readonly<Record<string, string>> = {};

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = "dsh.chatView";

    private view: vscode.WebviewView | undefined;
    private viewMessageDisposable: vscode.Disposable | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly optimisticPrompts: OptimisticPrompt[] = [];
    private readonly markdownRenders = new MarkdownRenderCache();
    private readonly goalMutations = new GoalMutationGate();
    private readonly subagentTrees = new SubagentTreeStore();
    private readonly subagentTreeAborts = new Map<string, AbortController>();
    private subagentPreview: SubagentHistoryPreview | undefined;
    private subagentPreviewAbort: AbortController | undefined;
    private subagentPreviewGeneration = 0;
    private sessionId: string | undefined;
    private sessionCwd: string | undefined;
    private newSessionDraft = false;
    private pendingNewSessionPreset: string | undefined;
    private pendingNewSessionWorkspaceId: string | undefined;
    private pendingNewSessionWorkspacePath: string | undefined;
    private pendingNewSessionWorkspaceTitle: string | undefined;
    private submitting = false;
    private cancelRequested = false;
    private selectionEnabled = true;
    private focusMode = false;
    private fileReferenceCandidates: DshReferenceCandidate[] = [];
    private fileReferenceQueryGeneration = 0;
    private pendingComposerUpdate: { type: "insertText" | "setText"; text: string } | undefined;
    private readonly pendingComposerImages: DshImageUpload[] = [];
    private webviewReady = false;
    private restoringPersistedSession: Promise<void> | undefined;
    private stateUpdateTimer: ReturnType<typeof setTimeout> | undefined;
    private subagentRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly observedRunning = new Map<string, boolean>();
    private readonly completedWhileHidden = new Set<string>();
    private readonly selectedModels = new Map<string, SelectedModelSnapshot>();
    private readonly modelCatalogs = new Map<string, DshSessionModelsResult>();
    private readonly modelCatalogRequests = new Map<string, Promise<void>>();
    private readonly skillCatalogs = new Map<string, DshSkillEntry[]>();
    private readonly skillCatalogRequests = new Map<string, Promise<void>>();
    private agentPresetCatalog: DshAgentPresetEntry[] | undefined;
    private agentPresetCatalogRequest: Promise<void> | undefined;
    private pendingNewSessionSkills: DshSkillEntry[] | undefined;
    private readonly agentPresetDocuments = new Map<string, string>();
    private readonly imageCache = new Map<string, { src?: string; error?: string; loading?: boolean }>();
    private settingsPanel: DshSettingsPanelView | undefined;
    private readonly settingsNamespaces = new Map<string, DshSettingsNamespaceView>();
    private settingsPanelGeneration = 0;
    private readonly changeReviews: ChangeReviewStore;
    private agentStatusChoice: { sessionId: string; candidateKey: string; label: string } | undefined;

    public constructor(
        private readonly extensionContext: vscode.ExtensionContext,
        private readonly extensionUri: vscode.Uri,
        private readonly runtime: DshRuntime,
        private readonly contextStore: ContextStore,
        private readonly output: vscode.OutputChannel,
        private readonly balanceService?: DeepSeekBalanceService,
        private readonly agentStatusPresentations?: AgentStatusPresentationRegistry,
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
                    projectionCell(snapshot, "goal"),
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
            vscode.workspace.registerTextDocumentContentProvider(
                AGENT_PRESET_DOCUMENT_SCHEME,
                {
                    provideTextDocumentContent: (uri) =>
                        this.agentPresetDocuments.get(uri.toString()) ?? "",
                },
            ),
            vscode.workspace.onDidCloseTextDocument((document) => {
                if (document.uri.scheme === AGENT_PRESET_DOCUMENT_SCHEME) {
                    this.agentPresetDocuments.delete(document.uri.toString());
                }
            }),
            runtime.onDidChange(() => this.schedulePostState()),
            agentStatusPresentations?.onDidChange(() => this.schedulePostState()) ?? new vscode.Disposable(() => {}),
            runtime.onDidHarnessConnect(() => {
                void this.restorePersistedSession(this.workspaceRoot()).then(() => {
                    if (this.sessionId) {
                        this.refreshModelCatalog(this.sessionId);
                        this.refreshSkillCatalog(this.sessionId);
                        void this.refreshSubagentTree(this.sessionId);
                    }
                });
            }),
            contextStore.onDidChange(() => this.schedulePostState()),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (
                    event.affectsConfiguration("dsh.agentStatusLabel") ||
                    event.affectsConfiguration("dsh.agentStatusLabels")
                ) {
                    this.agentStatusChoice = undefined;
                    this.schedulePostState();
                }
            }),
            vscode.window.onDidChangeActiveTextEditor(() => this.schedulePostState()),
            vscode.window.onDidChangeTextEditorSelection(() => this.schedulePostState()),
            this.changeReviews.onDidUpdate(() => this.schedulePostState()),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration("dsh.enableEffortKnob")) {
                    this.schedulePostState();
                }
            }),
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

    public async manageWorkspaces(): Promise<void> {
        const workspaceRoot = this.workspaceRoot();
        await this.runtime.start(workspaceRoot);
        await this.runtime.refreshSessions();

        while (true) {
            const catalog = this.runtime.getSessionCatalog().snapshot();
            const currentRegistered = workspaceRoot
                ? catalog.workspaces.some((workspace) => samePath(workspace.path, workspaceRoot))
                : true;
            type WorkspaceChoice = vscode.QuickPickItem &
                ({ choiceType: "workspace"; workspace: DshWorkspaceView } | { choiceType: "register" });
            const choices: WorkspaceChoice[] = [
                ...(!currentRegistered && workspaceRoot ? [{
                    choiceType: "register" as const,
                    label: `$(add) ${t("Register current folder as a DSH Workspace")}`,
                    detail: workspaceRoot,
                    alwaysShow: true,
                }] : []),
                ...catalog.workspaces.map((workspace): WorkspaceChoice => ({
                    choiceType: "workspace",
                    workspace,
                    label: `$(folder) ${workspace.title}`,
                    description: t("{count} sessions", { count: workspace.sessionIds.length }),
                    detail: workspace.path,
                })),
            ];
            if (choices.length === 0) {
                void vscode.window.showInformationMessage(t("No DSH Workspaces are registered."));
                return;
            }
            const selected = await vscode.window.showQuickPick(choices, {
                title: t("Manage DSH Workspaces"),
                placeHolder: t("Choose a Workspace to manage"),
                matchOnDescription: true,
                matchOnDetail: true,
            });
            if (!selected) return;
            if (selected.choiceType === "register") {
                if (workspaceRoot) {
                    await this.runtime.createWorkspace(workspaceRoot);
                    await this.runtime.refreshSessions();
                }
                continue;
            }

            const action = await this.chooseWorkspaceAction(selected.workspace, catalog.workspaces);
            if (!action) continue;
            if (action === "rename") {
                await this.renameWorkspace(selected.workspace);
            } else if (action === "sessions") {
                await this.reorderWorkspaceSession(selected.workspace);
            } else if (action === "remove") {
                await this.removeWorkspace(selected.workspace);
            } else {
                await this.reorderWorkspace(selected.workspace, catalog.workspaces, action);
            }
        }
    }

    private async chooseWorkspaceAction(
        workspace: DshWorkspaceView,
        workspaces: readonly DshWorkspaceView[],
    ): Promise<"rename" | "top" | "up" | "down" | "bottom" | "sessions" | "remove" | undefined> {
        const index = workspaces.findIndex((candidate) => candidate.workspaceId === workspace.workspaceId);
        const actions: Array<vscode.QuickPickItem & {
            action: "rename" | "top" | "up" | "down" | "bottom" | "sessions" | "remove";
        }> = [{
            action: "rename",
            label: `$(edit) ${t("Rename Workspace")}`,
            detail: workspace.path,
        }];
        if (index > 0) {
            actions.push(
                { action: "top", label: `$(fold-up) ${t("Move Workspace to top")}` },
                { action: "up", label: `$(arrow-up) ${t("Move Workspace up")}` },
            );
        }
        if (index >= 0 && index < workspaces.length - 1) {
            actions.push(
                { action: "down", label: `$(arrow-down) ${t("Move Workspace down")}` },
                { action: "bottom", label: `$(fold-down) ${t("Move Workspace to bottom")}` },
            );
        }
        if (workspace.sessionIds.length > 1) {
            actions.push({
                action: "sessions",
                label: `$(list-ordered) ${t("Reorder sessions")}`,
                detail: t("{count} sessions", { count: workspace.sessionIds.length }),
            });
        }
        actions.push({
            action: "remove",
            label: `$(trash) ${t("Remove Workspace group")}`,
            detail: t("Keep its directory and Session logs"),
        });
        const selected = await vscode.window.showQuickPick(actions, {
            title: workspace.title,
            placeHolder: t("Choose an action"),
        });
        return selected?.action;
    }

    private async renameWorkspace(workspace: DshWorkspaceView): Promise<void> {
        const title = await vscode.window.showInputBox({
            title: t("Rename DSH Workspace"),
            value: workspace.title,
            prompt: workspace.path,
            ignoreFocusOut: true,
            validateInput: (value) => value.trim() ? undefined : t("The title cannot be empty."),
        });
        if (title === undefined || title.trim() === workspace.title) return;
        const renamed = await this.runtime.renameWorkspace(workspace.workspaceId, title.trim());
        if (this.pendingNewSessionWorkspaceId === workspace.workspaceId) {
            this.pendingNewSessionWorkspaceTitle = renamed.title;
            this.postState();
        }
    }

    private async reorderWorkspace(
        workspace: DshWorkspaceView,
        workspaces: readonly DshWorkspaceView[],
        direction: "top" | "up" | "down" | "bottom",
    ): Promise<void> {
        const index = workspaces.findIndex((candidate) => candidate.workspaceId === workspace.workspaceId);
        if (index < 0) return;
        let beforeWorkspaceId: string | undefined;
        if (direction === "top") {
            beforeWorkspaceId = workspaces[0]?.workspaceId;
        } else if (direction === "up") {
            beforeWorkspaceId = workspaces[index - 1]?.workspaceId;
        } else if (direction === "down") {
            beforeWorkspaceId = workspaces[index + 2]?.workspaceId;
        }
        await this.runtime.moveWorkspace(workspace.workspaceId, beforeWorkspaceId);
    }

    private async reorderWorkspaceSession(workspace: DshWorkspaceView): Promise<void> {
        const catalog = this.runtime.getSessionCatalog().snapshot();
        const sessions = new Map(catalog.sessions.map((session) => [session.sessionId, session]));
        const archived = new Set(catalog.archivedSessionIds);
        const selected = await vscode.window.showQuickPick(
            workspace.sessionIds.map((sessionId, index) => {
                const session = sessions.get(sessionId);
                return {
                    label: `${archived.has(sessionId) ? "$(archive)" : "$(comment-discussion)"} ${session?.title || sessionId}`,
                    description: t("Position {position}", { position: index + 1 }),
                    detail: archived.has(sessionId) ? t("Archived Session") : session?.cwd,
                    sessionId,
                };
            }),
            {
                title: t("Reorder sessions in {workspace}", { workspace: workspace.title }),
                placeHolder: t("Choose a Session to move"),
                matchOnDescription: true,
                matchOnDetail: true,
            },
        );
        if (!selected) return;

        const index = workspace.sessionIds.indexOf(selected.sessionId);
        const actions: Array<vscode.QuickPickItem & { direction: "top" | "up" | "down" | "bottom" }> = [];
        if (index > 0) {
            actions.push(
                { direction: "top", label: `$(fold-up) ${t("Move Session to top")}` },
                { direction: "up", label: `$(arrow-up) ${t("Move Session up")}` },
            );
        }
        if (index >= 0 && index < workspace.sessionIds.length - 1) {
            actions.push(
                { direction: "down", label: `$(arrow-down) ${t("Move Session down")}` },
                { direction: "bottom", label: `$(fold-down) ${t("Move Session to bottom")}` },
            );
        }
        if (actions.length === 0) return;
        const move = await vscode.window.showQuickPick(actions, {
            title: sessions.get(selected.sessionId)?.title || selected.sessionId,
            placeHolder: t("Choose a new position"),
        });
        if (!move) return;

        let beforeSessionId: string | undefined;
        if (move.direction === "top") {
            beforeSessionId = workspace.sessionIds[0];
        } else if (move.direction === "up") {
            beforeSessionId = workspace.sessionIds[index - 1];
        } else if (move.direction === "down") {
            beforeSessionId = workspace.sessionIds[index + 2];
        }
        await this.runtime.moveWorkspaceSession(
            workspace.workspaceId,
            selected.sessionId,
            beforeSessionId,
        );
    }

    private async removeWorkspace(workspace: DshWorkspaceView): Promise<void> {
        const remove = t("Remove Workspace group");
        const confirmed = await vscode.window.showWarningMessage(
            t("Remove DSH Workspace group {workspace}?", { workspace: workspace.title }),
            {
                modal: true,
                detail: t("The directory and all Session logs will be kept. Its Sessions will appear as ungrouped."),
            },
            remove,
        );
        if (confirmed !== remove) return;
        await this.runtime.deleteWorkspace(workspace.workspaceId);
        if (this.pendingNewSessionWorkspaceId === workspace.workspaceId) {
            this.pendingNewSessionWorkspaceId = undefined;
            this.pendingNewSessionWorkspacePath = undefined;
            this.pendingNewSessionWorkspaceTitle = undefined;
            this.pendingNewSessionSkills = undefined;
            this.postState();
        }
    }

    public async manageAgentPresets(): Promise<void> {
        await this.runtime.start(this.workspaceRoot());

        while (true) {
            const [catalog, settingsWritable] = await Promise.all([
                this.runtime.agentPresets(),
                this.runtime.describeSettings()
                    .then((settings) => settings.writable)
                    .catch((error) => {
                        this.output.appendLine(`[dsh:agent-preset] settings status unavailable: ${errorMessage(error)}`);
                        return false;
                    }),
            ]);
            this.agentPresetCatalog = catalog.presets;
            if (catalog.presets.length === 0) {
                void vscode.window.showInformationMessage(t("Harness returned no Agent Presets to manage."));
                return;
            }
            const selected = await vscode.window.showQuickPick(
                catalog.presets.map((preset) => ({
                    label: `${preset.broken ? "$(error)" : preset.trust === "system" ? "$(verified)" : "$(person)"} ${preset.name || preset.id}`,
                    description: [
                        preset.id,
                        preset.trust === "system" ? t("System") : t("User"),
                        ...(preset.isDefault ? [t("Default")] : []),
                    ].join(" · "),
                    detail: preset.broken
                        ? t("Broken: {reason}", { reason: preset.broken })
                        : preset.description,
                    preset,
                })),
                {
                    title: t("Manage Agent Presets"),
                    placeHolder: t("Choose an Agent Preset to manage"),
                    matchOnDescription: true,
                    matchOnDetail: true,
                },
            );
            if (!selected) return;

            const action = await this.chooseAgentPresetAction(
                selected.preset,
                catalog.authorable,
                settingsWritable,
            );
            if (!action) continue;
            if (action === "view") {
                await this.viewAgentPreset(selected.preset);
            } else if (action === "copy") {
                await this.copyAgentPreset(selected.preset, catalog.presets);
            } else if (action === "open") {
                await this.openAgentPresetLocation(selected.preset.id);
            } else if (action === "default") {
                await this.runtime.setDefaultAgentPreset(selected.preset.id);
                void vscode.window.showInformationMessage(t("DSH: {preset} is now the default Agent Preset.", {
                    preset: selected.preset.name || selected.preset.id,
                }));
            } else {
                await this.removeAgentPreset(selected.preset);
            }
        }
    }

    private async chooseAgentPresetAction(
        preset: DshAgentPresetEntry,
        authorable: boolean,
        settingsWritable: boolean,
    ): Promise<"view" | "copy" | "open" | "default" | "remove" | undefined> {
        const actions: Array<vscode.QuickPickItem & {
            action: "view" | "copy" | "open" | "default" | "remove";
        }> = [{
            action: "view",
            label: `$(preview) ${t("View composition")}`,
            detail: t("Open a read-only snapshot of this Preset"),
        }];
        if (authorable) {
            actions.push({
                action: "copy",
                label: `$(copy) ${t("Copy as a user Preset")}`,
                detail: t("Create an editable Preset from this composition"),
            });
        }
        if (!preset.broken && !preset.isDefault && settingsWritable) {
            actions.push({
                action: "default",
                label: `$(star-full) ${t("Make default")}`,
                detail: t("Use this Preset for future Sessions without an explicit mode"),
            });
        }
        if (preset.trust === "user") {
            actions.push({
                action: "open",
                label: `$(folder-opened) ${t("Open Preset files")}`,
                detail: t("Edit this user Preset in its Harness-owned directory"),
            });
            actions.push({
                action: "remove",
                label: `$(trash) ${t("Delete user Preset")}`,
                detail: t("Existing Sessions keep their mounted composition"),
            });
        }
        const selected = await vscode.window.showQuickPick(actions, {
            title: preset.name || preset.id,
            placeHolder: preset.broken
                ? t("Broken: {reason}", { reason: preset.broken })
                : t("Choose an action"),
        });
        return selected?.action;
    }

    private async viewAgentPreset(preset: DshAgentPresetEntry): Promise<void> {
        const result = await this.runtime.readAgentPreset(preset.id);
        const uri = vscode.Uri.from({
            scheme: AGENT_PRESET_DOCUMENT_SCHEME,
            path: `/${preset.id}.yaml`,
            query: `snapshot=${randomUUID()}`,
        });
        this.agentPresetDocuments.set(uri.toString(), result.content);
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
    }

    private async copyAgentPreset(
        source: DshAgentPresetEntry,
        presets: readonly DshAgentPresetEntry[],
    ): Promise<void> {
        const id = await vscode.window.showInputBox({
            title: t("Copy Agent Preset {preset}", { preset: source.name || source.id }),
            prompt: t("Choose the new Preset ID used as its directory name"),
            value: `${source.id}-copy`,
            ignoreFocusOut: true,
            validateInput: (value) => {
                const normalized = value.trim();
                if (!normalized) return t("Enter a Preset ID.");
                if (normalized.length > 128 || !AGENT_PRESET_ID.test(normalized)) {
                    return t("Use lowercase letters, numbers, and hyphens; start with a letter or number.");
                }
                if (presets.some((preset) => preset.id === normalized)) {
                    return t("An Agent Preset with this ID already exists.");
                }
                return undefined;
            },
        });
        if (id === undefined) return;
        const name = await vscode.window.showInputBox({
            title: t("Name the new Agent Preset"),
            prompt: t("Optional display name; leave empty to use the Preset ID"),
            ignoreFocusOut: true,
        });
        if (name === undefined) return;

        const created = await this.runtime.copyAgentPreset(
            source.id,
            id.trim(),
            name.trim() || undefined,
        );
        void vscode.window.showInformationMessage(t("DSH: Agent Preset {preset} was created.", {
            preset: created,
        }));
        await this.openAgentPresetLocation(created);
    }

    private async openAgentPresetLocation(agentPreset: string): Promise<void> {
        const result = await this.runtime.openAgentPresetDocument(agentPreset);
        if (result.opened) return;
        const copy = t("Copy path");
        const selected = await vscode.window.showInformationMessage(
            t("Agent Preset files: {path}", { path: result.path }),
            copy,
        );
        if (selected === copy) await vscode.env.clipboard.writeText(result.path);
    }

    private async removeAgentPreset(preset: DshAgentPresetEntry): Promise<void> {
        if (preset.trust !== "user") return;
        const remove = t("Delete user Preset");
        const confirmed = await vscode.window.showWarningMessage(
            t("Delete user Agent Preset {preset}?", { preset: preset.name || preset.id }),
            {
                modal: true,
                detail: t("Its files will be removed. Existing Sessions keep their currently mounted composition."),
            },
            remove,
        );
        if (confirmed !== remove) return;
        await this.runtime.removeAgentPreset(preset.id);
        if (this.pendingNewSessionPreset === preset.id) {
            this.pendingNewSessionPreset = undefined;
            this.pendingNewSessionSkills = undefined;
            this.postState();
        }
        void vscode.window.showInformationMessage(t("DSH: Agent Preset {preset} was deleted.", {
            preset: preset.name || preset.id,
        }));
    }

    private async toggleSettingsPanel(): Promise<void> {
        if (this.settingsPanel?.open) {
            this.settingsPanel = undefined;
            this.settingsNamespaces.clear();
            this.postState();
            return;
        }
        const generation = ++this.settingsPanelGeneration;
        this.settingsPanel = {
            open: true,
            loading: true,
            writable: false,
            hasDocument: false,
            cards: [],
        };
        this.postState();
        try {
            await this.runtime.start(this.workspaceRoot());
            const result = await this.runtime.describeSettings();
            if (generation !== this.settingsPanelGeneration) return;
            this.settingsNamespaces.clear();
            for (const namespace of result.namespaces) this.settingsNamespaces.set(namespace.ns, namespace);
            this.settingsPanel = presentSettingsPanel(result);
        } catch (error) {
            if (generation !== this.settingsPanelGeneration) return;
            this.settingsPanel = {
                open: true,
                writable: false,
                hasDocument: false,
                cards: [],
                error: errorMessage(error),
            };
        }
        this.postState();
    }

    private async mutateSettings(
        namespaceId: string,
        revision: number,
        changes: Array<{ path: string[]; value: string; clear: boolean }>,
    ): Promise<void> {
        const panel = this.settingsPanel;
        const namespace = this.settingsNamespaces.get(namespaceId);
        const card = panel?.cards.find((candidate) => candidate.ns === namespaceId);
        if (!panel?.open || !panel.writable || !namespace || !card || card.revision !== revision) {
            throw new Error(t("Settings are out of date. Close and reopen the settings cards."));
        }
        const ops = settingsMutationOps(card.fields, changes);
        if (ops.length === 0) return;
        const updated = await this.runtime.mutateSettings(namespaceId, ops, revision);
        this.settingsNamespaces.set(namespaceId, updated);
        this.settingsPanel = presentSettingsPanel({
            writable: panel.writable,
            hasDocument: panel.hasDocument,
            namespaces: [...this.settingsNamespaces.values()],
        });
        this.postState();
    }

    public manageProviders(): Promise<void> {
        return runProviderManagement({
            runtime: this.runtime,
            output: this.output,
            workspaceRoot: () => this.workspaceRoot(),
            openBrowser: () => this.openBrowser(),
        });
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

    public async captureAppShot(): Promise<void> {
        this.reveal();
        const image = await captureNativeAppShot();
        if (!image) return;
        this.pendingComposerImages.push(image);
        this.flushPendingComposerImages();
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

    public revealConversationMilestone(seq: number): void {
        if (!Number.isSafeInteger(seq) || seq < 0) return;
        this.reveal();
        if (!this.view || !this.webviewReady) return;
        void this.view.webview.postMessage({ type: "revealMessage", seq });
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
                    this.flushPendingComposerImages();
                    if (this.sessionId) void this.refreshSubagentTree(this.sessionId);
                    break;
                case "sendPrompt":
                    await this.sendPrompt(message.text ?? "", message.mode, message.images ?? []);
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
                case "manageProviders":
                    await this.manageProviders();
                    break;
                case "manageSettings":
                    await this.toggleSettingsPanel();
                    break;
                case "openSettingsDocument":
                    await this.openBrowser();
                    break;
                case "mutateSettings":
                    await this.mutateSettings(message.ns, message.revision, message.changes);
                    break;
                case "manageAgentPresets":
                    await this.manageAgentPresets();
                    break;
                case "manageWorkspaces":
                    await this.manageWorkspaces();
                    break;
                case "openIdeContextPicker":
                    await this.openIdeContextPicker();
                    break;
                case "captureAppShot":
                    await this.captureAppShot();
                    break;
                case "removeContext":
                    this.contextStore.remove(message.id);
                    break;
                case "loadImage":
                    await this.loadImage(message.attachmentId);
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
                    await this.openBrowser();
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
                case "insertCode":
                    await this.insertCodeBlock(message.renderId, message.codeBlockId);
                    break;
                case "openCode":
                    await this.openCodeBlock(message.renderId, message.codeBlockId, message.language);
                    break;
                case "applyCode":
                    await this.applyCodeBlock(message.renderId, message.codeBlockId, message.language);
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
                case "newSessionInCurrentWorkspace":
                    await this.newSession(undefined, true);
                    break;
                case "searchSession":
                    await this.searchSession();
                    break;
                case "selectModel":
                    await this.selectModel();
                    break;
                case "selectReasoningEffort":
                    await this.selectReasoningEffort(message.effort);
                    break;
                case "openReasoningEffort":
                    await this.openReasoningEffort();
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
        const generation = ++this.fileReferenceQueryGeneration;
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const normalizedQuery = query.trim().replaceAll("\\", "/").toLowerCase();
        const filesPromise = workspaceFolder
            ? Promise.resolve(vscode.workspace.findFiles("**/*", "**/{.git,node_modules,.DS_Store}/**", 2_000)).catch(() => [] as vscode.Uri[])
            : Promise.resolve([] as vscode.Uri[]);
        const searchPromise: Promise<DshSessionSearchItem[]> = normalizedQuery && this.runtime.getUrl()
            ? this.runtime.searchSessions(query.trim()).then((result) => result.items).catch(() => [])
            : Promise.resolve([]);
        const [uris, searchItems] = await Promise.all([filesPromise, searchPromise]);
        if (generation !== this.fileReferenceQueryGeneration) return;
        const active = vscode.window.activeTextEditor?.document.uri;
        const fileCandidates = uris
            .map((uri) => vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/"))
            .filter((relative) => !normalizedQuery || relative.toLowerCase().includes(normalizedQuery))
            .map((relative): DshReferenceCandidate => ({
                kind: "file",
                label: relative,
                insertText: relative,
            }));
        const activeRelative = active
            ? vscode.workspace.asRelativePath(active, false).replaceAll("\\", "/")
            : undefined;
        const orderedFiles = activeRelative && (!normalizedQuery || activeRelative.toLowerCase().includes(normalizedQuery))
            ? [
                  { kind: "file", label: activeRelative, insertText: activeRelative } satisfies DshReferenceCandidate,
                  ...fileCandidates.filter((candidate) => candidate.insertText !== activeRelative),
              ]
            : fileCandidates;

        const remoteById = new Map(searchItems.map((item) => [item.sessionId, item]));
        const sessionById = new Map<string, { sessionId: string; title?: string; cwd?: string; blank?: boolean }>();
        for (const session of this.runtime.getSessionCatalog().snapshot().sessions) {
            sessionById.set(session.sessionId, session);
        }
        for (const item of searchItems) {
            if (!sessionById.has(item.sessionId)) sessionById.set(item.sessionId, { sessionId: item.sessionId });
        }
        const sessionCandidates = [...sessionById.values()]
            .filter((session) => session.blank !== true && session.sessionId !== this.sessionId)
            .filter((session) => {
                if (!normalizedQuery) return true;
                const remote = remoteById.get(session.sessionId);
                const searchable = [session.sessionId, session.title, session.cwd, remote?.snippet]
                    .filter((part): part is string => typeof part === "string")
                    .join("\\n")
                    .toLowerCase();
                return searchable.includes(normalizedQuery);
            })
            .map((session): DshReferenceCandidate => {
                const label = session.title?.trim() || session.sessionId;
                const escapedLabel = label.replace(/[\x5c\]]/gu, (match) => `\x5c${match}`);
                const payload = Buffer.from(JSON.stringify(session.sessionId), "utf8").toString("base64url");
                const remote = remoteById.get(session.sessionId);
                const description = [
                    session.sessionId,
                    session.cwd,
                    remote?.snippet,
                ].filter((part): part is string => typeof part === "string" && part.length > 0).join(" · ");
                return {
                    kind: "session",
                    label,
                    insertText: `@[${escapedLabel}](dsh-session:${payload})`,
                    ...(description ? { description } : {}),
                };
            });
        this.fileReferenceCandidates = [...orderedFiles, ...sessionCandidates].slice(0, 40);
        this.postState();
    }

    private async sendPrompt(
        rawText: string,
        requestedMode: "queue" | "steer",
        requestedImages: readonly DshImageUpload[] = [],
    ): Promise<void> {
        const text = rawText.trim();
        if ((!text && requestedImages.length === 0) || this.submitting) {
            return;
        }

        // Do not let a disabled optional command fall through as ordinary model input.
        if (
            requestedImages.length === 0 && /^\/compact$/u.test(text) &&
            !vscode.workspace.getConfiguration("dsh").get<boolean>("enableCompaction", true)
        ) {
            this.reportError(new Error(t("The connected dsh server does not expose the /compact command. Update dsh or enable the command-compact package.")));
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
            if (requestedImages.length === 0 && /^\/ide(?:$|[\t\n\r ])/u.test(text)) {
                await this.openIdeContextPicker();
                return;
            }

            // Harness command adapters require the command line to be the complete
            // prompt; never append IDE context to a slash command such as /compact or /goal.
            const commandName: PromptCommandName | undefined =
                requestedImages.length === 0 && /^\/compact$/u.test(text)
                    ? "compact"
                    : requestedImages.length === 0 && /^\/goal(?:$|[\t\n\r ])/u.test(text)
                      ? "goal"
                      : undefined;
            if (commandName !== undefined) {
                if (commandName === "compact") {
                    const hasConversationHistory = this.runtime.getSessionStore().get(session)?.events.some(
                        (event) => event.event.type === "user/message" || event.event.type === "assistant/message",
                    ) === true;
                    if (!hasConversationHistory) {
                        throw new Error(t("There is no prior conversation in this session to compact."));
                    }
                }
                optimistic = {
                    id: `optimistic:${randomUUID()}`,
                    sessionId: session,
                    displayText: text,
                    wireText: text,
                    afterSeq: highestKnownSeq(this.runtime.getSessionStore().get(session)),
                    createdAt: Date.now(),
                };
                this.optimisticPrompts.push(optimistic);
                this.postState();
                const mode = resolvePromptMode(requestedMode, this.selectedSessionRunning());
                const commandResult = await this.runtime.prompt(session, text, mode);
                assertPromptCommandSuccess(commandResult, commandName);
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
            let limits = imageLimitsProjection(
                this.runtime.getSessionStore().get(session)?.projections
                    .find((cell) => cell.key === "imageLimits")?.value,
            );
            if (requestedImages.length > 0 && !limits) {
                await this.runtime.syncSession(session);
                limits = imageLimitsProjection(
                    this.runtime.getSessionStore().get(session)?.projections
                        .find((cell) => cell.key === "imageLimits")?.value,
                );
            }
            if (requestedImages.length > 0 && !limits) {
                throw new Error(t("The connected Harness does not expose image attachment support."));
            }
            const prepared = requestedImages.length > 0
                ? prepareImageUploads(requestedImages, limits as DshImageLimitsView)
                : { uploads: [], views: [] };
            optimistic = {
                id: `optimistic:${randomUUID()}`,
                sessionId: session,
                displayText: text,
                wireText: prompt,
                ...(prepared.views.length === 0 ? {} : { images: prepared.views }),
                ...(prepared.uploads.length === 0 ? {} : { imageUploads: prepared.uploads }),
                afterSeq: highestKnownSeq(this.runtime.getSessionStore().get(session)),
                createdAt: Date.now(),
            };
            this.optimisticPrompts.push(optimistic);
            this.postState();
            const mode = resolvePromptMode(requestedMode, this.selectedSessionRunning());
            const promptResult = await this.runtime.prompt(session, prompt, mode, prepared.uploads);
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

    /** Sends a prompt originating from the VS Code Chat Participant. */
    public async sendParticipantPrompt(text: string, token?: vscode.CancellationToken): Promise<void> {
        if (token?.isCancellationRequested) return;
        await this.sendPrompt(text, "queue");
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
            const result = await this.runtime.prompt(
                this.sessionId,
                optimistic.wireText,
                "queue",
                optimistic.imageUploads ?? [],
            );
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
        if (!this.newSessionDraft) {
            await this.restorePersistedSession(workspaceRoot);
        }

        // The selected DSH Session may belong to a different DSH Workspace than
        // the folder currently open in VS Code. Once a Session is explicitly
        // selected, keep using it; the VS Code folder only determines which
        // Session is restored or created when there is no current selection.
        if (!this.sessionId) {
            const workspace = this.pendingNewSessionWorkspaceId
                ? {
                      workspace: {
                          workspaceId: this.pendingNewSessionWorkspaceId,
                      },
                  }
                : await this.runtime.createWorkspace(workspaceRoot);
            const created = await this.runtime.createSession(
                undefined,
                this.pendingNewSessionPreset,
                workspace.workspace.workspaceId,
            );
            if (this.sessionId !== created.sessionId) this.discardSubagentPreview();
            this.sessionId = created.sessionId;
            this.sessionCwd = this.pendingNewSessionWorkspacePath ?? workspaceRoot;
            if (persist) {
                await this.extensionContext.workspaceState.update("session", {
                    sessionId: created.sessionId,
                    cwd: workspaceRoot,
                } satisfies PersistedSession);
            }
            void this.refreshSubagentTree(created.sessionId);
            this.newSessionDraft = false;
            this.pendingNewSessionPreset = undefined;
            this.pendingNewSessionWorkspaceId = undefined;
            this.pendingNewSessionWorkspacePath = undefined;
            this.pendingNewSessionWorkspaceTitle = undefined;
            this.pendingNewSessionSkills = undefined;
        }

        this.refreshModelCatalog(this.sessionId);
        this.refreshSkillCatalog(this.sessionId);
        return this.sessionId;
    }

    private restorePersistedSession(workspaceRoot: string | undefined): Promise<void> {
        if (!workspaceRoot || this.newSessionDraft) {
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
        const candidates = [
            ...(persisted?.cwd === workspaceRoot ? [persisted.sessionId] : []),
            ...this.runtime
                .getSessionCatalog()
                .sessionsForWorkspace(workspaceRoot)
                .map((session) => session.sessionId),
        ].filter((sessionId, index, all) => all.indexOf(sessionId) === index);
        const sessionId = candidates[0];
        if (!sessionId) {
            return;
        }

        try {
            await this.runtime.history(sessionId, 1);
            if (this.sessionId) {
                return;
            }
            this.sessionId = sessionId;
            this.sessionCwd = workspaceRoot;
            if (persist) {
                await this.extensionContext.workspaceState.update("session", {
                    sessionId,
                    cwd: workspaceRoot,
                } satisfies PersistedSession);
            }
            this.postState();
            await this.runtime.syncSession(sessionId);
            this.refreshModelCatalog(sessionId);
            this.refreshSkillCatalog(sessionId);
        } catch (error) {
            const latest = this.extensionContext.workspaceState.get<PersistedSession>("session");
            if (latest?.sessionId === sessionId && latest.cwd === workspaceRoot) {
                await this.extensionContext.workspaceState.update("session", undefined);
            }
            this.output.appendLine(
                `[dsh] workspace session ${sessionId} could not be restored: ${errorMessage(error)}`,
            );
        }
    }

    public async newSession(agentPreset?: string, useCurrentWorkspace = false): Promise<void> {
        const workspaceRoot = this.workspaceRoot();
        if (!workspaceRoot) throw new Error(t("Open a workspace first."));
        await this.runtime.start(workspaceRoot);
        const catalog = this.runtime.getSessionCatalog().snapshot();
        const selectedWorkspace = useCurrentWorkspace
            ? (await this.runtime.createWorkspace(workspaceRoot)).workspace
            : this.sessionId
                ? catalog.workspaces.find((workspace) => workspace.sessionIds.includes(this.sessionId as string))
                : undefined;
        this.pendingNewSessionSkills = this.sessionId && selectedWorkspace?.sessionIds.includes(this.sessionId)
            ? this.skillCatalogs.get(this.sessionId)
            : undefined;
        this.sessionId = undefined;
        this.sessionCwd = undefined;
        this.newSessionDraft = true;
        this.pendingNewSessionPreset = agentPreset;
        this.pendingNewSessionWorkspaceId = selectedWorkspace?.workspaceId;
        this.pendingNewSessionWorkspacePath = selectedWorkspace?.path;
        this.pendingNewSessionWorkspaceTitle = selectedWorkspace?.title;
        this.optimisticPrompts.length = 0;
        this.cancelRequested = false;
        this.discardSubagentPreview();
        await this.extensionContext.workspaceState.update("session", undefined);
        this.postState();
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
        const workspaceRoot = this.workspaceRoot();
        if (!workspaceRoot) throw new Error(t("Open a workspace first."));
        if (!this.runtime.getUrl()) await this.runtime.start(workspaceRoot);

        // Model selection is also a valid first action. The Harness model
        // catalog is session-scoped, so materialize the pending/new session
        // before requesting it instead of rejecting the command outright.
        const sessionId = this.sessionId ?? await this.getOrCreateSession(workspaceRoot);
        const catalog = await this.runtime.models(sessionId);
        this.modelCatalogs.set(sessionId, catalog);
        const currentEfforts = reasoningEffortOptions(
            catalog,
            catalog.current.provider,
            catalog.current.model,
        );
        this.selectedModels.set(sessionId, {
            selection: catalog.current,
            asOfSeq: highestKnownSeq(this.runtime.getSessionStore().get(sessionId)),
            reasoningEfforts: currentEfforts,
        });
        this.schedulePostState();
        if (!catalog.routable) {
            throw new Error(t("The current session has no routable model."));
        }
        const items = catalog.groups.flatMap((group) => group.models.map((model) => {
            const provider = group.id;
            return {
                label: `${group.name || provider} / ${model.name || model.id}`,
                description: provider === catalog.current.provider && model.id === catalog.current.model
                    ? t("Current model")
                    : model.id,
                provider,
                model: model.id,
                efforts: reasoningEffortOptions(catalog, provider, model.id),
            };
        }));
        if (items.length === 0) throw new Error(t("Harness returned no available models."));
        const picked = await vscode.window.showQuickPick(items, {
            title: t("Select Harness model"),
            placeHolder: `${catalog.current.provider} / ${catalog.current.model}`,
        });
        if (!picked) return;
        let reasoningEffort: string | undefined;
        if (picked.efforts.length > 0) {
            const effort = await vscode.window.showQuickPick(picked.efforts.map((option) => option.id), {
                title: t("Select reasoning effort"),
                placeHolder: catalog.current.reasoningEffort ?? t("Default"),
            });
            if (effort === undefined) return;
            reasoningEffort = effort;
        }
        const result = await this.runtime.selectModel({
            sessionId,
            provider: picked.provider,
            model: picked.model,
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        });
        const selectedEfforts = reasoningEffortOptions(catalog, picked.provider, picked.model);
        this.selectedModels.set(sessionId, {
            selection: result.selected,
            asOfSeq: highestKnownSeq(this.runtime.getSessionStore().get(sessionId)),
            reasoningEfforts: selectedEfforts,
        });
        this.modelCatalogs.set(sessionId, {
            ...catalog,
            current: result.selected,
        });
        this.output.appendLine(`[dsh:model] selected ${result.selected.provider}/${result.selected.model}`);
        this.postState();
    }

    private async selectReasoningEffort(effort: string): Promise<void> {
        const sessionId = this.sessionId;
        if (!sessionId) throw new Error(t("There is no current session."));
        if (!this.runtime.getUrl()) await this.runtime.start(this.workspaceRoot());
        const catalog = this.modelCatalogs.get(sessionId) ?? await this.runtime.models(sessionId);
        this.modelCatalogs.set(sessionId, catalog);
        const current = catalog.current;
        const options = reasoningEffortOptions(catalog, current.provider, current.model);
        const selected = options.find((option) => option.id === effort);
        if (!selected) {
            throw new Error(t("The selected reasoning effort is not available for the current model."));
        }
        const result = await this.runtime.selectModel({
            sessionId,
            provider: current.provider,
            model: current.model,
            reasoningEffort: selected.id,
        });
        this.selectedModels.set(sessionId, {
            selection: result.selected,
            asOfSeq: highestKnownSeq(this.runtime.getSessionStore().get(sessionId)),
            reasoningEfforts: options,
        });
        this.modelCatalogs.set(sessionId, {
            ...catalog,
            current: result.selected,
        });
        this.postState();
    }

    private async openReasoningEffort(): Promise<void> {
        const workspaceRoot = this.workspaceRoot();
        if (!workspaceRoot) throw new Error(t("Open a workspace first."));
        if (!this.runtime.getUrl()) await this.runtime.start(workspaceRoot);
        const sessionId = this.sessionId ?? await this.getOrCreateSession(workspaceRoot);
        const catalog = this.modelCatalogs.get(sessionId) ?? await this.runtime.models(sessionId);
        this.modelCatalogs.set(sessionId, catalog);
        const options = reasoningEffortOptions(catalog, catalog.current.provider, catalog.current.model);
        if (options.length === 0) {
            throw new Error(t("The current model does not expose reasoning effort options."));
        }
        this.selectedModels.set(sessionId, {
            selection: catalog.current,
            asOfSeq: highestKnownSeq(this.runtime.getSessionStore().get(sessionId)),
            reasoningEfforts: options,
        });
        this.postState();
    }

    public async selectAgentPreset(requestedPreset?: string): Promise<void> {
        if (!this.sessionId && !this.newSessionDraft) {
            throw new Error(t("There is no current session."));
        }
        if (!this.runtime.getUrl()) await this.runtime.start(this.workspaceRoot());
        const catalog = await this.runtime.agentPresets();
        this.agentPresetCatalog = catalog.presets;
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
            const current = this.newSessionDraft
                ? this.pendingNewSessionPreset
                : this.runtime.getSessionCatalog().snapshot().sessions
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

        if (this.newSessionDraft && !this.sessionId) {
            this.pendingNewSessionPreset = target.id;
            this.pendingNewSessionSkills = undefined;
            this.output.appendLine(`[dsh:agent-preset] selected ${target.id} for new session`);
            this.postState();
            return;
        }

        const sessionId = this.sessionId;
        if (!sessionId) throw new Error(t("There is no current session."));
        const currentSession = this.runtime.getSessionCatalog().snapshot().sessions
            .find((session) => session.sessionId === sessionId);
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
            result = await this.runtime.selectAgentPreset(sessionId, target.id);
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
        this.skillCatalogs.delete(sessionId);
        this.refreshSkillCatalog(sessionId);
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
        this.newSessionDraft = false;
        this.pendingNewSessionPreset = undefined;
        this.pendingNewSessionWorkspaceId = undefined;
        this.pendingNewSessionWorkspacePath = undefined;
        this.pendingNewSessionWorkspaceTitle = undefined;
        this.pendingNewSessionSkills = undefined;
        if (vscode.workspace.getConfiguration("dsh").get<boolean>("persistSession", true)) {
            await this.extensionContext.workspaceState.update("session", {
                sessionId,
                cwd: this.sessionCwd ?? "",
            } satisfies PersistedSession);
        }
        await this.runtime.syncSession(sessionId);
        this.refreshModelCatalog(sessionId);
        this.refreshSkillCatalog(sessionId);
        void this.refreshSubagentTree(sessionId);
        this.reveal();
    }

    /**
     * Records a Harness ref acknowledgement, failing closed when the ref is
     * malformed so the HUD never advances past an unconfirmed mutation.
     *
     * @param method - the RPC name, used verbatim in the diagnostic.
     */
    private acknowledgeGoalRef(
        sessionId: string,
        method: string,
        result: { ref: unknown },
    ): void {
        const ref = normalizeGoalRef(result.ref);
        if (!ref) {
            throw new Error(t("Harness returned an invalid {method} ref.", { method }));
        }
        this.goalMutations.acknowledgeRef(sessionId, ref);
    }

    private async mutateGoal(action: ChatViewAction): Promise<void> {
        const sessionId = this.sessionId;
        if (!sessionId) return;
        const goalCell = projectionCell(this.runtime.getSessionStore().get(sessionId), "goal");
        if (!goalCell) {
            throw new Error(t("The current Harness does not provide a goal projection, so the Goal HUD remains hidden."));
        }
        const parsed = parseGoalProjection(goalCell.value);
        if (!parsed.ok) throw new Error(parsed.error);

        const operation = goalOperationFor(action.type);
        if (!operation || !this.goalMutations.claim(sessionId, operation, goalCell.seq)) return;
        this.postState();

        try {
            if (action.type === "goalCreate") {
                if (parsed.value !== null && !goalActionAllowed(
                    parsed.value.goal.phase,
                    operation,
                    parsed.value.roundsStarted,
                    parsed.value.goal.maxGoalRounds,
                )) {
                    throw new Error(t("A replacement Goal can only be created when the current Goal is empty or complete."));
                }
                const result = await this.runtime.createGoal(
                    sessionId,
                    action.objective,
                    action.maxGoalRounds,
                );
                this.acknowledgeGoalRef(sessionId, "goal.create", result);
            } else {
                if (parsed.value === null) throw new Error(t("The current session has no actionable Goal."));
                const ref = {
                    id: parsed.value.goal.id,
                    revision: parsed.value.goal.revision,
                };
                if (!goalActionAllowed(
                    parsed.value.goal.phase,
                    operation,
                    parsed.value.roundsStarted,
                    parsed.value.goal.maxGoalRounds,
                )) {
                    if (operation === "resume" && parsed.value.roundsStarted >= parsed.value.goal.maxGoalRounds) {
                        throw new Error(t("Goal has reached its maximum rounds and cannot be resumed."));
                    }
                    throw new Error(t("That Goal action is not available in the current phase."));
                }
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
                    this.acknowledgeGoalRef(sessionId, "goal.edit", result);
                } else if (
                    action.type === "goalPause" ||
                    action.type === "goalResume" ||
                    action.type === "goalComplete"
                ) {
                    // These three differ only in which RPC they call.
                    const call = {
                        goalPause: ["goal.pause", this.runtime.pauseGoal] as const,
                        goalResume: ["goal.resume", this.runtime.resumeGoal] as const,
                        goalComplete: ["goal.complete", this.runtime.completeGoal] as const,
                    }[action.type];
                    const result = await call[1].call(this.runtime, sessionId, ref);
                    this.acknowledgeGoalRef(sessionId, call[0], result);
                } else if (action.type === "goalClear") {
                    const result = await this.runtime.clearGoal(sessionId, ref);
                    if (result.cleared !== true) {
                        throw new Error(t("Harness returned an invalid goal.clear acknowledgement."));
                    }
                    this.goalMutations.acknowledgeClear(sessionId);
                }
            }
            const latestGoalCell = projectionCell(this.runtime.getSessionStore().get(sessionId), "goal");
            this.goalMutations.observe(sessionId, latestGoalCell);
        } catch (error) {
            this.goalMutations.fail(sessionId, goalErrorForHud(error, operation));
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

    private refreshModelCatalog(sessionId: string): void {
        if (!this.runtime.getUrl() || this.modelCatalogs.has(sessionId) || this.modelCatalogRequests.has(sessionId)) {
            return;
        }
        const request = this.runtime.models(sessionId)
            .then((catalog) => {
                this.modelCatalogs.set(sessionId, catalog);
                const efforts = reasoningEffortOptions(
                    catalog,
                    catalog.current.provider,
                    catalog.current.model,
                );
                const selected = this.selectedModels.get(sessionId);
                if (!selected ||
                    (selected.selection.provider === catalog.current.provider &&
                        selected.selection.model === catalog.current.model)) {
                    this.selectedModels.set(sessionId, {
                        selection: catalog.current,
                        asOfSeq: highestKnownSeq(this.runtime.getSessionStore().get(sessionId)),
                        reasoningEfforts: efforts,
                    });
                }
                if (this.sessionId === sessionId) this.postState();
            })
            .catch((error) => {
                this.output.appendLine(`[dsh:model] catalog refresh failed: ${errorMessage(error)}`);
            })
            .finally(() => {
                this.modelCatalogRequests.delete(sessionId);
            });
        this.modelCatalogRequests.set(sessionId, request);
    }

    private refreshSkillCatalog(sessionId: string): void {
        if (!this.runtime.getUrl() || this.skillCatalogs.has(sessionId) || this.skillCatalogRequests.has(sessionId)) {
            return;
        }
        const request = this.runtime.listSkills(sessionId)
            .then((skills) => {
                this.skillCatalogs.set(sessionId, skills);
                if (this.sessionId === sessionId) this.postState();
            })
            .catch((error) => {
                this.output.appendLine(`[dsh:skills] catalog refresh failed: ${errorMessage(error)}`);
            })
            .finally(() => {
                this.skillCatalogRequests.delete(sessionId);
            });
        this.skillCatalogRequests.set(sessionId, request);
    }

    private refreshAgentPresetCatalog(): void {
        if (!this.runtime.getUrl() || this.agentPresetCatalog || this.agentPresetCatalogRequest) return;
        const request = this.runtime.agentPresets()
            .then((catalog) => {
                this.agentPresetCatalog = catalog.presets;
                this.postState();
            })
            .catch((error) => {
                this.output.appendLine(`[dsh:agent-preset] catalog refresh failed: ${errorMessage(error)}`);
            })
            .finally(() => {
                this.agentPresetCatalogRequest = undefined;
            });
        this.agentPresetCatalogRequest = request;
    }

    private reasoningEffortView(): ChatViewState["reasoningEffort"] {
        if (!this.sessionId) return undefined;
        const selected = this.selectedModels.get(this.sessionId);
        const catalog = this.modelCatalogs.get(this.sessionId);
        const selection = selected?.selection ?? catalog?.current;
        if (!selection) return undefined;
        const options = selected?.reasoningEfforts ?? (catalog
            ? reasoningEffortOptions(catalog, selection.provider, selection.model)
            : []);
        if (options.length === 0) return undefined;
        return {
            ...(selection.reasoningEffort === undefined ? {} : { current: selection.reasoningEffort }),
            options: options.map((option) => {
                if (!this.reasoningEffortKnobEnabled()) return option;
                const image = this.reasoningEffortImage(option.id) ?? this.defaultEffortKnobImage();
                return image ? { ...option, image } : option;
            }),
        };
    }

    private agentStatusLabel(sessionId: string | undefined, busy: boolean): string | undefined {
        const pluginLabel = this.agentStatusPresentations?.current()?.label;
        if (pluginLabel) return pluginLabel;
        const configured = vscode.workspace
            .getConfiguration("dsh")
            .get<string>("agentStatusLabel", "")
            .trim();
        if (configured) return configured;

        const configuredCandidates = vscode.workspace
            .getConfiguration("dsh")
            .get<unknown>("agentStatusLabels", DEFAULT_AGENT_STATUS_LABELS);
        const candidates = Array.isArray(configuredCandidates)
            ? configuredCandidates.filter(
                (candidate): candidate is string =>
                    typeof candidate === "string" && candidate.trim().length > 0 && candidate.length <= 256,
            ).map((candidate) => candidate.trim())
            : [];
        if (!sessionId || !busy || candidates.length === 0) {
            this.agentStatusChoice = undefined;
            return undefined;
        }

        const candidateKey = candidates.join("\0");
        if (
            this.agentStatusChoice?.sessionId === sessionId &&
            this.agentStatusChoice.candidateKey === candidateKey
        ) return this.agentStatusChoice.label;

        const label = candidates[Math.floor(Math.random() * candidates.length)];
        this.agentStatusChoice = { sessionId, candidateKey, label };
        return label;
    }

    /** Resolves the webview-safe image URI for an effort id, if one is configured. */
    private reasoningEffortImage(effortId: string): string | undefined {
        const file = REASONING_EFFORT_IMAGES[effortId];
        if (!file || !this.view) return undefined;
        return this.view.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, "resources", file),
        ).toString();
    }

    /** Whether the sprite-based reasoning effort knob is enabled via settings. */
    private reasoningEffortKnobEnabled(): boolean {
        return vscode.workspace.getConfiguration("dsh").get<boolean>("enableEffortKnob", true);
    }

    /** Resolves the default knob sprite URI, if configured. */
    private defaultEffortKnobImage(): string | undefined {
        if (!this.view) return undefined;
        return this.view.webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, "resources", REASONING_EFFORT_KNOB_IMAGE),
        ).toString();
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

    private flushPendingComposerImages(): void {
        if (!this.view || !this.webviewReady) return;
        for (const image of this.pendingComposerImages.splice(0)) {
            void this.view.webview.postMessage({ type: "addImageDraft", image });
        }
    }

    private postState(): void {
        if (!this.view) {
            return;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const catalog = this.runtime.getSessionCatalog().snapshot();
        const currentDshWorkspace = workspaceFolder
            ? catalog.workspaces.find((workspace) => samePath(workspace.path, workspaceFolder.uri.fsPath))
            : undefined;
        const archived = new Set(catalog.archivedSessionIds);
        const workspaceBySession = new Map(
            catalog.workspaces.flatMap((workspace) =>
                workspace.sessionIds.map((sessionId) => [sessionId, workspace] as const),
            ),
        );
        const selected = catalog.sessions.find((item) => item.sessionId === this.sessionId);
        if (this.sessionId) this.refreshSkillCatalog(this.sessionId);
        if (selected?.agentPreset) this.refreshAgentPresetCatalog();
        const selectedAgentPreset = selected?.agentPreset;
        const selectedAgentPresetLabel = this.agentPresetCatalog
            ?.find((preset) => preset.id === selectedAgentPreset)?.name;
        const session = this.sessionId
            ? this.runtime.getSessionStore().get(this.sessionId)
            : undefined;
        const goalCell = projectionCell(session, "goal");
        const permissionsCell = projectionCell(session, "permissions");
        const todos = todoProjection(projectionValue(session, "todos"));
        const imageLimits = imageLimitsProjection(projectionValue(session, "imageLimits"));
        const sessionStats = sessionStatsProjection(projectionValue(session, "sessionStats"));
        const host = presentHostBaseline(this.runtime.getHostDescription());
        const busy = selected?.running === true;
        const agentStatusLabel = this.agentStatusLabel(this.sessionId, busy);
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
                this.sessionId,
            ),
            context: this.contextStore.snapshot(),
            fileReferenceCandidates: this.fileReferenceCandidates,
            ...(this.settingsPanel === undefined ? {} : { settings: this.settingsPanel }),
            selection: this.contextStore.getCurrentSelectionMetadata(),
            selectionEnabled: this.selectionEnabled,
            status: this.runtime.getStatus(),
            busy,
            ...(agentStatusLabel === undefined
                ? {}
                : { agentStatusLabel }),
            submitting: this.submitting,
            cancelling: this.cancelRequested && selected?.running === true,
            focusMode: this.focusMode,
            workspaceName: workspaceFolder?.name,
            skills: this.sessionId
                ? [...(this.skillCatalogs.get(this.sessionId) ?? [])]
                : [...(this.pendingNewSessionSkills ?? [])],
            ...(workspaceFolder === undefined
                ? {}
                : {
                      currentWorkspace: {
                          ...(currentDshWorkspace === undefined
                              ? {}
                              : { workspaceId: currentDshWorkspace.workspaceId }),
                          title: currentDshWorkspace?.title || workspaceFolder.name,
                      },
                  }),
            host,
            sessionId: this.sessionId,
            ...(selectedAgentPreset === undefined ? {} : { agentPreset: selectedAgentPreset }),
            ...(selectedAgentPresetLabel === undefined ? {} : { agentPresetLabel: selectedAgentPresetLabel }),
            ...(this.newSessionDraft && this.pendingNewSessionWorkspaceId
                ? {
                      draftWorkspaceId: this.pendingNewSessionWorkspaceId,
                      draftWorkspaceTitle: this.pendingNewSessionWorkspaceTitle,
                  }
                : {}),
            sessions: catalog.sessions
                .filter((item) => !archived.has(item.sessionId))
                .map((item) => ({
                    sessionId: item.sessionId,
                    title: item.title || item.sessionId.slice(0, 12),
                    ...(workspaceBySession.has(item.sessionId)
                        ? {
                              workspaceId: workspaceBySession.get(item.sessionId)?.workspaceId,
                              workspaceTitle: workspaceBySession.get(item.sessionId)?.title,
                          }
                        : {}),
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
            ...(sessionStats === undefined ? {} : { sessionStats }),
            reasoningEffort: this.reasoningEffortView(),
            permissions: permissionProjection(permissionsCell?.value),
            ...(todos === undefined ? {} : { todos }),
            ...(imageLimits === undefined ? {} : { imageLimits }),
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
                              this.subagentPreview.childSessionId,
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

    private renderMessages(
        messages: readonly ChatMessage[],
        scope: string,
        imageSessionId?: string,
    ): ChatMessage[] {
        const hydrated = messages.map((message): ChatMessage => {
            if (!imageSessionId) return message;
            const hydrateImages = (images: readonly ChatImageView[] | undefined): ChatImageView[] | undefined =>
                images?.map((image) => {
                    if (image.src || !image.attachmentId) return image;
                    const cached = this.imageCache.get(`${imageSessionId}:${image.attachmentId}`);
                    if (cached?.src) {
                        return { ...image, src: cached.src, loadState: undefined, error: undefined };
                    }
                    if (cached?.error) {
                        return { ...image, loadState: "error", error: cached.error };
                    }
                    return { ...image, loadState: cached?.loading ? "loading" : "idle" };
                });
            const images = hydrateImages(message.images);
            const toolImages = hydrateImages(message.tool?.images);
            if (!images && !toolImages) return message;
            return {
                ...message,
                ...(images === undefined ? {} : { images }),
                ...(message.tool === undefined || toolImages === undefined
                    ? {}
                    : { tool: { ...message.tool, images: toolImages } }),
            };
        });
        return this.markdownRenders.render(hydrated, scope);
    }

    private async loadImage(attachmentId: string): Promise<void> {
        const rootSessionId = this.sessionId;
        if (!rootSessionId) return;
        const referencedByRoot = projectChatMessages(
            this.runtime.getSessionStore().get(rootSessionId),
            this.optimisticPrompts,
        ).some((message) =>
            message.images?.some((image) => image.attachmentId === attachmentId) === true ||
            message.tool?.images?.some((image) => image.attachmentId === attachmentId) === true,
        );
        const preview = this.subagentPreview;
        const referencedByPreview = preview?.rootSessionId === rootSessionId &&
            preview.messages.some((message) =>
                message.images?.some((image) => image.attachmentId === attachmentId) === true ||
                message.tool?.images?.some((image) => image.attachmentId === attachmentId) === true,
            );
        const sessionId = referencedByRoot
            ? rootSessionId
            : referencedByPreview
              ? preview.childSessionId
              : undefined;
        if (!sessionId) return;

        const key = `${sessionId}:${attachmentId}`;
        const current = this.imageCache.get(key);
        if (current?.src || current?.loading) return;
        this.imageCache.set(key, { loading: true });
        this.postState();
        try {
            const result = await this.runtime.attachment(sessionId, attachmentId);
            if (result.attachment.attachmentId !== attachmentId) {
                throw new Error(t("Harness returned a different image attachment."));
            }
            const bytes = Buffer.from(result.data, "base64");
            if (!result.data || bytes.toString("base64") !== result.data ||
                bytes.byteLength !== result.attachment.bytes ||
                !isImageMediaType(result.attachment.mediaType)) {
                throw new Error(t("Harness returned invalid image attachment data."));
            }
            this.imageCache.delete(key);
            this.imageCache.set(key, {
                src: `data:${result.attachment.mediaType};base64,${result.data}`,
            });
            while (this.imageCache.size > 40) {
                const oldest = this.imageCache.keys().next().value as string | undefined;
                if (oldest === undefined) break;
                this.imageCache.delete(oldest);
            }
        } catch (error) {
            this.imageCache.set(key, { error: errorMessage(error) });
        }
        this.postState();
    }

    private copyCodeBlock(renderId: string, codeBlockId: string): Promise<void> {
        return copyCodeBlock(this.codeBlockText(renderId, codeBlockId));
    }

    private codeBlockText(renderId: string, codeBlockId: string): string {
        return this.markdownRenders.codeBlockText(renderId, codeBlockId);
    }

    private insertCodeBlock(renderId: string, codeBlockId: string): Promise<void> {
        return insertCodeBlock(this.codeBlockText(renderId, codeBlockId));
    }

    private openCodeBlock(
        renderId: string,
        codeBlockId: string,
        language?: string,
    ): Promise<void> {
        return openCodeBlock(this.codeBlockText(renderId, codeBlockId), language);
    }

    private applyCodeBlock(
        renderId: string,
        codeBlockId: string,
        language?: string,
    ): Promise<void> {
        return applyCodeBlock(this.codeBlockText(renderId, codeBlockId), language);
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
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${styleUri}">
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
