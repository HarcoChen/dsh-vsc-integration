import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as vscode from "vscode";
import type { DshRuntime } from "./dshRuntime";
import { t } from "./localize";

export async function exportSessionZip(runtime: DshRuntime, sessionId: string): Promise<void> {
    const choice = await vscode.window.showQuickPick(
        [
            { label: t("Current session"), descendants: false },
            { label: t("Session and all descendants"), descendants: true },
        ],
        { title: t("ZIP archive contents") }
    );
    if (!choice) return;
    const target = await vscode.window.showSaveDialog({
        filters: { ZIP: ["zip"] },
        defaultUri: vscode.Uri.file(join(tmpdir(), `dsh-${sessionId.replace(/[^a-zA-Z0-9_-]/gu, "_")}.zip`)),
    });
    if (!target) return;
    const endpoint = runtime.getUrl();
    const scratch = await mkdtemp(join(tmpdir(), "dsh-session-zip-"));
    const path = join(scratch, "session.zip");
    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: t("Exporting session and attachments"),
                cancellable: true,
            },
            async (_progress, token) => {
                const abort = new AbortController();
                const cancellation = token.onCancellationRequested(() => abort.abort());
                if (token.isCancellationRequested) abort.abort();
                try {
                    const response = await runtime.downloadSessionZip(sessionId, choice.descendants, abort.signal);
                    await pipeline(
                        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
                        createWriteStream(path, { flags: "wx", mode: 0o600 }),
                        { signal: abort.signal }
                    );
                    abort.signal.throwIfAborted();
                    if (runtime.getUrl() !== endpoint || !runtime.remoteAccess.snapshot.owner)
                        throw new Error(t("Session access changed while exporting. Try again."));
                    await vscode.workspace.fs.copy(vscode.Uri.file(path), target, { overwrite: true });
                } finally {
                    cancellation.dispose();
                }
            }
        );
        void vscode.window.showInformationMessage(t("ZIP archive saved to {path}", { path: target.fsPath }));
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
}
