import { isRecord } from "./guards";
import type {
    DshPluginFiberPhase,
    DshPluginInventoryEntry,
    DshPluginInventoryPreset,
    DshPluginInventoryRow,
    DshPluginInventorySnapshot,
    DshPluginPresetEnablement,
    DshPluginChangeResult,
    DshPluginInspection,
} from "./types";

const MAX_PLUGIN_ENTRIES = 1_000;
const MAX_PLUGIN_PRESETS = 256;
const MAX_PLUGIN_ROWS = 1_000;

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

/** Persistence and application are independent in the Plugin Manager response. */
export function normalizePluginChange(value: unknown): DshPluginChangeResult | undefined {
    if (!isRecord(value) || typeof value.changed !== "boolean" || typeof value.target !== "string" ||
        typeof value.application !== "string" || !["applied", "restart-required", "overridden", "failed", "cancelled"].includes(value.application) ||
        (value.warnings !== undefined && (!Array.isArray(value.warnings) || !value.warnings.every(item => typeof item === "string"))) ||
        (value.error !== undefined && (!isRecord(value.error) || typeof value.error.code !== "string" ||
            (value.error.diagnostic !== undefined && typeof value.error.diagnostic !== "string"))) ||
        (value.pendingBuilds !== undefined && (!Array.isArray(value.pendingBuilds) || !value.pendingBuilds.every(nonEmptyString))) ||
        (value.packageResult !== undefined && (!isRecord(value.packageResult) || !Number.isSafeInteger(value.packageResult.exitCode) ||
            typeof value.packageResult.output !== "string" || typeof value.packageResult.truncated !== "boolean" ||
            typeof value.packageResult.logPath !== "string" || (value.packageResult.kind !== undefined && typeof value.packageResult.kind !== "string")))) return undefined;
    return {
        changed: value.changed,
        application: value.application as DshPluginChangeResult["application"],
        target: value.target,
        ...(value.pendingBuilds === undefined ? {} : { pendingBuilds: [...value.pendingBuilds as string[]] }),
        ...(isRecord(value.packageResult) ? { packageResult: {
            exitCode: value.packageResult.exitCode as number,
            output: value.packageResult.output as string,
            truncated: value.packageResult.truncated as boolean,
            logPath: value.packageResult.logPath as string,
            ...(value.packageResult.kind === undefined ? {} : { kind: value.packageResult.kind as string }),
        } } : {}),
        ...(value.warnings === undefined ? {} : { warnings: [...value.warnings as string[]] }),
        ...(isRecord(value.error) ? { error: {
            code: value.error.code as string,
            ...(typeof value.error.diagnostic === "string" ? { diagnostic: value.error.diagnostic } : {}),
        } } : {}),
    };
}

export function normalizePluginInspection(value: unknown): DshPluginInspection | undefined {
    if (!isRecord(value)) return undefined;
    if (value.status === "refused" && typeof value.problem === "string" && typeof value.reason === "string") {
        return { status: "refused", problem: value.problem, reason: value.reason };
    }
    if (value.status !== "accepted" || typeof value.kind !== "string" ||
        (value.bundle !== null && typeof value.bundle !== "boolean") ||
        (value.registry !== null && typeof value.registry !== "string") ||
        ["name", "version", "description", "host"].some(key => value[key] !== undefined && typeof value[key] !== "string")) return undefined;
    return { status: "accepted", kind: value.kind, bundle: value.bundle, registry: value.registry,
        ...(value.name === undefined ? {} : { name: value.name as string }),
        ...(value.version === undefined ? {} : { version: value.version as string }),
        ...(value.description === undefined ? {} : { description: value.description as string }),
        ...(value.host === undefined ? {} : { host: value.host as string }) };
}

function fiberPhase(value: unknown): value is DshPluginFiberPhase {
    return value === null || value === "pending" || value === "loading" || value === "active" ||
        value === "failed" || value === "unloading";
}

function inventoryEntry(value: unknown): DshPluginInventoryEntry | undefined {
    if (
        !isRecord(value) ||
        !nonEmptyString(value.entryId) ||
        !nonEmptyString(value.moduleName) ||
        typeof value.enabled !== "boolean" ||
        !fiberPhase(value.fiberPhase)
    ) return undefined;
    return {
        entryId: value.entryId,
        moduleName: value.moduleName,
        enabled: value.enabled,
        fiberPhase: value.fiberPhase,
    };
}

function presetEnablement(value: unknown): value is DshPluginPresetEnablement {
    return typeof value === "boolean" || value === "conditional";
}

function inventoryRow(value: unknown): DshPluginInventoryRow | undefined {
    if (
        !isRecord(value) ||
        (value.entryId !== null && !nonEmptyString(value.entryId)) ||
        !nonEmptyString(value.moduleName) ||
        !presetEnablement(value.enabled) ||
        !fiberPhase(value.fiberPhase) ||
        (value.condition !== undefined && typeof value.condition !== "string")
    ) return undefined;
    return {
        entryId: value.entryId,
        moduleName: value.moduleName,
        enabled: value.enabled,
        fiberPhase: value.fiberPhase,
        ...(value.condition === undefined ? {} : { condition: value.condition }),
    };
}

function inventoryPreset(value: unknown): DshPluginInventoryPreset | undefined {
    if (
        !isRecord(value) ||
        !nonEmptyString(value.id) ||
        (value.trust !== undefined && value.trust !== "system" && value.trust !== "user") ||
        typeof value.isDefault !== "boolean" ||
        !Array.isArray(value.rows) ||
        value.rows.length > MAX_PLUGIN_ROWS ||
        (value.name !== undefined && typeof value.name !== "string") ||
        (value.broken !== undefined && typeof value.broken !== "string")
    ) return undefined;
    const rows = value.rows.map(inventoryRow);
    if (rows.some((row) => row === undefined)) return undefined;
    return {
        id: value.id,
        ...(value.trust === undefined ? {} : { trust: value.trust }),
        isDefault: value.isDefault,
        ...(value.name === undefined ? {} : { name: value.name }),
        ...(value.broken === undefined ? {} : { broken: value.broken }),
        rows: rows as DshPluginInventoryRow[],
    };
}

/** Validate and detach the point-in-time `pluginInventory/list` response. */
export function normalizePluginInventory(value: unknown): DshPluginInventorySnapshot | undefined {
    if (
        !isRecord(value) ||
        !Array.isArray(value.entries) ||
        value.entries.length > MAX_PLUGIN_ENTRIES ||
        (value.agentPresets !== undefined &&
            (!Array.isArray(value.agentPresets) || value.agentPresets.length > MAX_PLUGIN_PRESETS))
    ) return undefined;

    const entries = value.entries.map(inventoryEntry);
    if (entries.some((entry) => entry === undefined)) return undefined;
    const entryIds = new Set<string>();
    for (const entry of entries as DshPluginInventoryEntry[]) {
        if (entryIds.has(entry.entryId)) return undefined;
        entryIds.add(entry.entryId);
    }

    if (value.agentPresets === undefined) {
        return { entries: entries as DshPluginInventoryEntry[] };
    }
    const agentPresets = value.agentPresets.map(inventoryPreset);
    if (agentPresets.some((preset) => preset === undefined)) return undefined;
    const presetIds = new Set<string>();
    for (const preset of agentPresets as DshPluginInventoryPreset[]) {
        if (presetIds.has(preset.id)) return undefined;
        presetIds.add(preset.id);
    }
    return {
        entries: entries as DshPluginInventoryEntry[],
        agentPresets: agentPresets as DshPluginInventoryPreset[],
    };
}
