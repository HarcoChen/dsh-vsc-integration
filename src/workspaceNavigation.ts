import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import * as vscode from "vscode";
import { t } from "./localize";
import { FileLocation } from "./fileLocations";

function containsPath(root: string, candidate: string): boolean {
    const child = relative(root, candidate);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

/** Open a one-based location after both lexical and real-path workspace checks. */
export async function openWorkspaceFileLocation(
    location: FileLocation,
    preferredRoot?: string,
): Promise<void> {
    if (!vscode.workspace.isTrusted) {
        throw new Error(t("Trust the current workspace before opening a file location."));
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) throw new Error(t("There is no available workspace."));
    const roots = folders.map((folder) => folder.uri.fsPath);
    const bases = [preferredRoot, ...roots]
        .filter((value): value is string => Boolean(value))
        .filter((value, index, values) => values.indexOf(value) === index);
    const lexicalCandidates = isAbsolute(location.path)
        ? [resolve(location.path)]
        : bases.map((base) => resolve(base, location.path));
    const boundedCandidates = lexicalCandidates.filter((candidate) =>
        roots.some((root) => containsPath(resolve(root), candidate)),
    );
    if (boundedCandidates.length === 0) {
        throw new Error(t("Refusing to open a path outside the workspace: {path}", { path: location.path }));
    }

    const realRoots = await Promise.all(roots.map((root) => realpath(root)));
    let target: string | undefined;
    for (const candidate of boundedCandidates) {
        try {
            const resolved = await realpath(candidate);
            const metadata = await stat(resolved);
            if (metadata.isFile() && realRoots.some((root) => containsPath(root, resolved))) {
                target = resolved;
                break;
            }
        } catch {
            // Try the next workspace-relative interpretation.
        }
    }
    if (!target) throw new Error(t("File not found in the workspace: {path}", { path: location.path }));

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    const line = Math.min(location.line - 1, Math.max(0, document.lineCount - 1));
    const lineLength = document.lineAt(line).text.length;
    const column = Math.min(Math.max(0, (location.column ?? 1) - 1), lineLength);
    const position = new vscode.Position(line, column);
    const editor = await vscode.window.showTextDocument(document, {
        preview: true,
        selection: new vscode.Range(position, position),
    });
    editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
}
