import { join } from "node:path";
import * as vscode from "vscode";
import {
    AgentStatusPresentationRegistry,
    DshExtensionApi,
} from "./agentStatusPresentation";
import { AccountActions } from "./accountActions";
import { DesktopConnectionActions } from "./desktopActions";
import { InlineCompletionProvider } from "./inlineCompletion";
import { ForgeReviewController } from "./forgeReview";
import { configureBillingRate, configureChatAppearance } from "./localPreferences";
import { managePromptTemplates } from "./editorContextActions";
import { DeepSeekBalanceService } from "./balanceService";
import { ChatViewProvider, QuickTaskKind } from "./chatView";
import {
    ConversationNavigationProvider,
    ConversationNavigationRegistry,
} from "./conversationNavigation";
import { ContextStore } from "./contextStore";
import { DebugContextTracker } from "./debugContext";
import { DshRuntime, OFFICIAL_DESKTOP_DOWNLOAD_URL, OfficialDesktopRequiredError } from "./dshRuntime";
import { JEV_API_KEY_SECRET } from "./jevIntegration";
import { configureLocalization, t } from "./localize";
import { TracePanelManager } from "./tracePanel";
import { parseTraceLocation } from "./traceProtocol";
import { TerminalContextStore } from "./terminalContext";
import { showWhatsNew, showWhatsNewOnUpdate } from "./whatsNew";

let shutdownRuntime: (() => Promise<void>) | undefined;

export function activate(context: vscode.ExtensionContext): DshExtensionApi {
    configureLocalization((message, args) => vscode.l10n.t(message, args));
    const rawOutput = vscode.window.createOutputChannel("DeepSeek Harness");
    let outputDisposed = false;
    // A cancelled download or late stream callback may finish after shutdown.
    // Keep diagnostics alive through cleanup and ignore writes after disposal.
    const output = new Proxy(rawOutput, {
        get(target, property) {
            if (property === "append" || property === "appendLine") {
                return (value: string): void => { if (!outputDisposed) target[property](value); };
            }
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    const debugContextTracker = new DebugContextTracker();
    const runtime = new DshRuntime(
        output,
        context.globalStorageUri.fsPath,
        debugContextTracker,
        context.extensionUri.fsPath,
        () => context.secrets.get(JEV_API_KEY_SECRET),
    );
    const accountActions = new AccountActions(
        runtime,
        String(context.extension.packageJSON.version ?? ""),
        workspaceRoot,
    );
    const desktopActions = new DesktopConnectionActions(runtime, context.secrets);
    let shutdown: Promise<void> | undefined;
    const stopRuntime = (): Promise<void> => shutdown ??= runtime.dispose().finally(() => {
        outputDisposed = true;
        rawOutput.dispose();
    });
    shutdownRuntime = stopRuntime;
    const balanceService = new DeepSeekBalanceService(context, output);
    const terminalContext = new TerminalContextStore();
    const contextStore = new ContextStore(debugContextTracker);
    const agentStatusPresentations = new AgentStatusPresentationRegistry();
    const conversationNavigationRegistry = new ConversationNavigationRegistry();
    const chatView = new ChatViewProvider(
        context,
        context.extensionUri,
        runtime,
        contextStore,
        terminalContext,
        output,
        balanceService,
        agentStatusPresentations,
    );
    const tracePanels = new TracePanelManager(
        runtime,
        output,
        workspaceRoot,
        context.extensionUri,
    );
    const inlineCompletion = new InlineCompletionProvider(runtime, () => chatView.commandTarget().getCurrentSessionId(), output);
    const forgeReview = new ForgeReviewController(runtime, context);
    const conversationNavigation = new ConversationNavigationProvider(
        runtime,
        chatView,
        conversationNavigationRegistry,
    );

    context.subscriptions.push(
        inlineCompletion,
        forgeReview,
        vscode.commands.registerCommand("dsh.reviewRepository", () => runQuietCommand(t("DSH repository review"), async () => {
            await runtime.start(workspaceRoot());
            const sessionId = chatView.commandTarget().getCurrentSessionId();
            if (!sessionId) throw new Error(t("Choose a DSH session before opening repository review."));
            await forgeReview.open(sessionId);
        })),
        vscode.languages.registerInlineCompletionItemProvider({ scheme: "file" }, inlineCompletion),
        vscode.commands.registerCommand("dsh.completeInline", () => runQuietCommand(t("Complete code inline"), async () => {
            await runtime.start(workspaceRoot());
            await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
        })),
        balanceService,
        accountActions,
        terminalContext,
        debugContextTracker,
        agentStatusPresentations,
        conversationNavigationRegistry,
        chatView,
        tracePanels,
        conversationNavigation,
        new vscode.Disposable(() => {
            void stopRuntime().catch(error => console.error("DSH Runtime cleanup failed", error));
        }),
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatView, {
            webviewOptions: {
                retainContextWhenHidden: true,
            },
        }),
        vscode.window.registerTreeDataProvider(
            "dsh.conversationNavigation",
            conversationNavigation,
        ),
        vscode.commands.registerCommand("dsh.revealConversationMilestone", (seq?: unknown) => {
            if (typeof seq === "number") chatView.commandTarget().revealConversationMilestone(seq);
        }),
        registerChatParticipant(chatView, context.extensionUri),
        vscode.window.registerWebviewPanelSerializer(TracePanelManager.viewType, tracePanels),
        vscode.commands.registerCommand("dsh.open", () => chatView.commandTarget().reveal()),
        vscode.commands.registerCommand("dsh.configureAppearance", () => runQuietCommand(t("Chat appearance"), configureChatAppearance)),
        vscode.commands.registerCommand("dsh.managePromptTemplates", () => runQuietCommand(t("Manage prompt templates"), managePromptTemplates)),
        vscode.commands.registerCommand("dsh.searchCodeContext", () => runQuietCommand(t("Search code context"), () => chatView.commandTarget().searchCodeContext())),
        vscode.commands.registerCommand("dsh.attachProjectRules", () => runQuietCommand(t("Attach project rule documents"), () => chatView.commandTarget().attachProjectRules())),
        vscode.commands.registerCommand("dsh.configureBillingRates", () => runQuietCommand(t("Configure model cost rates"), configureBillingRate)),
        vscode.commands.registerCommand("dsh.connectDesktop", () => runQuietCommand(t("Connect to Desktop"), () => desktopActions.connect())),
        vscode.commands.registerCommand("dsh.disconnectDesktop", () => runQuietCommand(t("Disconnect Desktop"), () => desktopActions.disconnect())),
        vscode.commands.registerCommand("dsh.showWhatsNew", () =>
            runQuietCommand(t("View What's New"), () => showWhatsNew(context)),
        ),
        vscode.commands.registerCommand("dsh.openInEditor", (sessionId?: unknown) => runQuietCommand(t("Open session in editor"), async () => { await chatView.openInEditor(typeof sessionId === "string" ? sessionId : undefined); })),
        vscode.window.registerWebviewPanelSerializer(ChatViewProvider.editorViewType, { deserializeWebviewPanel: (panel, state) => chatView.restoreEditor(panel, state) }),
        vscode.commands.registerCommand("dsh.openRuntimeTerminal", () =>
            runQuietCommand(t("Open Runtime terminal"), () => chatView.commandTarget().openRuntimeTerminal()),
        ),
        vscode.commands.registerCommand("dsh.attachDiagnostics", () =>
            runQuietCommand(t("Attach Problems"), () => chatView.commandTarget().openDiagnosticsPicker()),
        ),
        vscode.commands.registerCommand("dsh.managePlugins", () =>
            runQuietCommand(t("Manage Runtime plugins"), () => chatView.commandTarget().managePlugins()),
        ),
        vscode.commands.registerCommand("dsh.openSessionCenter", () =>
            runQuietCommand(t("DSH Session center"), () => chatView.commandTarget().openSessionCenter()),
        ),
        vscode.commands.registerCommand("dsh.exportSession", () => runQuietCommand(t("Export conversation"), () => chatView.commandTarget().exportSession())),
        vscode.commands.registerCommand("dsh.copyConversation", () => runQuietCommand(t("Copy conversation as Markdown"), () => chatView.commandTarget().exportSession(true))),
        vscode.commands.registerCommand("dsh.openTrace", async (value?: unknown) => {
            try {
                const supplied = value === undefined ? undefined : parseTraceLocation(value);
                if (value !== undefined && !supplied) {
                    throw new Error(t("Invalid Trace location."));
                }
                const sessionId = supplied?.sessionId ?? chatView.commandTarget().getCurrentSessionId();
                if (!sessionId) throw new Error(t("There is no current session to open."));
                await tracePanels.open(supplied ?? { sessionId });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(t("DSH: Failed to open Trace: {message}", { message }));
            }
        }),
        vscode.commands.registerCommand("dsh.newSession", () =>
            runCommand(t("Create session"), () => chatView.commandTarget().newSession()),
        ),
        vscode.commands.registerCommand("dsh.switchSession", () =>
            runCommand(t("Switch session"), () => chatView.commandTarget().chooseSession()),
        ),
        vscode.commands.registerCommand("dsh.manageSessions", () =>
            runCommand(t("Manage DSH Sessions"), () => chatView.commandTarget().manageSessions()),
        ),
        vscode.commands.registerCommand("dsh.searchSession", () =>
            runCommand(t("Search sessions"), () => chatView.commandTarget().searchSession()),
        ),
        vscode.commands.registerCommand("dsh.selectModel", () =>
            runCommand(t("Select model"), () => chatView.commandTarget().selectModel()),
        ),
        vscode.commands.registerCommand("dsh.renameSession", () =>
            runCommand(t("Rename session"), () => chatView.commandTarget().renameSession()),
        ),
        vscode.commands.registerCommand("dsh.forkSession", () =>
            runCommand(t("Fork session"), () => chatView.commandTarget().forkSession()),
        ),
        vscode.commands.registerCommand("dsh.archiveSession", () =>
            runCommand(t("Archive session"), () => chatView.commandTarget().archiveSession()),
        ),
        vscode.commands.registerCommand("dsh.start", async () => {
            await runCommand(t("Start dsh web"), async () => {
                await runtime.start(workspaceRoot());
                chatView.commandTarget().reveal();
            });
        }),
        vscode.commands.registerCommand("dsh.stop", async () => {
            await runCommand(t("Stop dsh web"), () => runtime.stop());
        }),
        vscode.commands.registerCommand("dsh.restart", async () => {
            await runCommand(t("Restart dsh web"), async () => {
                await runtime.restart(workspaceRoot());
                chatView.commandTarget().reveal();
            });
        }),
        vscode.commands.registerCommand("dsh.openLogs", () => output.show(true)),
        vscode.commands.registerCommand("dsh.openConfigurationBackups", () => runQuietCommand(t("Open DSH configuration backups"), async () => {
            const directory = await runtime.getConfigurationBackupsDirectory();
            await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(directory));
        })),
        vscode.commands.registerCommand("dsh.recovery.cancel", () => {
            runtime.cancelRecovery();
        }),
        vscode.commands.registerCommand("dsh.recovery.openDiagnostics", async () => {
            const status = runtime.getRecoveryStatus();
            output.show(true);
            if (status === undefined) {
                output.appendLine(t("No DSH recovery session has run in this window."));
                return;
            }
            const details = [
                "sessionId=" + status.sessionId,
                "phase=" + status.phase,
                "usedBoots=" + status.usedBoots + "/" + status.maxBoots,
                "currentVariant=" + (status.currentVariant ?? "-"),
                "canRestore=" + status.canRestore,
                "summary=" + (status.summary ?? "-"),
            ].join("\n");
            output.appendLine("[dsh:recovery] session details\n" + details);
            // Reveal the per-session log folder when it exists, so "and logs" is literal.
            const sessionLogs = vscode.Uri.file(join(runtime.getRecoveryLogsDirectory(), status.sessionId));
            try {
                await vscode.commands.executeCommand("revealFileInOS", sessionLogs);
            } catch (error) {
                output.appendLine("[dsh:recovery] session log folder unavailable: " + String(error));
            }
        }),
        vscode.commands.registerCommand("dsh.recovery.exportDiagnostics", async () => {
            await runCommand(t("Export recovery diagnostics"), async () => {
                const path = await runtime.exportRecoveryDiagnostics();
                await vscode.env.clipboard.writeText(path);
                void vscode.window.showInformationMessage(t("DSH recovery diagnostics exported to {path}.", { path }));
            });
        }),
        vscode.commands.registerCommand("dsh.recovery.restore", async () => {
            // Ask outside runCommand: returning from inside its callback completes
            // normally and would report a successful restore that never happened.
            const answer = await vscode.window.showWarningMessage(
                t("Restore the automatic DSH recovery changes? The Runtime must be stopped first."),
                { modal: true },
                t("Restore"),
            );
            if (answer !== t("Restore")) return;
            await runCommand(t("Restore automatic recovery changes"), async () => {
                await runtime.restoreRecovery();
            });
        }),
        vscode.commands.registerCommand("dsh.openInBrowser", async () => {
            await runCommand(t("Open dsh Web UI"), () => chatView.commandTarget().openBrowser());
        }),
        vscode.commands.registerCommand("dsh.insertEditorReference", () =>
            chatView.commandTarget().insertEditorReference(),
        ),
        vscode.commands.registerCommand("dsh.askAboutResource", (resource?: vscode.Uri) =>
            runCommand(t("Ask about resource"), () => chatView.commandTarget().askAboutResource(resource)),
        ),
        vscode.commands.registerCommand("dsh.explainDebugState", () =>
            runQuietCommand(t("Capture Debug Context"), () => chatView.commandTarget().explainDebugState()),
        ),
        ...registerQuickTaskCommands(chatView),
        vscode.commands.registerCommand("dsh.openIdeContextPicker", () =>
            chatView.commandTarget().openIdeContextPicker(),
        ),
        vscode.commands.registerCommand("dsh.insertPromptTemplate", () =>
            runCommand(t("Insert prompt template"), () => chatView.commandTarget().insertPromptTemplate()),
        ),
        vscode.commands.registerCommand("dsh.browseRuntimeFiles", () =>
            runCommand(t("Runtime workspace files"), () => chatView.commandTarget().browseRuntimeFiles()),
        ),
        vscode.commands.registerCommand("dsh.refreshRuntimeFile", () =>
            runCommand(t("Refresh Runtime file preview"), () => chatView.commandTarget().refreshRuntimeFilePreview()),
        ),
        vscode.commands.registerCommand("dsh.captureAppShot", () =>
            runCommand(t("Capture AppShot"), () => chatView.commandTarget().captureAppShot()),
        ),
        vscode.commands.registerCommand("dsh.configureApiKey", () =>
            chatView.commandTarget().configureApiKey().catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(t("DSH: Failed to configure API Key: {message}", { message }));
            }),
        ),
        vscode.commands.registerCommand("dsh.configureJevApiKey", () =>
            runCommand(t("Configure Jev API Key"), async () => {
                const key = await vscode.window.showInputBox({
                    title: t("Configure Jev API Key"),
                    prompt: t("The Jev API Key is encrypted in VS Code SecretStorage and passed only to Runtime processes started by this extension. It is never written to settings, patch files, or logs."),
                    password: true,
                    ignoreFocusOut: true,
                    validateInput: (value) => value.trim() ? undefined : t("Enter a Jev API Key."),
                });
                if (key === undefined) return;
                await context.secrets.store(JEV_API_KEY_SECRET, key.trim());
                if (runtime.getStatus().state !== "running") return;
                const restart = t("Restart DSH Runtime");
                const answer = await vscode.window.showInformationMessage(
                    t("The Jev API Key will be used on the next Runtime launch. Restart DSH now?"),
                    restart,
                );
                if (answer === restart) await vscode.commands.executeCommand("dsh.restart");
            }),
        ),
        vscode.commands.registerCommand("dsh.manageProviders", () =>
            runCommand(t("Manage providers"), () => chatView.commandTarget().manageProviders()),
        ),
        vscode.commands.registerCommand("dsh.manageWorkspaces", () =>
            runCommand(t("Manage DSH Workspaces"), () => chatView.commandTarget().manageWorkspaces()),
        ),
        vscode.commands.registerCommand("dsh.manageAgentPresets", () =>
            runCommand(t("Manage Agent Presets"), () => chatView.commandTarget().manageAgentPresets()),
        ),
        vscode.commands.registerCommand("dsh.manageAccount", () =>
            runCommand(t("Manage DeepSeek account"), () => accountActions.manage()),
        ),
        vscode.commands.registerCommand("dsh.refreshBalance", () => balanceService.refresh()),
        vscode.commands.registerCommand("dsh.diagnoseEnvironment", async () => {
            await runCommand(t("Diagnose environment"), async () => {
                output.appendLine("");
                output.appendLine(await runtime.diagnoseEnvironment(workspaceRoot()));
                output.show(true);
            });
        }),
    );
    balanceService.start();

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            const autonomousDebuggingChanged = event.affectsConfiguration("dsh.autonomousDebugging");
            const jevChanged = event.affectsConfiguration("dsh.jev");
            if (!autonomousDebuggingChanged && !jevChanged) return;
            if (runtime.getStatus().state !== "running") return;
            const restart = t("Restart DSH Runtime");
            const message = jevChanged
                ? t("Jev settings apply to the next Runtime launch. Guarded tool arguments and samples for enabled policy features may be sent to the configured TypeSafe endpoint. Restart DSH now?")
                : t("Autonomous debugging changes how the Runtime launches, so it applies to the next launch. Restart DSH now?");
            void vscode.window
                .showInformationMessage(
                    message,
                    restart,
                )
                .then((answer) => {
                    if (answer !== restart) return;
                    void vscode.commands.executeCommand("dsh.restart");
                });
        }),
    );

    const configuration = vscode.workspace.getConfiguration("dsh");
    const autoStart = configuration.get<boolean>("autoStart", true);
    const root = workspaceRoot();
    const configuredServerUrl = configuration.get<string>("serverUrl", "").trim();
    if (autoStart && vscode.workspace.isTrusted && (root || configuredServerUrl || configuration.get<boolean>("desktopConnection", false))) {
        void runtime.start(root).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            output.appendLine(`[dsh] automatic startup failed: ${message}`);
        });
    }
    void showWhatsNewOnUpdate(context).catch((error: unknown) => {
        output.appendLine(`[dsh] could not show update notice: ${error instanceof Error ? error.message : String(error)}`);
    });

    return {
        registerAgentStatusPresentation: (presentation) =>
            agentStatusPresentations.registerAgentStatusPresentation(presentation),
        registerConversationNavigation: (entries) =>
            conversationNavigationRegistry.registerConversationNavigation(entries),
    };
}

function registerChatParticipant(chatView: ChatViewProvider, extensionUri: vscode.Uri): vscode.Disposable {
    const participant = vscode.chat.createChatParticipant("dsh", async (request, _context, response, token) => {
        const prompt = request.prompt.trim();
        if (!prompt) {
            response.markdown(t("Please provide a task for dsh."));
            return;
        }
        response.progress(t("Sending the task to the dsh session..."));
        await chatView.commandTarget().sendParticipantPrompt(prompt, token);
        if (token.isCancellationRequested) return;
        response.markdown(t("Task sent to the current dsh session. Continue in the DSH view for streaming output and approvals."));
    });
    participant.iconPath = {
        light: vscode.Uri.joinPath(extensionUri, "resources", "dsh.svg"),
        dark: vscode.Uri.joinPath(extensionUri, "resources", "dsh-dark.svg"),
    };
    return participant;
}

function registerQuickTaskCommands(chatView: ChatViewProvider): vscode.Disposable[] {
    const tasks: ReadonlyArray<{ kind: QuickTaskKind; command: string }> = [
        { kind: "explain", command: "explain" },
        { kind: "fix", command: "fix" },
        { kind: "review", command: "review" },
        { kind: "docs", command: "docs" },
    ];

    return tasks.flatMap(({ kind, command }) => [
        vscode.commands.registerCommand(`dsh.editorTask.${command}`, () =>
            runQuietCommand(t("Prefill editor quick task"), () => chatView.commandTarget().prefillEditorTask(kind)),
        ),
        vscode.commands.registerCommand(`dsh.gitDiffTask.${command}`, () =>
            runQuietCommand(t("Prefill Git diff quick task"), () => chatView.commandTarget().prefillGitDiffTask(kind)),
        ),
    ]);
}

export function deactivate(): Promise<void> | undefined {
    // VS Code awaits this promise; asynchronous Disposable callbacks alone are not awaited.
    return shutdownRuntime?.();
}

function workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function runCommand(label: string, action: () => Promise<void>): Promise<void> {
    try {
        await action();
        void vscode.window.showInformationMessage(t("DSH: {label} completed.", { label }));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof OfficialDesktopRequiredError) {
            const download = t("Download DeepSeek Desktop");
            void vscode.window.showErrorMessage(`DSH: ${message}`, download).then((action) => {
                if (action === download) void vscode.env.openExternal(vscode.Uri.parse(OFFICIAL_DESKTOP_DOWNLOAD_URL));
            });
        } else {
            void vscode.window.showErrorMessage(t("DSH: {label} failed: {message}", { label, message }));
        }
    }
}

async function runQuietCommand(label: string, action: () => Promise<void>): Promise<void> {
    try {
        await action();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(t("DSH: {label} failed: {message}", { label, message }));
    }
}
