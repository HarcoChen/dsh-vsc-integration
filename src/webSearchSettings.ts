import * as vscode from "vscode";
import type { DshRuntime } from "./dshRuntime";
import { valueAtPath } from "./chatViewPresentation";
import { t } from "./localize";

/** Configure the Host's selected Web providers without modifying model routes. */
export async function configureWebSearch(runtime: DshRuntime): Promise<void> {
    const endpoint = runtime.getUrl();
    const described = await runtime.describeSettings();
    const web = described.namespaces.find(item => item.ns === "web");
    const api = described.namespaces.find(item => item.ns === "web-deepseek-api");
    if (!described.writable || !web || !api) throw new Error(t("Web search settings are unavailable or read-only."));
    const selected = await vscode.window.showQuickPick([
        { label: t("DeepSeek Search and Fetch API"), api: true, description: t("Direct search and Markdown fetch; separate API billing") },
        { label: t("Messages search and local HTTP fetch"), api: false, description: t("Search through an auxiliary model request") },
    ], { title: t("Web search and fetch"), placeHolder: String(valueAtPath(web.value, ["searchProvider"]) ?? "") });
    if (!selected) return;
    const section = selected.api ? api : described.namespaces.find(item => item.ns === "web-search-deepseek");
    if (!section) throw new Error(t("Web search settings are unavailable or read-only."));
    const baseURL = await vscode.window.showInputBox({ title: t("Web search API endpoint"),
        value: String(valueAtPath(section.value, ["baseURL"]) ?? ""),
        prompt: selected.api ? t("API base URL including path prefix; leave empty to inherit") : t("Leave empty to inherit the Messages search endpoint"),
        validateInput: value => {
            if (!value.trim()) return undefined;
            try { const url = new URL(value.trim()); if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return undefined; } catch { /* invalid */ }
            return t("Enter a valid HTTP(S) endpoint.");
        } });
    if (baseURL === undefined) return;
    let count: number | undefined;
    if (selected.api) {
        const input = await vscode.window.showInputBox({ title: t("Search result count"), value: String(valueAtPath(api.value, ["count"]) ?? 10),
            validateInput: value => /^\d+$/u.test(value.trim()) && Number(value) >= 1 && Number(value) <= 50 ? undefined : t("Enter an integer from 1 to 50.") });
        if (input === undefined) return;
        count = Number(input);
    }
    const sendQuestion = selected.api ? await vscode.window.showQuickPick([
        { label: t("Include original question"), value: true }, { label: t("Send search query only"), value: false },
    ], { title: t("Send up to 128 characters of the user question with search requests") }) : undefined;
    if (selected.api && !sendQuestion) return;
    const key = await vscode.window.showInputBox({ title: t("API Key (optional)"), password: true,
        prompt: t("Leave empty to keep the stored API Key"),
        validateInput: value => !value || /^[\x21-\x7E]+$/u.test(value.trim()) ? undefined : t("API Key must contain printable characters only.") });
    if (key === undefined) return;
    const assertEndpoint = (): void => { if (runtime.getUrl() !== endpoint) throw new Error(t("The connected Runtime changed. Try again.")); };
    assertEndpoint();
    const ref = String(valueAtPath(section.value, ["apiKeyEnv"]) ?? "DEEPSEEK_API_KEY");
    if (key.trim()) await runtime.setCredential(ref, key.trim());
    assertEndpoint();
    await runtime.mutateSettings(section.ns, [baseURL.trim() ? { op: "set", path: ["baseURL"], value: baseURL.trim() }
        : { op: "unset", path: ["baseURL"] },
        ...(selected.api ? [{ op: "set" as const, path: ["count"], value: count! },
            { op: "set" as const, path: ["sendOriginalQuestion"], value: sendQuestion!.value }] : [])], section.revision);
    // Both providers change atomically in the same namespace after provider settings have saved.
    assertEndpoint();
    await runtime.mutateSettings(web.ns, [
        { op: "set", path: ["searchProvider"], value: selected.api ? "deepseek-search-api" : "deepseek-official" },
        { op: "set", path: ["fetchProvider"], value: selected.api ? "deepseek-fetch-api" : "http" },
    ], web.revision);
    void vscode.window.showInformationMessage(t("Web search settings saved. They apply to the next operation."));
}
