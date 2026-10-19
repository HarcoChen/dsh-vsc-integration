import type { AccountBonusBatch } from "./accountTypes";
import { isRecord } from "./guards";
import { t } from "./localize";

export function normalizeAccountNotifications(value: unknown): AccountBonusBatch | null {
    if (value === null) return null;
    if (!isRecord(value) || typeof value.accountId !== "string" || !Array.isArray(value.bonuses)) {
        throw new Error(t("The DSH Runtime returned invalid account bonus notifications."));
    }
    const bonuses = value.bonuses.map(item => {
        if (!isRecord(item) || typeof item.orderId !== "string" || !item.orderId || typeof item.expiresAt !== "string" ||
            typeof item.message !== "string" || (item.title !== undefined && typeof item.title !== "string")) {
            throw new Error(t("The DSH Runtime returned invalid account bonus notifications."));
        }
        return { orderId: item.orderId, expiresAt: item.expiresAt, message: item.message,
            ...(typeof item.title === "string" ? { title: item.title } : {}) };
    });
    return { accountId: value.accountId, bonuses };
}

export interface AccountNotificationQueue {
    read(): Promise<AccountBonusBatch | null>;
    acknowledge(accountId: string, orderId: string): Promise<unknown>;
    show(notice: AccountBonusBatch["bonuses"][number]): Promise<void>;
    isCurrent(): boolean;
}

/** Drain one bounded batch in order, rechecking the account around every awaited display. */
export async function drainAccountNotifications(queue: AccountNotificationQueue): Promise<void> {
    const batch = await queue.read();
    if (!batch) return;
    const seen = new Set<string>();
    for (const original of batch.bonuses) {
        if (!queue.isCurrent()) return;
        if (seen.has(original.orderId)) continue;
        seen.add(original.orderId);
        const current = await queue.read();
        if (!queue.isCurrent() || current?.accountId !== batch.accountId) return;
        const notice = current.bonuses.find(item => item.orderId === original.orderId);
        if (!notice) continue;
        const expires = Date.parse(notice.expiresAt);
        if (notice.expiresAt && Number.isFinite(expires) && expires <= Date.now()) continue;
        await queue.show(notice);
        if (!queue.isCurrent()) return;
        const latest = await queue.read();
        if (!queue.isCurrent() || latest?.accountId !== batch.accountId) return;
        const acknowledged = await queue.acknowledge(batch.accountId, notice.orderId);
        if (typeof acknowledged !== "boolean") throw new Error(t("The DSH Runtime returned an invalid account bonus acknowledgement."));
        if (!acknowledged) return;
    }
}
