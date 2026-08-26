import { realpath } from "node:fs/promises";
import * as vscode from "vscode";
import { t } from "./localize";
import { containsPath, samePath } from "./paths";

/**
 * The editor-side actions offered on a rendered code block.
 *
 * Each takes the already-resolved block text rather than a render id: the copyable
 * text lives in a cache the chat view shares with its markdown renderer, so the
 * lookup stays there and only the resolved value crosses into this module.
 */

/** Writes the block to the system clipboard. */
export async function copyCodeBlock(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
}

/** Replaces each selection in the active editor, or inserts at an empty caret. */
export async function insertCodeBlock(text: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) throw new Error(t("There is no active text editor."));
    const applied = await editor.edit((edit) => {
        for (const selection of editor.selections) {
            if (selection.isEmpty) edit.insert(selection.active, text);
            else edit.replace(selection, text);
        }
    });
    if (!applied) throw new Error(t("VS Code could not insert the code block."));
}

/** Opens the block as an untitled document, tagged with its language when known. */
export async function openCodeBlock(text: string, language?: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument({
        content: text,
        ...(language === undefined ? {} : { language }),
    });
    await vscode.window.showTextDocument(document, { preview: false });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
    if (left.byteLength !== right.byteLength) return false;
    for (let index = 0; index < left.byteLength; index += 1) {
        if (left[index] !== right[index]) return false;
    }
    return true;
}

/**
 * Writes the block over a user-chosen workspace file, after a diff and an
 * explicit confirmation.
 *
 * The target is validated twice against the workspace root — once before the
 * preview opens and again immediately before the edit — because the user could
 * move or replace the file, or swap in a symlink, while the diff is on screen.
 * The second pass also re-reads the file and compares both the editor text and
 * the bytes on disk, so a concurrent change aborts instead of being overwritten.
 */
export async function applyCodeBlock(text: string, language?: string): Promise<void> {
    if (!vscode.workspace.isTrusted) {
        throw new Error(t("Trust the current workspace before applying a code block."));
    }
    if (!(vscode.workspace.workspaceFolders?.length)) {
        throw new Error(t("Open a workspace before applying a code block."));
    }
    const selected = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: t("Select target file"),
        title: t("Apply code block"),
    });
    const targetUri = selected?.[0];
    if (!targetUri) return;
    if (targetUri.scheme !== "file") {
        throw new Error(t("Select a regular file inside the current workspace."));
    }
    const folder = vscode.workspace.getWorkspaceFolder(targetUri);
    if (!folder) {
        throw new Error(t("The target file is outside the current workspace."));
    }
    const [realRoot, realTarget] = await Promise.all([
        realpath(folder.uri.fsPath),
        realpath(targetUri.fsPath),
    ]);
    if (!containsPath(realRoot, realTarget)) {
        throw new Error(t("The target file is outside the current workspace."));
    }
    const metadata = await vscode.workspace.fs.stat(targetUri);
    if ((metadata.type & vscode.FileType.File) === 0) {
        throw new Error(t("Select a regular file inside the current workspace."));
    }
    const document = await vscode.workspace.openTextDocument(targetUri);
    if (document.isDirty) {
        throw new Error(t("The target file has unsaved changes. Save or discard them before applying code."));
    }
    const beforeText = document.getText();
    const beforeDisk = await vscode.workspace.fs.readFile(targetUri);
    const proposed = await vscode.workspace.openTextDocument({
        content: text,
        ...(language === undefined ? {} : { language }),
    });
    const path = vscode.workspace.asRelativePath(targetUri, false).replace(/\\/gu, "/");
    await vscode.commands.executeCommand(
        "vscode.diff",
        targetUri,
        proposed.uri,
        t("Apply code block to {path}", { path }),
        { preview: true },
    );
    const applyLabel = t("Apply");
    const confirmation = await vscode.window.showWarningMessage(
        t("Apply this code block to {path}?", { path }),
        { modal: true, detail: t("Review the proposed code block changes, then confirm to apply them.") },
        applyLabel,
    );
    if (confirmation !== applyLabel) return;
    const latestRealTarget = await realpath(targetUri.fsPath);
    if (!containsPath(realRoot, latestRealTarget) || !samePath(realTarget, latestRealTarget)) {
        throw new Error(t("The target file changed while the preview was open. No changes were applied."));
    }
    const latestDisk = await vscode.workspace.fs.readFile(targetUri);
    if (document.isDirty || document.getText() !== beforeText || !sameBytes(latestDisk, beforeDisk)) {
        throw new Error(t("The target file changed while the preview was open. No changes were applied."));
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
        targetUri,
        new vscode.Range(document.positionAt(0), document.positionAt(beforeText.length)),
        text,
    );
    if (!await vscode.workspace.applyEdit(edit) || !await document.save()) {
        throw new Error(t("VS Code could not apply the code block."));
    }
    void vscode.window.showInformationMessage(t("Applied code block to {path}.", { path }));
}
