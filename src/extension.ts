import * as vscode from "vscode";
import { DeepSeekBalanceService } from "./balanceService";
import { ChatViewProvider, QuickTaskKind } from "./chatView";
import { ContextStore } from "./contextStore";
import { DshRuntime } from "./dshRuntime";
import { configureLocalization, t } from "./localize";
import { TracePanelManager } from "./tracePanel";
import { parseTraceLocation } from "./traceProtocol";

export function activate(context: vscode.ExtensionContext): void {
    configureLocalization((message, args) => vscode.l10n.t(message, args));
    const output = vscode.window.createOutputChannel("DeepSeek Harness");
    const runtime = new DshRuntime(output);
    const balanceService = new DeepSeekBalanceService(context, output);
    const contextStore = new ContextStore();
    const chatView = new ChatViewProvider(
        context,
        context.extensionUri,
        runtime,
        contextStore,
        output,
        balanceService,
    );
    const tracePanels = new TracePanelManager(runtime, output, workspaceRoot);

    context.subscriptions.push(
        output,
        balanceService,
        chatView,
        tracePanels,
        new vscode.Disposable(() => {
            void runtime.dispose();
        }),
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatView, {
            webviewOptions: {
                retainContextWhenHidden: true,
            },
        }),
        vscode.window.registerWebviewPanelSerializer(TracePanelManager.viewType, tracePanels),
        vscode.commands.registerCommand("dsh.open", () => chatView.reveal()),
        vscode.commands.registerCommand("dsh.openTrace", async (value?: unknown) => {
            try {
                const supplied = value === undefined ? undefined : parseTraceLocation(value);
                if (value !== undefined && !supplied) {
                    throw new Error(t("Invalid Trace location."));
                }
                const sessionId = supplied?.sessionId ?? chatView.getCurrentSessionId();
                if (!sessionId) throw new Error(t("There is no current session to open."));
                await tracePanels.open(supplied ?? { sessionId });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(t("DSH: Failed to open Trace: {message}", { message }));
            }
        }),
        vscode.commands.registerCommand("dsh.newSession", () =>
            runCommand(t("Create session"), () => chatView.newSession()),
        ),
        vscode.commands.registerCommand("dsh.switchSession", () =>
            runCommand(t("Switch session"), () => chatView.chooseSession()),
        ),
        vscode.commands.registerCommand("dsh.searchSession", () =>
            runCommand(t("Search sessions"), () => chatView.searchSession()),
        ),
        vscode.commands.registerCommand("dsh.selectModel", () =>
            runCommand(t("Select model"), () => chatView.selectModel()),
        ),
        vscode.commands.registerCommand("dsh.renameSession", () =>
            runCommand(t("Rename session"), () => chatView.renameSession()),
        ),
        vscode.commands.registerCommand("dsh.forkSession", () =>
            runCommand(t("Fork session"), () => chatView.forkSession()),
        ),
        vscode.commands.registerCommand("dsh.archiveSession", () =>
            runCommand(t("Archive session"), () => chatView.archiveSession()),
        ),
        vscode.commands.registerCommand("dsh.start", async () => {
            await runCommand(t("Start dsh web"), async () => {
                await runtime.start(workspaceRoot());
                chatView.reveal();
            });
        }),
        vscode.commands.registerCommand("dsh.stop", async () => {
            await runCommand(t("Stop dsh web"), () => runtime.stop());
        }),
        vscode.commands.registerCommand("dsh.restart", async () => {
            await runCommand(t("Restart dsh web"), async () => {
                await runtime.restart(workspaceRoot());
                chatView.reveal();
            });
        }),
        vscode.commands.registerCommand("dsh.openLogs", () => output.show(true)),
        vscode.commands.registerCommand("dsh.openInBrowser", async () => {
            await runCommand(t("Open dsh Web UI"), () => chatView.openBrowser());
        }),
        vscode.commands.registerCommand("dsh.insertEditorReference", () =>
            chatView.insertEditorReference(),
        ),
        vscode.commands.registerCommand("dsh.askAboutResource", (resource?: vscode.Uri) =>
            runCommand(t("Ask about resource"), () => chatView.askAboutResource(resource)),
        ),
        ...registerQuickTaskCommands(chatView),
        vscode.commands.registerCommand("dsh.openIdeContextPicker", () =>
            chatView.openIdeContextPicker(),
        ),
        vscode.commands.registerCommand("dsh.configureApiKey", () =>
            chatView.configureApiKey().catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(t("DSH: Failed to configure API Key: {message}", { message }));
            }),
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

    const configuration = vscode.workspace.getConfiguration("dsh");
    const autoStart = configuration.get<boolean>("autoStart", true);
    const root = workspaceRoot();
    const configuredServerUrl = configuration.get<string>("serverUrl", "").trim();
    if (autoStart && vscode.workspace.isTrusted && (root || configuredServerUrl)) {
        void runtime.start(root).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            output.appendLine(`[dsh] automatic startup failed: ${message}`);
        });
    }
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
            runQuietCommand(t("Prefill editor quick task"), () => chatView.prefillEditorTask(kind)),
        ),
        vscode.commands.registerCommand(`dsh.gitDiffTask.${command}`, () =>
            runQuietCommand(t("Prefill Git diff quick task"), () => chatView.prefillGitDiffTask(kind)),
        ),
    ]);
}

export function deactivate(): void {
    // The runtime is registered as a disposable in activate().
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
        void vscode.window.showErrorMessage(t("DSH: {label} failed: {message}", { label, message }));
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
