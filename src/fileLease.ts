import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { basename, dirname, join } from "node:path";
import type { Stats } from "node:fs";
import { t } from "./localize";

/** A lease file records only who holds it; liveness is proven by `pid` alone. */
export interface FileLeaseRecord {
    pid: number;
    createdAt?: number;
    ownerId?: string;
}

export interface FileLeaseSnapshot {
    path: string;
    stat: Stats;
    contents: string;
    record?: FileLeaseRecord;
}

/** Allow an interrupted in-place write to finish, then discard broken metadata. */
export const CORRUPT_LEASE_GRACE_MS = 2_000;

function abandonedCorruptLease(snapshot: FileLeaseSnapshot): boolean {
    return snapshot.stat.isFile() && !snapshot.record &&
        Date.now() - snapshot.stat.mtimeMs >= CORRUPT_LEASE_GRACE_MS;
}

export function validPid(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Only ESRCH proves absence. Access-denied and unknown errors never authorize cleanup. */
export function processHasExited(pid: number): boolean {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

export async function readFileLease(path: string): Promise<FileLeaseSnapshot | undefined> {
    try {
        const stat = await lstat(path);
        // Do not follow a substituted lease symlink or treat it as available.
        if (!stat.isFile()) return { path, stat, contents: "" };
        const contents = await readFile(path, "utf8");
        let record: FileLeaseRecord | undefined;
        try {
            const value: unknown = JSON.parse(contents);
            if (typeof value === "object" && value !== null && !Array.isArray(value)) {
                const raw = value as Record<string, unknown>;
                if (validPid(raw.pid) &&
                    (raw.createdAt === undefined || typeof raw.createdAt === "number") &&
                    (raw.ownerId === undefined || (typeof raw.ownerId === "string" && raw.ownerId.length > 0))) {
                    record = raw as unknown as FileLeaseRecord;
                }
            }
        } catch { /* Fresh partial writes get a short grace period before recovery. */ }
        return { path, stat, contents, record };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

export function sameLeaseFile(left: Stats, right: Stats): boolean {
    return left.dev === right.dev && left.ino === right.ino && right.isFile();
}

/** Kernel-owned exclusion disappears on process death, including before file publication. */
async function acquireMutationGate(path: string, deadline: number): Promise<Server> {
    const canonical = join(await realpath(dirname(path)), basename(path));
    const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    // Stay below the usual ephemeral range used by the Runtime's --port 0.
    const port = 16384 + createHash("sha256").update(key).digest().readUInt32BE(0) % 16384;
    while (true) {
        const server = createServer(socket => socket.destroy());
        try {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
                    server.removeListener("error", reject);
                    resolve();
                });
            });
            return server;
        } catch (error) {
            server.close();
            if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
            // A port collision only delays/fails acquisition; never bypass exclusion.
            if (Date.now() >= deadline) throw new Error(t("DSH lease recovery is busy: {path}. Retry shortly.", { path }));
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    }
}

/**
 * The kernel gate serializes recovery and normal mutations across processes.
 * Keep the file guard too, so older builds still participate in exclusion.
 * A dead guard owner cannot resume; only gate holders may reclaim its file.
 */
export async function mutateFileLease<T>(path: string, action: () => Promise<T>): Promise<T> {
    const gate = await acquireMutationGate(path, Date.now() + 5_000);
    try {
        return await mutateFileLeaseWithGate(path, action);
    } finally {
        await new Promise<void>((resolve, reject) => gate.close(error => error ? reject(error) : resolve()));
    }
}

async function mutateFileLeaseWithGate<T>(path: string, action: () => Promise<T>): Promise<T> {
    const guardPath = `${path}.mutation`;
    const deadline = Date.now() + 3_000;
    const contents = JSON.stringify({ pid: process.pid, createdAt: Date.now(), ownerId: randomUUID() });
    let guard;
    while (!guard) {
        try { guard = await publishMutationGuard(guardPath, contents); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const abandoned = await readFileLease(guardPath);
            if (!abandoned) continue;
            if (((abandoned.record && processHasExited(abandoned.record.pid)) || abandonedCorruptLease(abandoned)) &&
                await removeFileLease(abandoned)) continue;
            if (Date.now() >= deadline) {
                throw new Error(t("DSH lease mutation is busy or abandoned: {path}. Retry; if it persists, verify its owner has exited before manual cleanup.", { path: guardPath }));
            }
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    }
    try {
        return await action();
    } finally {
        const stat = await guard.stat();
        await guard.close();
        const current = await readFileLease(guardPath);
        if (current && current.contents === contents && sameLeaseFile(stat, current.stat)) await removeFileLease(current);
    }
}

/** Publish a complete owner record atomically; a crash cannot leave an empty guard. */
async function publishMutationGuard(path: string, contents: string) {
    const staging = `${path}.${randomUUID()}.tmp`;
    const handle = await open(staging, "wx", 0o600);
    let published = false;
    try {
        await handle.writeFile(contents, "utf8");
        await link(staging, path);
        published = true;
        await unlink(staging);
        return handle;
    } catch (error) {
        const stat = await handle.stat().finally(() => handle.close());
        if (published) {
            const current = await readFileLease(path);
            if (current && sameLeaseFile(stat, current.stat) && current.contents === contents) {
                await removeFileLease(current);
            }
        }
        // Staging is not the mutex; preserve the original failure if cleanup also fails.
        await unlink(staging).catch(() => undefined);
        throw error;
    }
}

/** Check both file identity and contents after async liveness probes before unlinking. */
export async function removeFileLease(snapshot: FileLeaseSnapshot): Promise<boolean> {
    const current = await readFileLease(snapshot.path);
    if (!current || !sameLeaseFile(snapshot.stat, current.stat) || current.contents !== snapshot.contents) return false;
    try { await unlink(snapshot.path); return true; }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}
