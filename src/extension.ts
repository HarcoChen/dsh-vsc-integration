import * as vscode from "vscode";
import { ChatViewProvider } from "./chatView";
import { ContextStore } from "./contextStore";
import { DshRuntime } from "./dshRuntime";

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel("DeepSeek Harness");
    const runtime = new DshRuntime(output);
    const contextStore = new ContextStore();
    const chatView = new ChatViewProvider(
        context,
        context.extensionUri,
        runtime,
        contextStore,
        output,
    );

    context.subscriptions.push(
        output,
        chatView,
        new vscode.Disposable(() => {
            void runtime.dispose();
        }),
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatView, {
            webviewOptions: {
                retainContextWhenHidden: true,
            },
        }),
        vscode.commands.registerCommand("dsh.open", () => chatView.reveal()),
        vscode.commands.registerCommand("dsh.start", async () => {
            await runCommand("启动 dsh web", async () => {
                await runtime.start(workspaceRoot());
                chatView.reveal();
            });
        }),
        vscode.commands.registerCommand("dsh.stop", async () => {
            await runCommand("停止 dsh web", () => runtime.stop());
        }),
        vscode.commands.registerCommand("dsh.restart", async () => {
            await runCommand("重启 dsh web", async () => {
                await runtime.restart(workspaceRoot());
                chatView.reveal();
            });
        }),
        vscode.commands.registerCommand("dsh.openLogs", () => output.show(true)),
        vscode.commands.registerCommand("dsh.openInBrowser", async () => {
            await runCommand("打开 dsh Web UI", () => chatView.openBrowser());
        }),
        vscode.commands.registerCommand("dsh.addActiveEditorToContext", () =>
            chatView.addActiveEditorToContext(),
        ),
        vscode.commands.registerCommand("dsh.addSelectionToContext", () =>
            chatView.addSelectionToContext(),
        ),
        vscode.commands.registerCommand("dsh.addFileToContext", (uri?: vscode.Uri) =>
            chatView.addFileToContext(uri),
        ),
        vscode.commands.registerCommand("dsh.addFolderToContext", (uri?: vscode.Uri) =>
            chatView.addFolderToContext(uri),
        ),
        vscode.commands.registerCommand("dsh.addDiagnosticsToContext", () =>
            chatView.addDiagnosticsToContext(),
        ),
        vscode.commands.registerCommand("dsh.addGitDiffToContext", () =>
            chatView.addGitDiffToContext(),
        ),
        vscode.commands.registerCommand("dsh.clearContext", () => chatView.clearContext()),
        vscode.commands.registerCommand("dsh.showContext", () => chatView.showContext()),
        vscode.commands.registerCommand("dsh.copyContext", () => chatView.copyContext()),
    );
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
        void vscode.window.showInformationMessage(`DSH: ${label}完成。`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`DSH: ${label}失败：${message}`);
    }
}
