import * as vscode from "vscode";
import { ContextStore } from "./contextStore";
import { listPromptTemplates } from "./promptTemplates";
import { t } from "./localize";

function projectFolder(): vscode.WorkspaceFolder | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri
        ? (vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0])
        : vscode.workspace.workspaceFolders?.[0];
}

export async function managePromptTemplates(): Promise<void> {
    const folder = projectFolder();
    if (!folder) throw new Error(t("Open an IDE project folder first."));
    const root = vscode.Uri.joinPath(folder.uri, ".dsh", "prompts");
    const templates = await listPromptTemplates(root);
    const picked = await vscode.window.showQuickPick(
        [
            { label: t("Create prompt template"), path: undefined as string | undefined },
            ...templates.map((item) => ({
                label: item.label,
                description: item.path,
                detail: item.preview,
                path: item.path,
            })),
        ],
        { title: t("Manage prompt templates"), matchOnDescription: true }
    );
    if (!picked) return;
    let uri: vscode.Uri;
    if (picked.path) uri = vscode.Uri.joinPath(root, ...picked.path.split("/"));
    else {
        const name = await vscode.window.showInputBox({
            title: t("Template file name"),
            ignoreFocusOut: true,
            validateInput: (value) =>
                /^[\p{L}\p{N}_.-]+$/u.test(value) && ![".", ".."].includes(value)
                    ? undefined
                    : t("Enter a file name without directory separators."),
        });
        if (!name) return;
        uri = vscode.Uri.joinPath(root, name.endsWith(".md") ? name : `${name}.md`);
        await vscode.workspace.fs.createDirectory(root);
        try {
            await vscode.workspace.fs.stat(uri);
        } catch (error) {
            if (!(error instanceof vscode.FileSystemError) || error.code !== "FileNotFound") throw error;
            await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(`# ${name.replace(/\.md$/u, "")}\n\n`));
        }
    }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
}

export async function attachProjectRules(store: ContextStore): Promise<void> {
    const folder = projectFolder();
    if (!folder) throw new Error(t("Open an IDE project folder first."));
    const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, "{AGENTS.md,.dsh/rules/**/*.md,.agents/rules/**/*.md}"),
        "**/node_modules/**",
        100
    );
    const selected = await vscode.window.showQuickPick(
        files.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
        { title: t("Attach project rule documents"), canPickMany: true }
    );
    if (!selected?.length) return;
    const documents: vscode.TextDocument[] = [];
    for (const item of selected) {
        const stat = await vscode.workspace.fs.stat(item.uri);
        if (stat.size > 256 * 1024) throw new Error(t("Rule documents must be at most 256 KiB."));
        documents.push(await vscode.workspace.openTextDocument(item.uri));
    }
    for (const document of documents) store.addDocumentContext(document);
}

export async function searchEditorContext(store: ContextStore): Promise<void> {
    const mode = await vscode.window.showQuickPick(
        [
            { label: t("Find IDE files"), mode: "file" },
            { label: t("Find IDE symbols"), mode: "symbol" },
        ],
        { title: t("Search code context") }
    );
    if (!mode) return;
    const query = await vscode.window.showInputBox({
        title: t(mode.mode === "file" ? "File glob" : "Symbol query"),
        placeHolder: mode.mode === "file" ? "**/*.ts" : undefined,
        ignoreFocusOut: true,
    });
    if (!query?.trim()) return;
    let uri: vscode.Uri, range: vscode.Range | undefined;
    if (mode.mode === "file") {
        const folder = projectFolder();
        if (!folder) throw new Error(t("Open an IDE project folder first."));
        const matches = await vscode.workspace.findFiles(
            new vscode.RelativePattern(folder, query.trim()),
            "**/{node_modules,.git,dist,build}/**",
            100
        );
        const picked = await vscode.window.showQuickPick(
            matches.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
            { title: t("Choose code to attach") }
        );
        if (!picked) return;
        uri = picked.uri;
    } else {
        const matches = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            "vscode.executeWorkspaceSymbolProvider",
            query.trim()
        );
        const picked = await vscode.window.showQuickPick(
            (matches ?? [])
                .slice(0, 100)
                .map((symbol) => ({
                    label: symbol.name,
                    description: vscode.workspace.asRelativePath(symbol.location.uri),
                    symbol,
                })),
            { title: t("Choose code to attach"), matchOnDescription: true }
        );
        if (!picked) return;
        uri = picked.symbol.location.uri;
        range = picked.symbol.location.range;
    }
    const stat = await vscode.workspace.fs.stat(uri);
    if (!range && stat.size > 1024 * 1024) throw new Error(t("Choose a text file up to 1 MiB."));
    const document = await vscode.workspace.openTextDocument(uri);
    if (range?.isEmpty) {
        const line = Math.min(document.lineCount - 1, range.start.line);
        range = new vscode.Range(
            Math.max(0, line - 2),
            0,
            Math.min(document.lineCount - 1, line + 20),
            document.lineAt(Math.min(document.lineCount - 1, line + 20)).range.end.character
        );
    }
    store.addDocumentContext(document, range);
}
