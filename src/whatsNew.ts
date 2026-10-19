import * as vscode from "vscode";
import { t } from "./localize";

const LAST_SHOWN_VERSION_KEY = "dsh.whatsNew.lastShownVersion";

/** Show the update notice once for each extension version. */
export async function showWhatsNewOnUpdate(context: vscode.ExtensionContext): Promise<void> {
    const version = extensionVersion(context);
    if (!version || context.globalState.get<string>(LAST_SHOWN_VERSION_KEY) === version) return;

    await showWhatsNewMessage(context, version);
    await context.globalState.update(LAST_SHOWN_VERSION_KEY, version);
}

/** Open the same notice from the command palette without changing its version marker. */
export async function showWhatsNew(context: vscode.ExtensionContext): Promise<void> {
    await showWhatsNewMessage(context, extensionVersion(context));
}

function extensionVersion(context: vscode.ExtensionContext): string {
    const version = context.extension.packageJSON.version;
    return typeof version === "string" ? version : "";
}

async function showWhatsNewMessage(context: vscode.ExtensionContext, version: string): Promise<void> {
    const changelog = vscode.Uri.joinPath(context.extensionUri, "CHANGELOG.md");
    const contents = new TextDecoder().decode(await vscode.workspace.fs.readFile(changelog));
    const sections = contents.split(/^## \[([^\]]+)\][^\n]*$/m);
    const sectionIndex = sections.findIndex((section, index) => index % 2 === 1 && section === version);
    const notes = sectionIndex < 0 ? "" : sections[sectionIndex + 1]
        .replace(/<!--[^]*?-->/gu, "")
        .replace(/^###\s+/gm, "")
        .trim();
    const viewChangelog = t("View changelog");
    const choice = await vscode.window.showInformationMessage(
        t("DSH {version}: What's new", { version }),
        {
            modal: true,
            detail: notes || t("See the changelog for this version's changes."),
        },
        viewChangelog,
        t("Later"),
    );

    if (choice === viewChangelog) {
        await vscode.commands.executeCommand("markdown.showPreview", changelog);
    }
}
