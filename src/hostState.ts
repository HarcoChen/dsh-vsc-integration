import { HarnessHostDescription } from "./harnessProtocol";
import { HostBaselineView } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate the exact host.describe value currently exported by Harness. */
export function parseHostDescription(value: unknown): HarnessHostDescription | undefined {
    if (
        !isRecord(value) ||
        typeof value.version !== "string" ||
        !value.version.trim() ||
        typeof value.cwd !== "string" ||
        !value.cwd ||
        (value.provider !== undefined && typeof value.provider !== "string") ||
        (value.model !== undefined && typeof value.model !== "string") ||
        typeof value.attachedSessions !== "number" ||
        !Number.isSafeInteger(value.attachedSessions) ||
        value.attachedSessions < 0 ||
        typeof value.canOpenPath !== "boolean"
    ) {
        return undefined;
    }

    return {
        version: value.version,
        cwd: value.cwd,
        ...(value.provider === undefined ? {} : { provider: value.provider }),
        ...(value.model === undefined ? {} : { model: value.model }),
        attachedSessions: value.attachedSessions,
        canOpenPath: value.canOpenPath,
    };
}

export function presentHostBaseline(
    description: HarnessHostDescription | undefined,
): HostBaselineView | undefined {
    const parsed = parseHostDescription(description);
    if (!parsed) return undefined;
    return {
        version: parsed.version,
        cwd: parsed.cwd,
        ...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
        ...(parsed.model === undefined ? {} : { model: parsed.model }),
        attachedSessions: parsed.attachedSessions,
        canOpenPath: parsed.canOpenPath,
    };
}
