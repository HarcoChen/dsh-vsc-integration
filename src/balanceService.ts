import * as vscode from "vscode";
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
            throw new Error("请输入 DeepSeek API Key。");
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
            this.statusBarItem.text = "$(circle-slash) DeepSeek: 错误";
            this.statusBarItem.tooltip = `${message}\n点击重试`;
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
        this.statusBarItem.text = "$(key) DeepSeek: 设置 Key";
        this.statusBarItem.tooltip = "点击安全配置 DeepSeek API Key";
        this.statusBarItem.command = "dsh.configureApiKey";
        this.statusBarItem.backgroundColor = undefined;
    }

    private showRefreshing(): void {
        this.statusBarItem.text = "$(sync~spin) DeepSeek: 查询中";
        this.statusBarItem.tooltip = "正在查询 DeepSeek 账户余额…";
        this.statusBarItem.command = "dsh.refreshBalance";
        this.statusBarItem.backgroundColor = undefined;
    }

    private showBalance(balance: DeepSeekBalance): void {
        const info = preferredBalance(balance.balanceInfos);
        if (!balance.isAvailable || !info) {
            this.statusBarItem.text = "$(circle-slash) DeepSeek: 暂不可用";
            this.statusBarItem.tooltip = "DeepSeek 账户当前没有可用余额信息。点击重试";
            this.statusBarItem.command = "dsh.refreshBalance";
            this.statusBarItem.backgroundColor = undefined;
            return;
        }

        const total = formatAmount(info.totalBalance);
        const totalNumber = amount(info.totalBalance);
        const low = totalNumber !== undefined && totalNumber < LOW_BALANCE_THRESHOLD;
        const details = balance.balanceInfos
            .map(
                (value) =>
                    `${value.currency}: 总额 ${formatAmount(value.totalBalance)} · 赠送 ${formatAmount(value.grantedBalance)} · 充值 ${formatAmount(value.toppedUpBalance)}`,
            )
            .join("\n");
        this.statusBarItem.text = `${low ? "$(warning)" : "$(dashboard)"} DeepSeek: ${total} ${info.currency}`;
        this.statusBarItem.tooltip = `${details}\n\n点击刷新`;
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
