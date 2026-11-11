import type { RemoteUnaryClient } from "./remote/unaryClient";
import { RemoteProtocolError } from "./remote/errors";
import { projectionBlock as remoteProjectionBlock } from "./remote/sessionState";
import type { HarnessSessionStore } from "./sessionStore";
import type { DshSubagentCatalog } from "./types";
import { isRecord } from "./guards";

/** Read direct children from durable projections without activating their Agents. */
export async function readSubagentCatalog(
    parentSessionId: string,
    unary: Pick<RemoteUnaryClient, "call">,
    store: HarnessSessionStore,
    signal?: AbortSignal
): Promise<DshSubagentCatalog> {
    const read = async (sessionId: string): Promise<Record<string, unknown>> => {
        const block = remoteProjectionBlock(
            await unary.call("session/projections", { request: { sessionId } }, signal)
        );
        if (!block) throw new RemoteProtocolError("Invalid subagent projections");
        signal?.throwIfAborted();
        store.applyRemoteProjections(sessionId, {
            asOfSeq: block.asOfSeq,
            values: Object.fromEntries(
                Object.entries(block.values).filter(([key]) =>
                    ["subagentCatalog", "subagentIdentity", "subagentTiming"].includes(key)
                )
            ),
        });
        return block.values;
    };
    const parent = await read(parentSessionId);
    const entries: DshSubagentCatalog["entries"] = [];
    if (parent.subagentCatalog !== undefined && !Array.isArray(parent.subagentCatalog))
        throw new RemoteProtocolError("Invalid subagent catalog");
    for (const raw of Array.isArray(parent.subagentCatalog) ? parent.subagentCatalog : []) {
        if (!isRecord(raw) || typeof raw.id !== "string")
            throw new RemoteProtocolError("Invalid subagent catalog entry");
        const metadata = {
            ...(typeof raw.label === "string" ? { label: raw.label } : {}),
            ...(typeof raw.name === "string" ? { name: raw.name } : {}),
        };
        if (raw.mode === "external") {
            entries.push({
                kind: "child",
                id: raw.id,
                mode: "external",
                activity: "inactive",
                hasChildren: false,
                ...metadata,
            });
            continue;
        }
        try {
            const child = await read(raw.id);
            const identity = isRecord(child.subagentIdentity) ? child.subagentIdentity : undefined;
            const mode = identity?.mode ?? raw.mode;
            const label = typeof identity?.label === "string" ? identity.label : metadata.label;
            if ((mode !== "one-shot" && mode !== "continuable") || (mode === "continuable" && label === undefined)) {
                entries.push({ kind: "diagnostic", id: raw.id, reason: "unsupported" });
                continue;
            }
            const running = isRecord(child.subagentTiming) && isRecord(child.subagentTiming.active);
            const common = {
                kind: "child" as const,
                id: raw.id,
                activity: running ? ("running" as const) : ("inactive" as const),
                hasChildren: Array.isArray(child.subagentCatalog) && child.subagentCatalog.length > 0,
                ...metadata,
            };
            entries.push(
                mode === "continuable"
                    ? { ...common, mode, label: label! }
                    : { ...common, mode, ...(label ? { label } : {}) }
            );
        } catch (error) {
            if (signal?.aborted) throw error;
            entries.push({ kind: "diagnostic", id: raw.id, reason: "unavailable" });
        }
    }
    return { parentAvailable: true, entries };
}
