import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The package name used by the shared Runtime integration. */
export const JEV_INTEGRATION_PACKAGE = "dsh-jev-integration";
/** SecretStorage key used by the extension-managed Jev credential. */
export const JEV_API_KEY_SECRET = "dsh.jev.apiKey";

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

export const DEFAULT_JEV_LOOP_GUARD = {
    enabled: false,
    triggerThreshold: 2,
    noProgressThreshold: 0.3,
    pLoopThreshold: 0.6,
    minConfidence: 0.5,
    cooldownSteps: 3,
    maxHistory: 8,
    deferExactRepeats: true,
    requestTimeoutMs: 3_500,
    include: [] as const,
    exclude: [] as const,
} as const;

export const DEFAULT_JEV_RESULT_SHAPER = {
    enabled: false,
    shapeTools: ["bash", "pwsh", "terminal", "run_command", "execute_command"] as const,
    thresholdChars: 8_000,
    maxPerTurn: 2,
    keepKinds: ["warning", "failure"] as const,
    minKindConfidence: 0.6,
    maxClusters: 24,
    sampleChars: 400,
    requestTimeoutMs: 4_000,
} as const;

export const DEFAULT_JEV_DONE_GATE = {
    enabled: false,
    blockThreshold: 0.75,
    minEvidenceItems: 1,
    requestTimeoutMs: 3_500,
    maxClaimChars: 4_000,
    cooldownTurns: 1,
} as const;

export const DEFAULT_JEV_TOOL_PRUNER = {
    enabled: false,
    maxTools: 8,
    minScoreThreshold: 2,
    minConfidence: 0.5,
    minIntentChars: 8,
    minKeep: 3,
    maxCandidates: 50,
    requestTimeoutMs: 4_000,
    alwaysRetain: [
        "run_code", "skill", "jev_ask", "jev_rank", "jev_check",
        "read_file", "write_to_file", "write_file", "edit_file",
        "str_replace_editor", "bash", "terminal", "pwsh", "run_command",
        "execute_command", "grep", "glob", "find_by_name", "view_file",
        "replace_file_content",
    ] as const,
} as const;

export const DEFAULT_JEV_SKILL_ROUTER = {
    enabled: false,
    minCandidates: 8,
    minIntentChars: 12,
    maxSkills: 2,
    maxCandidates: 32,
    minScore: 1.5,
    minConfidence: 0.5,
    nameMatchBoost: 0.6,
    maxAdviceChars: 1_200,
    requestTimeoutMs: 4_000,
} as const;

export const DEFAULT_JEV_DECISION_TOOLS = {
    enabled: false,
    requestTimeoutMs: 3_500,
    maxStateChars: 12_000,
    maxQuestionChars: 1_500,
    maxQuestions: 16,
    maxCandidates: 50,
    maxCandidateChars: 600,
    maxResultChars: 4_000,
} as const;

export const DEFAULT_JEV_DETERMINISTIC_SAFETY_GUARD = {
    enabled: true,
    maxArgumentChars: 32_000,
} as const;

export interface JevLoopGuardConfig {
    enabled: boolean;
    triggerThreshold: number;
    noProgressThreshold: number;
    pLoopThreshold: number;
    minConfidence: number;
    cooldownSteps: number;
    maxHistory: number;
    deferExactRepeats: boolean;
    requestTimeoutMs: number;
    include: readonly string[];
    exclude: readonly string[];
}

export interface JevResultShaperConfig {
    enabled: boolean;
    shapeTools: readonly string[];
    thresholdChars: number;
    maxPerTurn: number;
    keepKinds: readonly string[];
    minKindConfidence: number;
    maxClusters: number;
    sampleChars: number;
    requestTimeoutMs: number;
}

export interface JevDoneGateConfig {
    enabled: boolean;
    blockThreshold: number;
    minEvidenceItems: number;
    requestTimeoutMs: number;
    maxClaimChars: number;
    cooldownTurns: number;
}

export interface JevToolPrunerConfig {
    enabled: boolean;
    maxTools: number;
    minScoreThreshold: number;
    minConfidence: number;
    minIntentChars: number;
    minKeep: number;
    maxCandidates: number;
    requestTimeoutMs: number;
    alwaysRetain: readonly string[];
}

export interface JevSkillRouterConfig {
    enabled: boolean;
    minCandidates: number;
    minIntentChars: number;
    maxSkills: number;
    maxCandidates: number;
    minScore: number;
    minConfidence: number;
    nameMatchBoost: number;
    maxAdviceChars: number;
    requestTimeoutMs: number;
}

export interface JevDecisionToolsConfig {
    enabled: boolean;
    requestTimeoutMs: number;
    maxStateChars: number;
    maxQuestionChars: number;
    maxQuestions: number;
    maxCandidates: number;
    maxCandidateChars: number;
    maxResultChars: number;
}

export interface JevDeterministicSafetyGuardConfig {
    enabled: boolean;
    maxArgumentChars: number;
}

export interface JevIntegrationConfig {
    enabled: boolean;
    baseUrl: string;
    model: string;
    timeoutMs: number;
    advisoryTimeoutMs: number;
    askThreshold: number;
    blockThreshold: number;
    guardedTools: readonly string[];
    loopGuard: JevLoopGuardConfig;
    resultShaper: JevResultShaperConfig;
    doneGate: JevDoneGateConfig;
    toolPruner: JevToolPrunerConfig;
    skillRouter: JevSkillRouterConfig;
    decisionTools: JevDecisionToolsConfig;
    deterministicSafetyGuard: JevDeterministicSafetyGuardConfig;
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

function boundedIntegerFrom(value: number, fallback: number, maximum: number): number {
    return Number.isInteger(value) && value >= 1 && value <= maximum ? value : fallback;
}

function boundedThreshold(value: number, fallback: number): number {
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function normalizedStringList(value: readonly string[], fallback: readonly string[], allowEmpty = true): string[] {
    const list = [...new Set(value.filter((item) => item.trim().length > 0).map((item) => item.trim()))];
    return list.length > 0 || allowEmpty ? list : [...fallback];
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
    const loopGuard = config.loopGuard;
    const resultShaper = config.resultShaper;
    const doneGate = config.doneGate;
    const toolPruner = config.toolPruner;
    const skillRouter = config.skillRouter;
    const decisionTools = config.decisionTools;
    const deterministicSafetyGuard = config.deterministicSafetyGuard;
    return {
        enabled: config.enabled === true,
        baseUrl,
        model,
        timeoutMs: boundedInteger(config.timeoutMs, DEFAULT_JEV_TIMEOUT_MS),
        advisoryTimeoutMs: boundedInteger(config.advisoryTimeoutMs, DEFAULT_JEV_ADVISORY_TIMEOUT_MS),
        askThreshold,
        blockThreshold,
        guardedTools: guardedTools.length > 0 ? guardedTools : [...DEFAULT_JEV_GUARDED_TOOLS],
        loopGuard: {
            enabled: loopGuard.enabled === true,
            triggerThreshold: boundedIntegerFrom(loopGuard.triggerThreshold, DEFAULT_JEV_LOOP_GUARD.triggerThreshold, 120),
            noProgressThreshold: boundedThreshold(loopGuard.noProgressThreshold, DEFAULT_JEV_LOOP_GUARD.noProgressThreshold),
            pLoopThreshold: boundedThreshold(loopGuard.pLoopThreshold, DEFAULT_JEV_LOOP_GUARD.pLoopThreshold),
            minConfidence: boundedThreshold(loopGuard.minConfidence, DEFAULT_JEV_LOOP_GUARD.minConfidence),
            cooldownSteps: boundedIntegerFrom(loopGuard.cooldownSteps, DEFAULT_JEV_LOOP_GUARD.cooldownSteps, 120),
            maxHistory: boundedIntegerFrom(loopGuard.maxHistory, DEFAULT_JEV_LOOP_GUARD.maxHistory, 120),
            deferExactRepeats: loopGuard.deferExactRepeats === true,
            requestTimeoutMs: boundedInteger(loopGuard.requestTimeoutMs, DEFAULT_JEV_LOOP_GUARD.requestTimeoutMs),
            include: normalizedStringList(loopGuard.include, DEFAULT_JEV_LOOP_GUARD.include),
            exclude: normalizedStringList(loopGuard.exclude, DEFAULT_JEV_LOOP_GUARD.exclude),
        },
        resultShaper: {
            enabled: resultShaper.enabled === true,
            shapeTools: normalizedStringList(resultShaper.shapeTools, DEFAULT_JEV_RESULT_SHAPER.shapeTools, false),
            thresholdChars: boundedInteger(resultShaper.thresholdChars, DEFAULT_JEV_RESULT_SHAPER.thresholdChars),
            maxPerTurn: boundedInteger(resultShaper.maxPerTurn, DEFAULT_JEV_RESULT_SHAPER.maxPerTurn),
            keepKinds: normalizedStringList(resultShaper.keepKinds, DEFAULT_JEV_RESULT_SHAPER.keepKinds, false),
            minKindConfidence: boundedThreshold(resultShaper.minKindConfidence, DEFAULT_JEV_RESULT_SHAPER.minKindConfidence),
            maxClusters: boundedInteger(resultShaper.maxClusters, DEFAULT_JEV_RESULT_SHAPER.maxClusters),
            sampleChars: boundedInteger(resultShaper.sampleChars, DEFAULT_JEV_RESULT_SHAPER.sampleChars),
            requestTimeoutMs: boundedInteger(resultShaper.requestTimeoutMs, DEFAULT_JEV_RESULT_SHAPER.requestTimeoutMs),
        },
        doneGate: {
            enabled: doneGate.enabled === true,
            blockThreshold: boundedThreshold(doneGate.blockThreshold, DEFAULT_JEV_DONE_GATE.blockThreshold),
            minEvidenceItems: boundedInteger(doneGate.minEvidenceItems, DEFAULT_JEV_DONE_GATE.minEvidenceItems),
            requestTimeoutMs: boundedInteger(doneGate.requestTimeoutMs, DEFAULT_JEV_DONE_GATE.requestTimeoutMs),
            maxClaimChars: boundedInteger(doneGate.maxClaimChars, DEFAULT_JEV_DONE_GATE.maxClaimChars),
            cooldownTurns: boundedInteger(doneGate.cooldownTurns, DEFAULT_JEV_DONE_GATE.cooldownTurns),
        },
        toolPruner: {
            enabled: toolPruner.enabled === true,
            maxTools: boundedIntegerFrom(toolPruner.maxTools, DEFAULT_JEV_TOOL_PRUNER.maxTools, 120),
            minScoreThreshold: Number.isFinite(toolPruner.minScoreThreshold)
                && toolPruner.minScoreThreshold >= 0 && toolPruner.minScoreThreshold <= 2
                ? toolPruner.minScoreThreshold : DEFAULT_JEV_TOOL_PRUNER.minScoreThreshold,
            minConfidence: boundedThreshold(toolPruner.minConfidence, DEFAULT_JEV_TOOL_PRUNER.minConfidence),
            minIntentChars: boundedInteger(toolPruner.minIntentChars, DEFAULT_JEV_TOOL_PRUNER.minIntentChars),
            minKeep: boundedIntegerFrom(toolPruner.minKeep, DEFAULT_JEV_TOOL_PRUNER.minKeep, 120),
            maxCandidates: boundedIntegerFrom(toolPruner.maxCandidates, DEFAULT_JEV_TOOL_PRUNER.maxCandidates, 120),
            requestTimeoutMs: boundedInteger(toolPruner.requestTimeoutMs, DEFAULT_JEV_TOOL_PRUNER.requestTimeoutMs),
            alwaysRetain: normalizedStringList(toolPruner.alwaysRetain, DEFAULT_JEV_TOOL_PRUNER.alwaysRetain),
        },
        skillRouter: {
            enabled: skillRouter.enabled === true,
            minCandidates: boundedIntegerFrom(skillRouter.minCandidates, DEFAULT_JEV_SKILL_ROUTER.minCandidates, 120),
            minIntentChars: boundedInteger(skillRouter.minIntentChars, DEFAULT_JEV_SKILL_ROUTER.minIntentChars),
            maxSkills: boundedIntegerFrom(skillRouter.maxSkills, DEFAULT_JEV_SKILL_ROUTER.maxSkills, 20),
            maxCandidates: boundedIntegerFrom(skillRouter.maxCandidates, DEFAULT_JEV_SKILL_ROUTER.maxCandidates, 120),
            minScore: Number.isFinite(skillRouter.minScore)
                && skillRouter.minScore >= 0 && skillRouter.minScore <= 2
                ? skillRouter.minScore : DEFAULT_JEV_SKILL_ROUTER.minScore,
            minConfidence: boundedThreshold(skillRouter.minConfidence, DEFAULT_JEV_SKILL_ROUTER.minConfidence),
            nameMatchBoost: Number.isFinite(skillRouter.nameMatchBoost)
                && skillRouter.nameMatchBoost >= 0 && skillRouter.nameMatchBoost <= 2
                ? skillRouter.nameMatchBoost : DEFAULT_JEV_SKILL_ROUTER.nameMatchBoost,
            maxAdviceChars: boundedInteger(skillRouter.maxAdviceChars, DEFAULT_JEV_SKILL_ROUTER.maxAdviceChars),
            requestTimeoutMs: boundedInteger(skillRouter.requestTimeoutMs, DEFAULT_JEV_SKILL_ROUTER.requestTimeoutMs),
        },
        decisionTools: {
            enabled: decisionTools.enabled === true,
            requestTimeoutMs: boundedInteger(decisionTools.requestTimeoutMs, DEFAULT_JEV_DECISION_TOOLS.requestTimeoutMs),
            maxStateChars: boundedInteger(decisionTools.maxStateChars, DEFAULT_JEV_DECISION_TOOLS.maxStateChars),
            maxQuestionChars: boundedInteger(decisionTools.maxQuestionChars, DEFAULT_JEV_DECISION_TOOLS.maxQuestionChars),
            maxQuestions: boundedIntegerFrom(decisionTools.maxQuestions, DEFAULT_JEV_DECISION_TOOLS.maxQuestions, 120),
            maxCandidates: boundedIntegerFrom(decisionTools.maxCandidates, DEFAULT_JEV_DECISION_TOOLS.maxCandidates, 120),
            maxCandidateChars: boundedInteger(decisionTools.maxCandidateChars, DEFAULT_JEV_DECISION_TOOLS.maxCandidateChars),
            maxResultChars: boundedInteger(decisionTools.maxResultChars, DEFAULT_JEV_DECISION_TOOLS.maxResultChars),
        },
        deterministicSafetyGuard: {
            enabled: deterministicSafetyGuard.enabled !== false,
            maxArgumentChars: Number.isInteger(deterministicSafetyGuard.maxArgumentChars)
                && deterministicSafetyGuard.maxArgumentChars >= 1
                && deterministicSafetyGuard.maxArgumentChars <= 1_000_000
                ? deterministicSafetyGuard.maxArgumentChars : DEFAULT_JEV_DETERMINISTIC_SAFETY_GUARD.maxArgumentChars,
        },
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
