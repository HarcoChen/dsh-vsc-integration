#!/usr/bin/env node
// Composer attachment presentation logic: file-kind glyphs, size labels, and
// the paste/drop routing that decides image drafts from file drafts.
// Usage: node scripts/verify-file-drafts.mjs
// Bundles the webview component so this runs without a browser or React.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// The bundles stay inside the repository so their `react` import resolves
// against the installed devDependency; a temp-directory bundle cannot.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = mkdtempSync(join(root, "node_modules", ".dsh-file-drafts-"));

// The i18n module reads the document language when it loads, which the module
// graph reaches through the component. Only that one lookup is needed here.
globalThis.document = { documentElement: { lang: "en" } };
const bundle = async (entry) => {
    const file = join(out, entry.replace(/\W/gu, "_") + ".mjs");
    // The browser bundle leaves React external, so the component module loads
    // under Node without a React runtime.
    await build({
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        platform: "node",
        external: ["react"],
        outfile: file,
    });
    return import(pathToFileURL(file).href);
};

const failures = [];
async function scenario(label, run) {
    try { await run(); console.log(`PASS ${label}`); }
    catch (error) { failures.push(error); console.error(`FAIL ${label}: ${error.message}`); }
}

try {
    const drafts = await bundle("webview/src/components/FileDrafts.tsx");
    const icons = await bundle("webview/src/components/FileTypeIcon.tsx");

    await scenario("size labels follow the product units at every boundary", () => {
        assert.equal(drafts.fileSizeText(916), "916B");
        assert.equal(drafts.fileSizeText(1024), "1.0KB");
        assert.equal(drafts.fileSizeText(10240), "10KB");
        assert.equal(drafts.fileSizeText(2 * 1024 * 1024), "2.0MB");
        assert.equal(drafts.fileSizeText(14508565), "14MB");
        assert.equal(drafts.fileSizeText(6 * 1024 ** 3), "6.0GB");
    });

    await scenario("extension parsing survives paths, dots, and dotfiles", () => {
        assert.equal(drafts.fileExtension("a/b/c.tar.gz"), "gz");
        assert.equal(drafts.fileExtension("dir\\notes.PDF"), "PDF");
        assert.equal(drafts.fileExtension("README"), "");
        // A leading dot is a hidden name, not an extension.
        assert.equal(drafts.fileExtension(".gitignore"), "");
    });

    await scenario("glyph kind resolves by extension, then by whole name", () => {
        assert.equal(icons.fileKind("report.pdf"), "pdf");
        assert.equal(icons.fileKind("data.xlsx"), "excel");
        assert.equal(icons.fileKind("clip.mp4"), "video");
        assert.equal(icons.fileKind("logs.zip"), "zip");
        assert.equal(icons.fileKind("notes.md"), "markdown");
        assert.equal(icons.fileKind("CHANGELOG"), "markdown");
        assert.equal(icons.fileKind("mystery.xyz"), "other");
        // Unclassified types still render, as the plain page.
        assert.equal(icons.fileKind("no-extension"), "other");
    });

    await scenario("paste routing separates images without dropping the rest", () => {
        const png = { type: "image/png", name: "a.png" };
        const zip = { type: "", name: "b.zip" };
        const pdf = { type: "application/pdf", name: "c.pdf" };
        const { images, others } = drafts.splitImageFiles([png, zip, pdf]);
        assert.deepEqual(images.map((file) => file.name), ["a.png"]);
        // A browser reports an empty type for .zip, which the old filter dropped.
        assert.deepEqual(others.map((file) => file.name), ["b.zip", "c.pdf"]);
    });
} finally {
    rmSync(out, { recursive: true, force: true });
}

if (failures.length > 0) {
    console.error(`${failures.length} scenario(s) failed`);
    process.exit(1);
}
console.log("file-drafts smoke: all scenarios passed");
