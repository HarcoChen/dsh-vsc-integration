import { constants } from "node:fs";
import { access, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { t } from "../localize";
import { launcherPath, runtimeDataDir } from "./runtimePlatform";
import type { ManagedRuntime, RuntimeInstallMetadata } from "./types";

export const INSTALL_METADATA_FILE = "installed.json";

const LOCK_WAIT_MS = 500;
const LOCK_TIMEOUT_MS = 5 * 60_000;

export function runtimeRoot(storagePath: string): string {
    return join(storagePath, "runtime");
}

export function versionDir(storagePath: string, target: string, version: string): string {
    return join(runtimeRoot(storagePath), target, version);
}

export function metadataPath(versionDirectory: string): string {
    return join(versionDirectory, INSTALL_METADATA_FILE);
}

export async function readMetadata(versionDirectory: string): Promise<RuntimeInstallMetadata | undefined> {
    try {
        const raw = await readFile(metadataPath(versionDirectory), "utf8");
        const parsed = JSON.parse(raw) as Partial<RuntimeInstallMetadata>;
        if (
            typeof parsed.version === "string" &&
            typeof parsed.target === "string" &&
            typeof parsed.filename === "string" &&
            typeof parsed.sha256 === "string" &&
            typeof parsed.size === "number" &&
            typeof parsed.installedAt === "string"
        ) {
            return parsed as RuntimeInstallMetadata;
        }
    } catch {
        // missing or unreadable metadata means "not installed"
    }
    return undefined;
}

export async function writeMetadata(versionDirectory: string, metadata: RuntimeInstallMetadata): Promise<void> {
    await mkdir(versionDirectory, { recursive: true });
    await writeFile(metadataPath(versionDirectory), JSON.stringify(metadata, null, 2), "utf8");
}

/**
 * Integrity check used before launching and before reusing a cached runtime:
 * metadata present, version directory present, launcher present and
 * executable, and the runtime data directory (dsh-runtime/app/node_modules)
 * present.
 */
export async function checkInstalled(
    storagePath: string,
    target: string,
    version: string,
): Promise<ManagedRuntime | undefined> {
    const dir = versionDir(storagePath, target, version);
    const metadata = await readMetadata(dir);
    if (!metadata || metadata.version !== version || metadata.target !== target) {
        return undefined;
    }

    const launcher = launcherPath(dir, target);
    try {
        await access(launcher, constants.X_OK);
    } catch {
        return undefined;
    }

    try {
        await access(runtimeDataDir(dir), constants.F_OK);
    } catch {
        return undefined;
    }

    return { version, target, versionDir: dir, launcherPath: launcher, metadata };
}

// ------------------------------------------------------------ install lock

export interface InstallLock {
    release(): Promise<void>;
}

interface LockInfo {
    pid: number;
    startedAt: string;
    target: string;
    version: string;
}

/**
 * Acquire an exclusive install lock for (target, version). The lock is
 * created with the `wx` flag, never overwriting an existing lock. A stale
 * lock (owner process no longer alive) is removed; otherwise we wait and
 * time out with a clear message instead of clobbering the lock.
 */
export async function acquireInstallLock(
    storagePath: string,
    target: string,
    version: string,
    options?: { log?: (message: string) => void; timeoutMs?: number; onWaiting?: () => void; signal?: AbortSignal },
): Promise<InstallLock> {
    const locksDir = join(runtimeRoot(storagePath), "locks");
    await mkdir(locksDir, { recursive: true });
    const lockPath = join(locksDir, `install-${target}-${version}.lock`);
    const deadline = Date.now() + (options?.timeoutMs ?? LOCK_TIMEOUT_MS);

    for (;;) {
        try {
            const handle = await open(lockPath, "wx", 0o600);
            const info: LockInfo = {
                pid: process.pid,
                startedAt: new Date().toISOString(),
                target,
                version,
            };
            await handle.writeFile(JSON.stringify(info, null, 2), "utf8");
            await handle.close();

            let released = false;
            return {
                async release() {
                    if (released) {
                        return;
                    }
                    released = true;
                    try {
                        const current = await readLockInfo(lockPath);
                        if (current?.pid === process.pid) {
                            await rm(lockPath, { force: true });
                        }
                    } catch {
                        // ignore cleanup errors
                    }
                },
            };
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "EEXIST") {
                throw error;
            }

            if (options?.signal?.aborted) {
                const reason = options.signal.reason;
                throw reason instanceof Error ? reason : new Error(t("The download was canceled."));
            }

            const info = await readLockInfo(lockPath);
            if (info !== undefined && isProcessAlive(info.pid)) {
                if (Date.now() >= deadline) {
                    throw new Error(
                        t("Another window is installing DSH Runtime {version}. Try again after it finishes.", { version }),
                    );
                }
                options?.log?.(`[dsh:runtime] install lock held by pid ${info.pid}; waiting`);
                options?.onWaiting?.();
                await delay(LOCK_WAIT_MS);
                continue;
            }

            // The owner process is gone or the lock is unreadable: it is stale.
            await rm(lockPath, { force: true }).catch(() => undefined);
        }
    }
}

async function readLockInfo(lockPath: string): Promise<LockInfo | undefined> {
    try {
        const raw = await readFile(lockPath, "utf8");
        const parsed = JSON.parse(raw) as Partial<LockInfo>;
        if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
            return parsed as LockInfo;
        }
    } catch {
        // unreadable lock is treated as stale
    }
    return undefined;
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
