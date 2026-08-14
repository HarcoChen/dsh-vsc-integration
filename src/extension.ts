import * as vscode from "vscode";
import { DeepSeekBalanceService } from "./balanceService";
import { ChatViewProvider } from "./chatView";
import { ContextStore } from "./contextStore";
import { DshRuntime } from "./dshRuntime";
import { TracePanelManager } from "./tracePanel";
import { parseTraceLocation } from "./traceProtocol";

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
                    throw new Error("Trace 定位参数无效。");
                }
                const sessionId = supplied?.sessionId ?? chatView.getCurrentSessionId();
                if (!sessionId) throw new Error("当前没有可打开的会话。");
                await tracePanels.open(supplied ?? { sessionId });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(`DSH: 打开 Trace 失败：${message}`);
            }
        }),
        vscode.commands.registerCommand("dsh.newSession", () =>
            runCommand("新建会话", () => chatView.newSession()),
        ),
        vscode.commands.registerCommand("dsh.switchSession", () =>
            runCommand("切换会话", () => chatView.chooseSession()),
        ),
        vscode.commands.registerCommand("dsh.searchSession", () =>
            runCommand("搜索会话", () => chatView.searchSession()),
        ),
        vscode.commands.registerCommand("dsh.selectModel", () =>
            runCommand("选择模型", () => chatView.selectModel()),
        ),
        vscode.commands.registerCommand("dsh.renameSession", () =>
            runCommand("重命名会话", () => chatView.renameSession()),
        ),
        vscode.commands.registerCommand("dsh.forkSession", () =>
            runCommand("Fork 会话", () => chatView.forkSession()),
        ),
        vscode.commands.registerCommand("dsh.archiveSession", () =>
            runCommand("归档会话", () => chatView.archiveSession()),
        ),
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
