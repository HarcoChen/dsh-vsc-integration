import { readFile } from "node:fs/promises";
import { isRecord } from "./guards";
import { t } from "./localize";

export const HEADLESS_BUNDLE = "@deepseek-ai/dsh-headless";

export class IncompatibleWebProfileError extends Error {}

export function assertWebBundle(name: string): void {
    if (name === HEADLESS_BUNDLE) {
        throw new IncompatibleWebProfileError(t("Headless must run in a separate CLI profile. It cannot be enabled in a Web Runtime."));
    }
}

/** Inspect only the selected local profile; do not rewrite the user's bundle selection. */
export async function assertWebProfileCompatible(manifestPath: string): Promise<void> {
    let manifest: unknown;
    try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
        // Missing profiles are initialized by DSH; malformed profiles retain its own diagnostic.
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return;
        throw error;
    }
    if (!isRecord(manifest) || !isRecord(manifest.dsh) || !isRecord(manifest.dsh.profile)) return;
    const bundles = manifest.dsh.profile.bundles;
    if (Array.isArray(bundles) && bundles.includes(HEADLESS_BUNDLE)) {
        throw new IncompatibleWebProfileError(t(
            "The Web profile selects the incompatible Headless bundle. Remove {name} from dsh.profile.bundles in {path}, then restart. Use a separate profile for Headless.",
            { name: HEADLESS_BUNDLE, path: manifestPath },
        ));
    }
}
