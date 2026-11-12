import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";

const RETAIN = 10;
const MAX_BYTES = 4 * 1024 * 1024;
const SNAPSHOT = /^\d{13}-[a-f0-9-]{36}$/u;
interface Source { home: string; profile: string; directory: string }

/** The OS releases the exclusive listener on exit, including crashes and PID reuse. */
async function acquireBackupLock(directory: string): Promise<(() => Promise<void>) | undefined> {
    const port = 20000 + createHash("sha256").update(directory).digest().readUInt32BE(0) % 10000;
    const server = createServer(socket => socket.destroy());
    const acquired = await new Promise<boolean>((resolve, reject) => {
        server.once("error", (error: NodeJS.ErrnoException) => {
            if (error.code === "EADDRINUSE") resolve(false);
            else reject(error);
        });
        server.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolve(true));
    });
    if (!acquired) return undefined;
    server.unref();
    return () => new Promise<void>(resolve => server.close(() => resolve()));
}

/** Local DSH configuration history, independent of Runtime health and the recovery ledger. */
export class ConfigurationBackups {
    public readonly directory: string;
    private source?: Source;
    private readonly watchers = new Map<string, FSWatcher>();
    private poll?: ReturnType<typeof setInterval>;
    private debounce?: ReturnType<typeof setTimeout>;
    private queue: Promise<void> = Promise.resolve();
    private disposed = false;
    private lastError?: string;

    public constructor(storage: string, private readonly diagnostic: (message: string) => void) {
        this.directory = join(storage, "config-backups");
    }

    public async start(home: string, profile: string): Promise<void> {
        if (this.disposed) return;
        const hash = createHash("sha256").update(JSON.stringify([resolve(home), profile])).digest("hex").slice(0, 24);
        const key = `${profile.replace(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 48)}-${hash}`;
        if (this.source?.directory !== join(this.directory, key)) {
            await this.flush();
            this.closeWatchers();
            this.source = { home: resolve(home), profile, directory: join(this.directory, key) };
        }
        await this.flush();
        if (!this.poll) {
            this.poll = setInterval(() => { void this.flush(); }, 2500);
            this.poll.unref();
        }
    }

    public async flush(): Promise<void> {
        const source = this.source;
        if (!source) return;
        this.queue = this.queue.then(async () => {
            await this.refreshWatchers(source);
            await this.capture(source);
            this.lastError = undefined;
        }).catch(error => {
            const message = `Configuration backup failed: ${String(error)}`;
            if (message !== this.lastError) this.diagnostic(message);
            this.lastError = message;
        });
        await this.queue;
    }

    private async refreshWatchers(source: Source): Promise<void> {
        for (const path of [source.home, join(source.home, "profiles", source.profile)]) {
            if (this.disposed || this.source !== source || this.watchers.has(path)) continue;
            try {
                const watcher = watch(path, () => {
                    if (this.disposed || this.source !== source) return;
                    if (this.debounce) clearTimeout(this.debounce);
                    this.debounce = setTimeout(() => { this.debounce = undefined; void this.flush(); }, 250);
                });
                watcher.unref();
                watcher.on("error", () => { watcher.close(); this.watchers.delete(path); });
                this.watchers.set(path, watcher);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
        }
    }

    private async capture(source: Source): Promise<void> {
        const paths = [
            ["profile/package.json", join(source.home, "profiles", source.profile, "package.json")],
            ["profile/cordis.patch.yml", join(source.home, "profiles", source.profile, "cordis.patch.yml")],
            ["home/cordis.patch.yml", join(source.home, "cordis.patch.yml")],
        ];
        const files: { file: string; source: string; contents: Buffer | null }[] = [];
        for (const [file, path] of paths) {
            try {
                const before = await lstat(path);
                if (!before.isFile() || before.size > MAX_BYTES) throw new Error(`Unsupported configuration file: ${path}`);
                const contents = await readFile(path);
                const after = await lstat(path);
                if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) return;
                files.push({ file, source: path, contents });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                files.push({ file, source: path, contents: null });
            }
        }
        if (files.every(file => file.contents === null)) return;
        const digest = createHash("sha256").update(JSON.stringify(files.map(file => [file.file,
            file.contents === null ? null : createHash("sha256").update(file.contents).digest("hex")]))).digest("hex");
        await mkdir(source.directory, { recursive: true, mode: 0o700 });
        const releaseLock = await acquireBackupLock(source.directory);
        if (!releaseLock) return;
        let pending: string | undefined;
        try {
            const listing = await readdir(source.directory, { withFileTypes: true });
            for (const entry of listing) {
                if (entry.isDirectory() && entry.name.startsWith(".pending-") && SNAPSHOT.test(entry.name.slice(9)))
                    await rm(join(source.directory, entry.name), { recursive: true });
            }
            const entries = listing
                .filter(entry => entry.isDirectory() && SNAPSHOT.test(entry.name)).map(entry => entry.name).sort().reverse();
            for (const expired of entries.slice(RETAIN)) await rm(join(source.directory, expired), { recursive: true });
            if (entries[0]) {
                try {
                    const latest = JSON.parse(await readFile(join(source.directory, entries[0], "backup.json"), "utf8"));
                    if (latest.digest === digest) return;
                } catch { /* Keep a new complete snapshot even if the previous metadata was damaged. */ }
            }
            const timestamp = Math.max(Date.now(), Number(entries[0]?.slice(0, 13) ?? 0) + 1);
            const id = `${timestamp}-${randomUUID()}`;
            pending = join(source.directory, `.pending-${id}`);
            await mkdir(pending, { mode: 0o700 });
            for (const file of files) {
                if (file.contents === null) continue;
                const target = join(pending, file.file);
                await mkdir(dirname(target), { recursive: true, mode: 0o700 });
                await writeFile(target, file.contents, { flag: "wx", mode: 0o600 });
            }
            await writeFile(join(pending, "backup.json"), JSON.stringify({ schemaVersion: 1,
                createdAt: new Date(timestamp).toISOString(), home: source.home, profile: source.profile, digest,
                files: files.map(file => ({ file: file.file, source: file.source, present: file.contents !== null })),
            }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
            await rename(pending, join(source.directory, id));
            pending = undefined;
            for (const expired of entries.slice(RETAIN - 1, RETAIN)) await rm(join(source.directory, expired), { recursive: true });
        } finally {
            try {
                if (pending) await rm(pending, { recursive: true, force: true });
            } finally {
                await releaseLock();
            }
        }
    }

    private closeWatchers(): void {
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = undefined;
        for (const watcher of this.watchers.values()) watcher.close();
        this.watchers.clear();
    }

    public async dispose(): Promise<void> {
        this.disposed = true;
        if (this.poll) clearInterval(this.poll);
        this.closeWatchers();
        await this.flush();
    }
}
