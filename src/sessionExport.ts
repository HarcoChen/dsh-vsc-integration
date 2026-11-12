import type { RemoteConnectionController } from "./remote/connection";
import { RemoteProtocolError } from "./remote/errors";
import { isRecord } from "./guards";
import {
    historyEntries as remoteHistoryEntries,
    projectionBlock as remoteProjectionBlock,
} from "./remote/sessionState";
import { projectChatMessages } from "./chatState";
import { HarnessSessionStore } from "./sessionStore";
import type { DshHistoryEntry, DshSessionProjectionsBlock } from "./types";

export interface SessionArchive {
    sessionId: string;
    cursor: number;
    header: unknown;
    events: DshHistoryEntry[];
    projections: DshSessionProjectionsBlock;
}

function fenced(text: string, language = "json"): string {
    let longest = 2;
    for (const match of text.matchAll(/`+/gu)) longest = Math.max(longest, match[0].length);
    const fence = "`".repeat(longest + 1);
    return `${fence}${language}\n${text}\n${fence}`;
}

/** Text-only export never embeds image data or pretends attachment references are portable files. */
export function sessionMarkdown(archive: SessionArchive, title: string): string {
    const store = new HarnessSessionStore();
    const snapshot = store.replaceRemoteBaseline(
        archive.sessionId,
        { events: archive.events, projections: archive.projections, hasMore: false },
        archive.cursor
    );
    const sections = [
        `# ${title.replace(/[\r\n]/gu, " ")}\n`,
        `Session: ${archive.sessionId}\n\nThrough event: ${archive.cursor}\n`,
    ];
    for (const message of projectChatMessages(snapshot, [])) {
        if (message.role === "tool") continue;
        sections.push(`## ${message.role}\n\n${message.text}\n`);
        if (message.reasoning)
            sections.push(`<details><summary>Reasoning</summary>\n\n${message.reasoning}\n\n</details>\n`);
        for (const image of message.images ?? [])
            sections.push(
                `Attachment: ${image.name ?? image.mediaType} (${image.bytes} bytes; reference ${image.attachmentId ?? "unavailable"}). Binary data is not included.\n`
            );
    }
    const journal = archive.events.filter(
        (entry) => entry.event.type === "tool/call" || entry.event.type === "tool/result"
    );
    if (journal.length) sections.push("## Tool journal\n", fenced(JSON.stringify(journal, null, 2)));
    return sections.join("\n");
}

/** Passive export with a fixed cursor; failures reject without returning a partial archive. */
export async function readSessionArchive(
    sessionId: string,
    connection: Pick<RemoteConnectionController, "open" | "unary">,
    signal: AbortSignal,
    pageSize = 100
): Promise<SessionArchive> {
    const opening = new AbortController();
    let tail: Record<string, unknown> | undefined;
    try {
        for await (const value of connection.open(
            "session/follow",
            {
                request: { address: { kind: "session", sessionId }, maxMessages: pageSize },
            },
            AbortSignal.any([signal, opening.signal])
        )) {
            if (!isRecord(value) || value.type !== "snapshot") throw new RemoteProtocolError("Invalid archive opening");
            tail = value;
            break;
        }
    } finally {
        opening.abort();
    }
    if (
        !tail ||
        !Array.isArray(tail.records) ||
        !Number.isSafeInteger(tail.cursor) ||
        Number(tail.cursor) < -1 ||
        typeof tail.hasMore !== "boolean"
    )
        throw new RemoteProtocolError("Invalid archive snapshot");
    const projections = remoteProjectionBlock(tail.projections);
    if (!projections || projections.asOfSeq > Number(tail.cursor)) throw new RemoteProtocolError("Invalid archive projections");
    const pages = [remoteHistoryEntries(tail.records)];
    let more = tail.hasMore;
    let before = pages[0].reduce((lowest, entry) => Math.min(lowest, entry.event.seq ?? Infinity), Infinity);
    const seen = new Set<number>();
    while (more) {
        if (!Number.isSafeInteger(before) || before <= 0)
            throw new RemoteProtocolError("Archive history has no backwards cursor");
        const page = await connection.unary.call<unknown>(
            "session/page",
            {
                request: {
                    address: { kind: "session", sessionId },
                    throughSeq: tail.cursor,
                    beforeSeq: before,
                    maxMessages: pageSize,
                },
            },
            signal
        );
        if (!isRecord(page) || !Array.isArray(page.records) || typeof page.hasMore !== "boolean")
            throw new RemoteProtocolError("Invalid archive page");
        const events = remoteHistoryEntries(page.records);
        const next = events.reduce((lowest, entry) => Math.min(lowest, entry.event.seq ?? Infinity), Infinity);
        if (
            !Number.isSafeInteger(next) ||
            next >= before ||
            events.some((entry) => (entry.event.seq ?? Infinity) >= before)
        )
            throw new RemoteProtocolError("Archive history did not advance");
        pages.push(events);
        before = next;
        more = page.hasMore;
    }
    const events = pages.reverse().flat();
    for (const entry of events) {
        const seq = entry.event.seq;
        if (typeof seq !== "number" || seen.has(seq) || seq > Number(tail.cursor))
            throw new RemoteProtocolError("Archive contains invalid event sequences");
        seen.add(seq);
    }
    signal.throwIfAborted();
    if (!isRecord(tail.header) || tail.header.id !== sessionId)
        throw new RemoteProtocolError("Archive Session identity changed");
    return { sessionId, cursor: Number(tail.cursor), header: tail.header, events, projections };
}
