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
    /** Fixed-vocabulary HTML produced by the extension-host safe Markdown renderer. */
    renderedHtml?: string;
    /** Opaque per-render nonce used to address host-retained code payloads. */
    renderId?: string;
    createdAt: number;
    seq?: number;
    state?: "committed" | "streaming" | "pending" | "failed";
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

export interface DshSurfaceReplaceOp {
    op: "replace";
    /** Inclusive seq of the first surface node being replaced. */
    start: number;
    /** Inclusive seq of the last surface node being replaced. */
    end: number;
}

export type DshSurfaceOp = "append" | DshSurfaceReplaceOp;

export interface DshSessionEvent {
    type: string;
    seq: number;
    time: number;
    data: unknown;
    sourceEventSeqs?: number[];
    surfaceOp?: DshSurfaceOp;
    ignorable?: true;
}

export interface DshHistoryEvent {
    type?: string;
    seq?: number;
    time?: number;
    data?: unknown;
    sourceEventSeqs?: number[];
    surfaceOp?: DshSurfaceOp;
    ignorable?: true;
}

export interface DshHistoryEntry {
    event: DshHistoryEvent;
    view?: unknown;
}

export interface DshHistoryResult {
    events: DshHistoryEntry[];
    hasMore?: boolean;
    projections?: DshSessionProjectionsBlock;
}

export interface DshSessionProjectionsBlock {
    /** Last committed event reflected by every value; -1 for an empty log. */
    asOfSeq: number;
    /** Complete current value for every projection registered by the host. */
    values: Record<string, unknown>;
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
    running?: boolean;
    blank?: boolean;
    parentSessionId?: string;
    origin?: "subagent";
    agentPreset?: string;
    projections?: DshSessionProjectionsBlock;
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

export interface DshSessionSearchItem {
    sessionId: string;
    snippet: string;
}

export interface DshSessionSearchResult {
    items: DshSessionSearchItem[];
    hasMore: boolean;
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

export interface DshGoalRef {
    id: string;
    revision: number;
}

export type DshGoalPhase = "active" | "paused" | "blocked" | "complete";

export interface DshGoalBlockReason {
    code: string;
    message: string;
}

export interface DshGoalSnapshot extends DshGoalRef {
    objective: string;
    phase: DshGoalPhase;
    blockedReason?: DshGoalBlockReason;
    maxGoalRounds: number;
}

/** Exact whole value carried by the public `goal` session projection. */
export interface DshGoalProjection {
    goal: DshGoalSnapshot;
    roundsStarted: number;
    createdAt: number;
    updatedAt: number;
}

export interface DshGoalRefResult {
    ref: DshGoalRef;
}

export type DshSubagentListEntry =
    | ({
          kind: "child";
          id: string;
          activity: "running" | "inactive";
          hasChildren: boolean;
      } &
          (
              | { mode: "one-shot"; label?: string }
              | { mode: "continuable"; label: string }
          ))
    | {
          kind: "diagnostic";
          id: string;
          reason: "corrupt" | "unsupported" | "unavailable";
      };

export interface DshSubagentCatalog {
    entries: DshSubagentListEntry[];
    parentAvailable: boolean;
}

export type DshSubagentAddress = {
    parentSessionId: string;
    childSessionId: string;
} & ({ mode: "one-shot" } | { mode: "continuable" });

export interface DshSubagentHistoryResult extends DshHistoryResult {
    hasMore: boolean;
}

export interface DshSubagentPromptResult {
    messageId: string;
}

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

export interface DshQueuedInboxItem {
    id: string;
    placement: "queued" | "steering" | "context";
    /** Message is merge-extensible in Harness, so clients retain it losslessly. */
    message: unknown;
}

export interface DshSessionQueueFrame {
    type: "session/queue";
    sessionId: string;
    items: DshQueuedInboxItem[];
}

export interface DshJobView {
    id: string;
    /** Producer kinds are plugin-extensible and intentionally not enumerated. */
    kind: string;
    label: string;
    status: "running" | "stopping" | "completed" | "killed" | "failed";
    detail?: string;
    startedAt: number;
    finishedAt?: number;
}

export interface DshSessionJobsFrame {
    type: "session/jobs";
    sessionId: string;
    jobs: DshJobView[];
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

export interface DshHostSessionAddedFrame {
    type: "host/session-added";
    sessionId: string;
    blank: boolean;
    parentSessionId?: string;
    origin?: "subagent";
    cwd?: string;
    agentPreset?: string;
}

export interface DshHostSessionRemovedFrame {
    type: "host/session-removed";
    sessionId: string;
}

export interface DshHostSessionStatusFrame {
    type: "host/session-status";
    sessionId: string;
    running: boolean;
}

export interface DshHostAgentErrorFrame {
    type: "host/agent-error";
    sessionId: string;
    message: string;
}

export interface DshWorkspaceView {
    workspaceId: string;
    path: string;
    title: string;
    sessionIds: string[];
    createdAt: string;
    updatedAt: string;
    [key: string]: unknown;
}

export interface DshWorkspaceListResult {
    items: DshWorkspaceView[];
    archivedSessionIds: string[];
}

export interface DshHostWorkspaceChangedFrame {
    type: "host/workspace-changed";
    workspace: DshWorkspaceView;
}

export interface DshHostWorkspaceRemovedFrame {
    type: "host/workspace-removed";
    workspaceId: string;
}

export interface DshHostWorkspaceOrderChangedFrame {
    type: "host/workspace-order-changed";
    workspaceIds: string[];
}

export interface DshHostArchivedSessionsChangedFrame {
    type: "host/archived-sessions-changed";
    archivedSessionIds: string[];
}

export interface DshHostRemoteEventFrame {
    type: "host/remote-event";
    event: string;
    args: unknown[];
}

export interface DshUnknownHostFrame {
    type: string;
    [key: string]: unknown;
}

export type DshHostFrame =
    | DshHostSessionAddedFrame
    | DshHostSessionRemovedFrame
    | DshHostSessionStatusFrame
    | DshHostAgentErrorFrame
    | DshHostWorkspaceChangedFrame
    | DshHostWorkspaceRemovedFrame
    | DshHostWorkspaceOrderChangedFrame
    | DshHostArchivedSessionsChangedFrame
    | DshHostRemoteEventFrame
    | DshStreamErrorFrame
    | DshUnknownHostFrame;

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
    selection?: DshContextItem;
    selectionEnabled: boolean;
    status: RuntimeStatus;
    busy: boolean;
    submitting: boolean;
    workspaceName?: string;
    host?: HostBaselineView;
    sessionId?: string;
    sessions: Array<{
        sessionId: string;
        title: string;
        running: boolean;
        attention: boolean;
        archived: boolean;
    }>;
    sessionStatus?: {
        running: boolean;
        attention: boolean;
        error?: string;
    };
    interactions: Array<{
        key: string;
        kind: "approval" | "question";
        status: "pending" | "submitting" | "resolved" | "failed" | "unavailable";
        toolName?: string;
        reason?: string;
        questions?: DshQuestionItem[];
        outcome?: string;
        error?: string;
    }>;
    queue: Array<{
        id: string;
        placement: "queued" | "steering";
        preview: string;
        editableText?: string;
    }>;
    goal?: GoalHudView;
    subagents?: SubagentTreeView;
    subagentPreview?: SubagentHistoryPreview;
    jobs: JobCenterItem[];
}

export interface HostBaselineView {
    version: string;
    cwd: string;
    provider?: string;
    model?: string;
    attachedSessions: number;
    canOpenPath: boolean;
}

export interface GoalHudView {
    state: "empty" | "present" | "invalid";
    goal?: DshGoalSnapshot;
    roundsStarted?: number;
    createdAt?: number;
    updatedAt?: number;
    pending?: boolean;
    pendingOperation?:
        | "create"
        | "edit"
        | "pause"
        | "resume"
        | "complete"
        | "clear";
    error?: string;
}

export interface SubagentTreeNodeView {
    kind: "child" | "diagnostic";
    id: string;
    parentSessionId: string;
    depth: number;
    parentAvailable: boolean;
    label?: string;
    mode?: "one-shot" | "continuable";
    activity?: "running" | "inactive";
    hasChildren?: boolean;
    reason?: "corrupt" | "unsupported" | "unavailable";
}

export interface SubagentTreeView {
    rootSessionId: string;
    state: "loading" | "ready" | "error";
    nodes: SubagentTreeNodeView[];
    error?: string;
}

export interface SubagentHistoryPreview {
    rootSessionId: string;
    childSessionId: string;
    label: string;
    mode: "one-shot" | "continuable";
    parentAvailable: boolean;
    activity: "running" | "inactive";
    state: "loading" | "ready" | "error";
    messages: ChatMessage[];
    pendingAction?: "follow-up" | "interrupt";
    error?: string;
}

export interface JobCenterItem {
    id: string;
    kind: string;
    label: string;
    ownerSessionId: string;
    status: DshJobView["status"];
    outputSummary?: string;
    startedAt: number;
    finishedAt?: number;
}
