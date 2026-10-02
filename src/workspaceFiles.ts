import { isRecord } from "./guards";
import { t } from "./localize";
import type { RemoteConnectionController } from "./remote/connection";
import { isRemoteError, RemoteHttpError, RemoteProtocolError } from "./remote/errors";
import type { RemoteUnaryClient } from "./remote/unaryClient";

export interface RuntimeFileStat {
    absolutePath: string;
    version: string;
    bytes?: number;
}

export interface RuntimeFileText extends RuntimeFileStat {
    offset: number;
    text: string;
    lines: number;
    eof: boolean;
}

export interface RuntimeFileBytes extends RuntimeFileStat {
    offset: number;
    data: Uint8Array;
    eof: boolean;
}

export interface RuntimeDirectoryListing {
    path: string;
    entries: Array<{ name: string; type: "file" | "directory" | "other"; size?: number }>;
    truncated: boolean;
}

export type RuntimeFileWatchFrame =
    | { kind: "ready" }
    | { kind: "change"; change: { absolutePath: string; version: string } | { absolutePath: string; absent: true } };

function natural(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function invalid(endpoint: string): never {
    throw new RemoteProtocolError(`Remote workspaceFiles/${endpoint} returned an invalid value`);
}

function fileStat(value: unknown, endpoint: string): RuntimeFileStat {
    if (!isRecord(value) || typeof value.absolutePath !== "string" || !value.absolutePath ||
        typeof value.version !== "string" || !value.version ||
        (value.bytes !== undefined && !natural(value.bytes))) return invalid(endpoint);
    return {
        absolutePath: value.absolutePath,
        version: value.version,
        ...(value.bytes === undefined ? {} : { bytes: value.bytes }),
    };
}

/** RC.2 file client shared by the Runtime facade and integration smoke. Paths always belong to the Host. */
export class WorkspaceFilesClient {
    public constructor(
        private readonly unary: Pick<RemoteUnaryClient, "call">,
        private readonly connection: Pick<RemoteConnectionController, "open">,
    ) {}

    private async call(endpoint: string, sessionId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
        try {
            return await this.unary.call(`workspaceFiles/${endpoint}`, { workspaceFileScopeId: sessionId, ...args }, signal);
        } catch (error) {
            if (error instanceof RemoteHttpError && error.status === 404) return undefined;
            throw error;
        }
    }

    /** Root requests use '.', while the Host's response spells the root as an empty path. */
    public async list(sessionId: string, path = ".", signal?: AbortSignal): Promise<RuntimeDirectoryListing | undefined> {
        const value = await this.call("list", sessionId, { path: path || "." }, signal);
        if (value === undefined) return undefined;
        if (!isRecord(value) || typeof value.path !== "string" ||
            (value.path !== "" && value.path.split("/").some(part => !part || part === "." || part === "..")) ||
            !Array.isArray(value.entries) || typeof value.truncated !== "boolean") return invalid("list");
        const names = new Set<string>();
        const entries = value.entries.map((entry): RuntimeDirectoryListing["entries"][number] => {
            if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name ||
                /[/\\\u0000]/u.test(entry.name) || entry.name === "." || entry.name === ".." || names.has(entry.name) ||
                (entry.type !== "file" && entry.type !== "directory" && entry.type !== "other") ||
                (entry.size !== undefined && !natural(entry.size))) return invalid("list");
            names.add(entry.name);
            return { name: entry.name, type: entry.type, ...(entry.size === undefined ? {} : { size: entry.size }) };
        });
        return { path: value.path, entries, truncated: value.truncated };
    }

    public async stat(sessionId: string, path: string, signal?: AbortSignal): Promise<RuntimeFileStat | undefined> {
        const value = await this.call("stat", sessionId, { path }, signal);
        return value === undefined ? undefined : fileStat(value, "stat");
    }

    /** Line offsets are one-based. The generated Remote requires a range object, including for defaults. */
    public async read(sessionId: string, path: string, range: { offset?: number; limit?: number } = {}, signal?: AbortSignal): Promise<RuntimeFileText | undefined> {
        const value = await this.call("read", sessionId, { path, range }, signal);
        if (value === undefined) return undefined;
        const stat = fileStat(value, "read");
        if (!isRecord(value) || !natural(value.offset) || value.offset < 1 || !natural(value.lines) ||
            typeof value.text !== "string" || typeof value.eof !== "boolean") return invalid("read");
        return { ...stat, offset: value.offset, text: value.text, lines: value.lines, eof: value.eof };
    }

    /** The generated Remote requires an options object; bytes are restored by the multipart carrier. */
    public async readBytes(sessionId: string, path: string, options: { range?: { offset?: number; length?: number }; baseFile?: string } = {}, signal?: AbortSignal): Promise<RuntimeFileBytes | undefined> {
        const value = await this.call("readBytes", sessionId, { path, options }, signal);
        if (value === undefined) return undefined;
        const stat = fileStat(value, "readBytes");
        if (!isRecord(value) || !natural(value.offset) || !(value.data instanceof Uint8Array) ||
            typeof value.eof !== "boolean") return invalid("readBytes");
        return { ...stat, offset: value.offset, data: value.data, eof: value.eof };
    }

    /** Watch frames are validated before a preview uses them for cache invalidation. Cancellation stays with the caller. */
    public async *changes(sessionId: string, path: string, signal: AbortSignal): AsyncGenerator<RuntimeFileWatchFrame> {
        try {
            for await (const value of this.connection.open("workspaceFiles/changes", { workspaceFileScopeId: sessionId, path }, signal)) {
                if (!isRecord(value)) return invalid("changes");
                if (value.kind === "ready") {
                    yield { kind: "ready" };
                } else if (value.kind === "change" && isRecord(value.change) &&
                    typeof value.change.absolutePath === "string" && value.change.absolutePath &&
                    (value.change.absent === true || (typeof value.change.version === "string" && value.change.version))) {
                    const change = value.change;
                    yield { kind: "change", change: change.absent === true
                        ? { absolutePath: change.absolutePath as string, absent: true }
                        : { absolutePath: change.absolutePath as string, version: change.version as string } };
                } else return invalid("changes");
            }
        } catch (error) {
            if ((error instanceof RemoteHttpError && error.status === 404) ||
                (isRemoteError(error) && ["gateway/definition-unavailable", "gateway/service-unavailable", "gateway/method-unavailable"].includes(error.code))) return;
            throw error;
        }
    }
}

/** Preview budget; the cap also bounds byte reads when the filesystem has no size metadata. */
export const RUNTIME_TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

/** Read exact UTF-8 text through a bounded byte window, rejecting binary, large, or concurrently changed files. */
export async function readRuntimeTextPreview(
    files: Pick<WorkspaceFilesClient, "stat" | "readBytes">,
    sessionId: string,
    path: string,
    signal?: AbortSignal,
): Promise<{ text: string; absolutePath: string }> {
    const before = await files.stat(sessionId, path, signal);
    if (!before) throw new Error(t("This Runtime does not expose workspace file previews."));
    const tooLarge = (): Error => new Error(t("Runtime file previews are limited to 1 MiB: {path}", { path }));
    if (before.bytes !== undefined && before.bytes > RUNTIME_TEXT_PREVIEW_MAX_BYTES) throw tooLarge();
    const length = before.bytes === undefined ? RUNTIME_TEXT_PREVIEW_MAX_BYTES + 1 : Math.max(1, before.bytes);
    const file = await files.readBytes(sessionId, path, { range: { length } }, signal);
    if (!file) throw new Error(t("This Runtime does not expose workspace file previews."));
    if (!file.eof || file.data.byteLength > RUNTIME_TEXT_PREVIEW_MAX_BYTES) throw tooLarge();
    const after = await files.stat(sessionId, path, signal);
    if (!after || before.version !== file.version || file.version !== after.version ||
        before.absolutePath !== file.absolutePath || file.absolutePath !== after.absolutePath) {
        throw new Error(t("The Runtime file changed while it was being read. Try again."));
    }
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.data);
    } catch {
        throw new Error(t("This Runtime file is not UTF-8 text: {path}", { path }));
    }
    if (text.includes("\u0000")) throw new Error(t("This Runtime file is not UTF-8 text: {path}", { path }));
    return { text, absolutePath: file.absolutePath };
}
