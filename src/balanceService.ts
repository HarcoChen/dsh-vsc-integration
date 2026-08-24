import * as vscode from "vscode";
import { t } from "./localize";
import { deepSeekPricingPeriod, DeepSeekPricingPeriod } from "./deepseekPricing";
import {
    DeepSeekBalance,
    DeepSeekBalanceInfo,
    fetchDeepSeekBalance,
} from "./deepseekBalance";

const BALANCE_SECRET_KEY = "dsh.deepseek.balance.apiKey";
const DEFAULT_REFRESH_INTERVAL_MS = 30_000;
const MIN_REFRESH_INTERVAL_MS = 10_000;
const MAX_REFRESH_INTERVAL_MS = 3_600_000;
const LOW_BALANCE_THRESHOLD = 10;

function amount(value: string): number | undefined {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function formatAmount(value: string): string {
    const parsed = amount(value);
    if (parsed === undefined) {
        return value;
    }
    return new Intl.NumberFormat(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(parsed);
}

function preferredBalance(infos: DeepSeekBalanceInfo[]): DeepSeekBalanceInfo | undefined {
    return (
        infos.find((info) => info.currency.toUpperCase() === "USD") ??
        infos.find((info) => info.currency.toUpperCase() === "CNY") ??
        infos[0]
    );
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function pricingBadge(period: DeepSeekPricingPeriod): string {
    return period === "peak" ? "$(flame)" : "$(moon)";
}

function pricingDetails(period: DeepSeekPricingPeriod): string {
    const label = period === "peak" ? t("Peak pricing") : t("Off-peak pricing (half rate)");
    return `${label}\n${t("Peak hours: 09:00-12:00 and 14:00-18:00 (GMT+8); weekends bill at off-peak rates all day.")}`;
}

/** Owns the low-noise status bar balance indicator and its secure key cache. */
export class DeepSeekBalanceService implements vscode.Disposable {
    private readonly statusBarItem: vscode.StatusBarItem;
    private refreshTimer: NodeJS.Timeout | undefined;
    private refreshInFlight: Promise<void> | undefined;
    private disposed = false;

    public constructor(
        private readonly extensionContext: vscode.ExtensionContext,
        private readonly output: vscode.OutputChannel,
    ) {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            90,
        );
        this.statusBarItem.name = "DSH DeepSeek Balance";
        this.statusBarItem.command = "dsh.configureApiKey";
        this.showKeyRequired();
    }

    public start(): void {
        if (this.disposed) {
            return;
        }
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
        }
        this.statusBarItem.show();
        void this.refresh();
        this.refreshTimer = setInterval(() => void this.refresh(), this.refreshIntervalMs());
    }

    public async refresh(): Promise<void> {
        if (this.disposed || this.refreshInFlight) {
            return this.refreshInFlight;
        }

        const operation = this.refreshInternal();
        this.refreshInFlight = operation;
        try {
            await operation;
        } finally {
            if (this.refreshInFlight === operation) {
                this.refreshInFlight = undefined;
            }
        }
    }

    /** Saves an encrypted copy for the balance API; the runtime remains the chat credential owner. */
    public async storeApiKey(apiKey: string): Promise<void> {
        const key = apiKey.trim();
        if (!key) {
            throw new Error(t("Enter a DeepSeek API Key."));
        }
        await this.extensionContext.secrets.store(BALANCE_SECRET_KEY, key);
        await this.refresh();
    }

    public dispose(): void {
        this.disposed = true;
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
        this.statusBarItem.dispose();
    }

    private async refreshInternal(): Promise<void> {
        try {
            const apiKey = await this.getApiKey();
            if (!apiKey) {
                this.showKeyRequired();
                return;
            }

            this.showRefreshing();
            const balance = await fetchDeepSeekBalance(apiKey);
            this.showBalance(balance);
        } catch (error) {
            const message = errorText(error);
            this.output.appendLine(`[balance] ${message}`);
            this.statusBarItem.text = `$(circle-slash) ${t("DeepSeek: Error")}`;
            this.statusBarItem.tooltip = `${message}\n${t("Click to retry")}`;
            this.statusBarItem.command = "dsh.refreshBalance";
            this.statusBarItem.backgroundColor = new vscode.ThemeColor(
                "statusBarItem.errorBackground",
            );
        }
    }

    private async getApiKey(): Promise<string> {
        const stored = await this.extensionContext.secrets.get(BALANCE_SECRET_KEY);
        if (stored?.trim()) {
            return stored.trim();
        }

        const ref = vscode.workspace
            .getConfiguration("dsh")
            .get<string>("apiKeyEnv", "DEEPSEEK_API_KEY")
            .trim();
        return ref ? process.env[ref]?.trim() ?? "" : "";
    }

    private showKeyRequired(): void {
        this.statusBarItem.text = `$(key) ${t("DeepSeek: Set Key")}`;
        this.statusBarItem.tooltip = t("Click to securely configure the DeepSeek API Key");
        this.statusBarItem.command = "dsh.configureApiKey";
        this.statusBarItem.backgroundColor = undefined;
    }

    private showRefreshing(): void {
        this.statusBarItem.text = `$(sync~spin) ${t("DeepSeek: Checking")}`;
        this.statusBarItem.tooltip = t("Checking DeepSeek account balance...");
        this.statusBarItem.command = "dsh.refreshBalance";
        this.statusBarItem.backgroundColor = undefined;
    }

    private showBalance(balance: DeepSeekBalance): void {
        const info = preferredBalance(balance.balanceInfos);
        if (!balance.isAvailable || !info) {
            this.statusBarItem.text = `$(circle-slash) ${t("DeepSeek: Unavailable")}`;
            this.statusBarItem.tooltip = t("DeepSeek account balance is currently unavailable. Click to retry.");
            this.statusBarItem.command = "dsh.refreshBalance";
            this.statusBarItem.backgroundColor = undefined;
            return;
        }

        const total = formatAmount(info.totalBalance);
        const totalNumber = amount(info.totalBalance);
        const low = totalNumber !== undefined && totalNumber < LOW_BALANCE_THRESHOLD;
        const pricing = deepSeekPricingPeriod(new Date());
        const details = balance.balanceInfos
            .map(
                (value) =>
                    t("{currency}: total {total} · granted {granted} · topped up {toppedUp}", {
                        currency: value.currency,
                        total: formatAmount(value.totalBalance),
                        granted: formatAmount(value.grantedBalance),
                        toppedUp: formatAmount(value.toppedUpBalance),
                    }),
            )
            .join("\n");
        this.statusBarItem.text = `${low ? "$(warning)" : "$(dashboard)"} DeepSeek: ${total} ${info.currency} ${pricingBadge(pricing)}`;
        this.statusBarItem.tooltip = `${details}\n\n${pricingDetails(pricing)}\n\n${t("Click to refresh")}`;
        this.statusBarItem.command = "dsh.refreshBalance";
        this.statusBarItem.backgroundColor = low
            ? new vscode.ThemeColor("statusBarItem.warningBackground")
            : undefined;
    }

    private refreshIntervalMs(): number {
        const configured = vscode.workspace
            .getConfiguration("dsh")
            .get<number>("balanceRefreshIntervalMs", DEFAULT_REFRESH_INTERVAL_MS);
        const interval = Number.isFinite(configured) ? configured : DEFAULT_REFRESH_INTERVAL_MS;
        return Math.min(
            MAX_REFRESH_INTERVAL_MS,
            Math.max(MIN_REFRESH_INTERVAL_MS, interval),
        );
    }
}
