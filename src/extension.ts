import * as vscode from "vscode";
import { DeepSeekBalanceService } from "./balanceService";
import { ChatViewProvider } from "./chatView";
import { ContextStore } from "./contextStore";
import { DshRuntime } from "./dshRuntime";

export function activate(context: vscode.ExtensionContext): void {
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

    context.subscriptions.push(
        output,
        balanceService,
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
        vscode.commands.registerCommand("dsh.insertEditorReference", () =>
            chatView.insertEditorReference(),
        ),
        vscode.commands.registerCommand("dsh.openIdeContextPicker", () =>
            chatView.openIdeContextPicker(),
        ),
        vscode.commands.registerCommand("dsh.configureApiKey", () =>
            chatView.configureApiKey().catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(`DSH: 配置 API Key 失败：${message}`);
            }),
        ),
        vscode.commands.registerCommand("dsh.refreshBalance", () => balanceService.refresh()),
    );
    balanceService.start();
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
