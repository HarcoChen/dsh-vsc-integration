const vscode = require("vscode");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const root = process.env.DSH_NATIVE_SMOKE_ROOT;
const stateFile = process.env.DSH_NATIVE_SMOKE_STATE;
const scratch = path.dirname(stateFile);
async function until(read) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        const value = await read();
        if (value) return value;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Native IDE condition timed out");
}
exports.run = async () => {
    let runtime;
    const output = vscode.window.createOutputChannel("DSH native integration");
    try {
        const data = JSON.parse(await fs.readFile(stateFile, "utf8"));
        const extension = vscode.extensions.getExtension("harcochen.dsh-vsc-integration");
        assert.ok(extension, "development extension loaded");
        await extension.activate();
        if (process.env.DSH_NATIVE_SMOKE_PHASE === "restore") {
            const previous = JSON.parse(await fs.readFile(path.join(scratch, "result.json"), "utf8"));
            await until(() =>
                vscode.window.tabGroups.all
                    .flatMap((group) => group.tabs)
                    .some((tab) => tab.label === previous.remaining)
            );
            await fs.writeFile(path.join(scratch, "result.json"), JSON.stringify({ ...previous, restored: true }));
            return;
        }
        await new Promise((r) => setTimeout(r, 1500));
        for (const id of data.sessionIds) await vscode.commands.executeCommand("dsh.openInEditor", id);
        const tabs = () =>
            vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.label.startsWith("DSH ·"));
        await until(
            () =>
                tabs().length === 2 &&
                tabs().some((tab) => tab.label.includes("IDE First Session")) &&
                tabs().some((tab) => tab.label.includes("IDE Second Session"))
        );
        await vscode.commands.executeCommand("dsh.openInEditor", data.sessionIds[0]);
        assert.equal(tabs().length, 2, "opening the same session reveals its existing tab");
        const { DshRuntime } = require(path.join(root, "dist/dshRuntime"));
        runtime = new DshRuntime(output, path.join(scratch, "storage"));
        await runtime.start(data.workspacePath);
        await until(() => runtime.getSessionCatalog().snapshot().sessions.length > 0);
        const { InlineCompletionProvider } = require(path.join(root, "dist/inlineCompletion"));
        const provider = new InlineCompletionProvider(runtime, () => data.sessionIds[0], output);
        const uri = vscode.Uri.file(path.join(data.workspacePath, "completion.js"));
        await vscode.workspace.fs.writeFile(uri, Buffer.from("function example() {\n    "));
        const document = await vscode.workspace.openTextDocument(uri);
        const { ContextStore } = require(path.join(root, "dist/contextStore"));
        const contextStore = new ContextStore();
        contextStore.addDocumentContext(document, new vscode.Range(0, 0, 0, document.lineAt(0).text.length), "Native symbol context");
        const contextCapture = contextStore.capturePromptContext({ includeCurrentSelection: false });
        assert.ok(contextCapture.text.includes("function example()"));
        assert.equal(contextStore.snapshot()[0].label, "Native symbol context");
        const token = new vscode.CancellationTokenSource();
        const completions = await provider.provideInlineCompletionItems(
            document,
            new vscode.Position(1, 4),
            { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined },
            token.token
        );
        assert.ok(completions.length > 0, "manual inline completion returns ghost text from the isolated model");
        assert.equal(completions[0].insertText, "Hello world");
        const cancelled = new vscode.CancellationTokenSource();
        cancelled.cancel();
        assert.deepEqual(
            await provider.provideInlineCompletionItems(
                document,
                new vscode.Position(1, 4),
                { triggerKind: vscode.InlineCompletionTriggerKind.Invoke },
                cancelled.token
            ),
            []
        );
        provider.dispose();
        token.dispose();
        cancelled.dispose();
        const api = runtime.getApiClient();
        const settings = await api.call("settings/describe", {});
        const pi = settings.namespaces.find(item => item.ns === "llm-pi-ai");
        await api.call("settings/mutate", { ns: pi.ns, expectedRevision: pi.revision,
            ops: [{ op: "set", path: ["providers", "native-text-only"], value: {
                api: "anthropic-messages", apiKeyEnv: "DSH_SMOKE_API_KEY", baseURL: data.modelUrl,
                models: [{ id: "native-text-only", input: ["text"], reasoningEfforts: false }],
            } }] });
        const fallback = await runtime.createSession(data.workspacePath, "minimal");
        await runtime.selectModel({ sessionId: fallback.sessionId, provider: "native-text-only", model: "native-text-only" });
        const receipt = await runtime.prompt(fallback.sessionId, "Non-vision attachment fixture", "queue", [{
            mediaType: "image/png", name: "pixel.png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=",
        }]);
        assert.equal(receipt.accepted, true, "text-only model receives the image through file fallback");
        const filePrompt = await until(async () => {
            await runtime.syncSession(fallback.sessionId);
            return runtime.getSessionStore().get(fallback.sessionId)?.events.find(entry => entry.event.type === "user/message");
        });
        assert.ok(filePrompt.event.data.content.some(part => part.type === "file"));
        await runtime.archiveSession(fallback.sessionId, true);
        await vscode.window.tabGroups.close(tabs()[0], true);
        assert.equal(tabs().length, 1, "closing a tab preserves the other conversation");
        await runtime.getApiClient().probe();
        await fs.writeFile(
            path.join(scratch, "result.json"),
            JSON.stringify({
                ok: true,
                remaining: tabs()[0].label,
                checks: [
                    "independent session tabs",
                    "reuse existing tab",
                    "close tab without stopping Runtime",
                    "real inline completion",
                    "cancelled inline completion",
                    "text-only model image/file fallback",
                ],
            })
        );
    } catch (error) {
        await fs.writeFile(
            path.join(scratch, "result.json"),
            JSON.stringify({ ok: false, message: String(error.stack || error) })
        );
        throw error;
    } finally {
        if (runtime) await runtime.dispose();
        output.dispose();
        if (process.env.DSH_NATIVE_SMOKE_PHASE === "restore") await fs.writeFile(stateFile + ".done", "done");
    }
};
