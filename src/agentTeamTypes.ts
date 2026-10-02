/**
  * Internal Agent Team wire vocabulary for Harness v0.2.0-rc.2.
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

/** Capability state for the opt-in Agent Teams profile bundle. */
export interface DshAgentTeamsCapability {
    /** True only when the Host-side Agent Teams service row is active. */
    readonly available: boolean;
    /** Why the current Runtime cannot be used for Agent Teams. */
    readonly status: "active" | "inactive" | "absent" | "unsupported";
}

/**
 * Detect Agent Teams from the Runtime's composition inventory.
 *
 * Agent Teams is an experimental profile bundle. Its `agentTeams/*` methods
 * are not part of the standard `api/remotes` assembly, so probing an endpoint
 * directly produces an unhelpful 404. The profile row is the authoritative
 * capability signal exposed by `pluginInventory/list`.
 *
 * @param inventory - Host plugin inventory returned by the public Remote.
 * @returns Capability state for the current composition.
 */
export function detectAgentTeamsCapability(
    inventory: {
        readonly entries: readonly { readonly moduleName: string; readonly enabled: boolean; readonly fiberPhase: string | null }[];
        readonly agentPresets?: readonly { readonly rows: readonly {
            readonly entryId: string | null;
            readonly moduleName: string;
            readonly enabled: boolean | "conditional";
            readonly fiberPhase: string | null;
        }[] }[];
    },
): DshAgentTeamsCapability {
    const rows = [
        ...inventory.entries.map((entry) => ({
            entryId: undefined,
            moduleName: entry.moduleName,
            enabled: entry.enabled,
            fiberPhase: entry.fiberPhase,
        })),
        ...(inventory.agentPresets ?? []).flatMap((preset) => preset.rows),
    ];
    const teamRow = rows.find((row) =>
        row.entryId === "agent-team" || row.moduleName === "@deepseek-ai/dsh-experimental-agent-team",
    );
    if (!teamRow) return { available: false, status: "absent" };
    if (teamRow.enabled !== true || teamRow.fiberPhase !== "active") {
        return { available: false, status: "inactive" };
    }
    return { available: true, status: "active" };
}
