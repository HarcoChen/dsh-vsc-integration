// Derives the zh-hans locale files from their zh-cn sources.
//
// VS Code does not fall back from zh-hans to zh-cn: a zh-Hans environment that
// finds no zh-hans file renders the English source string instead. That bug was
// hit in 0.5.3 for the command palette and fixed by adding package.nls.zh-hans,
// but the l10n bundle was never given the same treatment, so runtime messages
// stayed English there. Both are generated here so the two locales cannot drift.

import { copyFileSync, existsSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);

/** @type {ReadonlyArray<{ source: string, derived: string }>} */
const PAIRS = [
    { source: "package.nls.zh-cn.json", derived: "package.nls.zh-hans.json" },
    { source: "l10n/bundle.l10n.zh-cn.json", derived: "l10n/bundle.l10n.zh-hans.json" },
];

for (const { source, derived } of PAIRS) {
    const sourceUrl = new URL(source, root);
    if (!existsSync(sourceUrl)) {
        throw new Error(`Locale source is missing: ${source}`);
    }
    // Fail loudly on malformed JSON rather than shipping a broken bundle.
    JSON.parse(readFileSync(sourceUrl, "utf8"));
    copyFileSync(sourceUrl, new URL(derived, root));
    console.log(`[locales] ${source} -> ${derived}`);
}
