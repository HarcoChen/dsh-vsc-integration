export type DshContextKind =
    | "selection"
    | "file"
    | "folder"
    | "diagnostics"
    | "git-diff";

export interface DshContextItem {
    id: string;
    kind: DshContextKind;
    label: string;
    path?: string;
    language?: string;
    range?: {
        startLine: number;
        endLine: number;
    };
    content: string;
    byteLength: number;
}

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
    id: string;
    role: ChatRole;
    text: string;
    createdAt: number;
}

export type RuntimeState = "stopped" | "starting" | "running" | "error";

export interface RuntimeStatus {
    state: RuntimeState;
    url?: string;
    message?: string;
}

export interface DshHistoryEvent {
    type?: string;
    seq?: number;
    data?: unknown;
}

export interface DshHistoryEntry {
    event: DshHistoryEvent;
    view?: unknown;
}

export interface DshHistoryResult {
    events: DshHistoryEntry[];
    hasMore?: boolean;
}

export interface DshRpcEnvelope<T> {
    type?: string;
    rpcId?: string;
    result?: {
        ok: boolean;
        value?: T;
        error?: unknown;
    };
}

export interface DshSessionCreateResult {
    sessionId: string;
}

export interface DshSessionPromptResult {
    accepted?: boolean;
    command?: unknown;
}

export interface DshAssistantMessage {
    text: string;
    seq?: number;
}

export interface ChatViewState {
    messages: ChatMessage[];
    context: DshContextItem[];
    status: RuntimeStatus;
    busy: boolean;
    workspaceName?: string;
}
