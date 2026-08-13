import {
    DshHistoryResult,
    DshRpcError,
    DshSessionCreateResult,
    DshSessionListResult,
    DshSessionPromptResult,
    DshSkillListResult,
} from "./types";

/** Public DeepSeek Harness RPCs currently consumed by the extension foundation. */
export interface HarnessRpcMethodMap {
    "host.describe": RpcMethod<EmptyPayload, HarnessHostDescription>;
    "session.list": RpcMethod<{ cursor?: string }, DshSessionListResult>;
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
