import { rename } from "node:fs/promises";
import { join } from "node:path";
import { t } from "../localize";
import type { RuntimeAsset, RuntimeDownloadProvider } from "./types";

export interface DownloadedArchive {
    /** Verified archive path (renamed from archive.part). */
    path: string;
    sha256: string;
    size: number;
}

/**
 * Stream the asset for `asset` into `tmpDir`, verifying the SHA-256 and the
 * exact size declared by the manifest. The file is written as archive.part
 * and only renamed to archive after both checks pass, so a failed download
 * never leaves a usable-looking archive behind.
 */
export async function downloadRuntimeArchive(
    provider: RuntimeDownloadProvider,
    asset: RuntimeAsset,
    tmpDir: string,
    options?: { signal?: AbortSignal },
): Promise<DownloadedArchive> {
    const partPath = join(tmpDir, "archive.part");
    // Keep the archive suffix because the installer uses it to select the
    // tar.gz versus ZIP extractor. The manifest filename is validated as a
    // plain file name, so only its format suffix is used here.
    const archivePath = join(tmpDir, asset.filename.toLowerCase().endsWith(".zip") ? "archive.zip" : "archive.tar.gz");

    const result = await provider.downloadAsset(asset, partPath, { signal: options?.signal });

    if (result.sha256.toLowerCase() !== asset.sha256.toLowerCase()) {
        throw new Error(
            t("The downloaded archive checksum does not match the manifest (expected {expected}, got {actual}).", {
                expected: asset.sha256,
                actual: result.sha256,
            }),
        );
    }
    if (result.size !== asset.size) {
        throw new Error(
            t("The downloaded archive size does not match the manifest (expected {expected} bytes, got {actual} bytes).", {
                expected: asset.size,
                actual: result.size,
            }),
        );
    }

    await rename(partPath, archivePath);
    return { path: archivePath, sha256: result.sha256, size: result.size };
}
