/**
 * Native diff for one file-editing tool call, reconstructed without Git.
 *
 * The Runtime already ships everything needed. A `write` / `edit` /
 * `str_replace_editor` call carries a `card: 'diff'` presentation whose
 * `diffs` are the applied contextual hunks (three lines of context per side,
 * `@deepseek-ai/dsh-tool-fs/src/diff.ts`), and that payload is persisted with
 * the session log, so it survives replay and cold session loads.
 *
 * What the wire does NOT carry is a before-image of the whole file, or line
 * numbers for the hunks. This module recovers the before-image by walking the
 * hunks backwards out of the file that is on disk right now: each hunk's
 * `newText` is located in the current content and put back to its `oldText`.
 * The context lines are what make that anchor findable, and a hunk that does
 * not appear exactly once fails the reconstruction rather than guessing — a
 * wrong diff is worse than no diff.
 */

import { isRecord } from "./guards";
import { SessionStateSnapshot, StoredSessionEvent, toolResultCallId } from "./sessionStore";

/** One applied hunk: content after the change, and what it replaced. */
export interface ToolFileDiff {
    path: string;
    /** Prior content, or null for a pure insertion / a file with no before-image. */
    oldText: string | null;
    newText: string;
}

/** A parsed `card: 'diff'` tool presentation. */
export interface ToolDiffView {
    title?: string;
    diffs: ToolFileDiff[];
}

function fileDiff(value: unknown): ToolFileDiff | undefined {
    if (!isRecord(value)) return undefined;
    const { path, oldText, newText } = value;
    if (typeof path !== "string" || !path) return undefined;
    if (oldText !== null && typeof oldText !== "string") return undefined;
    if (typeof newText !== "string") return undefined;
    return { path, oldText, newText };
}

/**
 * Narrows an already-unwrapped tool presentation to a diff card. Anything that
 * is not a well-formed diff card returns undefined so the caller keeps its
 * generic rendering, matching how the Runtime's own bridges degrade.
 */
export function parseToolDiffView(view: unknown): ToolDiffView | undefined {
    if (!isRecord(view) || view.card !== "diff" || !Array.isArray(view.diffs)) return undefined;
    const diffs: ToolFileDiff[] = [];
    for (const entry of view.diffs) {
        const parsed = fileDiff(entry);
        if (!parsed) return undefined;
        diffs.push(parsed);
    }
    if (diffs.length === 0) return undefined;
    return {
        ...(typeof view.title === "string" ? { title: view.title } : {}),
        diffs,
    };
}

/** The distinct file paths a diff card touches, in first-seen order. */
export function diffViewPaths(view: ToolDiffView | undefined): string[] {
    if (!view) return [];
    const seen = new Set<string>();
    for (const diff of view.diffs) seen.add(diff.path);
    return [...seen];
}

/**
 * Hunks are computed on an LF-normalized basis upstream, so a CRLF working
 * copy would never match its own anchors. Both sides of the presented diff use
 * this normalization, which makes the comparison about content rather than
 * line endings.
 */
export function normalizeNewlines(text: string): string {
    return text.replace(/\r\n/gu, "\n");
}

/**
 * Whether these hunks describe a file that had no before-image at all — the
 * `write` tool's replay-safe fallback, which reports one whole-content hunk
 * with no prior text. Reconstruction for that case is the empty file.
 */
function isWholeFileCreate(hunks: readonly ToolFileDiff[]): boolean {
    return hunks.length === 1 && hunks[0]?.oldText === null;
}

/**
 * Undo one call's hunks, returning the content as it was before them.
 *
 * Hunks arrive in file order, so they are undone last-first: replacing a later
 * hunk cannot move an earlier one's anchor. Returns undefined when any anchor
 * is missing or ambiguous, which is the honest answer whenever the file has
 * drifted from what the Runtime recorded.
 */
export function reverseApplyHunks(
    content: string,
    hunks: readonly ToolFileDiff[],
): string | undefined {
    if (isWholeFileCreate(hunks)) {
        return normalizeNewlines(hunks[0]!.newText) === content ? "" : undefined;
    }
    let result = content;
    for (let index = hunks.length - 1; index >= 0; index -= 1) {
        const hunk = hunks[index]!;
        const after = normalizeNewlines(hunk.newText);
        // An empty anchor cannot be located; it also cannot have been produced
        // by a contextual hunk, so this is malformed rather than a hard case.
        if (!after) return undefined;
        const at = result.indexOf(after);
        if (at < 0) return undefined;
        if (result.indexOf(after, at + 1) >= 0) return undefined;
        result = result.slice(0, at) + normalizeNewlines(hunk.oldText ?? "") + result.slice(at + after.length);
    }
    return result;
}

/** One call's hunks for one file, oldest call first. */
export interface CallHunks {
    callId: string;
    hunks: ToolFileDiff[];
}

/**
 * Rewinds a file to its state on either side of one call.
 *
 * `history` is every diff-producing call for this path in the session, oldest
 * first; `current` is what is on disk now. Later calls are undone first so the
 * requested call is compared against the file as it actually stood then, not
 * against today's content.
 *
 * `afterIsCurrent` reports whether nothing followed this call, which lets the
 * caller show the real file on the right-hand side — a live, editable document
 * rather than another snapshot.
 */
export function rewindAround(
    current: string,
    history: readonly CallHunks[],
    callId: string,
): { before: string; after: string; afterIsCurrent: boolean } | undefined {
    const index = history.findIndex((entry) => entry.callId === callId);
    if (index < 0) return undefined;
    let after = normalizeNewlines(current);
    for (let cursor = history.length - 1; cursor > index; cursor -= 1) {
        const rewound = reverseApplyHunks(after, history[cursor]!.hunks);
        if (rewound === undefined) return undefined;
        after = rewound;
    }
    const before = reverseApplyHunks(after, history[index]!.hunks);
    if (before === undefined) return undefined;
    return { before, after, afterIsCurrent: index === history.length - 1 };
}

/** Unwraps the `{ for, view }` envelope the Runtime puts on a tool event. */
function toolPresentation(
    event: StoredSessionEvent | undefined,
    target: "call" | "result",
): unknown {
    if (!event || !isRecord(event.view) || event.view.for !== target) return undefined;
    return event.view.view;
}

/**
 * The diff card for one stored tool event pair. The result view wins: its
 * hunks are the change that was actually applied, while the call view is only
 * the model's proposal (for `edit`, the bare `old_string` → `new_string`
 * snippet, with no context lines to anchor on).
 */
export function storedDiffView(
    call: StoredSessionEvent | undefined,
    result: StoredSessionEvent | undefined,
): ToolDiffView | undefined {
    return parseToolDiffView(toolPresentation(result, "result"))
        ?? parseToolDiffView(toolPresentation(call, "call"));
}

/**
 * Every diff-producing call for one path in this session, oldest first. The
 * order is the session log's, which is the order the edits were applied, and
 * that is what makes rewinding one call at a time meaningful.
 */
export function collectCallHunks(
    snapshot: SessionStateSnapshot,
    path: string,
): CallHunks[] {
    const calls = new Map<string, StoredSessionEvent>();
    for (const stored of snapshot.events) {
        const data = isRecord(stored.event.data) ? stored.event.data : undefined;
        if (stored.event.type === "tool/call" && typeof data?.callId === "string") {
            calls.set(data.callId, stored);
        }
    }

    const history: CallHunks[] = [];
    for (const stored of snapshot.events) {
        if (stored.event.type !== "tool/result") continue;
        const callId = toolResultCallId(stored);
        if (callId === undefined) continue;
        const view = storedDiffView(calls.get(callId), stored);
        const hunks = view?.diffs.filter((diff) => diff.path === path) ?? [];
        if (hunks.length) history.push({ callId, hunks });
    }
    return history;
}
