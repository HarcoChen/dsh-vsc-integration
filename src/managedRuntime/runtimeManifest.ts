import { t } from "../localize";
import type { RuntimeAsset, RuntimeManifest } from "./types";

const SHA256_RE = /^[0-9a-f]{64}$/iu;

function fail(reason: string): never {
    throw new Error(t("The Runtime manifest is invalid: {reason}", { reason }));
}

/**
 * Validate a parsed manifest object.
 *
 * Minimal checks:
 *  - version: non-empty string
 *  - either the legacy `platforms` object or the release `artifacts` array
 *  - per-platform asset: file name is plain (no separators, absolute paths
 *    or ".."), sha256 is a 64-char hex string, size is a positive integer.
 *
 * Values taken from a remote manifest must never be used as extraction
 * destinations; the installer resolves every entry itself.
 */
export function parseManifest(input: unknown): RuntimeManifest {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        fail("expected an object");
    }
    const raw = input as Record<string, unknown>;

    if (typeof raw.version !== "string" || raw.version.length === 0) {
        fail("version must be a non-empty string");
    }
    const platforms: Record<string, RuntimeAsset> = {};
    if (typeof raw.platforms === "object" && raw.platforms !== null && !Array.isArray(raw.platforms)) {
        for (const [target, value] of Object.entries(raw.platforms as Record<string, unknown>)) {
            if (!/^[a-z0-9_-]+$/u.test(target)) {
                fail(`platform key "${target}" is invalid`);
            }
            platforms[target] = parseAsset(target, value);
        }
    } else if (Array.isArray(raw.artifacts)) {
        for (const value of raw.artifacts) {
            if (typeof value !== "object" || value === null || Array.isArray(value)) {
                fail("every artifact must be an object");
            }
            const artifact = value as Record<string, unknown>;
            if (
                typeof artifact.platform !== "string" ||
                !/^[a-z0-9_-]+$/u.test(artifact.platform) ||
                typeof artifact.arch !== "string" ||
                !/^[a-z0-9_-]+$/u.test(artifact.arch)
            ) {
                fail("artifact platform and arch must be non-empty identifiers");
            }
            const target = `${artifact.platform}-${artifact.arch}`;
            if (platforms[target]) {
                fail(`platform "${target}" is duplicated`);
            }
            platforms[target] = parseAsset(target, {
                filename: artifact.file,
                sha256: artifact.sha256,
                size: artifact.size,
            });
        }
    } else {
        fail("expected a platforms object or artifacts array");
    }
    if (Object.keys(platforms).length === 0) {
        fail("platforms must not be empty");
    }

    return { version: raw.version, platforms };
}

function parseAsset(target: string, value: unknown): RuntimeAsset {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail(`platform "${target}" must be an object`);
    }
    const raw = value as Record<string, unknown>;

    const filename = raw.filename;
    if (
        typeof filename !== "string" ||
        filename.length === 0 ||
        filename === "." ||
        filename === ".." ||
        filename.includes("/") ||
        filename.includes("\\") ||
        filename.includes("\0")
    ) {
        fail(`platform "${target}" has an invalid filename`);
    }

    const sha256 = raw.sha256;
    if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) {
        fail(`platform "${target}" has an invalid sha256`);
    }

    const size = raw.size;
    if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) {
        fail(`platform "${target}" has an invalid size`);
    }

    return { filename, sha256: sha256.toLowerCase(), size };
}
