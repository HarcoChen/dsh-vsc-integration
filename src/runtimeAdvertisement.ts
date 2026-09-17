import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Discovery metadata only. No field grants or denies permission to start. */
export interface RuntimeAdvertisement {
    ownerId: string;
    pid: number;
    runtimePid?: number;
    runtimeVersion?: string;
    baseUrl: string;
    launchUrl?: string;
    createdAt: number;
    compositionHash?: string;
}

export function runtimeAdvertisementDirectory(): string {
    const user = createHash("sha256").update(homedir()).digest("hex").slice(0, 16);
    return join(tmpdir(), `dsh-runtime-advertisements-${user}`);
}

function advertisementPath(ownerId: string): string {
    if (!/^[a-f0-9-]{36}$/u.test(ownerId)) throw new Error("Invalid Runtime advertisement owner");
    return join(runtimeAdvertisementDirectory(), `${ownerId}.json`);
}

/** Each editor publishes only its own file; no shared write ownership to recover. */
export async function publishRuntimeAdvertisement(record: RuntimeAdvertisement): Promise<void> {
    const path = advertisementPath(record.ownerId);
    await mkdir(runtimeAdvertisementDirectory(), { recursive: true, mode: 0o700 });
    const staging = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(staging, JSON.stringify(record), { flag: "wx", mode: 0o600 });
        await rename(staging, path);
    } finally { await unlink(staging).catch(() => undefined); }
}

export async function removeRuntimeAdvertisement(ownerId: string): Promise<void> {
    await unlink(advertisementPath(ownerId)).catch(() => undefined);
}

/**
 * Whether an advertised endpoint is provably gone. Only an explicitly refused
 * loopback connection counts: a timeout, a successful connect, or an ambiguous
 * host all keep the record, because withdrawing a live endpoint would hide a
 * reusable Runtime and invite a second one for the same machine.
 */
export async function advertisedEndpointRefused(address: string): Promise<boolean> {
    let url: URL;
    try { url = new URL(address); } catch { return false; }
    if (url.protocol !== "http:" || !url.port || url.username || url.password) return false;
    // A localhost alias may resolve differently across processes; never decide on that ambiguity.
    if (!["127.0.0.1", "0.0.0.0", "[::1]"].includes(url.hostname)) return false;
    const host = url.hostname === "[::1]" ? "::1" : url.hostname === "0.0.0.0" ? "127.0.0.1" : url.hostname;
    return new Promise(resolve => {
        const socket = createConnection({ host, port: Number(url.port) });
        const finish = (refused: boolean): void => { socket.destroy(); resolve(refused); };
        socket.setTimeout(1_000, () => finish(false));
        socket.once("connect", () => finish(false));
        socket.once("error", error => finish((error as NodeJS.ErrnoException).code === "ECONNREFUSED"));
    });
}

/** Legacy lock files are read-only hints. Never inspect their guards or reclaim them. */
export async function readRuntimeAdvertisements(): Promise<unknown[]> {
    const directory = runtimeAdvertisementDirectory();
    const names = await readdir(directory).catch(() => [] as string[]);
    const paths = names.filter(name => /^[a-f0-9-]{36}\.json$/u.test(name)).map(name => join(directory, name));
    paths.push(join(tmpdir(), "dsh-runtime.lock"), join(tmpdir(), "dsh-vscode-runtime.lock"));
    const entries = await Promise.all(paths.map(async path => {
        try {
            const stat = await lstat(path);
            if (!stat.isFile() || stat.size > 64 * 1024) return undefined;
            return { value: JSON.parse(await readFile(path, "utf8")) as unknown, time: stat.mtimeMs };
        } catch { return undefined; }
    }));
    return entries.filter(entry => entry !== undefined).sort((a, b) => b.time - a.time)
        .slice(0, 16).map(entry => entry.value);
}

/** Best effort only: at most 250 ms waiting and 500 ms holding; no disk guard. */
export async function acquireRuntimeStartupMutex(signal?: AbortSignal): Promise<(() => void) | undefined> {
    const port = 16384 + createHash("sha256").update(runtimeAdvertisementDirectory()).digest().readUInt32BE(0) % 16384;
    const deadline = Date.now() + 250;
    do {
        signal?.throwIfAborted();
        const server = createServer(socket => socket.destroy());
        const acquired = await new Promise<boolean>(resolve => {
            server.once("error", () => resolve(false));
            server.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolve(true));
        });
        if (acquired) {
            server.unref();
            let released = false;
            const release = (): void => {
                if (released) return;
                released = true;
                clearTimeout(timer);
                signal?.removeEventListener("abort", release);
                server.close();
            };
            const timer = setTimeout(release, 500);
            timer.unref();
            signal?.addEventListener("abort", release, { once: true });
            if (signal?.aborted) release();
            return release;
        }
        server.close();
        if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    return undefined;
}
