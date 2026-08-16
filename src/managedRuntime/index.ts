import { randomBytes } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { t } from "../localize";
import { CnbRuntimeProvider } from "./cnbProvider";
import { acquireInstallLock, checkInstalled, versionDir, writeMetadata } from "./runtimeCache";
import { downloadRuntimeArchive } from "./runtimeDownloader";
import { extractArchive } from "./runtimeInstaller";
import { CNB_RUNTIME_BASE_URL } from "./types";
import type { ManagedRuntime, RuntimeInstallPhase, RuntimeInstallMetadata } from "./types";

export { resolveTarget, supportedTargets } from "./runtimePlatform";
export { checkInstalled, readMetadata, versionDir } from "./runtimeCache";
export { RUNTIME_DEFAULT_VERSION, CNB_RUNTIME_BASE_URL } from "./types";
export type {
    ManagedRuntime,
    RuntimeInstallPhase,
    RuntimeInstallMetadata,
    RuntimeManifest,
    RuntimeAsset,
} from "./types";

export interface AcquireManagedRuntimeOptions {
    version: string;
    target: string;
    log?: (message: string) => void;
    signal?: AbortSignal;
    /** Report the current install phase for progress UI. */
    onPhase?: (phase: RuntimeInstallPhase) => void;
    /** Report while waiting for another window's install to finish. */
    onWaiting?: () => void;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        const reason = signal.reason;
        throw reason instanceof Error ? reason : new Error(t("The download was canceled."));
    }
}

/**
 * Return a cached managed runtime, or download and install it, or fail with
 * the exact stage that went wrong. Never overwrites a version directory that
 * passes the integrity check, and keeps the install isolated under a per
 * (target, version) lock so concurrent windows cooperate instead of racing.
 */
export async function acquireManagedRuntime(
    storagePath: string,
    options: AcquireManagedRuntimeOptions,
): Promise<ManagedRuntime> {
    const { version, target } = options;
    const log = options.log ?? (() => undefined);

    log("[dsh:runtime] checking managed runtime cache");
    const cached = await checkInstalled(storagePath, target, version);
    if (cached) {
        log(`[dsh:runtime] using cached runtime ${version} (${target})`);
        return cached;
    }
    throwIfAborted(options.signal);

    const lock = await acquireInstallLock(storagePath, target, version, {
        log,
        onWaiting: options.onWaiting,
        signal: options.signal,
    });
    try {
        // Another window may have completed the install while we waited.
        const rechecked = await checkInstalled(storagePath, target, version);
        if (rechecked) {
            log(`[dsh:runtime] using runtime installed by another window (${version}, ${target})`);
            return rechecked;
        }

        options.onPhase?.("preparing");
        const provider = new CnbRuntimeProvider(CNB_RUNTIME_BASE_URL, version);

        log("[dsh:runtime] downloading manifest from CNB");
        const manifest = await provider.getManifest(version, options.signal);
        throwIfAborted(options.signal);
        const asset = manifest.platforms[target];
        if (!asset) {
            throw new Error(
                t("No {target} asset is available for DSH Runtime version {version}.", { target, version }),
            );
        }
        log(`[dsh:runtime] selected ${target} asset ${asset.filename}`);

        const downloadsRoot = join(storagePath, "runtime-downloads");
        const tmpDir = join(downloadsRoot, `.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
        await mkdir(tmpDir, { recursive: true });

        try {
            options.onPhase?.("downloading");
            const downloaded = await downloadRuntimeArchive(provider, asset, tmpDir, { signal: options.signal });
            log("[dsh:runtime] sha256 verified");

            options.onPhase?.("verifying");
            const stagingDir = join(tmpDir, "staging");
            await extractArchive(downloaded.path, stagingDir, target);
            throwIfAborted(options.signal);

            options.onPhase?.("installing");
            const metadata: RuntimeInstallMetadata = {
                version,
                target,
                filename: asset.filename,
                sha256: downloaded.sha256,
                size: downloaded.size,
                installedAt: new Date().toISOString(),
            };

            const targetVersionDir = versionDir(storagePath, target, version);
            await mkdir(dirname(targetVersionDir), { recursive: true });
            // A partial/corrupt directory from an interrupted install may exist;
            // remove it while holding the install lock. A healthy runtime is never
            // touched because checkInstalled returned undefined above.
            await rm(targetVersionDir, { recursive: true, force: true });
            // Metadata is written inside staging so the rename to the version
            // directory is atomic.
            await writeMetadata(stagingDir, metadata);
            await rename(stagingDir, targetVersionDir);
            log(`[dsh:runtime] installed ${version} (${target})`);
        } finally {
            await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
        }

        const installed = await checkInstalled(storagePath, target, version);
        if (!installed) {
            throw new Error(t("DSH Runtime {version} was installed but failed the integrity check.", { version }));
        }
        return installed;
    } finally {
        await lock.release();
    }
}
