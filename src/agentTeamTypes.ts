/**
 * Durable RC.2 Agent Team projection vocabulary, independent of the optional Host package.
 */
import { isRecord } from "./guards";
import type { DshPluginInventorySnapshot } from "./types";

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

export interface DshTeamProjection {
    readonly members: Array<{
        id: string;
        name: string;
        role: "lead" | "teammate";
        phase: "provisioning" | "active" | "failed";
        error?: string;
    }>;
    readonly tasks: DshTeamTaskView[];
    readonly failure?: string;
}

/** Capability state for the opt-in Agent Teams profile bundle. */
export interface DshAgentTeamsCapability {
    /** True when the Host Team service is active; it publishes a projection, not agentTeams RPCs. */
    readonly available: boolean;
    /** Why the current Runtime cannot be used for Agent Teams. */
    readonly status: "active" | "inactive" | "absent" | "unsupported";
}

/**
 * Detect Agent Teams from the Runtime's composition inventory.
 *
 * The active Host row identifies the optional service. Team data is read from
 * the Lead Session's `agentTeam` projection; no `agentTeams/*` Remote is published in RC.2.
 *
 * @param inventory - Host plugin inventory returned by the public Remote.
 * @returns Capability state for the current composition.
 */
export function detectAgentTeamsCapability(
    inventory: DshPluginInventorySnapshot,
): DshAgentTeamsCapability {
    const rows = inventory.entries.filter(row => row.moduleName === "@deepseek-ai/dsh-experimental-agent-team");
    if (!rows.length) return { available: false, status: "absent" };
    const available = rows.some(row => row.enabled && row.fiberPhase === "active");
    return { available, status: available ? "active" : "inactive" };
}

function strings(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === "string");
}

/** Validate the durable Team value read from the public Session projection. */
export function normalizeAgentTeamProjection(value: unknown): DshTeamProjection | undefined {
    if (!isRecord(value) || !Array.isArray(value.members) || !Array.isArray(value.tasks) ||
        (value.failure !== undefined && typeof value.failure !== "string")) return undefined;
    const members: DshTeamProjection["members"] = [];
    for (const member of value.members) {
        if (!isRecord(member) || typeof member.id !== "string" || typeof member.name !== "string" ||
            (member.role !== "lead" && member.role !== "teammate") ||
            (member.phase !== "provisioning" && member.phase !== "active" && member.phase !== "failed") ||
            (member.error !== undefined && typeof member.error !== "string")) return undefined;
        members.push({ id: member.id, name: member.name, role: member.role, phase: member.phase,
            ...(member.error === undefined ? {} : { error: member.error }) });
    }
    const tasks: DshTeamTaskView[] = [];
    for (const task of value.tasks) {
        if (!isRecord(task) || typeof task.id !== "string" || typeof task.subject !== "string" ||
            typeof task.description !== "string" || typeof task.revision !== "number" ||
            !Number.isSafeInteger(task.revision) || task.revision < 1 ||
            (task.status !== "pending" && task.status !== "in_progress" && task.status !== "completed" && task.status !== "deleted") ||
            !strings(task.blockedBy) || !strings(task.writeScopes) || !strings(task.writeScopeWarnings) ||
            typeof task.ready !== "boolean" || (task.ownerName !== undefined && typeof task.ownerName !== "string")) return undefined;
        tasks.push({ id: task.id, revision: task.revision, subject: task.subject, description: task.description,
            status: task.status, blockedBy: [...task.blockedBy], writeScopes: [...task.writeScopes], ready: task.ready,
            writeScopeWarnings: [...task.writeScopeWarnings], ...(task.ownerName === undefined ? {} : { ownerName: task.ownerName }) });
    }
    return { members, tasks, ...(value.failure === undefined ? {} : { failure: value.failure }) };
}
