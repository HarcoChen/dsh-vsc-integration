import * as vscode from "vscode";
import { hasPath, valueAtPath } from "./chatViewPresentation";
import { DshRuntime } from "./dshRuntime";
import { errorMessage } from "./errors";
import { t } from "./localize";
import {
    DshConfigurableProvider,
    DshCredentialView,
    DshSettingsDescribeResult,
    DshSettingsNamespaceView,
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
    /** Opens the Harness Web UI, which owns onboarding and advanced editing. */
    openBrowser: () => Promise<void>;
}

interface ProviderManagementRow {
    entry: DshConfigurableProvider;
    namespace?: DshSettingsNamespaceView;
    configured: boolean;
    removable: boolean;
    apiKeyEnv?: string;
    credential?: DshCredentialView;
}

function deriveProviderKeyRef(provider: string): string {
    return `${provider.toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}_API_KEY`;
}

function providerStatusDetail(row: ProviderManagementRow): string {
    const configuration = row.configured ? t("Configured") : t("Not configured");
    if (!row.apiKeyEnv) return `${configuration} · ${t("Provider-native authentication")}`;
    if (!row.credential) return `${configuration} · ${row.apiKeyEnv}: ${t("Credential status unavailable")}`;
    if (!row.credential.configured) return `${configuration} · ${row.apiKeyEnv}: ${t("API Key missing")}`;
    const source = row.credential.source ? ` (${row.credential.source})` : "";
    return `${configuration} · ${row.apiKeyEnv}: ${t("API Key configured")}${source}`;
}

/** Builds the rows for the picker, keeping only providers with a live configuration. */
async function loadRows(
    deps: ProviderManagementDeps,
): Promise<{ rows: ProviderManagementRow[]; settings: DshSettingsDescribeResult }> {
    const [providerResult, settings] = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: t("Loading provider configuration..."),
            cancellable: false,
        },
        () => Promise.all([
            deps.runtime.listProviders(),
            deps.runtime.describeSettings(),
        ]),
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
            };
        })
        // Unconfigured catalog entries belong in the Web UI onboarding flow,
        // not in the already-configured provider management list.
        .filter((row) => row.configured);

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
    return { rows, settings };
}

async function chooseProviderAction(
    row: ProviderManagementRow,
    settingsWritable: boolean,
    hasDocument: boolean,
): Promise<"set-key" | "unset-key" | "document" | "remove" | undefined> {
    const actions: Array<vscode.QuickPickItem & {
        action: "set-key" | "unset-key" | "document" | "remove";
    }> = [];
    if (row.apiKeyEnv && row.credential?.writable !== false) {
        actions.push({
            action: "set-key",
            label: `$(key) ${t("Set API Key")}`,
            detail: row.apiKeyEnv,
        });
    }
    if (row.apiKeyEnv && row.credential?.configured && row.credential.writable) {
        actions.push({
            action: "unset-key",
            label: `$(trash) ${t("Remove stored API Key")}`,
            detail: row.apiKeyEnv,
        });
    }
    if (hasDocument) {
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

async function setProviderCredential(
    deps: ProviderManagementDeps,
    row: ProviderManagementRow,
): Promise<void> {
    const ref = row.apiKeyEnv;
    if (!ref) return;
    const value = await vscode.window.showInputBox({
        title: t("Set API Key for {provider}", {
            provider: row.entry.displayName || row.entry.provider,
        }),
        prompt: t("Store credential {reference} in the Harness credential provider.", { reference: ref }),
        password: true,
        ignoreFocusOut: true,
        validateInput: (input) => input.trim() ? undefined : t("Enter an API Key."),
    });
    if (value === undefined) return;
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
 * Onboarding for providers that have no configuration yet, and advanced editing,
 * both hand off to the Web UI.
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
            ({ choiceType: "provider"; row: ProviderManagementRow } | { choiceType: "web" });
        const choices: ProviderChoice[] = [
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
        if (choice.choiceType === "web") {
            await deps.openBrowser();
            return;
        }

        const action = await chooseProviderAction(choice.row, settings.writable, settings.hasDocument);
        if (!action) continue;
        if (action === "document") {
            await deps.openBrowser();
            return;
        }
        if (action === "set-key") {
            await setProviderCredential(deps, choice.row);
            continue;
        }
        if (action === "unset-key") {
            await unsetProviderCredential(deps, choice.row);
            continue;
        }
        await removeProvider(deps, choice.row);
    }
}
