/**
  * Internal Agent Team wire vocabulary for Harness v0.1.5-rc.2.
  * Mirrors packages/experimental/agent-team/src/{client,types}.ts.
  * Deliberately independent of the opt-in experimental package and webview protocol.
  */

export interface DshTeamMemberView {
    readonly id: string;
    readonly name: string;
    readonly role: "lead" | "teammate";
    readonly status: "running" | "idle" | "inactive" | "provisioning" | "failed";
    readonly description?: string;
    readonly provider?: string;
    readonly context?: "fresh" | "fork";
    readonly model?: string;
    readonly diagnostics: string[];
}

export type DshTeamTaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface DshTeamTaskView {
    readonly id: string;
    readonly revision: number;
    readonly subject: string;
    readonly description: string;
    readonly status: DshTeamTaskStatus;
    readonly blockedBy: string[];
    readonly writeScopes: string[];
    readonly ownerName?: string;
    readonly ready: boolean;
    readonly writeScopeWarnings: string[];
}

export interface DshTeamView {
    readonly members: DshTeamMemberView[];
    readonly tasks: DshTeamTaskView[];
}

export interface DshCreateTeamTaskRequest {
    readonly subject: string;
    readonly description: string;
    readonly blockedBy?: readonly string[];
    readonly writeScopes?: readonly string[];
}

export type DshTeamTaskAction =
    | "claim"
    | "release"
    | "edit"
    | "set_dependencies"
    | "complete"
    | "reopen"
    | "reassign"
    | "delete";

export interface DshUpdateTeamTaskRequest {
    readonly taskId: string;
    readonly expectedRevision: number;
    readonly action: DshTeamTaskAction;
    readonly subject?: string;
    readonly description?: string;
    readonly blockedBy?: readonly string[];
    readonly writeScopes?: readonly string[];
    readonly owner?: string;
}

export type DshTeamTaskMutationResult =
    | { readonly ok: true; readonly value: DshTeamTaskView }
    | {
        readonly ok: false;
        readonly error: {
            readonly code: "team-task-conflict" | "team-rejected";
            readonly message: string;
        }
    };
