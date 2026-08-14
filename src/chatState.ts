import { ChatMessage, ChatToolCall, DshQueuedInboxItem, TurnStatusView } from "./types";
import { SessionStateSnapshot, StoredSessionEvent } from "./sessionStore";
import { safeTraceJson } from "./traceProjector";

export interface OptimisticPrompt {
    id: string;
    sessionId: string;
    displayText: string;
    wireText: string;
    afterSeq: number;
    createdAt: number;
    error?: string;
}

export interface QueueDockItem {
    id: string;
    placement: "queued" | "steering";
    preview: string;
    editableText?: string;
}

const NO_VISIBLE_ASSISTANT_ANSWER = "（无可见回答）";
const TOOL_SUMMARY_LIMIT = 1_200;

export function resolvePromptMode(
    requested: "queue" | "steer",
    sessionRunning: boolean,
): "queue" | "steer" {
    return requested === "steer" && sessionRunning ? "steer" : "queue";
}

/** Focus mode is a presentation-only projection; the underlying event store stays intact. */
export function focusChatMessages(
    messages: readonly ChatMessage[],
    enabled: boolean,
): ChatMessage[] {
    if (!enabled) return messages.map((message) => ({ ...message }));
    return messages.flatMap((message) => {
        if (message.role === "tool") return [];
        if (message.role !== "assistant") return [{ ...message }];
        const {
            reasoning: _reasoning,
            reasoningState: _reasoningState,
            renderedReasoningHtml: _renderedReasoningHtml,
            reasoningRenderId: _reasoningRenderId,
            ...focused
        } = message;
        return [focused];
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ContentChannels {
    text: string;
    reasoning: string;
}

/** Preserve per-channel ContentBlock order without leaking reasoning into visible text. */
export function contentChannels(value: unknown): ContentChannels {
    if (typeof value === "string") {
        return { text: value, reasoning: "" };
    }
    if (!Array.isArray(value)) {
        const object = isRecord(value) ? value : undefined;
        const content = typeof object?.text === "string" ? object.text : "";
        return object?.type === "reasoning"
            ? { text: "", reasoning: content }
            : { text: content, reasoning: "" };
    }
    const channels: ContentChannels = { text: "", reasoning: "" };
    for (const part of value) {
        if (!isRecord(part) || typeof part.text !== "string") continue;
        if (part.type === "text") channels.text += part.text;
        else if (part.type === "reasoning") channels.reasoning += part.text;
    }
    return channels;
}

export function contentText(value: unknown): string {
    return contentChannels(value).text;
}

export function promptDisplayText(wireText: string): string {
    const marker = "\n\n<ide_context>\n";
    const index = wireText.indexOf(marker);
    return index < 0 ? wireText : wireText.slice(0, index);
}

function messageRecord(event: StoredSessionEvent): Record<string, unknown> | undefined {
    const data = isRecord(event.event.data) ? event.event.data : undefined;
    if (!data) return undefined;
    if (event.event.type === "assistant/message") {
        return isRecord(data.message) ? data.message : undefined;
    }
    return data;
}

function directUser(event: StoredSessionEvent): boolean {
    if (event.event.type !== "user/message") return false;
    const message = messageRecord(event);
    return isRecord(message?.source) && message.source.kind === "user";
}

function eventText(event: StoredSessionEvent): string {
    const message = messageRecord(event);
    return contentText(message?.content ?? message?.text);
}

function oneLine(value: string, limit = TOOL_SUMMARY_LIMIT): string {
    const normalized = value.replace(/\s+/gu, " ").trim();
    return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function toolView(event: StoredSessionEvent | undefined, target: "call" | "result"):
    Record<string, unknown> | undefined {
    if (!event || !isRecord(event.view) || event.view.for !== target || !isRecord(event.view.view)) {
        return undefined;
    }
    return event.view.view;
}

function contentSummary(value: unknown): string {
    if (typeof value === "string") return oneLine(value);
    if (!Array.isArray(value)) return "";
    return oneLine(value.flatMap((part) => {
        if (!isRecord(part)) return [];
        if (typeof part.text === "string") return [part.text];
        if (part.type === "image") return ["[image]"];
        return [];
    }).join("\n"));
}

function presentationSummary(view: Record<string, unknown> | undefined): string | undefined {
    if (!view) return undefined;
    const parts: string[] = [];
    for (const key of ["description", "cwd", "path", "url", "answer", "output"] as const) {
        if (typeof view[key] === "string") parts.push(view[key]);
    }
    const content = contentSummary(view.content);
    if (content) parts.push(content);
    if (view.rawInput !== undefined) parts.push(oneLine(safeTraceJson(view.rawInput, 3_600)));
    if (typeof view.exitCode === "number") parts.push(`exit ${view.exitCode}`);
    if (typeof view.signal === "string") parts.push(view.signal);
    return parts.length ? oneLine(parts.join(" · ")) : undefined;
}

function toolArgumentsSummary(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string") return oneLine(safeTraceJson(value, 3_600));
    try {
        return oneLine(safeTraceJson(JSON.parse(value), 3_600));
    } catch {
        return oneLine(value);
    }
}

function toolResultFacts(event: StoredSessionEvent): {
    callId?: string;
    result?: string;
    error?: string;
} {
    const data = isRecord(event.event.data) ? event.event.data : undefined;
    const message = isRecord(data?.message) ? data.message : undefined;
    const source = isRecord(message?.source) ? message.source : undefined;
    const block = Array.isArray(message?.content) && isRecord(message.content[0])
        ? message.content[0]
        : undefined;
    const callId = typeof source?.callId === "string"
        ? source.callId
        : typeof block?.toolCallId === "string"
          ? block.toolCallId
          : typeof data?.callId === "string"
            ? data.callId
            : undefined;
    const result = presentationSummary(toolView(event, "result")) ||
        contentSummary(block?.content ?? data?.content) || undefined;
    const structuredError = isRecord(data?.error)
        ? [data.error.code, data.error.message].filter((part) => typeof part === "string").join(" · ")
        : typeof data?.error === "string" ? data.error : undefined;
    const failed = block?.isError === true || data?.isError === true || Boolean(structuredError);
    return {
        ...(callId ? { callId } : {}),
        ...(result ? { result } : {}),
        ...(failed ? { error: oneLine(structuredError || result || "Tool failed") } : {}),
    };
}

function projectToolRows(snapshot: SessionStateSnapshot): Array<ChatMessage & { order: number }> {
    const calls = new Map<string, StoredSessionEvent>();
    const results = new Map<string, StoredSessionEvent>();
    for (const event of snapshot.events) {
        const data = isRecord(event.event.data) ? event.event.data : undefined;
        if (event.event.type === "tool/call" && typeof data?.callId === "string") {
            calls.set(data.callId, event);
        } else if (event.event.type === "tool/result") {
            const callId = toolResultFacts(event).callId;
            if (callId && !results.has(callId)) results.set(callId, event);
        }
    }
    return [...new Set([...calls.keys(), ...results.keys()])].flatMap((callId) => {
        const call = calls.get(callId);
        const result = results.get(callId);
        const anchor = call ?? result;
        if (!anchor) return [];
        const data = call && isRecord(call.event.data) ? call.event.data : undefined;
        const facts = result ? toolResultFacts(result) : undefined;
        const callPresentation = toolView(call, "call");
        const name = typeof data?.name === "string" ? data.name : "unknown tool";
        const title = typeof callPresentation?.title === "string" ? callPresentation.title : name;
        const args = presentationSummary(callPresentation) ||
            toolArgumentsSummary(data?.arguments);
        const durationMs = call && result && result.event.time >= call.event.time
            ? result.event.time - call.event.time
            : undefined;
        const tool: ChatToolCall = {
            callId,
            name,
            title,
            status: !result ? "running" : facts?.error ? "failed" : "completed",
            ...(args ? { args } : {}),
            ...(facts?.result ? { result: facts.result } : {}),
            ...(durationMs === undefined ? {} : { durationMs }),
            ...(facts?.error ? { error: facts.error } : {}),
        };
        return [{
            id: `tool:${callId}`,
            role: "tool" as const,
            text: title,
            tool,
            createdAt: anchor.event.time,
            seq: anchor.event.seq,
            state: result ? "committed" as const : "streaming" as const,
            order: anchor.event.seq + 0.25,
        }];
    });
}

function assistantLocation(event: StoredSessionEvent): string | undefined {
    if (event.event.type !== "assistant/message" || !isRecord(event.event.data)) return undefined;
    const turn = event.event.data.turn;
    const step = event.event.data.step;
    return typeof turn === "number" && typeof step === "number" ? `${turn}:${step}` : undefined;
}

interface PartialBlock {
    kind: "text" | "reasoning" | "other";
    text: string;
}

interface PartialMessage {
    key: string;
    turn: number;
    step: number;
    firstSeq: number;
    lastTime: number;
    blocks: Map<number, PartialBlock>;
}

function foldPartialChunk(partial: PartialMessage, chunk: Record<string, unknown>): void {
    const index = typeof chunk.index === "number" ? chunk.index : -1;
    if (index < 0) return;
    const previous = partial.blocks.get(index);
    switch (chunk.type) {
        case "block-start": {
            const kind = chunk.blockType === "text" || chunk.blockType === "reasoning"
                ? chunk.blockType
                : "other";
            partial.blocks.set(index, { kind, text: "" });
            return;
        }
        case "text-delta":
            partial.blocks.set(index, {
                kind: "text",
                text: (previous?.kind === "text" ? previous.text : "") +
                    (typeof chunk.text === "string" ? chunk.text : ""),
            });
            return;
        case "reasoning-delta":
            partial.blocks.set(index, {
                kind: "reasoning",
                text: (previous?.kind === "reasoning" ? previous.text : "") +
                    (typeof chunk.text === "string" ? chunk.text : ""),
            });
            return;
        case "block-end": {
            const block = isRecord(chunk.block) ? chunk.block : undefined;
            const kind = block?.type === "text" || block?.type === "reasoning"
                ? block.type
                : "other";
            partial.blocks.set(index, {
                kind,
                text: typeof block?.text === "string" ? block.text : "",
            });
            return;
        }
        default:
            return;
    }
}

/**
 * Derive the visible chat from the current surface plus raw in-flight chunks. Finalized
 * assistant messages consume their source chunk seqs, so the partial disappears atomically
 * instead of rendering a duplicate assistant reply.
 */
export function projectChatMessages(
    snapshot: SessionStateSnapshot | undefined,
    optimistic: readonly OptimisticPrompt[],
): ChatMessage[] {
    if (!snapshot) {
        return optimistic.map((item) => ({
            id: item.id,
            role: item.error ? "system" : "user",
            text: item.error ? `发送失败：${item.error}` : item.displayText,
            createdAt: item.createdAt,
            state: item.error ? "failed" : "pending",
        }));
    }

    const optimisticForSession = optimistic
        .filter((item) => item.sessionId === snapshot.sessionId)
        .sort((left, right) => left.createdAt - right.createdAt);
    const matchBySeq = new Map<number, OptimisticPrompt>();
    const matched = new Set<string>();
    for (const item of optimisticForSession) {
        const candidate = snapshot.events.find(
            (stored) =>
                !matched.has(`event:${stored.event.seq}`) &&
                stored.event.seq > item.afterSeq &&
                directUser(stored) &&
                eventText(stored) === item.wireText,
        );
        if (candidate) {
            matchBySeq.set(candidate.event.seq, item);
            matched.add(item.id);
            matched.add(`event:${candidate.event.seq}`);
        }
    }

    const rows: Array<ChatMessage & { order: number }> = [];
    const finalizedChunkSeqs = new Set<number>();
    const finalizedLocations = new Set<string>();
    for (const stored of snapshot.events) {
        if (stored.event.type !== "assistant/message") continue;
        for (const seq of stored.event.sourceEventSeqs ?? []) finalizedChunkSeqs.add(seq);
        const location = assistantLocation(stored);
        if (location) finalizedLocations.add(location);
    }
    for (const node of snapshot.surface.nodes) {
        if (directUser(node)) {
            const optimisticMatch = matchBySeq.get(node.event.seq);
            rows.push({
                id: `event:${node.event.seq}`,
                role: "user",
                text: optimisticMatch?.displayText ?? promptDisplayText(eventText(node)),
                createdAt: node.event.time,
                seq: node.event.seq,
                state: "committed",
                order: node.event.seq,
            });
        } else if (node.event.type === "assistant/message") {
            const message = messageRecord(node);
            const content = contentChannels(message?.content ?? message?.text);
            if (content.text || content.reasoning) {
                rows.push({
                    id: `event:${node.event.seq}`,
                    role: "assistant",
                    text: content.text || NO_VISIBLE_ASSISTANT_ANSWER,
                    ...(content.reasoning
                        ? { reasoning: content.reasoning, reasoningState: "complete" as const }
                        : {}),
                    createdAt: node.event.time,
                    seq: node.event.seq,
                    state: "committed",
                    order: node.event.seq,
                });
            }
        }
    }
    rows.push(...projectToolRows(snapshot));

    const partials = new Map<string, PartialMessage>();
    const endedTurns = new Set<number>();
    for (const stored of snapshot.events) {
        if (stored.event.type !== "turn/end" || !isRecord(stored.event.data)) continue;
        if (typeof stored.event.data.turn === "number") endedTurns.add(stored.event.data.turn);
    }
    for (const stored of snapshot.events) {
        const event = stored.event;
        if (event.type !== "assistant/chunk" || finalizedChunkSeqs.has(event.seq) || !isRecord(event.data)) {
            continue;
        }
        const turn = event.data.turn;
        const step = event.data.step;
        const chunk = isRecord(event.data.chunk) ? event.data.chunk : undefined;
        if (typeof turn !== "number" || typeof step !== "number" || !chunk) continue;
        const key = `${turn}:${step}`;
        if (finalizedLocations.has(key)) continue;
        let partial = partials.get(key);
        if (!partial) {
            partial = {
                key,
                turn,
                step,
                firstSeq: event.seq,
                lastTime: event.time,
                blocks: new Map(),
            };
            partials.set(key, partial);
        }
        partial.lastTime = event.time;
        foldPartialChunk(partial, chunk);
    }
    for (const partial of partials.values()) {
        const blocks = [...partial.blocks.entries()].sort(([left], [right]) => left - right);
        const text = blocks
            .filter(([, block]) => block.kind === "text")
            .map(([, block]) => block.text)
            .join("");
        const reasoning = blocks
            .filter(([, block]) => block.kind === "reasoning")
            .map(([, block]) => block.text)
            .join("");
        if (!text && !reasoning) continue;
        const complete = endedTurns.has(partial.turn);
        rows.push({
            id: `partial:${partial.key}`,
            role: "assistant",
            text: text || NO_VISIBLE_ASSISTANT_ANSWER,
            ...(reasoning
                ? {
                      reasoning,
                      reasoningState: complete ? "complete" as const : "streaming" as const,
                  }
                : {}),
            createdAt: partial.lastTime,
            state: complete ? "committed" : "streaming",
            order: partial.firstSeq + 0.5,
        });
    }

    for (const stored of snapshot.events) {
        const event = stored.event;
        if (event.type !== "turn/end" || !isRecord(event.data) || !isRecord(event.data.reason)) {
            continue;
        }
        const reason = event.data.reason;
        if (reason.kind !== "error" && reason.kind !== "blocked") continue;
        const failure = isRecord(reason.error) ? reason.error : reason;
        const message = typeof failure.message === "string"
            ? failure.message
            : "dsh agent 在生成回复前结束了本轮任务。";
        const code = typeof failure.code === "string" ? failure.code : undefined;
        rows.push({
            id: `turn-error:${event.seq}`,
            role: "system",
            text: code ? `[${code}] ${message}` : message,
            createdAt: event.time,
            seq: event.seq,
            state: "committed",
            order: event.seq + 0.75,
        });
    }

    rows.sort((left, right) => left.order - right.order);
    const projected = rows.map(({ order: _order, ...message }) => message);
    for (const item of optimisticForSession) {
        if (matched.has(item.id)) continue;
        projected.push({
            id: item.id,
            role: item.error ? "system" : "user",
            text: item.error ? `发送失败：${item.error}` : item.displayText,
            createdAt: item.createdAt,
            state: item.error ? "failed" : "pending",
        });
    }
    return projected;
}

/** Project the current turn lifecycle from durable events plus authoritative transient state. */
export function projectTurnStatus(
    snapshot: SessionStateSnapshot | undefined,
    hostRunning: boolean,
    hostError?: string,
): TurnStatusView {
    const pendingInteraction = snapshot?.interactions.some(
        (interaction) => interaction.status === "pending" || interaction.status === "submitting",
    ) === true;
    const turns = new Map<number, { started: boolean; end?: StoredSessionEvent }>();
    for (const stored of snapshot?.events ?? []) {
        if ((stored.event.type !== "turn/start" && stored.event.type !== "turn/end") ||
            !isRecord(stored.event.data) ||
            typeof stored.event.data.turn !== "number" ||
            !Number.isSafeInteger(stored.event.data.turn) ||
            stored.event.data.turn < 1) continue;
        const turn = stored.event.data.turn;
        const current = turns.get(turn) ?? { started: false };
        if (stored.event.type === "turn/start") current.started = true;
        else current.end = stored;
        turns.set(turn, current);
    }
    const latestTurn = [...turns.keys()].sort((left, right) => right - left)[0];
    const latest = latestTurn === undefined ? undefined : turns.get(latestTurn);
    if (pendingInteraction) {
        return { phase: "waiting", ...(latestTurn === undefined ? {} : { turn: latestTurn }) };
    }
    if (hostRunning || (latest?.started === true && latest.end === undefined)) {
        return { phase: "running", ...(latestTurn === undefined ? {} : { turn: latestTurn }) };
    }
    if (hostError) {
        return {
            phase: "failed",
            ...(latestTurn === undefined ? {} : { turn: latestTurn }),
            detail: hostError,
        };
    }
    if ((snapshot?.queue.items.length ?? 0) > 0) {
        return { phase: "queued", ...(latestTurn === undefined ? {} : { turn: latestTurn }) };
    }
    const endData = latest?.end && isRecord(latest.end.event.data) ? latest.end.event.data : undefined;
    const reason = isRecord(endData?.reason) ? endData.reason : undefined;
    const kind = typeof reason?.kind === "string" ? reason.kind : undefined;
    if (kind === "completed") return { phase: "completed", turn: latestTurn };
    if (kind === "aborted" || kind === "interrupted") {
        return { phase: "cancelled", turn: latestTurn };
    }
    if (kind) {
        const failure = isRecord(reason?.error) ? reason.error : undefined;
        const detail = typeof failure?.message === "string"
            ? failure.message
            : kind === "max-tokens" ? "达到最大输出 token" : kind;
        return { phase: "failed", turn: latestTurn, detail };
    }
    return { phase: "completed" };
}

export function hiddenViewBadge(
    sessions: readonly { sessionId: string; pendingInteraction?: unknown }[],
    completedSessionIds: ReadonlySet<string>,
): { value: number; tooltip: string } | undefined {
    const attention = sessions.filter((session) => session.pendingInteraction !== undefined);
    const notified = new Set([
        ...attention.map((session) => session.sessionId),
        ...completedSessionIds,
    ]);
    if (notified.size === 0) return undefined;
    return {
        value: notified.size,
        tooltip: attention.length > 0
            ? `${attention.length} 个会话等待操作`
            : `${notified.size} 个会话已完成`,
    };
}

export function queueDockItems(items: readonly DshQueuedInboxItem[]): QueueDockItem[] {
    return items.flatMap((item) => {
        if (item.placement === "context") return [];
        const message = isRecord(item.message) ? item.message : undefined;
        const content = Array.isArray(message?.content) ? message.content : [];
        const preview = content
            .map((block) => {
                if (!isRecord(block)) return "";
                return block.type === "text" && typeof block.text === "string"
                    ? block.text
                    : `[${String(block.type ?? "内容")}]`;
            })
            .join(" ")
            .replace(/\s+/gu, " ")
            .trim();
        const editable = content.every((block) => isRecord(block) && block.type === "text");
        return [{
            id: item.id,
            placement: item.placement,
            preview: Array.from(preview).length > 200
                ? `${Array.from(preview).slice(0, 200).join("")}…`
                : preview,
            ...(editable ? { editableText: contentText(content) } : {}),
        }];
    });
}

export function highestKnownSeq(snapshot: SessionStateSnapshot | undefined): number {
    return snapshot?.events.reduce(
        (maximum, stored) => Math.max(maximum, stored.event.seq),
        -1,
    ) ?? -1;
}
