import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The package name used by the shared Runtime integration. */
export const JEV_INTEGRATION_PACKAGE = "dsh-jev-integration";

export const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_JEV_MODEL = "jev-latest";
export const DEFAULT_JEV_TIMEOUT_MS = 2_000;
export const DEFAULT_JEV_ADVISORY_TIMEOUT_MS = 3_500;
export const DEFAULT_JEV_ASK_THRESHOLD = 0.5;
export const DEFAULT_JEV_BLOCK_THRESHOLD = 0.85;
export const DEFAULT_JEV_GUARDED_TOOLS = [
    "bash",
    "pwsh",
    "terminal",
    "run_command",
    "execute_command",
    "run_code",
    "write_to_file",
    "replace_file_content",
] as const;

export interface JevIntegrationConfig {
    enabled: boolean;
    baseUrl: string;
    model: string;
    timeoutMs: number;
    advisoryTimeoutMs: number;
    askThreshold: number;
    blockThreshold: number;
    guardedTools: readonly string[];
}

interface PackageManifest {
    name?: unknown;
    version?: unknown;
}

export interface JevIntegrationPatchOptions {
    /** The installed extension root, containing vendor/dsh-jev-integration. */
    extensionPath: string;
    /** A private extension-owned directory for generated launch overlays. */
    outputDirectory: string;
    config: JevIntegrationConfig;
    onDiagnostic?: (message: string) => void;
}

function isValidHttpUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
}

function boundedInteger(value: number, fallback: number): number {
    return Number.isInteger(value) && value >= 1 && value <= 120_000 ? value : fallback;
}

function boundedThreshold(value: number, fallback: number): number {
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function normalizedConfig(config: JevIntegrationConfig): Record<string, unknown> {
    const askThreshold = boundedThreshold(config.askThreshold, DEFAULT_JEV_ASK_THRESHOLD);
    const blockThreshold = Math.max(
        askThreshold,
        boundedThreshold(config.blockThreshold, DEFAULT_JEV_BLOCK_THRESHOLD),
    );
    const baseUrl = isValidHttpUrl(config.baseUrl) ? config.baseUrl : DEFAULT_JEV_BASE_URL;
    const model = config.model.trim() || DEFAULT_JEV_MODEL;
    const guardedTools = [...new Set(config.guardedTools.filter((tool) => tool.trim().length > 0))];
    return {
        enabled: config.enabled === true,
        baseUrl,
        model,
        timeoutMs: boundedInteger(config.timeoutMs, DEFAULT_JEV_TIMEOUT_MS),
        advisoryTimeoutMs: boundedInteger(config.advisoryTimeoutMs, DEFAULT_JEV_ADVISORY_TIMEOUT_MS),
        askThreshold,
        blockThreshold,
        guardedTools: guardedTools.length > 0 ? guardedTools : [...DEFAULT_JEV_GUARDED_TOOLS],
    };
}

/**
 * Prepare the launch overlay that mounts the vendored Jev Runtime package.
 *
 * The plugin is loaded by absolute entry path, so the DSH profile and its
 * package manifest remain untouched. Missing vendor contents are treated as an
 * optional development checkout and simply disable this overlay.
 */
export async function prepareJevIntegrationPatch(
    options: JevIntegrationPatchOptions,
): Promise<string | undefined> {
    const packageRoot = join(options.extensionPath, "vendor", JEV_INTEGRATION_PACKAGE);
    const packageManifestPath = join(packageRoot, "package.json");
    const packageEntryPath = join(packageRoot, "dist", "runtime", "src", "index.js");
    let manifest: PackageManifest;
    try {
        manifest = JSON.parse(await readFile(packageManifestPath, "utf8")) as PackageManifest;
        await access(packageEntryPath);
    } catch (error) {
        options.onDiagnostic?.(
            `[dsh:jev] built-in integration is unavailable at ${packageRoot}: ${String(error)}`,
        );
        return undefined;
    }
    if (manifest.name !== JEV_INTEGRATION_PACKAGE) {
        options.onDiagnostic?.(
            `[dsh:jev] ignoring vendored package with unexpected name ${String(manifest.name)}`,
        );
        return undefined;
    }

    await mkdir(options.outputDirectory, { recursive: true });
    const patchPath = join(options.outputDirectory, "jev-integration.patch.yml");
    const patch = [{
        insert: [{
            id: JEV_INTEGRATION_PACKAGE,
            // DSH converts absolute insert names to file URLs before loading;
            // this avoids profile-local installs and works for managed DSH too.
            name: packageEntryPath,
            config: normalizedConfig(options.config),
        }],
    }];
    await writeFile(patchPath, `${JSON.stringify(patch, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
    options.onDiagnostic?.(
        `[dsh:jev] mounted ${JEV_INTEGRATION_PACKAGE}${typeof manifest.version === "string" ? `@${manifest.version}` : ""}`,
    );
    return patchPath;
}
