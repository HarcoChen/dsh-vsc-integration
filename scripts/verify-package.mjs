import { execFileSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles } from "@vscode/vsce";

const root = fileURLToPath(new URL("../", import.meta.url));
const vendor = "vendor/dsh-jev-integration";
const required = new Set([
    `${vendor}/package.json`,
    `${vendor}/dist/runtime/src/index.js`,
    `${vendor}/dist/protocol/src/index.js`,
    `${vendor}/dist/protocol/schema/jev-integration.schema.json`,
]);

// The pinned submodule already contains compiled output; no separate build or
// dependency installation is needed, but an uninitialized checkout must fail.
for (const path of required) {
    const file = await stat(join(root, path)).catch(() => undefined);
    if (!file?.isFile()) {
        throw new Error(`Missing vendored Jev file: ${path}. Run git submodule update --init --recursive.`);
    }
}

// Check every shipped module so excluding an imported policy or helper also
// blocks packaging, even when the entry point itself is still included.
for (const path of await readdir(join(root, vendor, "dist"), { recursive: true })) {
    if (path.endsWith(".js")) {
        required.add(`${vendor}/dist/${path.split(sep).join("/")}`);
    }
}

// Without an argument, check vsce's file selection (including .vscodeignore).
// Release CI passes the actual VSIX to verify the archive before publishing.
const vsix = process.argv[2];
const files = new Set(vsix
    ? execFileSync("unzip", ["-Z1", vsix], { encoding: "utf8" }).trim().split(/\r?\n/)
    : await listFiles({ cwd: root }));
const prefix = vsix ? "extension/" : "";
const missing = [...required].filter(path => !files.has(`${prefix}${path}`));
if (missing.length > 0) {
    throw new Error(`Vendored Jev files are missing from ${vsix ?? "the VSIX file list"}:\n${missing.join("\n")}\nCheck .vscodeignore and the submodule checkout.`);
}
console.log(`Verified ${required.size} vendored Jev files in ${vsix ?? "the VSIX file list"}.`);
