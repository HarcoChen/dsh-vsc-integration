import * as vscode from "vscode";
import { t } from "./localize";
import { modelRates } from "./sessionCost";

export async function configureBillingRate(): Promise<void> {
    const provider = await vscode.window.showInputBox({ title: t("Provider ID"), ignoreFocusOut: true });
    if (!provider?.trim()) return;
    const model = await vscode.window.showInputBox({ title: t("Model ID"), ignoreFocusOut: true });
    if (!model?.trim()) return;
    const currency = await vscode.window.showInputBox({
        title: t("Currency code"),
        value: "USD",
        ignoreFocusOut: true,
        validateInput: (value) => (/^[A-Z]{3}$/u.test(value) ? undefined : t("Enter a three-letter currency code.")),
    });
    if (!currency) return;
    const prices: Record<string, number> = {};
    for (const [key, label] of [
        ["input", "Uncached input price per million tokens"],
        ["output", "Output price per million tokens"],
        ["cacheRead", "Cache-read price per million tokens"],
        ["cacheWrite", "Cache-write price per million tokens"],
    ]) {
        const value = await vscode.window.showInputBox({
            title: t(label),
            prompt: t("Use your provider's rates. Estimates exclude non-token charges."),
            ignoreFocusOut: true,
            validateInput: (value) =>
                value.trim() && Number.isFinite(Number(value)) && Number(value) >= 0
                    ? undefined
                    : t("Enter a non-negative price."),
        });
        if (value === undefined) return;
        prices[key] = Number(value);
    }
    const config = vscode.workspace.getConfiguration("dsh");
    const rates = modelRates(config.get("billingRates"));
    await config.update(
        "billingRates",
        [
            ...rates.filter((rate) => rate.provider !== provider.trim() || rate.model !== model.trim()),
            { provider: provider.trim(), model: model.trim(), currency, ...prices },
        ],
        vscode.ConfigurationTarget.Global
    );
}

export async function configureChatAppearance(): Promise<void> {
    const config = vscode.workspace.getConfiguration("dsh");
    const size = await vscode.window.showInputBox({
        title: t("Chat font size"),
        value: String(config.get<number>("chatFontSize", 13)),
        validateInput: (value) =>
            Number.isInteger(Number(value)) && Number(value) >= 11 && Number(value) <= 24
                ? undefined
                : t("Enter a font size from 11 to 24."),
    });
    if (size === undefined) return;
    const density = await vscode.window.showQuickPick(
        [
            { label: t("Comfortable"), value: "comfortable" },
            { label: t("Compact"), value: "compact" },
        ],
        { title: t("Chat density") }
    );
    if (!density) return;
    await config.update("chatFontSize", Number(size), vscode.ConfigurationTarget.Global);
    await config.update("chatDensity", density.value, vscode.ConfigurationTarget.Global);
}
