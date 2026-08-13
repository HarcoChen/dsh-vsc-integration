import {
    DshHistoryResult,
    DshGoalRef,
    DshGoalRefResult,
    DshRpcError,
    DshSessionCreateResult,
    DshSessionForkResult,
    DshSessionListResult,
    DshSessionPromptResult,
    DshSessionRenameResult,
    DshSessionSearchResult,
    DshSkillListResult,
    DshSubagentAddress,
    DshSubagentCatalog,
    DshSubagentHistoryResult,
    DshSubagentPromptResult,
    DshWorkspaceListResult,
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
    "credentials.set": RpcMethod<{ ref: string; value: string }, Record<string, never>>;
}

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
