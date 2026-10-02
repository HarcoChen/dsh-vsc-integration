import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import * as vscode from "vscode";
import type { DshRuntime } from "./dshRuntime";
import { errorMessage } from "./errors";
import { t } from "./localize";
import { isAbortError, isRemoteError } from "./remote/errors";
import { readRuntimeTextPreview } from "./workspaceFiles";

const PREVIEW_SCHEME = "dsh-runtime-file";

interface Preview {
    uri: vscode.Uri;
    sessionId: string;
    path: string;
    endpoint: string;
    content: string;
    watch?: AbortController;
    read?: AbortController;
    timer?: ReturnType<typeof setTimeout>;
}

interface FileChoice extends vscode.QuickPickItem {
    action: "up" | "refresh" | "directory" | "file";
    path: string;
}

/** Explicit Host-side file browsing, with read-only previews bound to a Session and Runtime endpoint. */
export class RuntimeWorkspaceBrowser implements vscode.TextDocumentContentProvider, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<vscode.Uri>();
    public readonly onDidChange = this.changed.event;
    private readonly previews = new Map<string, Preview>();
    private readonly openingReads = new Set<AbortController>();
    private disposed = false;
    private readonly subscriptions: vscode.Disposable[];

    public constructor(private readonly runtime: DshRuntime, private readonly output: vscode.OutputChannel) {
        this.subscriptions = [
            vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, this),
            vscode.workspace.onDidCloseTextDocument(document => {
                const preview = this.previews.get(document.uri.toString());
                if (!preview) return;
                this.stop(preview);
                this.previews.delete(document.uri.toString());
            }),
            runtime.onDidChange(status => {
                if (status.state === "stopped") for (const preview of this.previews.values()) this.stop(preview);
            }),
            runtime.onDidHarnessConnect(() => {
                for (const preview of this.previews.values()) {
                    this.stop(preview);
                    if (preview.endpoint !== runtime.getUrl()) {
                        preview.content = t("The connected Runtime changed. Browse its files again to open a new preview.");
                        this.changed.fire(preview.uri);
                        continue;
                    }
                    this.watch(preview);
                    void this.refreshPreview(preview).catch(error => this.showRefreshError(preview, error));
                }
            }),
        ];
    }

    public provideTextDocumentContent(uri: vscode.Uri): string {
        const preview = this.previews.get(uri.toString());
        if (!preview) throw new Error(t("This Runtime file preview has been closed. Browse the files again."));
        return preview.content;
    }

    /** Read directory entries from the selected DSH Session, never from the editor's local filesystem. */
    public async browse(sessionId: string): Promise<void> {
        const endpoint = this.runtime.getUrl();
        if (!endpoint) throw new Error(t("The Runtime is not connected."));
        let path = ".";
        while (true) {
            this.assertEndpoint(endpoint);
            const listing = await this.runtime.workspaceFiles.list(sessionId, path);
            this.assertEndpoint(endpoint);
            if (!listing) throw new Error(t("This Runtime does not expose workspace file previews."));
            const choices: FileChoice[] = [
                ...(listing.path ? [{ action: "up" as const, path: posix.dirname(listing.path), label: `$(arrow-up) ${t("Parent directory")}` }] : []),
                { action: "refresh", path: listing.path || ".", label: `$(refresh) ${t("Refresh directory")}` },
                ...[...listing.entries].sort((a, b) =>
                    Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name),
                ).filter(entry => entry.type !== "other").map(entry => ({
                    action: entry.type as "directory" | "file",
                    path: posix.join(listing.path, entry.name),
                    label: `$(${entry.type === "directory" ? "folder" : "file"}) ${entry.name}`,
                    ...(entry.size === undefined ? {} : { description: t("{bytes} bytes", { bytes: entry.size.toLocaleString() }) }),
                })),
            ];
            const choice = await vscode.window.showQuickPick(choices, {
                title: t("Runtime workspace files · {path}", { path: listing.path || "/" }),
                placeHolder: listing.truncated
                    ? t("This directory listing was truncated by the Runtime. Choose a folder or refresh.")
                    : t("Choose a folder or open a read-only UTF-8 file preview (up to 1 MiB)."),
                matchOnDescription: true,
            });
            if (!choice) return;
            if (choice.action !== "file") { path = choice.path || "."; continue; }
            this.assertEndpoint(endpoint);
            await this.openPreview(sessionId, choice.path, endpoint);
            return;
        }
    }

    /** Manual refresh also works when the Host has no filesystem watcher. */
    public async refreshActive(): Promise<void> {
        const uri = vscode.window.activeTextEditor?.document.uri;
        const preview = uri ? this.previews.get(uri.toString()) : undefined;
        if (!preview) throw new Error(t("Open a Runtime file preview before refreshing it."));
        await this.refreshPreview(preview);
    }

    private assertEndpoint(endpoint: string): void {
        if (this.disposed) throw new Error(t("This Runtime file preview has been closed. Browse the files again."));
        if (this.runtime.getUrl() !== endpoint) throw new Error(t("The connected Runtime changed. Browse its files again to open a new preview."));
    }

    private async openPreview(sessionId: string, path: string, endpoint: string): Promise<void> {
        const controller = new AbortController();
        this.openingReads.add(controller);
        const result = await Promise.resolve(vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: t("Reading Runtime file: {path}", { path }),
            cancellable: true,
        }, async (_progress, token) => {
            const listener = token.onCancellationRequested(() => controller.abort());
            if (token.isCancellationRequested) controller.abort();
            try {
                return await this.read(sessionId, path, endpoint, controller.signal);
            } finally { listener.dispose(); }
        })).finally(() => this.openingReads.delete(controller));
        controller.signal.throwIfAborted();
        this.assertEndpoint(endpoint);
        const uri = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: `/${posix.basename(path)}`, query: randomUUID() });
        const preview: Preview = { uri, sessionId, path: result.absolutePath, endpoint, content: result.text };
        this.previews.set(uri.toString(), preview);
        try {
            const document = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(document, { preview: true });
            this.watch(preview);
        } catch (error) {
            this.stop(preview);
            this.previews.delete(uri.toString());
            throw error;
        }
    }

    /** Check before each RPC so a server switch cannot send a preview's Session id to the new Host. */
    private read(sessionId: string, path: string, endpoint: string, signal: AbortSignal) {
        return readRuntimeTextPreview({
            stat: async (...args) => {
                this.assertEndpoint(endpoint);
                const result = await this.runtime.workspaceFiles.stat(...args);
                this.assertEndpoint(endpoint);
                return result;
            },
            readBytes: async (...args) => {
                this.assertEndpoint(endpoint);
                const result = await this.runtime.workspaceFiles.readBytes(...args);
                this.assertEndpoint(endpoint);
                return result;
            },
        }, sessionId, path, signal);
    }

    private async refreshPreview(preview: Preview): Promise<void> {
        this.assertEndpoint(preview.endpoint);
        preview.read?.abort();
        const controller = new AbortController();
        preview.read = controller;
        try {
            const result = await this.read(preview.sessionId, preview.path, preview.endpoint, controller.signal);
            if (controller.signal.aborted || !this.previews.has(preview.uri.toString())) return;
            preview.content = result.text;
            this.changed.fire(preview.uri);
        } finally {
            if (preview.read === controller) preview.read = undefined;
        }
    }

    private watch(preview: Preview): void {
        preview.watch?.abort();
        const controller = new AbortController();
        preview.watch = controller;
        void (async () => {
            try {
                this.assertEndpoint(preview.endpoint);
                for await (const frame of this.runtime.workspaceFiles.changes(preview.sessionId, preview.path, controller.signal)) {
                    if (frame.kind !== "change") continue;
                    if (preview.timer !== undefined) clearTimeout(preview.timer);
                    preview.timer = setTimeout(() => {
                        preview.timer = undefined;
                        void this.refreshPreview(preview).catch(error => this.showRefreshError(preview, error));
                    }, 150);
                }
            } catch (error) {
                if (controller.signal.aborted) return;
                // Unsupported watches keep the preview readable via the explicit refresh command.
                if (isRemoteError(error) && error.code === "workspace-file/watch-unsupported") return;
                this.output.appendLine(`[dsh:workspace-files] watcher: ${errorMessage(error)}`);
            }
        })();
    }

    private showRefreshError(preview: Preview, error: unknown): void {
        if (isAbortError(error) || !this.previews.has(preview.uri.toString()) || preview.watch?.signal.aborted) return;
        preview.content = t("Runtime file preview could not be refreshed: {message}", { message: errorMessage(error) });
        this.changed.fire(preview.uri);
    }

    private stop(preview: Preview): void {
        preview.watch?.abort();
        preview.read?.abort();
        if (preview.timer !== undefined) clearTimeout(preview.timer);
        preview.timer = undefined;
    }

    public dispose(): void {
        this.disposed = true;
        for (const controller of this.openingReads) controller.abort();
        this.openingReads.clear();
        for (const preview of this.previews.values()) this.stop(preview);
        this.previews.clear();
        for (const subscription of this.subscriptions) subscription.dispose();
        this.changed.dispose();
    }
}
