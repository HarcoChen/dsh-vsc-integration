import { isRecord } from "./guards";
import { createHash } from "node:crypto";
import { t } from "./localize";

interface Hunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
}
export interface ForgeFile {
    path: string;
    previousPath: string | null;
    status: string;
    binary: boolean;
    oversized: boolean;
    layer: string;
    digest: string;
    additions: number;
    deletions: number;
    hunks: Hunk[];
}
export function forgeFiles(value: unknown): ForgeFile[] {
    if (!isRecord(value) || !Array.isArray(value.files)) throw new Error("Invalid forge diff");
    return value.files.map((file) => {
        if (
            !isRecord(file) ||
            typeof file.path !== "string" ||
            !Array.isArray(file.hunks) ||
            !file.hunks.every(
                (hunk) =>
                    isRecord(hunk) &&
                    [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every(
                        (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0
                    ) &&
                    Array.isArray(hunk.lines) &&
                    hunk.lines.every((line) => typeof line === "string" && /^[ +\\-]/u.test(line))
            )
        )
            throw new Error("Invalid forge file");
        const layer = ["interface", "implementation", "test"].includes(String(file.layer)) ? file.layer
            : /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|\.(?:test|spec)\./iu.test(file.path) ? "test"
            : /\.d\.ts$|(?:^|\/)(?:types|interfaces)(?:\/|$)/iu.test(file.path) ? "interface" : "implementation";
        return { ...file, layer, digest: typeof file.digest === "string" ? file.digest : createHash("sha256").update(JSON.stringify(file)).digest("hex") } as unknown as ForgeFile;
    });
}

/** Undo structured Git hunks by their line anchors, rejecting text that no longer matches the shown diff. */
export function forgeBeforeText(after: string, file: ForgeFile): string {
    if (file.status === "added") return "";
    if (file.status === "deleted") {
        const lines = file.hunks.flatMap((hunk) =>
            hunk.lines.filter((line) => line.startsWith("-") || line.startsWith(" ")).map((line) => line.slice(1))
        );
        return (
            lines.join("\n") + (file.hunks.some((hunk) => hunk.lines.some((line) => line.startsWith("\\"))) ? "" : "\n")
        );
    }
    const lines = after.replace(/\r\n/gu, "\n").split("\n");
    let oldNoNewline = false;
    let newNoNewline = false;
    for (const hunk of [...file.hunks].reverse()) {
        const oldLines: string[] = [],
            newLines: string[] = [];
        let previous = "";
        for (const line of hunk.lines) {
            if (line.startsWith("\\")) {
                if (previous !== "+") oldNoNewline = true;
                if (previous !== "-") newNoNewline = true;
            } else {
                if (line[0] !== "+") oldLines.push(line.slice(1));
                if (line[0] !== "-") newLines.push(line.slice(1));
                previous = line[0];
            }
        }
        const at = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
        if (
            oldLines.length !== hunk.oldLines ||
            newLines.length !== hunk.newLines ||
            lines.slice(at, at + newLines.length).join("\n") !== newLines.join("\n")
        )
            throw new Error(t("The file changed after the diff was read. Refresh the review."));
        lines.splice(at, newLines.length, ...oldLines);
    }
    if (oldNoNewline && lines.at(-1) === "") lines.pop();
    if (newNoNewline && !oldNoNewline) lines.push("");
    return lines.join("\n");
}
