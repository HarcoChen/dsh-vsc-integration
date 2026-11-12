import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { DshRuntime } from "./dshRuntime";
import { projectionValue } from "./sessionStore";
import { contentText } from "./chatState";
import { isRecord } from "./guards";
import { normalizeModelSelectionProjection } from "./modelSelection";

export function cleanInlineCompletion(text: string, prefix: string, suffix: string): string {
    let value = text.replace(/^```[^\n]*\n/u, "").replace(/\n```\s*$/u, "");
    const lastLine = prefix.slice(prefix.lastIndexOf("\n") + 1);
    if (lastLine && value.startsWith(lastLine)) value = value.slice(lastLine.length);
    const nextLine = suffix.split("\n")[0];
    if (nextLine && value.endsWith(nextLine)) value = value.slice(0, -nextLine.length);
    return value.slice(0, 4000);
}

/** Uses a dedicated minimal Session, then cancels and archives it on every exit path. */
export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
    private current?: AbortController;
    private disposed = false;
    public constructor(
        private readonly runtime: DshRuntime,
        private readonly currentSession: () => string | undefined,
        private readonly output: vscode.OutputChannel
    ) {}

    public dispose(): void {
        this.disposed = true;
        this.current?.abort();
    }

    public async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionItem[]> {
        const automatic = context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic;
        const config = vscode.workspace.getConfiguration("dsh", document.uri);
        if (
            this.disposed ||
            !vscode.workspace.isTrusted ||
            document.isClosed ||
            document.uri.scheme !== "file" ||
            context.selectedCompletionInfo !== undefined ||
            (automatic && !config.get<boolean>("inlineCompletion.automatic", false)) ||
            this.runtime.getStatus().state !== "running" ||
            !this.runtime.remoteAccess.snapshot.owner
        )
            return [];
        this.current?.abort();
        const abort = new AbortController();
        this.current = abort;
        const cancellation = token.onCancellationRequested(() => abort.abort());
        const timer = setTimeout(() => abort.abort(), 30_000);
        const endpoint = this.runtime.getUrl();
        const version = document.version;
        let sessionId: string | undefined;
        const api = this.runtime.getApiClient();
        try {
            if (token.isCancellationRequested) return [];
            await new Promise<void>((resolve, reject) => {
                const ready = setTimeout(
                    () => {
                        abort.signal.removeEventListener("abort", stop);
                        resolve();
                    },
                    automatic ? 500 : 0
                );
                const stop = (): void => {
                    clearTimeout(ready);
                    reject(new Error("cancelled"));
                };
                abort.signal.addEventListener("abort", stop, { once: true });
            });
            abort.signal.throwIfAborted();
            const text = document.getText();
            const offset = document.offsetAt(position);
            const prefix = text.slice(Math.max(0, offset - 12_000), offset);
            const suffix = text.slice(offset, offset + 4000);
            const root = this.currentSession();
            const summary = this.runtime
                .getSessionCatalog()
                .snapshot()
                .sessions.find((item) => item.sessionId === root);
            const cwd = summary?.cwd ?? vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
            const created = await api.call<unknown>(
                "session/create",
                { request: { agentPreset: "minimal", ...(cwd ? { cwd } : {}) } },
                abort.signal
            );
            if (!isRecord(created) || typeof created.sessionId !== "string") return [];
            sessionId = created.sessionId;
            this.runtime.markBackgroundSession(sessionId);
            const selected = normalizeModelSelectionProjection(
                projectionValue(root ? this.runtime.getSessionStore().get(root) : undefined, "modelSelection")
            );
            const provider =
                config.get<string>("inlineCompletion.provider", "").trim() ||
                (isRecord(selected) && typeof selected.provider === "string" ? selected.provider : undefined);
            const model =
                config.get<string>("inlineCompletion.model", "").trim() ||
                (isRecord(selected) && typeof selected.model === "string" ? selected.model : undefined);
            if (provider && model)
                await api.call("session/selectModel", { request: { sessionId, provider, model } }, abort.signal);
            await api.call(
                "session/prompt",
                {
                    request: {
                        sessionId,
                        requestId: randomUUID(),
                        mode: "queue",
                        content: [
                            {
                                type: "text",
                                text: `Complete the ${document.languageId} code at <CURSOR>. Return only the code to insert, with no explanation or Markdown fences. Do not repeat the prefix or suffix. Do not call tools.\n<PREFIX>\n${prefix}\n</PREFIX>\n<CURSOR>\n<SUFFIX>\n${suffix}\n</SUFFIX>`,
                            },
                        ],
                    },
                },
                abort.signal
            );
            let answer = "";
            for await (const frame of this.runtime.followCompletion(sessionId, abort.signal)) {
                if (!isRecord(frame)) continue;
                const events =
                    frame.type === "snapshot" && Array.isArray(frame.records)
                        ? frame.records.filter(isRecord).map((record) => record.event)
                        : frame.type === "event"
                          ? [frame.event]
                          : [];
                let ended = false;
                for (const event of events) {
                    if (!isRecord(event) || !isRecord(event.data)) continue;
                    if (event.type === "assistant/message") {
                        const message = isRecord(event.data.message) ? event.data.message : event.data;
                        answer = contentText(message.content);
                    }
                    if (event.type === "turn/end") ended = true;
                }
                if (ended) break;
            }
            if (
                abort.signal.aborted ||
                document.version !== version ||
                endpoint !== this.runtime.getUrl() ||
                this.disposed
            )
                return [];
            const insertion = cleanInlineCompletion(answer, prefix, suffix);
            return insertion ? [new vscode.InlineCompletionItem(insertion, new vscode.Range(position, position))] : [];
        } catch (error) {
            if (!abort.signal.aborted)
                this.output.appendLine(`[dsh:inline] ${error instanceof Error ? error.name : "request failed"}`);
            return [];
        } finally {
            clearTimeout(timer);
            cancellation.dispose();
            if (sessionId && endpoint === this.runtime.getUrl()) {
                await api
                    .call("session/cancel", { request: { sessionId } }, AbortSignal.timeout(3000))
                    .catch(() => undefined);
                await api
                    .call(
                        "workspace/archiveSession",
                        { request: { sessionId, stopActivity: true } },
                        AbortSignal.timeout(3000)
                    )
                    .catch(() => undefined);
                this.runtime.unmarkBackgroundSession(sessionId);
            }
            if (this.current === abort) this.current = undefined;
        }
    }
}
