import type { DshGoalPhase } from "./types";

/** Goal mutations shared by host validation and UI adapters. */
export type GoalAction = "create" | "pause" | "resume" | "complete" | "edit" | "clear";

/**
 * The phase/action matrix is intentionally shared by the UI and host gate.
 * `create` is only meaningful for an empty projection or a completed Goal.
 */
export const GOAL_ACTIONS_BY_PHASE: Readonly<Record<DshGoalPhase, readonly GoalAction[]>> = {
    active: ["pause", "complete", "edit", "clear"],
    paused: ["resume", "complete", "edit", "clear"],
    blocked: ["resume", "complete", "edit", "clear"],
    complete: ["create", "clear"],
};

export function goalActionAllowed(
    phase: DshGoalPhase,
    action: GoalAction,
    roundsStarted?: number,
    maxGoalRounds?: number,
): boolean {
    if (!GOAL_ACTIONS_BY_PHASE[phase].includes(action)) return false;
    if (action !== "resume") return true;
    return (
        typeof roundsStarted === "number" &&
        typeof maxGoalRounds === "number" &&
        roundsStarted < maxGoalRounds
    );
}
