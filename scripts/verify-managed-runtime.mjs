#!/usr/bin/env node
/**
 * Verify that a published DSH Runtime release is actually usable by this
 * extension.
 *
 * The point of this script is that it drives the extension's OWN compiled
 * managedRuntime module (dist/managedRuntime) instead of re-implementing the
 * download/verify/extract logic. A passing run therefore exercises the exact
 * code path the plugin takes at runtime — provider, manifest parser, checksum
 * gate, tar/zip extractor, atomic install and integrity check — so it cannot
 * pass while the plugin would fail.
 *
 * Tiers:
 *   (default)  remote contract only: manifest + all five assets reachable with
 *              matching sizes. Seconds, no large download.
 *   --full     additionally performs a real install into a throwaway storage
 *              directory and smoke-tests the launcher, including `web`.
 *
 * Options:
 *   --version <v>   release to verify (default: the version pinned in dist)
 *   --keep          keep the temporary storage directory for inspection
 *   --port <n>      port for the `web` smoke test (default: an ephemeral one)
 */

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, rm, access } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let managed;
try {
    managed = require(join(ROOT, "dist", "managedRuntime"));
} catch (error) {
    console.error("Cannot load dist/managedRuntime — run `npm run compile` first.");
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}
const { CnbRuntimeProvider } = require(join(ROOT, "dist", "managedRuntime", "cnbProvider"));
const {
    CNB_RUNTIME_BASE_URL,
    RUNTIME_DEFAULT_VERSION,
    acquireManagedRuntime,
    checkInstalled,
    resolveTarget,
    supportedTargets,
} = managed;

// ------------------------------------------------------------------ options

function parseArgs(argv) {
    const options = { full: false, keep: false, version: RUNTIME_DEFAULT_VERSION, port: 0 };
    for (let index = 2; index < argv.length; index += 1) {
        const key = argv[index];
        if (key === "--full") options.full = true;
        else if (key === "--keep") options.keep = true;
        else if (key === "--version") options.version = argv[++index];
        else if (key === "--port") options.port = Number(argv[++index]);
        else if (key === "--remote-only") options.full = false;
        else throw new Error(`Unknown option: ${key}`);
    }
    if (!options.version) throw new Error("--version requires a value");
    return options;
}

// ------------------------------------------------------------------ reporting

const results = [];
let failed = false;

function record(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failed = true;
}

async function step(name, run) {
    try {
        const detail = await run();
        record(name, true, detail);
        return true;
    } catch (error) {
        record(name, false, error instanceof Error ? error.message : String(error));
        return false;
    }
}

function section(title) {
    console.log(`\n${title}`);
}

function mib(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

// ------------------------------------------------------------------ helpers

/** Confirm an asset is really downloadable and its size matches the manifest. */
async function probeAsset(version, asset) {
    const url = `${CNB_RUNTIME_BASE_URL}/-/releases/download/v${version}/${asset.filename}`;
    const response = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${asset.filename}`);
    const length = Number(response.headers.get("content-length"));
    if (!Number.isInteger(length) || length <= 0) {
        throw new Error(`${asset.filename}: no usable content-length`);
    }
    if (length !== asset.size) {
        throw new Error(`${asset.filename}: manifest says ${asset.size} bytes, server says ${length}`);
    }
    return `${mib(length)}, sha256 ${asset.sha256.slice(0, 12)}…`;
}

function freePort() {
    return new Promise((resolvePort, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close(() => resolvePort(port));
        });
    });
}

/** Run the launcher to completion and return its exit code plus output. */
function runLauncher(command, args, timeoutMs) {
    return new Promise((resolveRun, reject) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdout.on("data", (chunk) => { out += chunk; });
        child.stderr.on("data", (chunk) => { err += chunk; });
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("exit", (code, signal) => {
            clearTimeout(timer);
            resolveRun({ code, signal, out, err });
        });
    });
}

/**
 * Start the launcher in `web` mode the way the extension does and wait until
 * the port actually answers. Returns the captured output and stops the child.
 */
async function smokeWeb(launcher, port, timeoutMs) {
    const args = ["web", "--no-open", "--port", String(port)];
    const child = spawn(launcher, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });

    let exited;
    child.once("exit", (code, signal) => { exited = { code, signal }; });

    const deadline = Date.now() + timeoutMs;
    try {
        for (;;) {
            if (exited) {
                throw new Error(
                    `process exited early (code ${exited.code ?? exited.signal}). Output:\n${out.trim().slice(0, 800)}`,
                );
            }
            if (Date.now() > deadline) {
                throw new Error(`port ${port} never answered within ${timeoutMs}ms. Output:\n${out.trim().slice(0, 800)}`);
            }
            try {
                const response = await fetch(`http://127.0.0.1:${port}`, {
                    redirect: "manual",
                    signal: AbortSignal.timeout(2000),
                });
                // Any HTTP status proves the server is listening and serving.
                return `HTTP ${response.status} on 127.0.0.1:${port}`;
            } catch {
                await new Promise((wait) => setTimeout(wait, 400));
            }
        }
    } finally {
        child.kill("SIGTERM");
        await new Promise((wait) => setTimeout(wait, 300));
        if (exited === undefined) child.kill("SIGKILL");
    }
}

// ------------------------------------------------------------------ main

async function main() {
    const options = parseArgs(process.argv);
    const host = `${process.platform}-${process.arch}`;

    console.log(`DSH Runtime verification`);
    console.log(`  release   v${options.version}`);
    console.log(`  source    ${CNB_RUNTIME_BASE_URL}`);
    console.log(`  host      ${host}`);
    console.log(`  mode      ${options.full ? "full (download + launch)" : "remote contract only"}`);

    // ---- 1. the extension can map this host to an asset target -------------
    section("Platform mapping (runtimePlatform)");
    let target;
    await step("host platform resolves to a Runtime target", () => {
        target = resolveTarget();
        return target;
    });

    // ---- 2. the extension's own provider can fetch and parse the manifest --
    section("Remote manifest (cnbProvider + runtimeManifest)");
    const provider = new CnbRuntimeProvider(CNB_RUNTIME_BASE_URL, options.version);
    let manifest;
    const gotManifest = await step("manifest downloads anonymously and parses", async () => {
        manifest = await provider.getManifest(options.version);
        return `${Object.keys(manifest.platforms).length} platforms`;
    });
    if (!gotManifest) return finish();

    await step("manifest version matches the requested release", () => {
        if (manifest.version !== options.version) {
            throw new Error(`manifest says ${manifest.version}, requested ${options.version}`);
        }
        return manifest.version;
    });

    await step("every supported target has an asset", () => {
        const missing = supportedTargets().filter((entry) => !manifest.platforms[entry]);
        if (missing.length > 0) throw new Error(`missing: ${missing.join(", ")}`);
        return supportedTargets().join(", ");
    });

    // ---- 3. every asset is really downloadable, at the declared size -------
    section("Asset availability (permanent download route, anonymous)");
    for (const entry of supportedTargets()) {
        const asset = manifest.platforms[entry];
        if (!asset) continue;
        await step(entry, () => probeAsset(options.version, asset));
    }

    if (!options.full) {
        console.log("\nRemote contract verified. Re-run with --full to install and launch.");
        return finish();
    }

    // ---- 4. real install through the extension's own install pipeline -----
    section("Install pipeline (acquireManagedRuntime → download, sha256, extract, atomic rename)");
    const storagePath = await mkdtemp(join(tmpdir(), "dsh-runtime-verify-"));
    let runtime;
    let lastPercent = -1;
    const installed = await step(`install ${target} into a clean storage dir`, async () => {
        runtime = await acquireManagedRuntime(storagePath, {
            version: options.version,
            target,
            log: (message) => console.log(`        ${message}`),
            onPhase: (phase) => console.log(`        phase: ${phase}`),
            onDownloadProgress: (received, total) => {
                if (!total) return;
                const percent = Math.floor((received / total) * 100);
                if (percent >= lastPercent + 25) {
                    lastPercent = percent;
                    console.log(`        downloaded ${percent}% (${mib(received)} / ${mib(total)})`);
                }
            },
        });
        return `${runtime.version} (${runtime.target})`;
    });

    try {
        if (!installed) return finish();

        await step("integrity check passes on a fresh install", async () => {
            const verified = await checkInstalled(storagePath, target, options.version);
            if (!verified) throw new Error("checkInstalled rejected the install it just produced");
            return verified.versionDir.replace(storagePath, "<storage>");
        });

        await step("launcher exists and is executable", async () => {
            await access(runtime.launcherPath, constants.X_OK);
            return runtime.launcherPath.replace(storagePath, "<storage>");
        });

        await step("second acquire reuses the cache without downloading", async () => {
            const messages = [];
            const again = await acquireManagedRuntime(storagePath, {
                version: options.version,
                target,
                log: (message) => messages.push(message),
                onPhase: () => messages.push("PHASE"),
            });
            if (messages.includes("PHASE")) throw new Error("cache miss: the install pipeline ran a second time");
            return again.versionDir === runtime.versionDir ? "same version dir, no phases" : "unexpected dir";
        });

        // ---- 5. the bundled Node actually runs the bundled dsh ------------
        section("Launcher smoke test (bundled Node + full dependency tree)");
        // Cheapest proof that the bundled Node can load the bundled dsh entry
        // point at all: it parses argv and prints usage instead of failing to
        // resolve a module.
        await step("launcher --help exits 0 (bundled Node loads the bundled dsh)", async () => {
            const result = await runLauncher(runtime.launcherPath, ["--help"], 60_000);
            if (result.code !== 0) {
                throw new Error(`exit ${result.code ?? result.signal}: ${(result.err || result.out).trim().slice(0, 400)}`);
            }
            if (!result.out.includes("Usage: dsh")) {
                throw new Error(`unexpected output: ${result.out.trim().slice(0, 200)}`);
            }
            return "usage printed";
        });

        // Resolves the whole default plugin stack for the profile the plugin
        // uses, so a dependency missing from the archive shows up here.
        await step("launcher resolves the `web` profile config", async () => {
            const result = await runLauncher(
                runtime.launcherPath,
                ["--dump-default-config", "--profile", "web"],
                90_000,
            );
            if (result.code !== 0) {
                throw new Error(`exit ${result.code ?? result.signal}: ${(result.err || result.out).trim().slice(0, 400)}`);
            }
            if (result.out.trim().length === 0) {
                throw new Error("no config was produced");
            }
            return `${result.out.length} bytes of profile config`;
        });

        await step("launcher serves `web --no-open --port <n>` (the plugin's command)", async () => {
            const port = options.port > 0 ? options.port : await freePort();
            return await smokeWeb(runtime.launcherPath, port, 90_000);
        });
    } finally {
        if (options.keep) console.log(`\nKept storage directory: ${storagePath}`);
        else await rm(storagePath, { recursive: true, force: true }).catch(() => undefined);
    }

    return finish();
}

function finish() {
    const passed = results.filter((entry) => entry.ok).length;
    console.log(`\n${failed ? "FAILED" : "OK"} — ${passed}/${results.length} checks passed`);
    process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
    console.error(`\nverification aborted: ${error instanceof Error ? error.stack : error}`);
    process.exitCode = 1;
});
