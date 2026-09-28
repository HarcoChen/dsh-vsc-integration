import * as vscode from "vscode";
import { isRecord } from "./guards";
import { t } from "./localize";
import { DshRuntime } from "./dshRuntime";
import type {
    AccountBalanceResult,
    AccountBonusBatch,
    AccountClientMetadata,
    AccountProfileResult,
    AccountView,
    AccountWallet,
} from "./accountTypes";

type AccountAction = "refresh" | "signIn" | "signOut" | "usage" | "topUp";
interface AccountQuickPickItem extends vscode.QuickPickItem {
    readonly action?: AccountAction;
}

const ACCOUNT_CALLBACK_ERROR = "DeepSeek account browser sign-in requires the DSH Runtime to be available at a browser-accessible localhost HTTP address.";

function isString(value: unknown): value is string {
    return typeof value === "string";
}

function normalizeAccountView(value: unknown): AccountView {
    if (!isRecord(value) || (value.status !== "signed-out" && value.status !== "credential-stored") ||
        !isRecord(value.links) || !isString(value.links.usageUrl) || !isString(value.links.topUpUrl)) {
        throw new Error(t("The DSH Runtime returned an invalid account state."));
    }
    let attempt: AccountView["attempt"] = null;
    if (value.attempt !== null) {
        const raw = value.attempt;
        const phases = ["initializing", "waiting-browser", "exchanging", "committing", "succeeded", "cancelled", "expired", "failed"];
        const errorCodes = ["network", "protocol", "expired", "storage"];
        if (!isRecord(raw) || !isString(raw.id) || !phases.includes(String(raw.phase)) ||
            (raw.authorizeUrl !== undefined && !isString(raw.authorizeUrl)) ||
            (raw.expiresAt !== undefined && (typeof raw.expiresAt !== "number" || !Number.isFinite(raw.expiresAt))) ||
            (raw.errorCode !== undefined && !errorCodes.includes(String(raw.errorCode)))) {
            throw new Error(t("The DSH Runtime returned an invalid account sign-in state."));
        }
        attempt = {
            id: raw.id,
            phase: raw.phase as NonNullable<AccountView["attempt"]>["phase"],
            ...(raw.authorizeUrl === undefined ? {} : { authorizeUrl: raw.authorizeUrl }),
            ...(raw.expiresAt === undefined ? {} : { expiresAt: raw.expiresAt }),
            ...(raw.errorCode === undefined ? {} : { errorCode: raw.errorCode as NonNullable<AccountView["attempt"]>["errorCode"] }),
        };
    }
    return {
        status: value.status,
        links: { usageUrl: value.links.usageUrl, topUpUrl: value.links.topUpUrl },
        attempt,
    };
}

function normalizeProfile(value: unknown): AccountProfileResult | null {
    if (value === null) return null;
    if (!isRecord(value)) throw new Error(t("The DSH Runtime returned an invalid account profile."));
    if (value.status === "failed") return { status: "failed" };
    if (value.status !== "ready" || !isRecord(value.value)) {
        throw new Error(t("The DSH Runtime returned an invalid account profile."));
    }
    const profile = value.value;
    if ((profile.id !== null && !isString(profile.id)) ||
        (profile.name !== null && !isString(profile.name)) ||
        (profile.contact !== null && !isString(profile.contact)) ||
        (profile.avatarUrl !== undefined && profile.avatarUrl !== null && !isString(profile.avatarUrl))) {
        throw new Error(t("The DSH Runtime returned an invalid account profile."));
    }
    return {
        status: "ready",
        value: {
            id: profile.id,
            name: profile.name,
            contact: profile.contact,
            ...(profile.avatarUrl === undefined ? {} : { avatarUrl: profile.avatarUrl }),
        },
    };
}

function normalizeWallets(value: unknown): readonly AccountWallet[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const wallets: AccountWallet[] = [];
    for (const wallet of value) {
        if (!isRecord(wallet) || (wallet.currency !== "CNY" && wallet.currency !== "USD") || !isString(wallet.balance)) {
            return undefined;
        }
        wallets.push({ currency: wallet.currency, balance: wallet.balance });
    }
    return wallets;
}

function normalizeBalance(value: unknown): AccountBalanceResult | null {
    if (value === null) return null;
    if (!isRecord(value)) throw new Error(t("The DSH Runtime returned an invalid account balance."));
    if (value.status === "failed") return { status: "failed" };
    const wallets = value.status === "ready" ? normalizeWallets(value.value) : undefined;
    const bonusWallets = value.status === "ready" ? normalizeWallets(value.bonusWallets) : undefined;
    if (wallets === undefined || bonusWallets === undefined) {
        throw new Error(t("The DSH Runtime returned an invalid account balance."));
    }
    return { status: "ready", value: wallets, bonusWallets };
}

function normalizeBonuses(value: unknown): AccountBonusBatch | null {
    if (value === null) return null;
    if (!isRecord(value) || !isString(value.accountId) || !Array.isArray(value.bonuses)) {
        throw new Error(t("The DSH Runtime returned invalid account bonus notifications."));
    }
    const bonuses: AccountBonusBatch["bonuses"][number][] = [];
    for (const bonus of value.bonuses) {
        if (!isRecord(bonus) || !isString(bonus.orderId) || !isString(bonus.campaign) ||
            !isString(bonus.amount) || (bonus.currency !== "CNY" && bonus.currency !== "USD") ||
            !isString(bonus.grantedAt) || !isString(bonus.expiresAt) || !isString(bonus.message)) {
            throw new Error(t("The DSH Runtime returned invalid account bonus notifications."));
        }
        bonuses.push({
            orderId: bonus.orderId,
            campaign: bonus.campaign,
            amount: bonus.amount,
            currency: bonus.currency,
            grantedAt: bonus.grantedAt,
            expiresAt: bonus.expiresAt,
            message: bonus.message,
        });
    }
    return { accountId: value.accountId, bonuses };
}

function parseCallbackOrigin(value: string | undefined): string | undefined {
    if (!value) return undefined;
    try {
        const url = new URL(value);
        const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
        if (url.protocol !== "http:" || !isLoopback || !url.port || url.username || url.password) return undefined;
        return url.origin;
    } catch {
        return undefined;
    }
}

function safeExternalUrl(value: string): vscode.Uri | undefined {
    try {
        const url = new URL(value);
        const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
        if ((url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) || url.username || url.password) return undefined;
        return vscode.Uri.parse(url.href);
    } catch {
        return undefined;
    }
}

function formatWallets(wallets: readonly AccountWallet[]): string {
    if (wallets.length === 0) return t("No balance reported");
    return wallets.map(({ currency, balance }) => `${currency} ${balance}`).join(" · ");
}

function accountClientMetadata(version: string): AccountClientMetadata {
    return {
        version,
        locale: vscode.env.language,
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    };
}

/** VS Code account entry point backed only by the public RC.2 Account RPC. */
export class AccountActions implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private expiryController: AbortController | undefined;
    private disposed = false;

    public constructor(
        private readonly runtime: DshRuntime,
        private readonly extensionVersion: string,
        private readonly workspaceRoot: () => string | undefined,
    ) {
        this.disposables.push(runtime.onDidChange((status) => {
            if (status.state === "running") this.startExpiryWatch();
            else this.stopExpiryWatch();
        }));
        this.disposables.push(runtime.onDidRemoteEvent((event) => {
            if (event === "deepseek-account/model-sign-in-required") this.notifySignInRequired();
        }));
        if (runtime.getStatus().state === "running") this.startExpiryWatch();
    }

    public dispose(): void {
        this.disposed = true;
        this.stopExpiryWatch();
        for (const disposable of this.disposables.splice(0)) disposable.dispose();
    }

    public async manage(): Promise<void> {
        await this.ensureRuntime();
        while (!this.disposed) {
            const client = this.client();
            const view = normalizeAccountView(await this.runtime.getAccountState());
            if (view.status === "credential-stored") await this.showUnnotifiedBonuses(client);
            const [profileValue, balanceValue] = view.status === "credential-stored"
                ? await Promise.all([
                    this.runtime.getAccountProfile(client).catch(() => null),
                    this.runtime.getAccountBalance(client).catch(() => null),
                ])
                : [null, null];
            const profile = normalizeProfile(profileValue);
            const balance = normalizeBalance(balanceValue);
            const items: AccountQuickPickItem[] = [];
            const displayName = profile?.status === "ready"
                ? [profile.value.name, profile.value.contact].filter((part): part is string => Boolean(part)).join(" · ")
                : "";
            if (view.status === "credential-stored") {
                items.push({
                    label: `$(account) ${displayName || t("DeepSeek account")}`,
                    description: balance?.status === "ready"
                        ? `${t("Recharge balance")}: ${formatWallets(balance.value)} · ${t("Bonus balance")}: ${formatWallets(balance.bonusWallets)}`
                        : t("Account details are currently unavailable."),
                    action: "refresh",
                });
            } else {
                items.push({
                    label: `$(circle-slash) ${t("Not signed in to a DeepSeek account")}`,
                    description: t("Your DSH account is separate from API Key providers."),
                    action: "refresh",
                });
            }
            items.push({ label: `$(refresh) ${t("Refresh account details")}`, action: "refresh" });
            if (view.status === "credential-stored") {
                items.push({ label: `$(sign-out) ${t("Sign out of DeepSeek account")}`, action: "signOut" });
            } else {
                items.push({ label: `$(sign-in) ${t("Sign in to DeepSeek account")}`, action: "signIn" });
            }
            if (view.status === "credential-stored") {
                items.push({ label: `$(graph) ${t("Open account usage")}`, action: "usage" });
                items.push({ label: `$(credit-card) ${t("Open account top-up")}`, action: "topUp" });
            }
            const selected = await vscode.window.showQuickPick(items, {
                title: t("Manage DeepSeek account"),
                placeHolder: view.status === "credential-stored"
                    ? t("Profile and wallet balances use your DSH account. API Key balance is managed separately.")
                    : t("Sign in to use the DeepSeek account model route."),
                ignoreFocusOut: true,
            });
            switch (selected?.action) {
                case "refresh":
                    continue;
                case "signIn":
                    await this.signIn();
                    continue;
                case "signOut":
                    await this.signOut(client);
                    continue;
                case "usage":
                    await this.openAccountLink(view.links.usageUrl);
                    continue;
                case "topUp":
                    await this.openAccountLink(view.links.topUpUrl);
                    continue;
                default:
                    return;
            }
        }
    }

    private client(): AccountClientMetadata {
        return accountClientMetadata(this.extensionVersion);
    }

    private async ensureRuntime(): Promise<void> {
        if (this.runtime.getStatus().state !== "running") await this.runtime.start(this.workspaceRoot());
    }

    private async showUnnotifiedBonuses(client: AccountClientMetadata): Promise<void> {
        const batch = normalizeBonuses(await this.runtime.getUnnotifiedAccountBonuses(client));
        if (!batch) return;
        const bonus = batch.bonuses[0];
        if (!bonus) return;
        const expiresAt = Date.parse(bonus.expiresAt);
        if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return;
        // VS Code resolves this only after the notification has been presented and dismissed.
        await vscode.window.showInformationMessage(bonus.message);
        const acknowledged = await this.runtime.acknowledgeAccountBonus(batch.accountId, bonus.orderId, client);
        if (typeof acknowledged !== "boolean") {
            throw new Error(t("The DSH Runtime returned an invalid account bonus acknowledgement."));
        }
    }

    private async signIn(): Promise<void> {
        const origin = parseCallbackOrigin(this.runtime.getUrl());
        if (!origin) throw new Error(t(ACCOUNT_CALLBACK_ERROR));
        const started = normalizeAccountView(await this.runtime.startAccountSignIn(this.client(), origin, "desktop"));
        const attempt = started.attempt;
        if (started.status === "credential-stored") return this.finishSignIn();
        if (!attempt) throw new Error(t("The DSH Runtime did not return a sign-in attempt."));

        const controller = new AbortController();
        let cancellationRequested = false;
        let openedAuthorizationUrl: string | undefined;
        let terminal: "succeeded" | "cancelled" | "expired" | "failed" | undefined;
        const openAuthorization = async (view: AccountView): Promise<void> => {
            const url = view.attempt?.authorizeUrl;
            if (!url || url === openedAuthorizationUrl) return;
            const uri = safeExternalUrl(url);
            if (!uri) throw new Error(t("The DSH Runtime returned an invalid account authorization URL."));
            openedAuthorizationUrl = url;
            if (!(await vscode.env.openExternal(uri))) throw new Error(t("The account sign-in page could not be opened."));
        };
        let finished: "succeeded" | "cancelled" | "expired" | "failed" | "ended";
        try {
            finished = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: t("Sign in to DeepSeek account"),
                cancellable: true,
            }, async (progress, token) => {
                token.onCancellationRequested(() => {
                    cancellationRequested = true;
                    controller.abort();
                });
                await openAuthorization(started);
                try {
                    for await (const raw of this.runtime.watchAccount(controller.signal)) {
                        const view = normalizeAccountView(raw);
                        if (view.status === "credential-stored") return "succeeded" as const;
                        if (view.attempt?.id !== attempt.id) continue;
                        progress.report({ message: this.signInPhase(view.attempt.phase) });
                        await openAuthorization(view);
                        if (view.attempt.phase === "cancelled" || view.attempt.phase === "expired" || view.attempt.phase === "failed") {
                            terminal = view.attempt.phase;
                            return view.attempt.phase;
                        }
                    }
                } catch (error) {
                    if (!cancellationRequested) throw error;
                }
                return cancellationRequested ? "cancelled" as const : "ended" as const;
            });
        } catch (error) {
            try {
                await this.runtime.cancelAccountSignIn(attempt.id);
            } catch {
                // The attempt expires remotely if cancellation is unavailable.
            }
            throw error;
        } finally {
            controller.abort();
        }

        if (cancellationRequested) {
            const settled = normalizeAccountView(await this.runtime.cancelAccountSignIn(attempt.id));
            if (settled.status === "credential-stored") return this.finishSignIn();
            return;
        }
        if (finished === "succeeded") return this.finishSignIn();
        if (finished === "cancelled" || terminal === "cancelled") return;
        if (finished === "expired" || terminal === "expired") {
            throw new Error(t("The DeepSeek account sign-in request expired. Start sign-in again."));
        }
        if (finished === "failed" || terminal === "failed") {
            throw new Error(t("DeepSeek account sign-in failed. Start sign-in again."));
        }
        throw new Error(t("The DeepSeek account sign-in stream ended before sign-in completed."));
    }

    private signInPhase(phase: NonNullable<AccountView["attempt"]>["phase"]): string {
        switch (phase) {
            case "initializing": return t("Preparing browser sign-in…");
            case "waiting-browser": return t("Complete sign-in in your browser…");
            case "exchanging": return t("Verifying the sign-in response…");
            case "committing": return t("Saving the account credential…");
            case "succeeded": return t("Sign-in complete.");
            case "cancelled": return t("Sign-in cancelled.");
            case "expired": return t("Sign-in request expired.");
            case "failed": return t("Sign-in failed.");
        }
    }

    private async finishSignIn(): Promise<void> {
        try {
            // RC.2 selects a default account model only when no other provider has an API key.
            await this.runtime.initializeDefaultModel();
        } catch {
            // Older or custom Runtimes may not expose this optional post-login initializer.
        }
        void vscode.window.showInformationMessage(t("DeepSeek account sign-in is complete."));
    }

    private async signOut(client: AccountClientMetadata): Promise<void> {
        const running = await this.runtime.hasRunningAccountTasks();
        if (typeof running !== "boolean") throw new Error(t("The DSH Runtime returned an invalid account task status."));
        const confirm = t("Sign out");
        const message = running
            ? t("Signing out will stop running tasks that are using the DeepSeek account. Continue?")
            : t("Sign out of the DeepSeek account? Your API Key providers remain configured.");
        const answer = await vscode.window.showWarningMessage(message, { modal: true }, confirm);
        if (answer !== confirm) return;
        normalizeAccountView(await this.runtime.signOutAccount(client));
    }

    private async openAccountLink(value: string): Promise<void> {
        const uri = safeExternalUrl(value);
        if (!uri) throw new Error(t("The DSH Runtime returned an invalid account link."));
        await vscode.env.openExternal(uri);
    }

    private notifySignInRequired(): void {
        const action = t("Manage account");
        void vscode.window.showWarningMessage(t("Sign in to your DeepSeek account to use the selected account model."), action)
            .then((selected) => {
                if (selected === action) void vscode.commands.executeCommand("dsh.manageAccount");
            });
    }

    private notifyExpired(): void {
        const action = t("Manage account");
        void vscode.window.showWarningMessage(t("Your DeepSeek account session expired. Sign in again to use account models."), action)
            .then((selected) => {
                if (selected === action) void vscode.commands.executeCommand("dsh.manageAccount");
            });
    }

    private startExpiryWatch(): void {
        if (this.disposed || this.expiryController) return;
        const controller = new AbortController();
        this.expiryController = controller;
        void this.runExpiryWatch(controller.signal).finally(() => {
            if (this.expiryController === controller) this.expiryController = undefined;
        });
    }

    private stopExpiryWatch(): void {
        this.expiryController?.abort();
        this.expiryController = undefined;
    }

    private async runExpiryWatch(signal: AbortSignal): Promise<void> {
        let retryDelay = 1_000;
        while (!signal.aborted && !this.disposed) {
            try {
                for await (const event of this.runtime.watchAccountExpiry(signal)) {
                    if (event === "session-expired") this.notifyExpired();
                }
                if (!signal.aborted) throw new Error("Account expiry stream ended");
            } catch {
                if (signal.aborted || this.disposed) return;
                await new Promise<void>((resolve) => {
                    const finish = (): void => {
                        if (timer !== undefined) clearTimeout(timer);
                        signal.removeEventListener("abort", finish);
                        resolve();
                    };
                    const timer = setTimeout(finish, retryDelay);
                    signal.addEventListener("abort", finish, { once: true });
                });
                retryDelay = Math.min(retryDelay * 2, 30_000);
            }
        }
    }
}
