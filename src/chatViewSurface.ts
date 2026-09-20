/**
 * One live rendering of the chat.
 *
 * The controller (`ChatViewProvider`) owns the Session and the single chat
 * state; a surface owns only what is inherently per-view: whether that view has
 * booted, how to bring it forward, and how to turn a resource path into a URI
 * its own webview can load. `asWebviewUri` is scoped to one webview, so two
 * surfaces cannot share state that has a resource URI baked into it — see
 * ChatViewProvider.withSurfaceResources.
 */

import * as vscode from "vscode";

export interface ChatViewSurfaceConfig {
    readonly view: vscode.WebviewView | vscode.WebviewPanel;
    readonly extensionUri: vscode.Uri;
    /**
     * Command that exposes a sidebar surface's parent container. `WebviewView.show()`
     * only reveals the view inside its container, so a collapsed sidebar part
     * needs this as well. An editor tab is already a workbench part and omits it.
     */
    readonly revealCommand?: string;
    readonly html: (webview: vscode.Webview) => string;
    readonly onMessage: (message: unknown, surface: ChatViewSurface) => void;
    readonly onVisibilityChange: (surface: ChatViewSurface) => void;
    readonly onDisposed: (surface: ChatViewSurface) => void;
}

/**
 * A view that has not booted yet accepts no messages, and one that is already
 * gone reports `false` from every post rather than throwing.
 */
export class ChatViewSurface implements vscode.Disposable {
    public readonly webview: vscode.Webview;
    private booted = false;
    private closed = false;
    private readonly subscriptions: vscode.Disposable[] = [];

    private constructor(private readonly config: ChatViewSurfaceConfig) {
        this.webview = config.view.webview;
        this.webview.options = {
            enableScripts: true,
            localResourceRoots: [config.extensionUri],
        };
        this.webview.html = config.html(this.webview);
        this.subscriptions.push(
            this.webview.onDidReceiveMessage((message: unknown) => {
                this.config.onMessage(message, this);
            }),
        );
        this.subscribeView();
    }

    public static open(config: ChatViewSurfaceConfig): ChatViewSurface {
        return new ChatViewSurface(config);
    }

    public get ready(): boolean {
        return this.booted && !this.closed;
    }

    public get visible(): boolean {
        return this.closed ? false : this.config.view.visible;
    }

    /** Records the webview bootstrap message for this surface only. */
    public markReady(): void {
        this.booted = true;
    }

    public post(message: unknown): void {
        if (this.ready) void this.webview.postMessage(message);
    }

    /** Turns a file under `resources/` into a URI this webview is allowed to load. */
    public resolveResource(...path: string[]): string {
        return this.webview
            .asWebviewUri(vscode.Uri.joinPath(this.config.extensionUri, ...path))
            .toString();
    }

    public reveal(): void {
        if (this.closed) return;
        if (this.config.revealCommand) {
            void vscode.commands.executeCommand(this.config.revealCommand);
        }
        const view = this.config.view;
        if (isWebviewView(view)) view.show(false);
        else view.reveal();
    }

    public setBadge(badge: { value: number; tooltip: string } | undefined): void {
        const view = this.config.view;
        // Only a view-container entry has a badge; an editor tab shows itself.
        if (isWebviewView(view)) view.badge = badge;
    }

    public dispose(): void {
        if (this.closed) return;
        this.closed = true;
        for (const subscription of this.subscriptions) subscription.dispose();
        this.subscriptions.length = 0;
        this.config.onDisposed(this);
    }

    private subscribeView(): void {
        const view = this.config.view;
        if (isWebviewView(view)) {
            this.subscriptions.push(
                view.onDidChangeVisibility(() => this.config.onVisibilityChange(this)),
                view.onDidDispose(() => this.dispose()),
            );
            return;
        }
        this.subscriptions.push(
            view.onDidChangeViewState(() => this.config.onVisibilityChange(this)),
            view.onDidDispose(() => this.dispose()),
        );
    }
}

function isWebviewView(view: vscode.WebviewView | vscode.WebviewPanel): view is vscode.WebviewView {
    return (view as vscode.WebviewView).onDidChangeVisibility !== undefined;
}
