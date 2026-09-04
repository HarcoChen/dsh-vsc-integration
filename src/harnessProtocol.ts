import {
    DshCommandDescriptor,
    DshCommandExecution,
    DshHistoryResult,
    DshImageUpload,
    DshGoalRef,
    DshGoalRefResult,
    DshRpcError,
    DshSessionCreateResult,
    DshSessionForkResult,
    DshSessionListResult,
    DshSessionPromptResult,
    DshImageAttachmentResult,
    DshSessionModelsResult,
    DshSessionSelectModelResult,
    DshAgentPresetListResult,
    DshAgentPresetOpenResult,
    DshAgentPresetReadResult,
    DshAgentPresetSelectResult,
    DshSessionRenameResult,
    DshSessionSearchResult,
    DshSkillListResult,
    DshProviderListResult,
    DshLlmModelsResult,
    DshLlmDiscoverModelsResult,
    DshCredentialDescribeResult,
    DshSettingsDescribeResult,
    DshSettingsNamespaceView,
    DshSettingsPathOperation,
    DshSubagentAddress,
    DshSubagentCatalog,
    DshSubagentHistoryResult,
    DshSubagentPromptResult,
    DshMessageFeedbackDeleteRequest,
    DshMessageFeedbackDeleteResult,
    DshMessageFeedbackListRequest,
    DshMessageFeedbackListResult,
    DshMessageFeedbackPutRequest,
    DshMessageFeedbackPutResult,
    DshWorkspaceListResult,
    DshWorkspaceCreateResult,
    DshWorkspaceView,
} from "./types";

/** Public DeepSeek Harness RPCs currently consumed by the extension foundation. */
export interface HarnessRpcMethodMap {
    "host.describe": RpcMethod<EmptyPayload, HarnessHostDescription>;
    "session.list": RpcMethod<{ cursor?: string }, DshSessionListResult>;
    "session.search": RpcMethod<{ query: string }, DshSessionSearchResult>;
    "session.create": RpcMethod<
        {
            workspaceId?: string;
            cwd?: string;
            sessionId?: string;
            agentPreset?: string;
        },
        DshSessionCreateResult
    >;
    "session.history": RpcMethod<
        { sessionId: string; beforeSeq?: number; maxMessages?: number },
        DshHistoryResult
    >;
    "session.rename": RpcMethod<
        { sessionId: string; title: string },
        DshSessionRenameResult
    >;
    "session.fork": RpcMethod<
        { sessionId: string; atSeq?: number },
        DshSessionForkResult
    >;
    "session.prompt": RpcMethod<
        {
            sessionId: string;
            mode: "queue" | "steer";
            content: HarnessPromptContentPart[];
            clientTimeZone?: string;
        },
        DshSessionPromptResult
    >;
    "session.attachment": RpcMethod<
        { sessionId: string; attachmentId: string },
        DshImageAttachmentResult
    >;
    "session.models": RpcMethod<{ sessionId: string }, DshSessionModelsResult>;
    "session.selectModel": RpcMethod<{
        sessionId: string;
        provider: string;
        model: string;
        reasoningEffort?: string;
    }, DshSessionSelectModelResult>;
    "agentPreset.list": RpcMethod<EmptyPayload, DshAgentPresetListResult>;
    "agentPreset.select": RpcMethod<{
        sessionId: string;
        agentPreset: string;
    }, DshAgentPresetSelectResult>;
    "agentPreset.read": RpcMethod<{ agentPreset: string }, DshAgentPresetReadResult>;
    "agentPreset.copy": RpcMethod<
        { from: string; agentPreset: string; name?: string },
        { agentPreset: string }
    >;
    "agentPreset.openDocument": RpcMethod<
        { agentPreset: string },
        DshAgentPresetOpenResult
    >;
    "agentPreset.remove": RpcMethod<{ agentPreset: string }, Record<string, never>>;
    "session.updateQueue": RpcMethod<
        { sessionId: string; itemId: string; action: HarnessQueueAction },
        { accepted: true }
    >;
    "session.cancel": RpcMethod<{ sessionId: string }, { accepted: true }>;
    "subagent.list": RpcMethod<
        { parentSessionId: string },
        DshSubagentCatalog
    >;
    "subagent.history": RpcMethod<
        DshSubagentAddress & { beforeSeq?: number; maxMessages?: number },
        DshSubagentHistoryResult
    >;
    "subagent.prompt": RpcMethod<
        Extract<DshSubagentAddress, { mode: "continuable" }> & {
            content: HarnessDurableContentBlock[];
            clientTimeZone?: string;
        },
        DshSubagentPromptResult
    >;
    "subagent.interrupt": RpcMethod<
        Extract<DshSubagentAddress, { mode: "continuable" }>,
        { accepted: true }
    >;
    "workspace.list": RpcMethod<EmptyPayload, DshWorkspaceListResult>;
    "workspace.create": RpcMethod<{ path: string }, DshWorkspaceCreateResult>;
    "workspace.rename": RpcMethod<
        { workspaceId: string; title: string },
        { workspace: DshWorkspaceView }
    >;
    "workspace.delete": RpcMethod<{ workspaceId: string }, { deleted: true }>;
    "workspace.insertBefore": RpcMethod<
        { workspaceId: string; beforeWorkspaceId?: string },
        { workspaceIds: string[] }
    >;
    "workspace.insertSessionBefore": RpcMethod<
        { workspaceId: string; sessionId: string; beforeSessionId?: string },
        { workspace: DshWorkspaceView }
    >;
    "workspace.archiveSession": RpcMethod<
        { sessionId: string },
        { archivedSessionIds: string[] }
    >;
    "goal.create": RpcMethod<
        { sessionId: string; objective: string; maxGoalRounds?: number },
        DshGoalRefResult
    >;
    "goal.edit": RpcMethod<
        { sessionId: string; ref: DshGoalRef } & HarnessGoalEditChanges,
        DshGoalRefResult
    >;
    "goal.pause": RpcMethod<
        { sessionId: string; ref: DshGoalRef },
        DshGoalRefResult
    >;
    "goal.resume": RpcMethod<
        { sessionId: string; ref: DshGoalRef },
        DshGoalRefResult
    >;
    "goal.complete": RpcMethod<
        { sessionId: string; ref: DshGoalRef },
        DshGoalRefResult
    >;
    "goal.clear": RpcMethod<
        { sessionId: string; ref: DshGoalRef },
        { cleared: true }
    >;
    "skill.list": RpcMethod<{ sessionId: string }, DshSkillListResult>;
    // Typert Remote endpoints. These share the /api channel and wire envelope
    // with the unary apiproxy methods above, but the Gateway claims them ahead
    // of the apiproxy dispatch table, so their path segment is
    // "<namespace>/<method>" and the payload is the single `args` object
    // holding one field per declared wire parameter. `agentId` is the
    // session's id: the Remote resolves the receiving Agent from it.
    "commands/list": RpcMethod<
        { args: { agentId: string } },
        readonly DshCommandDescriptor[]
    >;
    "commands/execute": RpcMethod<
        { args: { agentId: string; line: string; images: readonly DshImageUpload[] } },
        DshCommandExecution | undefined
    >;
    "messageFeedback/list": RpcMethod<
        { args: { request: DshMessageFeedbackListRequest } },
        DshMessageFeedbackListResult
    >;
    "messageFeedback/put": RpcMethod<
        { args: { request: DshMessageFeedbackPutRequest } },
        DshMessageFeedbackPutResult
    >;
    "messageFeedback/delete": RpcMethod<
        { args: { request: DshMessageFeedbackDeleteRequest } },
        DshMessageFeedbackDeleteResult
    >;
    "llm.providers": RpcMethod<EmptyPayload, DshProviderListResult>;
    "llm.models": RpcMethod<EmptyPayload, DshLlmModelsResult>;
    "llm.discoverModels": RpcMethod<{
        settingsNs: string;
        provider?: string;
        baseURL?: string;
        api?: string;
        apiKey?: string;
    }, DshLlmDiscoverModelsResult>;
    "settings.describe": RpcMethod<EmptyPayload, DshSettingsDescribeResult>;
    "settings.openDocument": RpcMethod<EmptyPayload, { opened: true }>;
    "settings.update": RpcMethod<{
        ns: string;
        patch: Record<string, unknown>;
        expectedRevision?: number;
    }, DshSettingsNamespaceView>;
    "settings.mutate": RpcMethod<{
        ns: string;
        ops: DshSettingsPathOperation[];
        expectedRevision?: number;
    }, DshSettingsNamespaceView>;
    "credentials.describe": RpcMethod<{ refs: string[] }, DshCredentialDescribeResult>;
    "credentials.set": RpcMethod<{ ref: string; value: string }, Record<string, never>>;
    "credentials.unset": RpcMethod<{ ref: string }, Record<string, never>>;
}

/**
 * Methods whose success envelope may legitimately carry no `value` field.
 * A Typert Remote returning `undefined` rides the wire as an absent value —
 * JSON has no `undefined` — so absence is a business answer here, not the
 * malformed response it would be for a unary apiproxy method.
 */
export const ABSENT_VALUE_METHODS: ReadonlySet<HarnessRpcMethod> = new Set([
    "commands/execute",
]);

/** Marker used only to derive request and response types from the map. */
export interface RpcMethod<P, V> {
    readonly payload: P;
    readonly value: V;
}

export type HarnessRpcMethod = keyof HarnessRpcMethodMap;

export type HarnessRpcPayload<K extends HarnessRpcMethod> =
    HarnessRpcMethodMap[K]["payload"];

export type HarnessRpcValue<K extends HarnessRpcMethod> = HarnessRpcMethodMap[K]["value"];

export type EmptyPayload = Record<string, never>;

export interface HarnessHostDescription {
    version: string;
    cwd: string;
    provider?: string;
    model?: string;
    attachedSessions: number;
    canOpenPath: boolean;
}

export type HarnessPromptContentPart =
    | { type: "text"; text: string }
    | {
          type: "image";
          mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
          data: string;
          name?: string;
      };

/** Merge-extensible durable ContentBlock boundary used by subagent.prompt. */
export interface HarnessDurableContentBlock {
    type: string;
    [key: string]: unknown;
}

/** Official goal.edit constraint: at least one replacement must be present. */
export type HarnessGoalEditChanges =
    | { objective: string; maxGoalRounds?: number }
    | { objective?: never; maxGoalRounds: number };

export type HarnessQueueAction =
    | { kind: "edit"; content: Array<Record<string, unknown>> }
    | { kind: "remove" }
    | { kind: "steer" };

export interface HarnessClientRequest<K extends HarnessRpcMethod = HarnessRpcMethod> {
    type: "client-request";
    rpcId: string;
    method: K;
    payload: HarnessRpcPayload<K>;
}

export interface HarnessServerResponse<T = unknown> {
    type: "server-response";
    rpcId: string;
    result:
        | { ok: true; value: T }
        | { ok: false; error: DshRpcError };
}

export interface HarnessServerRequest<T = unknown> {
    type: "server-request";
    rpcId: string;
    method: string;
    payload: T;
}

export interface HarnessClientResponse<T = unknown> {
    type: "client-response";
    rpcId: string;
    result:
        | { ok: true; value: T }
        | { ok: false; error: DshRpcError };
}
