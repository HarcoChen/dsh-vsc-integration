import type { DshSessionSummary } from "./types";
import { projectionCell, type SessionStateSnapshot } from "./sessionStore";
import { isRecord } from "./guards";
import { posix, win32 } from "node:path";

/** Preserve the Runtime's path syntax when the Extension Host uses another platform. */
export function resolveRuntimePath(path: string, directory: string | undefined): string {
    if (!directory) return path;
    const paths = /^[A-Za-z]:[\\/]|^\\\\/u.test(directory) ? win32 : posix;
    return paths.resolve(directory, path);
}

/** Session identity and permission roots stay with header.cwd; only operations use this directory. */
export function currentWorkingDirectory(
    snapshot: SessionStateSnapshot | undefined,
    summary: DshSessionSummary | undefined,
): string | undefined {
    const cell = projectionCell(snapshot, "workingDirectory");
    const baseline = summary?.projections;
    // Cached hints are for display only; they cannot authorize an operation's directory.
    const value = baseline && (!cell || baseline.asOfSeq > cell.seq)
        ? baseline.values.workingDirectory
        : cell?.value;
    return typeof value === "string" && value.length > 0 ? value : summary?.cwd;
}

/** Resolve historical operations at their event cut, never against a later directory selection. */
export function workingDirectoryAt(
    snapshot: SessionStateSnapshot,
    seq: number,
    originalDirectory: string | undefined,
): string | undefined {
    let cwd = originalDirectory;
    for (const stored of snapshot.events) {
        if (stored.event.seq > seq) break;
        if (stored.event.type === "working-directory/change" && isRecord(stored.event.data) &&
            typeof stored.event.data.cwd === "string" && stored.event.data.cwd.length > 0) {
            cwd = stored.event.data.cwd;
        }
    }
    return cwd;
}
