export interface DeepSeekBalanceInfo {
    currency: string;
    totalBalance: string;
    grantedBalance: string;
    toppedUpBalance: string;
}

export interface DeepSeekBalance {
    isAvailable: boolean;
    balanceInfos: DeepSeekBalanceInfo[];
}

export interface DeepSeekBalanceFetchOptions {
    fetch?: typeof fetch;
    endpoint?: string;
    timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = "0"): string {
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
    }
    return fallback;
}

function parseBalanceInfo(value: unknown): DeepSeekBalanceInfo | undefined {
    if (!isRecord(value) || typeof value.currency !== "string") {
        return undefined;
    }

    return {
        currency: value.currency,
        totalBalance: stringValue(value.total_balance),
        grantedBalance: stringValue(value.granted_balance),
        toppedUpBalance: stringValue(value.topped_up_balance),
    };
}

/**
 * Fetches the account balance from DeepSeek's official `/user/balance` endpoint.
 * The API key is only placed in the outgoing Authorization header and is never included
 * in an error or return value.
 */
export async function fetchDeepSeekBalance(
    apiKey: string,
    options: DeepSeekBalanceFetchOptions = {},
): Promise<DeepSeekBalance> {
    const key = apiKey.trim();
    if (!key) {
        throw new Error("未配置 DeepSeek API Key。");
    }

    const doFetch = options.fetch ?? fetch;
    const endpoint = options.endpoint ?? "https://api.deepseek.com/user/balance";
    const timeoutMs = Math.max(1_000, options.timeoutMs ?? 10_000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await doFetch(endpoint, {
            method: "GET",
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${key}`,
            },
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(`DeepSeek 余额请求失败（HTTP ${response.status}）。`);
        }

        const body: unknown = await response.json();
        if (!isRecord(body) || typeof body.is_available !== "boolean") {
            throw new Error("DeepSeek 余额响应格式无效。");
        }

        const values = Array.isArray(body.balance_infos)
            ? body.balance_infos
                  .map(parseBalanceInfo)
                  .filter((value): value is DeepSeekBalanceInfo => value !== undefined)
            : [];
        return {
            isAvailable: body.is_available,
            balanceInfos: values,
        };
    } catch (error) {
        if (controller.signal.aborted) {
            throw new Error("DeepSeek 余额请求超时。");
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}
