import * as vscode from "vscode";
import { t } from "./localize";

const LAST_SHOWN_VERSION_KEY = "dsh.whatsNew.lastShownVersion";

/** Show the update notice once for each extension version. */
export async function showWhatsNewOnUpdate(context: vscode.ExtensionContext): Promise<void> {
    const version = extensionVersion(context);
    if (!version || context.globalState.get<string>(LAST_SHOWN_VERSION_KEY) === version) return;

    await showWhatsNewMessage(version);
    await context.globalState.update(LAST_SHOWN_VERSION_KEY, version);
}

/** Open the same notice from the command palette without changing its version marker. */
export async function showWhatsNew(context: vscode.ExtensionContext): Promise<void> {
    await showWhatsNewMessage(extensionVersion(context));
}

function extensionVersion(context: vscode.ExtensionContext): string {
    const version = context.extension.packageJSON.version;
    return typeof version === "string" ? version : "";
}

async function showWhatsNewMessage(version: string): Promise<void> {
    const configure = t("Open Jev settings");
    const later = t("Later");
    const choice = await vscode.window.showInformationMessage(
        [
            t("DSH {version}: Jev can now use Laya.", { version }),
            t("Run laya-serve, then set dsh.jev.baseUrl to http://127.0.0.1:8000/v1/systemone."),
            t("Configure a non-empty Jev API key. If Laya has LAYA_API_KEY set, use the same value. Laya confidence scores differ from Jev's, so calibrate thresholds before relying on ask/block decisions."),
        ].join("\n\n"),
        { modal: true },
        configure,
        later,
    );

    if (choice === configure) {
        await vscode.commands.executeCommand("workbench.action.openSettings", "dsh.jev");
    }
}
