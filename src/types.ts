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

export interface DshRpcError {
    code: string;
    message: string;
    details?: unknown;
    [key: string]: unknown;
}

export type DshRpcResult<T = unknown> =
    | {
          ok: true;
          value?: T;
      }
    | {
          ok: false;
          error?: DshRpcError | unknown;
      };

export interface DshServerRequest<T = unknown> {
    type: "server-request";
    rpcId: string;
    method: string;
    payload: T;
}

export interface DshClientResponse<T = unknown> {
    type: "client-response";
    rpcId: string;
    result: DshRpcResult<T>;
}

export type DshRpcReceipt =
    | { accepted: true }
    | { accepted: false; reason: "not-pending" | "bad-response" | string };

export interface DshSessionEvent {
    type: string;
    seq: number;
    time: number;
    data: unknown;
    sourceEventSeqs?: number[];
    surfaceOp?: unknown;
}

export interface DshHistoryEvent {
    type?: string;
    seq?: number;
    time?: number;
    data?: unknown;
    sourceEventSeqs?: number[];
    surfaceOp?: unknown;
}

export interface DshHistoryEntry {
    event: DshHistoryEvent;
    view?: unknown;
}

export interface DshHistoryResult {
    events: DshHistoryEntry[];
    hasMore?: boolean;
    projections?: Record<string, unknown>;
}

export interface DshRpcEnvelope<T> {
    type?: string;
    rpcId?: string;
    result?: DshRpcResult<T>;
}

export interface DshSessionCreateResult {
    sessionId: string;
    agentPreset?: string;
}

export interface DshSessionPromptResult {
    accepted?: boolean;
    command?: unknown;
}

export interface DshSessionSummary {
    sessionId: string;
    title?: string;
    cwd?: string;
    createdAt?: number;
    updatedAt?: number;
    [key: string]: unknown;
}

export interface DshSessionListResult {
    items: DshSessionSummary[];
    nextCursor?: string;
    [key: string]: unknown;
}

export interface DshSessionListPayload {
    cursor?: string;
}

export interface DshModelSelection {
    provider: string;
    model: string;
    reasoningEffort?: string;
    [key: string]: unknown;
}

export interface DshModelProviderModel {
    id: string;
    name?: string;
    reasoningEfforts?: string[];
    [key: string]: unknown;
}

export interface DshModelProviderGroup {
    provider: string;
    name?: string;
    models: DshModelProviderModel[];
    [key: string]: unknown;
}

export interface DshModelCatalogFailure {
    provider?: string;
    message?: string;
    [key: string]: unknown;
}

export interface DshSessionModelsResult {
    current: DshModelSelection;
    routable: boolean;
    groups: DshModelProviderGroup[];
    failures: DshModelCatalogFailure[];
    [key: string]: unknown;
}

export interface DshSessionSelectModelResult {
    selected: DshModelSelection;
    [key: string]: unknown;
}

export interface DshSessionRenameResult {
    title: string;
    seq: number;
    [key: string]: unknown;
}

export interface DshSessionForkResult {
    sessionId: string;
    [key: string]: unknown;
}

export interface DshCommandInput {
    hint: string;
    [key: string]: unknown;
}

export interface DshCommandDescriptor {
    name: string;
    description: string;
    input?: DshCommandInput;
    [key: string]: unknown;
}

export type DshCommandListResult =
    | DshCommandDescriptor[]
    | {
          commands: DshCommandDescriptor[];
          [key: string]: unknown;
      };

export interface DshSkillEntry {
    name: string;
    description: string;
    whenToUse?: string;
    modelInvocable: boolean;
    [key: string]: unknown;
}

export interface DshSkillListResult {
    skills: DshSkillEntry[];
    [key: string]: unknown;
}

export interface DshApprovalRequested {
    type: "approval/requested";
    sessionId: string;
    approvalId: string;
    toolName: string;
    callId?: string;
    reason?: string;
}

export interface DshApprovalResolved {
    type: "approval/resolved";
    sessionId: string;
    approvalId: string;
    outcome: "allowed-once" | "rejected" | "cancelled" | "unavailable" | string;
}

export type DshApprovalOutcome = "allowed-once" | "rejected";

export interface DshApprovalResponse {
    sessionId: string;
    approvalId: string;
    outcome: DshApprovalOutcome;
}

export interface DshQuestionOption {
    label: string;
    description?: string;
}

export interface DshQuestionIntent {
    kind: string;
    [key: string]: unknown;
}

export interface DshQuestionItem {
    id: string;
    question: string;
    header?: string;
    detail?: string;
    options?: DshQuestionOption[];
    multiSelect?: boolean;
    intent?: DshQuestionIntent;
}

export interface DshQuestionRequested {
    type: "question/requested";
    sessionId: string;
    questions: DshQuestionItem[];
}

export interface DshQuestionResolved {
    type: "question/resolved";
    sessionId: string;
    questionRpcId: string;
    outcome: "answered" | "cancelled" | string;
}

export interface DshQuestionAnswerItem {
    id: string;
    selected: string[];
    custom?: string;
}

export interface DshQuestionResponse {
    sessionId: string;
    answer: {
        answers: DshQuestionAnswerItem[];
    };
}

export interface DshSessionEventFrame {
    type: "session/event";
    sessionId: string;
    event: DshSessionEvent;
    view?: unknown;
}

export interface DshSessionSubscribedFrame {
    type: "session/subscribed";
    sessionId: string;
    lastSeq: number;
}

export interface DshSessionQueueFrame {
    type: "session/queue";
    sessionId: string;
    items: unknown[];
}

export interface DshSessionJobsFrame {
    type: "session/jobs";
    sessionId: string;
    jobs: unknown[];
}

export interface DshSessionProjectionFrame {
    type: "session/projection";
    sessionId: string;
    key: string;
    value: unknown;
    seq: number;
}

export interface DshStreamErrorFrame {
    type: "stream/error";
    error: DshRpcError | unknown;
}

export interface DshUnknownMuxFrame {
    type: string;
    [key: string]: unknown;
}

export type DshMuxFrame =
    | DshSessionEventFrame
    | DshSessionSubscribedFrame
    | DshApprovalRequested
    | DshApprovalResolved
    | DshQuestionRequested
    | DshQuestionResolved
    | DshSessionQueueFrame
    | DshSessionJobsFrame
    | DshSessionProjectionFrame
    | DshStreamErrorFrame
    | DshUnknownMuxFrame;

export type DshEvent = DshMuxFrame;

export type DshReceivedEvent = DshMuxFrame & {
    rpcId: string;
    method: string;
    payload: DshMuxFrame;
};

export type DshEventListener = (event: DshReceivedEvent) => void | Promise<void>;

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
