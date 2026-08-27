/**
 * Opens VS Code's native diff editor for one file-editing tool call.
 *
 * Unlike {@link ChangeReviewStore}, which snapshots Git trees around a whole
 * turn, this store touches no VCS at all: the before-image is rebuilt from the
 * hunks the Runtime already recorded on the tool result (see ./toolDiff). That
 * matters for a workspace that is not a repository, for files Git ignores, and
 * for the granularity — one call, not one turn.
 */

import { promises as fs } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import * as vscode from "vscode";
import { errorMessage } from "./errors";
import { t } from "./localize";
import { SessionStateSnapshot } from "./sessionStore";
import type { ToolDiffView } from "./toolDiff";
import { applyProposedHunks, callDiffState, collectCallHunks, normalizeNewlines, rewindAround } from "./toolDiff";

export const TOOL_DIFF_SCHEME = "dsh-tool-diff";

/**
 * How many rebuilt snapshots stay resolvable. Each open mints at most two, and
 * these hold whole file bodies, so they are evicted oldest-first rather than
 * kept for the session's lifetime. A diff whose document has been evicted
 * reports that plainly instead of rendering an empty side.
 */
const MAX_DOCUMENTS = 24;

interface ToolDiffDocument {
    text: string;
}

export class ToolDiffStore implements vscode.Disposable, vscode.TextDocumentContentProvider {
    private readonly documents = new Map<string, ToolDiffDocument>();
    private readonly registration: vscode.Disposable;
    private sequence = 0;

    public constructor(private readonly output: vscode.OutputChannel) {
        this.registration = vscode.workspace.registerTextDocumentContentProvider(
            TOOL_DIFF_SCHEME,
            this,
        );
    }

    public provideTextDocumentContent(uri: vscode.Uri): string {
        const token = uri.path.split("/").filter(Boolean)[0];
        const document = token ? this.documents.get(token) : undefined;
        if (!document) throw new Error(t("This diff is no longer available."));
        return document.text;
    }

    public dispose(): void {
        this.registration.dispose();
        this.documents.clear();
    }

    /**
     * Shows what one call did to one file, as a native side-by-side diff.
     *
     * The right-hand side is the real file whenever nothing has edited it
     * since, so the reader can type directly into the result the way they
     * would with any diff editor. Once a later call has touched the same file,
     * both sides become snapshots instead, because the working copy no longer
     * represents this call's outcome.
     */
    public async openDiff(
        snapshot: SessionStateSnapshot | undefined,
        cwd: string | undefined,
        callId: string,
        path: string,
    ): Promise<void> {
        if (!snapshot) throw new Error(t("This diff is no longer available."));
        const state = callDiffState(snapshot, callId);
        if (!state) throw new Error(t("This diff is no longer available."));
        const absolute = isAbsolute(path) ? path : resolve(cwd ?? "", path);

        let current: string;
        try {
            current = await fs.readFile(absolute, "utf8");
        } catch (error) {
            // A pending call may be creating this file, in which case an empty
            // left-hand side is exactly right. A settled call cannot be rewound
            // out of a file that is no longer there.
            if (state.settled) {
                this.output.appendLine(`[dsh:tool-diff] ${absolute}: ${errorMessage(error)}`);
                throw new Error(t("“{path}” is no longer readable, so its diff cannot be rebuilt.", { path }));
            }
            current = "";
        }

        if (!state.settled) {
            await this.openProposed(state.view, current, path);
            return;
        }

        const history = collectCallHunks(snapshot, path);
        const rewound = rewindAround(current, history, callId);
        if (!rewound) {
            throw new Error(t(
                "“{path}” has changed since this edit, so DSH cannot rebuild a faithful diff of it.",
                { path },
            ));
        }

        // The right-hand side is the real file only when nothing edited it
        // since AND it is already on the LF basis the hunks were computed on.
        // `after` equals the normalized current content in that case, so this
        // comparison is exactly the "no CRLF" test — and a CRLF working copy
        // put beside an LF snapshot would diff as an entirely rewritten file.
        const liveFile = rewound.afterIsCurrent && current === rewound.after;
        const title = t("{path} (tool edit)", { path });
        const left = this.documentUri(rewound.before, path);
        const right = liveFile
            ? vscode.Uri.file(absolute)
            : this.documentUri(rewound.after, path);
        await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: true });
    }

    /**
     * Previews a call that has not run yet: the working copy is its real
     * before-image, so this is a genuine "what would change if I approve"
     * rather than a reconstruction. The left side is the file as it stands,
     * never the live URI — approving must not look like an edit already made.
     */
    private async openProposed(
        view: ToolDiffView,
        current: string,
        path: string,
    ): Promise<void> {
        const hunks = view.diffs.filter((diff) => diff.path === path);
        const base = normalizeNewlines(current);
        const proposed = hunks.length ? applyProposedHunks(base, hunks) : undefined;
        if (proposed === undefined) {
            throw new Error(t("“{path}” does not match this pending change, so it cannot be previewed.", { path }));
        }
        await vscode.commands.executeCommand(
            "vscode.diff",
            this.documentUri(base, path),
            this.documentUri(proposed, path),
            t("{path} (proposed)", { path }),
            { preview: true },
        );
    }

    /**
     * Virtual documents are keyed by a minted token rather than by content, so
     * a reopened diff never serves a stale body, and the path rides the URI
     * tail purely so the editor picks the right language for highlighting.
     */
    private documentUri(text: string, path: string): vscode.Uri {
        const token = String(++this.sequence);
        this.documents.set(token, { text });
        while (this.documents.size > MAX_DOCUMENTS) {
            const oldest = this.documents.keys().next();
            if (oldest.done) break;
            this.documents.delete(oldest.value);
        }
        const tail = path.split(/[\\/]/u).pop() || "file";
        return vscode.Uri.from({ scheme: TOOL_DIFF_SCHEME, path: `/${token}/${tail}` });
    }
}
