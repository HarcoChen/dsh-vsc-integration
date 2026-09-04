import * as vscode from "vscode";
import { hasPath, valueAtPath } from "./chatViewPresentation";
import { DshRuntime } from "./dshRuntime";
import { errorMessage } from "./errors";
import { t } from "./localize";
import {
    DshConfigurableProvider,
    DshCredentialView,
    DshDiscoveredModel,
    DshLlmModelsResult,
    DshModelProviderGroup,
    DshSettingsDescribeResult,
    DshSettingsNamespaceView,
    DshSettingsPathOperation,
} from "./types";

/**
 * What the provider flow needs from its host. Passed in rather than reached for,
 * so this module owns no session or webview state — it is a QuickPick flow over
 * Harness-owned configuration and nothing else.
 */
export interface ProviderManagementDeps {
    runtime: DshRuntime;
    output: vscode.OutputChannel;
    workspaceRoot: () => string | undefined;
    /** Opens the Harness Web UI for unsupported or advanced provider fields. */
    openBrowser: () => Promise<void>;
}

interface ProviderManagementRow {
    entry: DshConfigurableProvider;
    namespace?: DshSettingsNamespaceView;
    configured: boolean;
    removable: boolean;
    apiKeyEnv?: string;
    credential?: DshCredentialView;
    modelGroup?: DshModelProviderGroup;
    modelFailure?: string;
}

function deriveProviderKeyRef(provider: string): string {
    return `${provider.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}_API_KEY`;
}

function credentialRefFor(row: ProviderManagementRow): string | undefined {
    if (row.apiKeyEnv) return row.apiKeyEnv;
    if (row.entry.provider === "deepseek-official") return "DEEPSEEK_API_KEY";
    if (row.entry.settingsNs === "llm-pi-ai") return deriveProviderKeyRef(row.entry.provider);
    return undefined;
}

function validateApiKeyInput(value: string): string | undefined {
    if (value.length === 0) return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0) return t("Enter an API Key.");
    if (!/^[\x21-\x7E]+$/u.test(trimmed)) return t("API Key must contain printable characters only.");
    return undefined;
}

function providerStatusDetail(row: ProviderManagementRow): string {
    const configuration = row.configured ? t("Configured") : t("Not configured");
    const credential = !row.apiKeyEnv
        ? t("Provider-native authentication")
        : !row.credential
          ? `${row.apiKeyEnv}: ${t("Credential status unavailable")}`
          : !row.credential.configured
            ? `${row.apiKeyEnv}: ${t("API Key missing")}`
            : `${row.apiKeyEnv}: ${t("API Key configured")}${row.credential.source ? ` (${row.credential.source})` : ""}`;
    const models = row.modelGroup
        ? t("{count} models", { count: row.modelGroup.models.length })
        : row.modelFailure
          ? t("Model catalog unavailable")
          : undefined;
    return [configuration, credential, models].filter((part): part is string => part !== undefined).join(" · ");
}

/** Builds provider rows from the configurable directory and host model catalog. */
async function loadRows(
    deps: ProviderManagementDeps,
): Promise<{
    rows: ProviderManagementRow[];
    settings: DshSettingsDescribeResult;
    catalog?: DshLlmModelsResult;
}> {
    const [providerResult, settings, catalog] = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: t("Loading provider configuration..."),
            cancellable: false,
        },
        async () => {
            const [providers, described, models] = await Promise.all([
                deps.runtime.listProviders(),
                deps.runtime.describeSettings(),
                deps.runtime.listLlmModels().catch((error) => {
                    // The catalog is an enrichment. Older runtimes, and a
                    // deployment without a model registry, should not hide
                    // the settings rows that are still manageable.
                    deps.output.appendLine(`[dsh:providers] model catalog unavailable: ${errorMessage(error)}`);
                    return undefined;
                }),
            ]);
            return [providers, described, models] as const;
        },
    );
    const namespaces = new Map(settings.namespaces.map((namespace) => [namespace.ns, namespace]));
    const rows: ProviderManagementRow[] = providerResult.providers
        .map((entry) => {
            const namespace = namespaces.get(entry.settingsNs);
            const profile = namespace ? valueAtPath(namespace.value, entry.settingsPath) : undefined;
            const apiKeyEnv = profile && typeof profile === "object" && !Array.isArray(profile)
                ? (profile as Record<string, unknown>).apiKeyEnv
                : undefined;
            return {
                entry,
                ...(namespace ? { namespace } : {}),
                configured: namespace !== undefined &&
                    (entry.settingsPath.length === 0 || profile !== undefined),
                removable: namespace !== undefined &&
                    entry.settingsPath.length > 0 &&
                    hasPath(namespace.user, entry.settingsPath) &&
                    !hasPath(namespace.base, entry.settingsPath),
                ...(typeof apiKeyEnv === "string" && apiKeyEnv.length > 0 ? { apiKeyEnv } : {}),
                ...(catalog?.groups.find((group) => group.id === entry.provider)
                    ? { modelGroup: catalog.groups.find((group) => group.id === entry.provider) }
                    : {}),
                ...(catalog?.failures.find((failure) => failure.id === entry.provider)
                    ? { modelFailure: catalog.failures.find((failure) => failure.id === entry.provider)?.message }
                    : {}),
            };
        })
        // Keep dormant directory entries visible: they are the providers the
        // Harness can configure, and are precisely what the internal setup
        // flow needs to make active.

    const credentialRefs = [...new Set(rows.flatMap((row) => row.apiKeyEnv ? [row.apiKeyEnv] : []))];
    if (credentialRefs.length > 0) {
        try {
            const result = await deps.runtime.describeCredentials(credentialRefs);
            for (const row of rows) {
                if (row.apiKeyEnv && result.credentials[row.apiKeyEnv]) {
                    row.credential = result.credentials[row.apiKeyEnv];
                }
            }
        } catch (error) {
            deps.output.appendLine(`[dsh:providers] credential status unavailable: ${errorMessage(error)}`);
        }
    }
    return { rows, settings, ...(catalog === undefined ? {} : { catalog }) };
}

type ProviderAction = "configure" | "discover" | "models" | "set-key" | "unset-key" | "document" | "remove";

function profileObject(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function profileFor(row: ProviderManagementRow, source: unknown = row.namespace?.value): Record<string, unknown> {
    return profileObject(row.namespace ? valueAtPath(source, row.entry.settingsPath) : undefined) ?? {};
}

function stringField(profile: Record<string, unknown>, key: string): string | undefined {
    const value = profile[key];
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function schemaNodeAtPath(schema: unknown, path: readonly string[]): Record<string, unknown> | undefined {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
    let node = schema as Record<string, unknown>;
    if (typeof node.uid === "number" && node.refs && typeof node.refs === "object" && !Array.isArray(node.refs)) {
        const root = (node.refs as Record<string, unknown>)[String(node.uid)];
        if (!root || typeof root !== "object" || Array.isArray(root)) return undefined;
        node = root as Record<string, unknown>;
    }
    for (const segment of path) {
        const type = node.type;
        if (type === "object" && node.dict && typeof node.dict === "object" && !Array.isArray(node.dict)) {
            const child = (node.dict as Record<string, unknown>)[segment];
            if (!child || typeof child !== "object" || Array.isArray(child)) return undefined;
            node = child as Record<string, unknown>;
        } else if ((type === "dict" || type === "array") && node.inner
            && typeof node.inner === "object" && !Array.isArray(node.inner)) {
            node = node.inner as Record<string, unknown>;
        } else {
            return undefined;
        }
    }
    return node;
}

function protocolChoicesForNamespace(namespace: DshSettingsNamespaceView | undefined): string[] {
    const schemaNode = schemaNodeAtPath(namespace?.schema, ["providers", "\0probe", "api"]);
    const listed = schemaNode?.list;
    if (Array.isArray(listed)) {
        const choices = listed.flatMap((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
            const value = (entry as Record<string, unknown>).value;
            return typeof value === "string" ? [value] : [];
        });
        if (choices.length > 0) return [...new Set(choices)];
    }
    // Keep dormant namespaces usable if a reduced/older settings descriptor
    // omits schema metadata. These are the public protocols this adapter
    // currently supports for hand-declared routes.
    return ["openai-completions", "openai-responses", "anthropic-messages"];
}

function protocolChoices(row: ProviderManagementRow): string[] {
    return row.entry.settingsNs === "llm-pi-ai" ? protocolChoicesForNamespace(row.namespace) : [];
}

function profileFieldPath(row: ProviderManagementRow, field: string): string[] {
    return [...row.entry.settingsPath, field];
}

function jsonEqual(left: unknown, right: unknown): boolean {
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    } catch {
        return left === right;
    }
}

/** Builds minimal settings operations for the fields owned by this picker. */
function profileFieldOps(
    row: ProviderManagementRow,
    fields: Readonly<Record<string, unknown | undefined>>,
): DshSettingsPathOperation[] {
    const namespace = row.namespace;
    if (!namespace) return [];
    const effective = profileFor(row, namespace.value);
    const user = profileFor(row, namespace.user);
    const ops: DshSettingsPathOperation[] = [];
    for (const [field, next] of Object.entries(fields)) {
        const current = effective[field];
        const owned = hasPath(namespace.user, profileFieldPath(row, field));
        if (next === undefined) {
            if (owned) ops.push({ op: "unset", path: profileFieldPath(row, field) });
        } else if (!jsonEqual(current, next)) {
            ops.push({ op: "set", path: profileFieldPath(row, field), value: next });
        } else if (owned && !jsonEqual(user[field], next)) {
            // The effective value can come from a base layer. If the user
            // layer happens to hold the same value, retaining it is harmless;
            // otherwise leave the explicit override in place.
            ops.push({ op: "unset", path: profileFieldPath(row, field) });
        }
    }
    // A dormant pi-ai catalog route becomes active once its profile exists.
    // Materialize an empty object when the user chose no visible fields yet.
    if (row.entry.settingsPath.length > 0
        && valueAtPath(namespace.value, row.entry.settingsPath) === undefined
        && ops.length === 0) {
        ops.push({ op: "set", path: [...row.entry.settingsPath], value: {} });
    }
    return ops;
}

async function chooseProviderAction(
    row: ProviderManagementRow,
    settingsWritable: boolean,
    hasDocument: boolean,
): Promise<ProviderAction | undefined> {
    const actions: Array<vscode.QuickPickItem & {
        action: ProviderAction;
    }> = [];
    if (settingsWritable && row.namespace && row.entry.settingsNs.length > 0) {
        actions.push({
            action: "configure",
            label: `$(edit) ${t("Configure provider")}`,
            detail: t("Set endpoint, protocol, and API Key inside the IDE"),
        });
    }
    if (row.entry.settingsNs === "llm-pi-ai") {
        actions.push({
            action: "discover",
            label: `$(cloud-download) ${t("Discover models")}`,
            detail: t("Query this provider with the current endpoint and adopt models"),
        });
    }
    if (row.modelGroup || row.modelFailure) {
        actions.push({
            action: "models",
            label: `$(list-unordered) ${t("View available models")}`,
            detail: row.modelFailure ?? t("{count} models", { count: row.modelGroup?.models.length ?? 0 }),
        });
    }
    const derivedRef = credentialRefFor(row);
    if (derivedRef && row.credential?.writable !== false && (row.apiKeyEnv !== undefined || settingsWritable)) {
        actions.push({
            action: "set-key",
            label: `$(key) ${t("Set API Key")}`,
            detail: derivedRef,
        });
    }
    if (row.apiKeyEnv && row.credential?.configured && row.credential.writable) {
        actions.push({
            action: "unset-key",
            label: `$(trash) ${t("Remove stored API Key")}`,
            detail: row.apiKeyEnv,
        });
    }
    if (hasDocument && row.entry.settingsNs.length > 0) {
        actions.push({
            action: "document",
            label: `$(settings-gear) ${t("Open advanced configuration")}`,
            detail: t("Edit endpoint, protocol, models, and other provider settings"),
        });
    }
    if (settingsWritable && row.removable) {
        actions.push({
            action: "remove",
            label: `$(trash) ${t("Delete provider")}`,
            detail: t("Remove this user-defined provider configuration"),
        });
    }
    if (actions.length === 0) {
        void vscode.window.showInformationMessage(t("This provider has no settings that can be changed here."));
        return undefined;
    }
    const selected = await vscode.window.showQuickPick(actions, {
        title: row.entry.displayName || row.entry.provider,
        placeHolder: t("Choose an action"),
    });
    return selected?.action;
}

function currentModels(row: ProviderManagementRow): Array<Record<string, unknown>> {
    const configured = profileFor(row);
    const models = configured.models;
    if (Array.isArray(models)) {
        return models.flatMap((model) => {
            if (!model || typeof model !== "object" || Array.isArray(model)) return [];
            return [{ ...(model as Record<string, unknown>) }];
        });
    }
    // A dormant catalog route has no profile but the host catalog still gives
    // us useful defaults to display/adopt when discovery is requested.
    return row.modelGroup?.models.map((model) => ({
        id: model.id,
        ...(model.name ? { name: model.name } : {}),
    })) ?? [];
}

function discoveredModelItem(model: DshDiscoveredModel, picked: boolean): vscode.QuickPickItem & {
    model: DshDiscoveredModel;
} {
    const capacity = [
        model.contextWindow ? `ctx ${model.contextWindow.toLocaleString()}` : undefined,
        model.maxTokens ? `out ${model.maxTokens.toLocaleString()}` : undefined,
    ].filter((value): value is string => value !== undefined).join(" · ");
    return {
        model,
        label: model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id,
        description: capacity || undefined,
        picked,
    };
}

const CUSTOM_PROVIDER_ROUTE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

async function discoverDraftModels(
    deps: ProviderManagementDeps,
    payload: {
        settingsNs: string;
        provider?: string;
        baseURL?: string;
        api?: string;
        apiKey?: string;
    },
): Promise<DshDiscoveredModel[] | undefined> {
    try {
        const discovered = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: t("Discovering models..."),
                cancellable: true,
            },
            async (_progress, token) => {
                const controller = new AbortController();
                const cancellation = token.onCancellationRequested(() => controller.abort());
                try {
                    return await deps.runtime.discoverLlmModels(payload, controller.signal);
                } finally {
                    cancellation.dispose();
                }
            },
        );
        if (discovered.models.length === 0) {
            void vscode.window.showInformationMessage(t("Harness returned no available models."));
            return undefined;
        }
        return discovered.models;
    } catch (error) {
        const message = errorMessage(error);
        deps.output.appendLine(`[dsh:providers] model discovery failed: ${message}`);
        void vscode.window.showWarningMessage(t("Model discovery failed: {message}", { message }));
        return undefined;
    }
}

async function chooseDiscoveredModels(
    models: readonly DshDiscoveredModel[],
    existing: readonly Record<string, unknown>[] = [],
): Promise<Array<Record<string, unknown>> | undefined> {
    const known = new Set(existing.map((model) => typeof model.id === "string" ? model.id : ""));
    const choices = models.map((model) => discoveredModelItem(model, !known.has(model.id)));
    const picked = await vscode.window.showQuickPick(choices, {
        title: t("Select models to add"),
        placeHolder: t("New models are selected by default"),
        canPickMany: true,
        matchOnDescription: true,
    });
    if (!picked || picked.length === 0) return undefined;
    const merged = new Map<string, Record<string, unknown>>(
        existing.flatMap((model) => typeof model.id === "string" ? [[model.id, model] as const] : []),
    );
    for (const item of picked) {
        if (merged.has(item.model.id)) continue;
        merged.set(item.model.id, {
            id: item.model.id,
            ...(item.model.name === undefined ? {} : { name: item.model.name }),
            ...(item.model.contextWindow === undefined ? {} : { contextWindow: item.model.contextWindow }),
            ...(item.model.maxTokens === undefined ? {} : { maxTokens: item.model.maxTokens }),
        });
    }
    return [...merged.values()];
}

async function manuallyChooseModels(): Promise<Array<Record<string, unknown>> | undefined> {
    const entered = await vscode.window.showInputBox({
        title: t("Model IDs"),
        prompt: t("Enter model IDs separated by commas"),
        placeHolder: "model-a, model-b",
        ignoreFocusOut: true,
        validateInput: (value) => {
            const ids = [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))];
            return ids.length > 0 ? undefined : t("Enter at least one model ID.");
        },
    });
    if (entered === undefined) return undefined;
    const ids = [...new Set(entered.split(",").map((id) => id.trim()).filter(Boolean))];
    return ids.map((id) => ({ id }));
}

async function viewProviderModels(row: ProviderManagementRow): Promise<void> {
    if (row.modelFailure) {
        void vscode.window.showWarningMessage(t("Model catalog unavailable: {message}", {
            message: row.modelFailure,
        }));
        return;
    }
    const models = row.modelGroup?.models ?? [];
    if (models.length === 0) {
        void vscode.window.showInformationMessage(t("Harness returned no available models."));
        return;
    }
    await vscode.window.showQuickPick(
        models.map((model) => ({
            label: model.name || model.id,
            description: model.name && model.name !== model.id ? model.id : undefined,
            detail: model.description,
        })),
        {
            title: t("Available models for {provider}", {
                provider: row.entry.displayName || row.entry.provider,
            }),
            placeHolder: t("These models are currently routable"),
        },
    );
}

async function configureProvider(
    deps: ProviderManagementDeps,
    row: ProviderManagementRow,
    settings: DshSettingsDescribeResult,
): Promise<void> {
    const namespace = row.namespace;
    if (!namespace || !settings.writable || row.entry.settingsNs.length === 0) return;
    const profile = profileFor(row);
    const isPiAi = row.entry.settingsNs === "llm-pi-ai";
    const isDeepSeek = row.entry.settingsNs === "llm-deepseek";
    const baseURL = await vscode.window.showInputBox({
        title: t("Configure {provider}", { provider: row.entry.displayName || row.entry.provider }),
        prompt: isDeepSeek
            ? t("Optional API endpoint; leave empty to use the public DeepSeek API")
            : t("Provider API endpoint"),
        value: stringField(profile, "baseURL") ?? "",
        placeHolder: isDeepSeek ? "https://api.deepseek.com" : "https://gateway.example/v1",
        ignoreFocusOut: true,
        validateInput: (value) => isPiAi && row.entry.declared === true && value.trim().length === 0
            ? t("Enter a provider endpoint.")
            : undefined,
    });
    if (baseURL === undefined) return;

    let api: string | undefined = stringField(profile, "api");
    if (isPiAi && (row.entry.declared === true || api !== undefined)) {
        const protocols = protocolChoices(row);
        const selected = await vscode.window.showQuickPick(
            protocols.map((protocol) => ({
                label: protocol,
                description: protocol === api ? t("Current protocol") : undefined,
                protocol,
            })),
            {
                title: t("Select provider protocol"),
                placeHolder: t("Choose the wire protocol used by this endpoint"),
            },
        );
        if (!selected) return;
        api = selected.protocol;
    }

    let displayName: string | undefined;
    if (isPiAi && row.entry.declared === true) {
        const entered = await vscode.window.showInputBox({
            title: t("Provider display name"),
            prompt: t("Optional name shown in model pickers"),
            value: stringField(profile, "displayName") ?? "",
            placeHolder: row.entry.provider,
            ignoreFocusOut: true,
        });
        if (entered === undefined) return;
        displayName = entered.trim() || undefined;
    }

    const apiKey = await vscode.window.showInputBox({
        title: t("API Key (optional)"),
        prompt: row.apiKeyEnv
            ? t("Leave empty to keep the stored API Key")
            : t("Leave empty to use provider-native authentication"),
        password: true,
        ignoreFocusOut: true,
        validateInput: validateApiKeyInput,
    });
    if (apiKey === undefined) return;
    const keyValue = apiKey.trim();
    const keyRef = credentialRefFor(row) ?? deriveProviderKeyRef(row.entry.provider);
    const fields: Record<string, unknown | undefined> = {
        baseURL: baseURL.trim() || undefined,
        ...(api === undefined ? {} : { api }),
        ...(displayName === undefined && isPiAi && row.entry.declared === true
            ? { displayName: undefined }
            : displayName === undefined ? {} : { displayName }),
        ...(keyValue.length > 0 ? { apiKeyEnv: keyRef } : {}),
    };
    let ops = profileFieldOps(row, fields);
    // A newly configured route with no visible fields still needs a profile
    // object; otherwise the directory remains dormant and the next refresh
    // would make the user's action appear to have done nothing.
    if (ops.length === 0 && row.entry.settingsPath.length > 0
        && valueAtPath(namespace.value, row.entry.settingsPath) === undefined) {
        ops = [{ op: "set", path: [...row.entry.settingsPath], value: {} }];
    }
    if (ops.length > 0) {
        await deps.runtime.mutateSettings(row.entry.settingsNs, ops, namespace.revision);
    }
    if (keyValue.length > 0) {
        await deps.runtime.setCredential(keyRef, keyValue);
    }
    void vscode.window.showInformationMessage(t("DSH: Provider {provider} was configured.", {
        provider: row.entry.displayName || row.entry.provider,
    }));
}

async function discoverProviderModels(
    deps: ProviderManagementDeps,
    row: ProviderManagementRow,
): Promise<void> {
    const namespace = row.namespace;
    if (!namespace || row.entry.settingsNs.length === 0) return;
    const profile = profileFor(row);
    let baseURL = stringField(profile, "baseURL");
    if (!baseURL && row.entry.declared === true) {
        const entered = await vscode.window.showInputBox({
            title: t("Discover models"),
            prompt: t("Enter the endpoint to query"),
            placeHolder: "https://gateway.example/v1",
            ignoreFocusOut: true,
            validateInput: (value) => value.trim() ? undefined : t("Enter a provider endpoint."),
        });
        if (entered === undefined) return;
        baseURL = entered.trim();
    }
    const api = stringField(profile, "api");
    let apiKey: string | undefined;
    // Installed catalog routes answer from pi-ai's registry without touching
    // the network, so do not ask for a secret merely to display their models.
    const needsEndpointProbe = row.entry.declared === true || baseURL !== undefined;
    if (needsEndpointProbe && row.credential?.configured !== true) {
        const entered = await vscode.window.showInputBox({
            title: t("API Key for model discovery (optional)"),
            prompt: t("The key is used only for this request and is never stored here"),
            password: true,
            ignoreFocusOut: true,
            validateInput: validateApiKeyInput,
        });
        if (entered === undefined) return;
        apiKey = entered.trim() || undefined;
    }
    const discovered = await discoverDraftModels(deps, {
        settingsNs: row.entry.settingsNs,
        provider: row.entry.provider,
        ...(baseURL ? { baseURL } : {}),
        ...(api ? { api } : {}),
        ...(apiKey ? { apiKey } : {}),
    });
    if (!discovered) return;
    const existingModels = currentModels(row);
    const models = await chooseDiscoveredModels(discovered, existingModels);
    if (!models) return;
    const ops = profileFieldOps(row, { models });
    if (ops.length === 0) return;
    await deps.runtime.mutateSettings(row.entry.settingsNs, ops, namespace.revision);
    void vscode.window.showInformationMessage(t("DSH: {count} models are now configured for {provider}.", {
        count: models.length,
        provider: row.entry.displayName || row.entry.provider,
    }));
}

async function addCustomProvider(
    deps: ProviderManagementDeps,
    settings: DshSettingsDescribeResult,
    rows: readonly ProviderManagementRow[],
): Promise<void> {
    const namespace = settings.namespaces.find((candidate) => candidate.ns === "llm-pi-ai");
    if (!namespace || !settings.writable) return;
    const taken = new Set(rows.map((row) => row.entry.provider));
    const route = await vscode.window.showInputBox({
        title: t("Add custom provider"),
        prompt: t("Use lowercase letters, numbers, and hyphens; start with a letter"),
        placeHolder: "acme-gateway",
        ignoreFocusOut: true,
        validateInput: (value) => {
            const candidate = value.trim();
            if (!CUSTOM_PROVIDER_ROUTE.test(candidate)) return t("Provider ID is invalid.");
            if (taken.has(candidate)) return t("A provider with this ID already exists.");
            return undefined;
        },
    });
    if (route === undefined) return;
    const provider = route.trim();
    const displayName = await vscode.window.showInputBox({
        title: t("Provider display name"),
        prompt: t("Optional name shown in model pickers"),
        value: provider,
        placeHolder: provider,
        ignoreFocusOut: true,
    });
    if (displayName === undefined) return;
    const baseURL = await vscode.window.showInputBox({
        title: t("Provider API endpoint"),
        prompt: t("Custom providers require an endpoint"),
        placeHolder: "https://gateway.example/v1",
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() ? undefined : t("Enter a provider endpoint."),
    });
    if (baseURL === undefined) return;
    const protocols = protocolChoicesForNamespace(namespace);
    const protocol = await vscode.window.showQuickPick(
        protocols.map((candidate) => ({ label: candidate, protocol: candidate })),
        {
            title: t("Select provider protocol"),
            placeHolder: t("Choose the wire protocol used by this endpoint"),
        },
    );
    if (!protocol) return;
    const key = await vscode.window.showInputBox({
        title: t("API Key (optional)"),
        prompt: t("Leave empty to use provider-native authentication"),
        password: true,
        ignoreFocusOut: true,
        validateInput: validateApiKeyInput,
    });
    if (key === undefined) return;
    const keyValue = key.trim();
    const keyRef = deriveProviderKeyRef(provider);
    const discovered = await discoverDraftModels(deps, {
        settingsNs: "llm-pi-ai",
        provider,
        baseURL: baseURL.trim(),
        api: protocol.protocol,
        ...(keyValue.length === 0 ? {} : { apiKey: keyValue }),
    });
    let models: Array<Record<string, unknown>> | undefined;
    if (discovered === undefined) {
        models = await manuallyChooseModels();
    } else {
        models = await chooseDiscoveredModels(discovered);
        if (models === undefined) {
            // Empty selection is a valid user decision, but a custom route
            // cannot be registered without at least one model. Offer the
            // explicit hand-entry fallback instead of silently cancelling.
            models = await manuallyChooseModels();
        }
    }
    if (!models || models.length === 0) return;
    const profile: Record<string, unknown> = {
        ...(displayName.trim() && displayName.trim() !== provider
            ? { displayName: displayName.trim() }
            : {}),
        ...(keyValue.length === 0 ? {} : { apiKeyEnv: keyRef }),
        api: protocol.protocol,
        baseURL: baseURL.trim(),
        models,
    };
    await deps.runtime.mutateSettings(
        "llm-pi-ai",
        [{ op: "set", path: ["providers", provider], value: profile }],
        namespace.revision,
    );
    if (keyValue.length > 0) await deps.runtime.setCredential(keyRef, keyValue);
    void vscode.window.showInformationMessage(t("DSH: Provider {provider} was configured.", {
        provider: displayName.trim() || provider,
    }));
}

async function setProviderCredential(
    deps: ProviderManagementDeps,
    row: ProviderManagementRow,
    settingsWritable: boolean,
): Promise<void> {
    const ref = credentialRefFor(row);
    if (!ref) return;
    const value = await vscode.window.showInputBox({
        title: t("Set API Key for {provider}", {
            provider: row.entry.displayName || row.entry.provider,
        }),
        prompt: t("Store credential {reference} in the Harness credential provider.", { reference: ref }),
        password: true,
        ignoreFocusOut: true,
        validateInput: (input) => validateApiKeyInput(input) ?? (input.trim() ? undefined : t("Enter an API Key.")),
    });
    if (value === undefined) return;
    if (!row.apiKeyEnv && settingsWritable && row.namespace && row.entry.settingsNs.length > 0) {
        await deps.runtime.mutateSettings(
            row.entry.settingsNs,
            [{ op: "set", path: profileFieldPath(row, "apiKeyEnv"), value: ref }],
            row.namespace.revision,
        );
    }
    await deps.runtime.setCredential(ref, value.trim());
    void vscode.window.showInformationMessage(t("DSH: {reference} was saved.", { reference: ref }));
}

async function unsetProviderCredential(
    deps: ProviderManagementDeps,
    row: ProviderManagementRow,
): Promise<void> {
    const ref = row.apiKeyEnv;
    if (!ref) return;
    const remove = t("Remove API Key");
    const confirmed = await vscode.window.showWarningMessage(
        t("Remove the stored credential {reference}?", { reference: ref }),
        { modal: true },
        remove,
    );
    if (confirmed !== remove) return;
    await deps.runtime.unsetCredential(ref);
    void vscode.window.showInformationMessage(t("DSH: {reference} was removed.", { reference: ref }));
}

async function removeProvider(
    deps: ProviderManagementDeps,
    row: ProviderManagementRow,
): Promise<void> {
    const namespace = row.namespace;
    if (!namespace || !row.removable) return;
    const remove = t("Delete provider");
    const confirmed = await vscode.window.showWarningMessage(
        t("Delete provider {provider}? This removes its user configuration.", {
            provider: row.entry.displayName || row.entry.provider,
        }),
        { modal: true },
        remove,
    );
    if (confirmed !== remove) return;

    const managedRef = deriveProviderKeyRef(row.entry.provider);
    if (
        row.apiKeyEnv === managedRef &&
        row.credential?.configured === true &&
        row.credential.writable
    ) {
        await deps.runtime.unsetCredential(managedRef);
    }
    await deps.runtime.mutateSettings(
        row.entry.settingsNs,
        [{ op: "unset", path: [...row.entry.settingsPath] }],
        namespace.revision,
    );
    void vscode.window.showInformationMessage(t("DSH: Provider {provider} was deleted.", {
        provider: row.entry.displayName || row.entry.provider,
    }));
}

/**
 * Runs the provider management picker until the user leaves it.
 *
 * Every mutation goes through Harness-owned operations (`settings.mutate`,
 * `credentials.set/unset`); this flow never writes configuration files itself.
 * Dormant providers, endpoint edits, model discovery, and credentials all stay
 * inside this flow; the Web UI remains available for settings this compact
 * editor intentionally does not expose.
 */
export async function manageProviders(deps: ProviderManagementDeps): Promise<void> {
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: t("Loading provider configuration..."),
            cancellable: false,
        },
        () => deps.runtime.start(deps.workspaceRoot()),
    );

    while (true) {
        const { rows, settings } = await loadRows(deps);

        type ProviderChoice = vscode.QuickPickItem &
            ({ choiceType: "provider"; row: ProviderManagementRow }
                | { choiceType: "custom" }
                | { choiceType: "web" });
        const choices: ProviderChoice[] = [
            ...(settings.writable && settings.namespaces.some((namespace) => namespace.ns === "llm-pi-ai")
                ? [{
                    choiceType: "custom" as const,
                    label: `$(add) ${t("Add custom provider")}`,
                    detail: t("Create a pi-ai gateway provider with endpoint, protocol, and models"),
                    alwaysShow: true,
                }]
                : []),
            {
                choiceType: "web" as const,
                label: `$(link-external) ${t("Open dsh Web UI")}`,
                detail: t("Configure providers, endpoints, models, and credentials in the official Web UI"),
                alwaysShow: true,
            },
            ...rows.map((row): ProviderChoice => ({
                choiceType: "provider",
                row,
                label: `${row.entry.active ? "$(check)" : "$(circle-slash)"} ${row.entry.displayName || row.entry.provider}`,
                description: `${row.entry.provider} · ${row.entry.active ? t("Active") : t("Inactive")}`,
                detail: providerStatusDetail(row),
            })),
        ];
        const choice = await vscode.window.showQuickPick(choices, {
            title: t("Manage providers"),
            placeHolder: t("Choose a provider to manage"),
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!choice) return;
        if (choice.choiceType === "custom") {
            try {
                await addCustomProvider(deps, settings, rows);
            } catch (error) {
                const message = errorMessage(error);
                deps.output.appendLine(`[dsh:providers] custom provider failed: ${message}`);
                void vscode.window.showErrorMessage(t("DSH: Provider action failed: {message}", { message }));
            }
            continue;
        }
        if (choice.choiceType === "web") {
            await deps.openBrowser();
            return;
        }

        const action = await chooseProviderAction(choice.row, settings.writable, settings.hasDocument);
        if (!action) continue;
        try {
            if (action === "document") {
                await deps.openBrowser();
                return;
            }
            if (action === "configure") {
                await configureProvider(deps, choice.row, settings);
                continue;
            }
            if (action === "discover") {
                await discoverProviderModels(deps, choice.row);
                continue;
            }
            if (action === "models") {
                await viewProviderModels(choice.row);
                continue;
            }
            if (action === "set-key") {
                await setProviderCredential(deps, choice.row, settings.writable);
                continue;
            }
            if (action === "unset-key") {
                await unsetProviderCredential(deps, choice.row);
                continue;
            }
            await removeProvider(deps, choice.row);
        } catch (error) {
            const message = errorMessage(error);
            deps.output.appendLine(`[dsh:providers] ${action} failed: ${message}`);
            void vscode.window.showErrorMessage(t("DSH: Provider action failed: {message}", { message }));
        }
    }
}
