import { constants } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { access, chmod, mkdir, open, readdir, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { createGunzip, createInflateRaw } from "node:zlib";
import { t } from "../localize";
import { isWindowsTarget, launcherPath } from "./runtimePlatform";

const TAR_BLOCK = 512;

/**
 * Extract a runtime archive into `stagingDir` and verify the result.
 * Supported formats: .tar.gz (macOS/Linux) and .zip (Windows). Extraction is
 * implemented with Node built-ins only (zlib + streaming fs) so the packaged
 * extension stays dependency-free.
 *
 * After extraction the staging directory must contain exactly one top-level
 * directory named "dsh-runtime" with a launcher at dsh-runtime/bin/dsh[.cmd].
 */
export async function extractArchive(archivePath: string, stagingDir: string, target: string): Promise<void> {
    await mkdir(stagingDir, { recursive: true });
    if (archivePath.endsWith(".zip")) {
        await extractZip(archivePath, stagingDir);
    } else {
        await extractTarGz(archivePath, stagingDir);
    }
    await verifyExtractedArchive(stagingDir, target);
}

// ---------------------------------------------------------------- tar.gz

async function extractTarGz(archivePath: string, stagingDir: string): Promise<void> {
    const tarPath = resolve(dirname(archivePath), "unpacked.tar");
    await gunzipToFile(archivePath, tarPath);
    try {
        await parseTarFile(tarPath, stagingDir);
    } finally {
        await rm(tarPath, { force: true }).catch(() => undefined);
    }
}

function gunzipToFile(sourcePath: string, targetPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const source = createReadStream(sourcePath);
        const gunzip = createGunzip();
        const target = createWriteStream(targetPath);
        source.on("error", reject);
        gunzip.on("error", reject);
        target.on("error", reject);
        target.on("finish", resolve);
        source.pipe(gunzip).pipe(target);
    });
}

async function parseTarFile(tarPath: string, stagingDir: string): Promise<void> {
    const handle = await open(tarPath, "r");
    try {
        const info = await handle.stat();
        let offset = 0;
        let pendingLongName: string | undefined;
        let pendingPax: Record<string, string> | undefined;

        while (offset + TAR_BLOCK <= info.size) {
            const header = Buffer.alloc(TAR_BLOCK);
            const { bytesRead } = await handle.read(header, 0, TAR_BLOCK, offset);
            if (bytesRead < TAR_BLOCK) {
                break; // trailing garbage; not part of the archive
            }
            offset += TAR_BLOCK;

            const rawName = header.subarray(0, 100).toString("utf8").replace(/\0+$/u, "");
            const typeFlag = String.fromCharCode(header[156]);
            const size = parseOctal(header.subarray(124, 136));

            if (typeFlag === "L") {
                // GNU long name: the next block holds the real name.
                pendingLongName = await readEntryText(handle, offset, size);
                offset += paddedBlockSize(size);
                continue;
            }
            if (typeFlag === "x") {
                // POSIX extended header: key=value records for the next entry.
                const paxText = await readEntryText(handle, offset, size);
                offset += paddedBlockSize(size);
                pendingPax = { ...(pendingPax ?? {}), ...parsePax(paxText) };
                continue;
            }
            if (typeFlag === "g") {
                // Global extended header: ignore, but consume its blocks.
                offset += paddedBlockSize(size);
                continue;
            }

            const name = pendingPax?.path ?? pendingLongName ?? rawName;
            const contentSize = pendingPax?.size !== undefined ? Number(pendingPax.size) : size;

            if (typeFlag === "5") {
                await mkdir(safeEntryPath(stagingDir, name), { recursive: true });
            } else if (typeFlag === "0" || typeFlag === "7" || typeFlag === " " || typeFlag === "" || typeFlag === "\0") {
                const entryPath = safeEntryPath(stagingDir, name);
                await mkdir(dirname(entryPath), { recursive: true });
                await readEntryToFile(handle, offset, contentSize, entryPath);
            }
            // Symlinks, hardlinks and device nodes are not extracted.
            offset += paddedBlockSize(size);
            pendingLongName = undefined;
            pendingPax = undefined;
        }
    } finally {
        await handle.close();
    }
}

function parseOctal(buffer: Buffer): number {
    const text = buffer.toString("utf8").trim();
    return text.length === 0 ? 0 : Number.parseInt(text, 8);
}

function paddedBlockSize(size: number): number {
    return Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
}

async function readEntryText(handle: FileHandle, offset: number, size: number): Promise<string> {
    const buffer = Buffer.alloc(size);
    await readFully(handle, buffer, offset);
    return buffer.toString("utf8");
}

async function readEntryToFile(handle: FileHandle, offset: number, size: number, targetPath: string): Promise<void> {
    const writeStream = createWriteStream(targetPath);
    const chunk = Buffer.allocUnsafe(64 * 1024);
    await new Promise<void>((resolvePromise, reject) => {
        let failed = false;
        writeStream.on("error", (error) => {
            failed = true;
            reject(error);
        });
        writeStream.on("finish", () => resolvePromise());

        (async () => {
            let remaining = size;
            let position = offset;
            while (remaining > 0 && !failed) {
                const toRead = Math.min(chunk.length, remaining);
                const { bytesRead } = await handle.read(chunk, 0, toRead, position);
                if (bytesRead <= 0) {
                    break;
                }
                if (!writeStream.write(chunk.subarray(0, bytesRead))) {
                    await onceDrain(writeStream);
                }
                position += bytesRead;
                remaining -= bytesRead;
            }
            writeStream.end();
        })().catch((error) => {
            if (!failed) {
                writeStream.destroy(error);
                reject(error);
            }
        });
    });
}

function onceDrain(stream: NodeJS.WritableStream): Promise<void> {
    return new Promise<void>((resolvePromise) => stream.once("drain", () => resolvePromise()));
}

function parsePax(content: string): Record<string, string> {
    const records: Record<string, string> = {};
    const re = /^(\d+) ([^\n]*)\n/gu;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
        const record = match[2];
        const eq = record.indexOf("=");
        if (eq > 0) {
            records[record.slice(0, eq)] = record.slice(eq + 1);
        }
    }
    return records;
}

// ------------------------------------------------------------------- zip

async function extractZip(archivePath: string, stagingDir: string): Promise<void> {
    const handle = await open(archivePath, "r");
    try {
        const info = await handle.stat();
        const eocd = await findEndOfCentralDirectory(handle, info.size);
        const totalEntries = eocd.readUInt16LE(10);
        const centralSize = eocd.readUInt32LE(12);
        const centralOffset = eocd.readUInt32LE(16);
        if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
            throw new Error(t("ZIP64 archives are not supported."));
        }

        const central = Buffer.alloc(centralSize);
        await readFully(handle, central, centralOffset);

        let pos = 0;
        for (let index = 0; index < totalEntries; index++) {
            if (central.readUInt32LE(pos) !== 0x02014b50) {
                throw new Error(t("The archive central directory is corrupt."));
            }
            const method = central.readUInt16LE(pos + 10);
            const compressedSize = central.readUInt32LE(pos + 20);
            const uncompressedSize = central.readUInt32LE(pos + 24);
            const nameLength = central.readUInt16LE(pos + 28);
            const extraLength = central.readUInt16LE(pos + 30);
            const commentLength = central.readUInt16LE(pos + 32);
            const localHeaderOffset = central.readUInt32LE(pos + 42);
            const name = central.subarray(pos + 46, pos + 46 + nameLength).toString("utf8");
            pos += 46 + nameLength + extraLength + commentLength;

            if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
                throw new Error(t("ZIP64 archives are not supported."));
            }
            if (method !== 0 && method !== 8) {
                throw new Error(t("The archive uses an unsupported compression method ({method}).", { method }));
            }

            const entryPath = safeEntryPath(stagingDir, name);
            if (name.endsWith("/")) {
                await mkdir(entryPath, { recursive: true });
                continue;
            }
            await mkdir(dirname(entryPath), { recursive: true });
            if (compressedSize === 0) {
                // Empty file entry (method 0, zero bytes).
                await writeFile(entryPath, Buffer.alloc(0));
                continue;
            }
            await extractZipEntry(archivePath, handle, localHeaderOffset, compressedSize, method, entryPath);
        }
    } finally {
        await handle.close();
    }
}

async function findEndOfCentralDirectory(handle: FileHandle, fileSize: number): Promise<Buffer> {
    const tailSize = Math.min(fileSize, 65_557);
    const tail = Buffer.alloc(tailSize);
    await readFully(handle, tail, fileSize - tailSize);
    for (let index = tail.length - 22; index >= 0; index--) {
        if (tail.readUInt32LE(index) === 0x06054b50) {
            return tail.subarray(index, index + 22);
        }
    }
    throw new Error(t("The archive is not a valid ZIP file."));
}

async function extractZipEntry(
    archivePath: string,
    handle: FileHandle,
    localHeaderOffset: number,
    compressedSize: number,
    method: number,
    entryPath: string,
): Promise<void> {
    const localHeader = Buffer.alloc(30);
    await readFully(handle, localHeader, localHeaderOffset);
    if (localHeader.readUInt32LE(0) !== 0x04034b50) {
        throw new Error(t("The archive is corrupt."));
    }
    const nameLength = localHeader.readUInt16LE(26);
    const extraLength = localHeader.readUInt16LE(28);
    const dataOffset = localHeaderOffset + 30 + nameLength + extraLength;

    const source = createReadStream(archivePath, { start: dataOffset, end: dataOffset + compressedSize - 1 });
    const target = createWriteStream(entryPath);
    const inflater = method === 8 ? createInflateRaw() : undefined;

    await new Promise<void>((resolvePromise, reject) => {
        source.on("error", reject);
        inflater?.on("error", reject);
        target.on("error", reject);
        target.on("finish", resolvePromise);
        const stream = inflater ? source.pipe(inflater) : source;
        stream.pipe(target);
    });
}

// -------------------------------------------------------------- shared

async function readFully(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
    let offset = 0;
    let remaining = buffer.length;
    while (remaining > 0) {
        const { bytesRead } = await handle.read(buffer, offset, remaining, position + offset);
        if (bytesRead <= 0) {
            throw new Error(t("The archive is truncated."));
        }
        offset += bytesRead;
        remaining -= bytesRead;
    }
}

/**
 * Resolve an archive entry name under `stagingDir`, rejecting anything that
 * escapes the staging directory (absolute paths, drive letters, "..").
 */
function safeEntryPath(stagingDir: string, entryName: string): string {
    if (entryName.includes("\0")) {
        throw new Error(t("The archive contains an invalid entry name."));
    }
    const segments = entryName
        .replace(/\\/gu, "/")
        .split("/")
        .filter((segment) => segment !== "" && segment !== ".");
    if (segments.some((segment) => segment === "..")) {
        throw new Error(t("The archive contains an entry that escapes the installation directory: {entry}", { entry: entryName }));
    }
    const target = resolve(stagingDir, ...segments);
    if (target !== stagingDir && !target.startsWith(stagingDir + sep)) {
        throw new Error(t("The archive contains an entry that escapes the installation directory: {entry}", { entry: entryName }));
    }
    return target;
}

async function verifyExtractedArchive(stagingDir: string, target: string): Promise<void> {
    const entries = await readdir(stagingDir, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0].isDirectory() || entries[0].name !== "dsh-runtime") {
        throw new Error(t("The Runtime archive must contain a single top-level dsh-runtime directory."));
    }

    const launcher = launcherPath(stagingDir, target);
    try {
        await access(launcher, constants.F_OK);
    } catch {
        throw new Error(t("The Runtime launcher is missing after extraction: {path}", { path: launcher }));
    }

    if (!isWindowsTarget(target)) {
        // Archive extraction may not preserve the executable bit.
        await chmod(launcher, 0o755).catch(() => undefined);
        try {
            await access(launcher, constants.X_OK);
        } catch {
            throw new Error(t("The Runtime launcher is not executable: {path}", { path: launcher }));
        }
    }
}
