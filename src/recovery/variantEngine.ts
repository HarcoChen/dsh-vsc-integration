import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { t } from "../localize";
import { recomputeComposition } from "./composition";
import type {
    Attribution,
    CandidateFix,
    CompositionDescriptor,
    CompositionVariant,
    HealthEvidence,
    RecoveryBudget,
    VariantKind,
} from "./types";

function pathKey(path: string): string {
    const resolvedPath = resolve(path);
    return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

function idFor(kind: VariantKind, target: readonly string[]): string {
    const digest = createHash("sha256")
        .update(`${kind}:${target.join("\0")}`)
        .digest("hex")
        .slice(0, 12);
    return `${kind}-${digest}`;
}

function bundleVariant(
    base: CompositionDescriptor,
    kind: VariantKind,
    selected: readonly string[],
    assumption: string,
): CompositionVariant {
    const selectedSet = new Set(selected);
    const bundles = base.bundles.map((bundle) => ({
        ...bundle,
        selected: bundle.origin === "installation" ? bundle.selected : selectedSet.has(bundle.packageName),
    }));
    const composition = recomputeComposition(base, { bundles });
    return {
        id: idFor(kind, selected),
        kind,
        parentHash: base.compositionHash,
        assumption,
        bundleSelection: bundles.filter(bundle => bundle.selected).map(bundle => bundle.packageName),
        composition,
    };
}

function overlayVariant(base: CompositionDescriptor): CompositionVariant {
    const removed = [...base.extensionOverlayPaths];
    const remaining = new Set(removed.map(pathKey));
    const patchLayers = base.patchLayers.filter((layer) => !remaining.has(pathKey(layer.path)));
    const composition = recomputeComposition(base, {
        patchLayers,
        extensionOverlayPaths: [],
    });
    const candidate: CandidateFix = {
        id: idFor("v4-extension-overlays-removed", removed),
        kind: "remove-extension-overlay",
        targetIds: removed.map((path) => basename(path)),
        reason: "The composition becomes healthy after removing the extension-owned patch layer.",
        evidenceBootIds: [],
        precondition: {
            runtimeMustBeDead: true,
            expectedSourceHashes: Object.fromEntries(
                base.patchLayers
                    .filter((layer) => removed.some((path) => pathKey(path) === pathKey(layer.path)))
                    .map((layer) => [layer.path, layer.contentHash ?? ""]),
            ),
        },
        removedPatchPaths: removed,
        restore: {
            kind: "remove-managed-state",
            target: "recovery/active-fixes.json",
            displayCommand: "Remove the recovery overlay state",
            requiresConfirmation: false,
        },
    };
    return {
        id: idFor("v4-extension-overlays-removed", removed),
        kind: "v4-extension-overlays-removed",
        parentHash: base.compositionHash,
        assumption: "The extension-owned patch layer is the failing part of the boot composition.",
        removedOverlayPaths: removed,
        composition,
        candidateFix: candidate,
    };
}

function bundleCandidate(
    base: CompositionDescriptor,
    variant: CompositionVariant,
    removed: readonly string[],
): CandidateFix | undefined {
    if (removed.length === 0 || removed.length > 2 || !base.profileManifestPath) return undefined;
    const targets = base.bundles.filter((bundle) =>
        removed.includes(bundle.packageName) && bundle.origin === "profile-dependency",
    );
    if (targets.length !== removed.length) return undefined;
    return {
        id: idFor(variant.kind, removed),
        kind: "disable-profile-bundles",
        targetIds: [...removed],
        reason: `Profile dependency bundle candidate: ${removed.join(", ")}`,
        evidenceBootIds: [],
        precondition: {
            runtimeMustBeDead: true,
            expectedSourceHashes: {
                [base.profileManifestPath]: base.profilePackageHash ?? "",
            },
        },
        profileManifestPath: base.profileManifestPath,
        expectedProfileManifestHash: base.profilePackageHash,
        restore: {
            kind: "restore-json",
            target: base.profileManifestPath,
            expectedHash: base.profilePackageHash,
            displayCommand: `Restore the managed bundle list in ${base.profileManifestPath}`,
            requiresConfirmation: true,
        },
    };
}

export class VariantEngine {
    public plan(composition: CompositionDescriptor, budget: RecoveryBudget): CompositionVariant[] {
        const variants: CompositionVariant[] = [];
        const seen = new Set<string>();
        const add = (variant: CompositionVariant): void => {
            if (seen.has(variant.composition.compositionHash)) {
                budget.skipped.push({ variantId: variant.id, reason: "duplicate" });
                return;
            }
            seen.add(variant.composition.compositionHash);
            variants.push(variant);
        };

        add({
            id: idFor("v1-reproduce", [composition.compositionHash]),
            kind: "v1-reproduce",
            parentHash: composition.compositionHash,
            assumption: "The failure was transient; reproduce the exact launch composition.",
            composition,
        });

        if (composition.extensionOverlayPaths.length > 0) {
            add(overlayVariant(composition));
        }

        const userBundles = composition.bundles
            .filter((bundle) => bundle.selected && bundle.origin === "profile-dependency")
            .map((bundle) => bundle.packageName);
        if (userBundles.length > 0) {
            const empty = bundleVariant(
                composition,
                "v3-all-user-bundles-removed",
                [],
                "All non-installation bundles are removed in the sandbox to test the core/profile baseline.",
            );
            if (userBundles.length === 1) {
                empty.candidateFix = bundleCandidate(composition, empty, userBundles);
            }
            add(empty);

            const addSelection = (kind: VariantKind, selected: string[], assumption: string): void => {
                const variant = bundleVariant(composition, kind, selected, assumption);
                const removed = userBundles.filter(name => !selected.includes(name));
                variant.candidateFix = bundleCandidate(composition, variant, removed);
                add(variant);
            };
            const midpoint = Math.ceil(userBundles.length / 2);
            const halves = [userBundles.slice(0, midpoint), userBundles.slice(midpoint)];
            for (const half of halves.filter(half => half.length)) {
                addSelection("v3-bundle-half-added", half, `Only this bundle half is retained: ${half.join(", ")}`);
            }
            for (const bundle of userBundles) {
                addSelection("v3-bundle-singleton", [bundle], `Only this bundle is retained: ${bundle}`);
            }
        }
        const limit = Math.max(1, budget.maxBoots);
        const plannedBundles = userBundles.length;
        budget.reserved = {
            v1: 1,
            v3: plannedBundles ? 1 + Math.ceil(Math.log2(plannedBundles)) + 1 : 0,
            v4: composition.extensionOverlayPaths.length ? 1 : 0,
            confirmation: 1,
        };
        if (budget.reserved.v1 + budget.reserved.v3 + budget.reserved.v4 + budget.reserved.confirmation > limit) {
            budget.skipped.push({ variantId: "budget-shortfall", reason: "budget" });
        }
        for (const dropped of variants.slice(limit)) {
            budget.skipped.push({ variantId: dropped.id, reason: "budget" });
        }
        return variants.slice(0, limit);
    }

    /** Confirm that re-adding only the candidate set reproduces the original failure. */
    public readdConfirmation(
        base: CompositionDescriptor,
        targetIds: readonly string[],
    ): CompositionVariant {
        return bundleVariant(
            base,
            "v3-confirm-culprit",
            targetIds,
            `Re-add only the candidate bundle set (${targetIds.join(", ")}) to confirm it is the culprit.`,
        );
    }

    public explain(
        variant: CompositionVariant,
        evidence: readonly HealthEvidence[],
    ): Attribution | undefined {
        const current = evidence.find((item) => item.variantId === variant.id);
        if (!current || current.verdict !== "healthy") return undefined;
        if (variant.kind === "v1-reproduce") {
            return {
                category: "transient",
                confidence: "medium",
                culpritIds: [],
                humanSummary: t("The original composition recovered in the sandbox; the fault looks like a transient startup failure."),
            };
        }
        if (variant.kind === "v4-extension-overlays-removed") {
            return {
                category: "extension-overlay",
                confidence: "high",
                culpritIds: variant.removedOverlayPaths ?? [],
                humanSummary: t("The sandbox passed its health probe once the extension overlay was removed."),
            };
        }
        return {
            category: "bundle",
            confidence: variant.candidateFix?.targetIds.length === 1 ? "high" : "medium",
            culpritIds: variant.candidateFix?.targetIds ?? [],
            humanSummary: t(
                    "The sandbox passed its health probe after shrinking the bundle set: {targets}",
                    { targets: variant.candidateFix?.targetIds.join(", ") || t("bundle interaction") },
                ),
        };
    }
}
