/** Public, credential-free account projections exposed by DSH Remote RPC. */
export interface AccountClientMetadata {
    readonly version: string;
    readonly locale: string;
    /** Offset from UTC in seconds, positive east of Greenwich. */
    readonly timezoneOffsetSeconds: number;
}

export interface AccountProfile {
    readonly id: string | null;
    readonly name: string | null;
    readonly contact: string | null;
    readonly avatarUrl?: string | null;
}

export interface AccountWallet {
    readonly currency: "CNY" | "USD";
    readonly balance: string;
}

export interface AccountView {
    readonly status: "signed-out" | "credential-stored";
    readonly links: {
        readonly usageUrl: string;
        readonly topUpUrl: string;
    };
    readonly attempt: {
        readonly id: string;
        readonly phase: "initializing" | "waiting-browser" | "exchanging" | "committing" |
            "succeeded" | "cancelled" | "expired" | "failed";
        readonly authorizeUrl?: string;
        readonly expiresAt?: number;
        readonly errorCode?: "network" | "protocol" | "expired" | "storage";
    } | null;
}

export interface AccountBonusBatch {
    readonly accountId: string;
    readonly bonuses: readonly {
        readonly orderId: string;
        readonly campaign: string;
        readonly amount: string;
        readonly currency: "CNY" | "USD";
        readonly grantedAt: string;
        readonly expiresAt: string;
        readonly message: string;
    }[];
}

export type AccountProfileResult =
    | { readonly status: "ready"; readonly value: AccountProfile }
    | { readonly status: "failed" };

export type AccountBalanceResult =
    | { readonly status: "ready"; readonly value: readonly AccountWallet[]; readonly bonusWallets: readonly AccountWallet[] }
    | { readonly status: "failed" };
