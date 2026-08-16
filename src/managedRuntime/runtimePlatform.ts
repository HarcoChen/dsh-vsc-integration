import { join } from "node:path";
import { t } from "../localize";

export type PlatformKey = `${NodeJS.Platform}-${string}`;

const SUPPORTED_TARGETS: ReadonlyArray<{ key: string; target: string }> = [
    { key: "darwin-arm64", target: "darwin-arm64" },
    { key: "darwin-x64", target: "darwin-x64" },
    { key: "linux-arm64", target: "linux-arm64" },
    { key: "linux-x64", target: "linux-x64" },
    { key: "win32-x64", target: "win32-x64" },
];

/** All platform targets that ship a prebuilt Runtime asset. */
export function supportedTargets(): string[] {
    return SUPPORTED_TARGETS.map((entry) => entry.target);
}

/**
 * Map the current VS Code / Node platform to a Runtime asset target.
 * Fails before any download when the platform has no prebuilt asset.
 */
export function resolveTarget(
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
): string {
    const key = `${platform}-${arch}`;
    const entry = SUPPORTED_TARGETS.find((candidate) => candidate.key === key);
    if (!entry) {
        throw new Error(
            t("This platform ({platform}) is not supported by the managed DSH Runtime. Supported targets: {targets}.", {
                platform: key,
                targets: supportedTargets().join(", "),
            }),
        );
    }
    return entry.target;
}

export function isWindowsTarget(target: string): boolean {
    return target.startsWith("win32-");
}

/** dsh-runtime-v<version>-<target>.tar.gz (or .zip on Windows). */
export function archiveFilename(version: string, target: string): string {
    const base = `dsh-runtime-v${version}-${target}`;
    return isWindowsTarget(target) ? `${base}.zip` : `${base}.tar.gz`;
}

export function launcherName(target: string): string {
    return isWindowsTarget(target) ? "dsh.cmd" : "dsh";
}

/** <runtimeRoot>/dsh-runtime/bin/dsh[.cmd] */
export function launcherPath(runtimeRoot: string, target: string): string {
    return join(runtimeRoot, "dsh-runtime", "bin", launcherName(target));
}

/** <runtimeRoot>/dsh-runtime/app/node_modules — required runtime data. */
export function runtimeDataDir(runtimeRoot: string): string {
    return join(runtimeRoot, "dsh-runtime", "app", "node_modules");
}
