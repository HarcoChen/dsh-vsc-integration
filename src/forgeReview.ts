import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { DshRuntime } from "./dshRuntime";
import { isRecord } from "./guards";
import { t } from "./localize";
import { forgeFiles, forgeBeforeText, type ForgeFile } from "./forgeDiff";
import { RemoteHttpError, isRemoteError } from "./remote/errors";

export class ForgeReviewController implements vscode.Disposable {
    private readonly contents = new Map<string, string>();
    private readonly registration = vscode.workspace.registerTextDocumentContentProvider("dsh-forge", {
        provideTextDocumentContent: (uri) => this.contents.get(uri.toString()) ?? "",
    });
    private readonly closes = vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.uri.scheme === "dsh-forge") this.contents.delete(document.uri.toString());
    });
    private pending = false;
    private endpoint?: string;
    public constructor(
        private readonly runtime: DshRuntime,
        private readonly context: vscode.ExtensionContext
    ) {}
    public dispose(): void {
        this.registration.dispose();
        this.closes.dispose();
        this.contents.clear();
    }
    private async call<T = unknown>(sessionId: string, action: string, args: Record<string, unknown> = {}): Promise<T> {
        if (this.runtime.getUrl() !== this.endpoint)
            throw new Error(t("The connected Runtime changed. Reopen review."));
        const value = await this.runtime.getApiClient().call<T>(`forgePanel/${action}`, { sessionId, ...args });
        if (this.runtime.getUrl() !== this.endpoint)
            throw new Error(t("The connected Runtime changed. Reopen review."));
        if (action === "submitReview" && isRecord(value) && value.ok === false)
            throw new Error(
                typeof value.message === "string"
                    ? value.message
                    : t("The host could not confirm the review. Check the pull request before retrying.")
            );
        return value;
    }
    private async panel(sessionId: string): Promise<Record<string, unknown>> {
        const abort = new AbortController();
        try {
            for await (const value of this.runtime.followForge(
                sessionId,
                AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)])
            )) {
                if (isRecord(value) && isRecord(value.checkout) && value.checkout.state !== "pending") return value;
            }
            throw new Error(t("The Runtime did not return repository state."));
        } finally {
            abort.abort();
        }
    }
    public async open(sessionId: string): Promise<void> {
        if (this.pending) return;
        this.pending = true;
        const endpoint = this.runtime.getUrl();
        this.endpoint = endpoint;
        try {
            for (;;) {
                if (this.runtime.getUrl() !== endpoint)
                    throw new Error(t("The connected Runtime changed. Reopen review."));
                const panel = await this.panel(sessionId);
                const choices = [
                    { label: t("Review local changes"), action: "local" },
                    { label: t("Request a worktree for this session"), action: "worktree" },
                    { label: t("Worktree recovery and controls"), action: "controls" },
                    { label: t("Track a pull request"), action: "track" },
                    ...(Array.isArray(panel.changeRequests)
                        ? panel.changeRequests
                              .filter(isRecord)
                              .filter((item) => typeof item.url === "string")
                              .map((item) => ({
                                  label:
                                      item.snapshot &&
                                      isRecord(item.snapshot) &&
                                      typeof item.snapshot.title === "string"
                                          ? item.snapshot.title
                                          : (item.url as string),
                                  description: item.url as string,
                                  action: "pr",
                                  url: item.url as string,
                              }))
                        : []),
                ];
                const choice = await vscode.window.showQuickPick(choices, {
                    title: t("DSH repository review"),
                    placeHolder: typeof panel.directory === "string" ? panel.directory : undefined,
                });
                if (!choice) return;
                if (choice.action === "local") await this.local(sessionId);
                else if (choice.action === "worktree") {
                    const branches = await this.call<{ branches: string[] }>(sessionId, "branches");
                    const base = await vscode.window.showQuickPick(
                        [
                            { label: "HEAD", from: null as string | null },
                            ...branches.branches.map((from) => ({ label: from, from })),
                        ],
                        { title: t("Worktree base") }
                    );
                    if (base) await this.call(sessionId, "requestWorktree", { from: base.from });
                } else if (choice.action === "controls") {
                    const action = await vscode.window.showQuickPick(
                        [
                            { label: t("Cancel worktree request"), action: "cancelWorktree" },
                            { label: t("Stop worktree creation"), action: "stopCreation" },
                            { label: t("Retry worktree creation"), action: "retryWorktree" },
                            { label: t("Restore missing worktree"), action: "restoreWorktree" },
                            { label: t("Continue in the source project"), action: "continueInProject" },
                        ],
                        { title: t("Worktree recovery and controls") }
                    );
                    if (action) await this.call(sessionId, action.action);
                } else if (choice.action === "track") {
                    const url = await vscode.window.showInputBox({
                        title: t("Pull request URL"),
                        ignoreFocusOut: true,
                    });
                    if (url?.trim()) await this.call(sessionId, "track", { url: url.trim() });
                } else if ("url" in choice && typeof choice.url === "string")
                    await this.pullRequest(sessionId, choice.url);
            }
        } catch (error) {
            if (
                (error instanceof RemoteHttpError && error.status === 404) ||
                (isRemoteError(error) && error.code === "gateway/not-found")
            ) {
                throw new Error(
                    t("Enable the official Worktree / Forge bundle in Runtime plugins to use repository review.")
                );
            }
            throw error;
        } finally {
            this.pending = false;
        }
    }
    private async local(sessionId: string): Promise<void> {
        const scopeChoice = await vscode.window.showQuickPick(
            [
                { label: t("Uncommitted changes"), kind: "uncommitted" },
                { label: t("Staged changes"), kind: "staged" },
                { label: t("Unstaged changes"), kind: "unstaged" },
                { label: t("Branch changes"), kind: "branch" },
            ].map((item) => ({ label: item.label, scope: item.kind })),
            { title: t("Comparison scope") }
        );
        if (!scopeChoice) return;
        let scope: Record<string, unknown> = { kind: scopeChoice.scope };
        if (scopeChoice.scope === "branch" && this.runtime.isRuntimeAtLeast("0.2.2-rc.2")) {
            const base = await vscode.window.showInputBox({
                title: t("Base branch (empty for automatic fork point)"),
                ignoreFocusOut: true,
            });
            if (base === undefined) return;
            scope = { kind: "branch", base: base || null, commits: null };
            const commits = await this.call<unknown>(sessionId, "localCommits", { base: base || null });
            if (isRecord(commits) && Array.isArray(commits.commits)) {
                const selected = await vscode.window.showQuickPick(
                    [
                        { label: t("All branch changes"), sha: undefined as string | undefined },
                        ...commits.commits
                            .filter(isRecord)
                            .map((item) => ({ label: String(item.title ?? item.sha), sha: String(item.sha) })),
                    ],
                    { title: t("Compare a commit or the whole branch") }
                );
                if (!selected) return;
                if (selected.sha) scope.commits = { from: selected.sha, to: selected.sha };
            }
        }
        const diff = await this.call(sessionId, "localDiff", { scope });
        await this.files(sessionId, forgeFiles(diff), scope);
    }
    private async files(
        sessionId: string,
        files: ForgeFile[],
        scope?: Record<string, unknown>,
        pr?: { url: string; headSha: string }
    ): Promise<void> {
        let filter = "all";
        const viewed =
            pr && this.runtime.isRuntimeAtLeast("0.2.2-rc.2")
                ? await this.call<unknown>(sessionId, "changeRequestViewed", { url: pr.url, headSha: pr.headSha })
                : undefined;
        const marks: Record<string, unknown> = isRecord(viewed) && isRecord(viewed.files) ? { ...viewed.files } : {};
        const hasRemoteMarks = isRecord(viewed) && isRecord(viewed.files);
        const isReviewed = (file: ForgeFile): boolean => hasRemoteMarks ? marks[file.path] === "viewed"
            : this.context.workspaceState.get(`review:${sessionId}:${file.path}`) === file.digest;
        for (;;) {
            const choices = files
                .filter((file) => filter === "all" || file.layer === filter)
                .map((file) => ({
                    label: `${isReviewed(file) ? "$(check) " : ""}${file.path}`,
                    description: `${file.layer} · +${file.additions} −${file.deletions}`,
                    file,
                }));
            const item = await vscode.window.showQuickPick(
                [{ label: t("Filter by file type"), file: undefined }, ...choices],
                { title: t("Changed files"), matchOnDescription: true }
            );
            if (!item) return;
            if (!item.file) {
                const layer = await vscode.window.showQuickPick(
                    ["all", "interface", "implementation", "test"].map((value) => ({ label: t(value), value })),
                    { title: t("Review layer") }
                );
                if (layer) filter = layer.value;
                continue;
            }
            const file = item.file;
            if (file.binary || file.oversized) {
                void vscode.window.showInformationMessage(t("This file has no text diff."));
                continue;
            }
            const after =
                file.status === "deleted"
                    ? ""
                    : pr
                      ? await this.call<string>(sessionId, "changeRequestText", {
                            url: pr.url,
                            commit: pr.headSha,
                            path: file.path,
                        })
                      : await this.call<string>(sessionId, "localText", { scope, path: file.path });
            const before = forgeBeforeText(after, file);
            const id = randomUUID();
            const left = vscode.Uri.from({
                scheme: "dsh-forge",
                path: `/${id}/before/${file.previousPath ?? file.path}`,
            });
            const right = vscode.Uri.from({ scheme: "dsh-forge", path: `/${id}/after/${file.path}` });
            this.contents.set(left.toString(), before);
            this.contents.set(right.toString(), after);
            await vscode.commands.executeCommand("vscode.diff", left, right, file.path, { preview: true });
            const reviewed = isReviewed(file);
            const mark = t(reviewed ? "Mark unreviewed" : "Mark reviewed"),
                comment = t("Comment on lines"),
                next = t("Next file");
            const action = await vscode.window.showQuickPick(
                [mark, ...(pr && this.runtime.isRuntimeAtLeast("0.2.2-rc.2") ? [comment] : []), next],
                { title: file.path }
            );
            if (!action) return;
            if (action === mark) {
                if (pr && this.runtime.isRuntimeAtLeast("0.2.2-rc.2"))
                    await this.call(sessionId, "setFileViewed", {
                        url: pr.url,
                        request: { path: file.path, headSha: pr.headSha, viewed: !reviewed },
                    });
                marks[file.path] = reviewed ? "unviewed" : "viewed";
                await this.context.workspaceState.update(`review:${sessionId}:${file.path}`, reviewed ? undefined : file.digest);
            }
            if (action === comment && pr) await this.lineComment(sessionId, pr, file);
        }
    }
    private async lineComment(sessionId: string, pr: { url: string; headSha: string }, file: ForgeFile): Promise<void> {
        const side = await vscode.window.showQuickPick([
            { label: t("New side"), side: "R" },
            { label: t("Old side"), side: "L" },
        ]);
        if (!side) return;
        const range = await vscode.window.showInputBox({
            title: t("Line or line range"),
            placeHolder: "12-15",
            validateInput: (value) => (/^\d+(?:-\d+)?$/u.test(value) ? undefined : t("Enter a line or line range.")),
        });
        if (!range) return;
        const [startLine, end = startLine] = range.split("-").map(Number);
        if (startLine < 1 || end < startLine) return;
        const body = await vscode.window.showInputBox({ title: t("Review comment"), ignoreFocusOut: true });
        if (!body?.trim()) return;
        const publish = t("Publish comment");
        if (
            (await vscode.window.showWarningMessage(`${file.path}:${range}\n\n${body}`, { modal: true }, publish)) !==
            publish
        )
            return;
        await this.call(sessionId, "submitReview", {
            url: pr.url,
            request: {
                kind: "comment",
                headSha: pr.headSha,
                comment: { path: file.path, side: side.side, startLine, endLine: end, body },
            },
        });
    }
    private async pullRequest(sessionId: string, url: string): Promise<void> {
        const action = await vscode.window.showQuickPick(
            [
                t("Review changed files"),
                t("Checks and review threads"),
                ...(this.runtime.isRuntimeAtLeast("0.2.2-rc.2") ? [t("Submit review"), t("Update branch")] : []),
            ],
            { title: url }
        );
        if (!action) return;
        const diff = await this.call<unknown>(sessionId, "changeRequestDiff", {
            url,
            ...(this.runtime.isRuntimeAtLeast("0.2.2-rc.2") ? { commits: null } : {}),
        });
        const files = forgeFiles(diff);
        if (!isRecord(diff) || typeof diff.headSha !== "string") throw new Error("Invalid PR head");
        const headSha = diff.headSha;
        if (action === t("Review changed files")) {
            await this.files(sessionId, files, undefined, { url, headSha });
            return;
        }
        if (action === t("Checks and review threads")) {
            const checks = await this.call(sessionId, "changeRequestChecks", { url, headSha });
            const review = this.runtime.isRuntimeAtLeast("0.2.2-rc.2")
                ? await this.call(sessionId, "changeRequestReview", { url, headSha, fresh: true })
                : undefined;
            await vscode.window.showTextDocument(
                await vscode.workspace.openTextDocument({
                    language: "json",
                    content: JSON.stringify({ checks, review }, null, 2),
                })
            );
            return;
        }
        if (action === t("Update branch")) {
            const method = await vscode.window.showQuickPick(["merge", "rebase"], { title: t("Update branch method") });
            const confirm = t("Update branch");
            if (
                method &&
                (await vscode.window.showWarningMessage(`${url}\n${headSha}\n${method}`, { modal: true }, confirm)) ===
                    confirm
            )
                await this.call(sessionId, "updateBranch", { url, method, headSha });
        } else {
            const event = await vscode.window.showQuickPick(["comment", "approve", "request-changes"], {
                title: t("Review decision"),
            });
            if (!event) return;
            const body = await vscode.window.showInputBox({ title: t("Review summary"), ignoreFocusOut: true });
            if (body === undefined) return;
            const confirm = t("Publish review");
            if (
                (await vscode.window.showWarningMessage(`${url}\n${event}\n\n${body}`, { modal: true }, confirm)) ===
                confirm
            )
                await this.call(sessionId, "submitReview", {
                    url,
                    request: { kind: "review", event, body, comments: [], headSha },
                });
        }
    }
}
