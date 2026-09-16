#!/usr/bin/env node
// Integration: real CLI executables, PATH/npm-prefix discovery, startup arguments,
// versioned locks and owned-child shutdown; no downloads, model calls or user data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");
const pause = ms => new Promise(done => setTimeout(done, ms));
if (!process.argv.includes("--worker")) {
    if (process.platform === "win32") throw new Error("This executable-fixture smoke requires POSIX; run Windows validation separately.");
    const selected = process.argv.slice(2);
    for (const scenario of selected.length ? selected : ["npx-package-equals", "npx-package-separate", "npx-p-equals", "npx-p-separate", "writer-lock", "runtime-error", "download-fallback", "config-local", "config-pnpm", "config-managed", "local", "prefix", "old", "unknown", "missing", "newer", "npx-fallback", "timeout", "cancel", "explicit-old", "explicit-missing", "explicit-pnpm", "explicit-npx", "legacy-args", "legacy-version", "port-occupied", "port-unknown", "port-race", "compatible-rc2", "newer-numeric", "newer-stable", "newer-major", "compatible-build", "target-newer", "upgrade-prerelease", "upgrade-accept", "upgrade-decline", "upgrade-close", "upgrade-failed", "upgrade-mismatch", "upgrade-cancel", "upgrade-stop", "upgrade-prompt-stop", "upgrade-diagnose", "upgrade-race"]) {
        const directory = await mkdtemp(join(tmpdir(), "dsh-discovery-verify-"));
        try {
            const child = spawn(process.execPath, [script, "--worker", scenario], {
                env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory,
                    DSH_HOME: join(directory, "home"), DSH_DISCOVERY_VERIFY_DIRECTORY: directory }, stdio: "inherit",
            });
            const code = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); });
            assert.equal(code, 0, `scenario ${scenario} failed`);
        } finally { await rm(directory, { recursive: true, force: true }); }
    }
} else {
    const directory = process.env.DSH_DISCOVERY_VERIFY_DIRECTORY;
    assert.ok(directory);
    assert.equal(resolve(tmpdir()), resolve(directory));
    const scenario = process.argv.at(-1);
    const bin = join(directory, "bin");
    const prefix = join(directory, "prefix with spaces");
    const upgrading = scenario.startsWith("upgrade-");
    const compatibleVersions = {
        "compatible-rc2": "0.1.5-rc.2", newer: "0.1.5-rc.3", "newer-numeric": "0.1.5-rc.10",
        "newer-stable": "0.1.5", "newer-major": "1.0.0", "compatible-build": "0.1.5-rc.1+local.7",
    };
    const packageForms = {
        "npx-package-equals": ["--package=@deepseek-ai/dsh@next", "dsh"],
        "npx-package-separate": ["--package", "@deepseek-ai/dsh@next", "dsh"],
        "npx-p-equals": ["-p=@deepseek-ai/dsh@next", "dsh"],
        "npx-p-separate": ["-p", "@deepseek-ai/dsh@next", "dsh"],
    };
    const packageArgs = packageForms[scenario];
    const targetVersion = packageArgs ? "0.1.5-rc.2" : scenario === "target-newer" ? "1.0.0" : "0.1.5-rc.1";
    const versionFile = join(directory, "installed-version");
    const upgradeMarker = join(directory, "upgrade.json");
    if (upgrading) await writeFile(versionFile, scenario === "upgrade-prerelease" ? "0.1.5-rc.0" : "0.1.2-rc.1");
    const marker = join(directory, "launched.json");
    const attempts = join(directory, "attempts.jsonl");
    const probeMarker = join(directory, "probe-started");
    await mkdir(bin);
    await mkdir(join(prefix, "bin"), { recursive: true });
    await symlink("/bin/ps", join(bin, "ps"));
    await symlink(process.execPath, join(bin, "node"));
    const executable = async (path, name, version) => writeFile(path, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) {
    fs.writeFileSync(${JSON.stringify(probeMarker)}, ${JSON.stringify(Boolean(packageArgs))} ? JSON.stringify(args) : 'started');
    if (${JSON.stringify(version)} === 'hang') {
        fs.writeFileSync(${JSON.stringify(probeMarker)}, 'started');
        setInterval(() => {}, 1000);
    } else { console.log(${JSON.stringify(name)} === 'local' && fs.existsSync(${JSON.stringify(versionFile)}) ? fs.readFileSync(${JSON.stringify(versionFile)}, 'utf8') : ${JSON.stringify(version)}); process.exit(0); }
} else {
if (args[0] === 'prefix') { console.log(${JSON.stringify(prefix)}); process.exit(0); }
if (args[0] === 'config') { console.log('https://registry.npmjs.org'); process.exit(0); }
if (args[0] === 'install') {
    fs.writeFileSync(${JSON.stringify(upgradeMarker)}, JSON.stringify(args));
    if (${JSON.stringify(scenario)} === 'upgrade-failed') process.exit(1);
    if (['upgrade-cancel', 'upgrade-stop'].includes(${JSON.stringify(scenario)})) { setInterval(() => {}, 1000); return; }
    if (${JSON.stringify(scenario)} !== 'upgrade-mismatch') fs.writeFileSync(${JSON.stringify(versionFile)}, '0.1.5-rc.1');
    process.exit(0);
}
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({name:${JSON.stringify(name)}, args, registry: process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY}));
fs.appendFileSync(${JSON.stringify(attempts)}, JSON.stringify(args) + '\\n');
if (${JSON.stringify(scenario)} === 'writer-lock') {
    console.error('file:///cache/pnpm/store/runtime.js');
    console.error('Error: atomic-write: timed out waiting for the writer lock at /fixture/profiles/node_modules.lock');
    process.exit(1);
}
if (${JSON.stringify(scenario)} === 'runtime-error') {
    console.error('file:///cache/pnpm/store/runtime.js');
    console.error('Error: invalid profile configuration');
    process.exit(1);
}
if (${JSON.stringify(scenario)} === 'download-fallback' && !process.env.npm_config_registry && !process.env.NPM_CONFIG_REGISTRY) {
    console.error('ERR_PNPM_FETCH_502 GET https://registry.npmjs.org/@deepseek-ai/dsh: Bad Gateway');
    process.exit(1);
}
setInterval(() => {}, 1000);
}
`, { mode: 0o700 });
    const localVersion = scenario === "old" || scenario === "explicit-old" || scenario === "prefix" ? "0.1.2-rc.1"
        : compatibleVersions[scenario] ?? (scenario === "unknown" ? "not a version"
        : ["timeout", "cancel"].includes(scenario) ? "hang" : "0.1.5-rc.1");
    if (!["missing", "npx-fallback", "config-managed"].includes(scenario)) await executable(join(bin, "dsh"), "local", localVersion);
    if (scenario === "prefix") await executable(join(prefix, "bin", "dsh"), "prefix", "0.1.5-rc.1");
    if (scenario !== "config-managed") {
        if (upgrading) {
            const packageRoot = join(prefix, "lib", "node_modules", "@deepseek-ai", "dsh");
            const npmRoot = join(prefix, "lib", "node_modules", "npm");
            await mkdir(join(packageRoot, "lib"), { recursive: true });
            await mkdir(join(npmRoot, "bin"), { recursive: true });
            await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", bin: { dsh: "lib/bin.js" } }));
            await writeFile(join(npmRoot, "package.json"), JSON.stringify({ name: "npm" }));
            await executable(join(packageRoot, "lib", "bin.js"), "local", "0.1.2-rc.1");
            await rm(join(bin, "dsh"));
            await symlink(join(packageRoot, "lib", "bin.js"), join(bin, "dsh"));
            await symlink(join(packageRoot, "lib", "bin.js"), join(prefix, "bin", "dsh"));
            await executable(join(npmRoot, "bin", "npm-cli.js"), "npm", "11.0.0");
            await symlink(join(npmRoot, "bin", "npm-cli.js"), join(bin, "npm"));
        } else await executable(join(bin, "npm"), "npm", "11.0.0");
        if (scenario !== "npx-fallback") await executable(join(bin, "pnpm"), "pnpm", "10.0.0");
        await executable(join(bin, "npx"), "npx", packageArgs ? "0.1.5-rc.2" : "11.0.0");
    }
    process.env.PATH = bin;
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const defaults = manifest.contributes.configuration.properties;
    const settings = new Map([["enableCompaction", false], ["installWhenMissing", false]]);
    if (scenario.startsWith("config-")) settings.set("runtimeVersion", "0.1.2-rc.1");
    if (scenario === "config-pnpm") settings.set("command", "pnpm");
    if (scenario === "target-newer") { settings.set("command", "pnpm"); settings.set("runtimeVersion", targetVersion); }
    if (scenario === "explicit-old") settings.set("command", join(bin, "dsh"));
    if (scenario === "explicit-missing") settings.set("command", join(bin, "absent-dsh"));
    if (["explicit-pnpm", "writer-lock", "runtime-error", "download-fallback", "port-occupied", "port-unknown", "port-race"].includes(scenario)) settings.set("command", "pnpm");
    if (scenario === "runtime-error") settings.set("recovery.enabled", false);
    if (scenario === "explicit-npx") settings.set("command", "npx");
    if (scenario === "legacy-args") settings.set("commandArgs", ["dlx", "@deepseek-ai/dsh", "web", "--no-open", "--port", "49151"]);
    if (scenario === "legacy-version") settings.set("commandArgs", ["dlx", "@deepseek-ai/dsh@0.1.2-rc.1", "web", "--no-open"]);
    if (packageArgs) {
        settings.set("command", "npx");
        settings.set("commandArgs", [...packageArgs, "web", "--no-open"]);
    }
    const configuration = {
        get: (key, fallback) => settings.has(key) ? settings.get(key) : defaults[`dsh.${key}`]?.default ?? fallback,
        inspect: key => ({ defaultValue: defaults[`dsh.${key}`]?.default, globalValue: settings.get(key) }),
    };
    const require = createRequire(import.meta.url);
    const Module = require("node:module");
    const originalLoad = Module._load;
    const prompts = [];
    let pendingChoice;
    Module._load = function (id, ...args) {
        if (id === "vscode") return {
            workspace: { isTrusted: true, getConfiguration: () => configuration },
            window: {
                showWarningMessage: async (message, _options, ...choices) => {
                    prompts.push({ message, choices });
                    await assert.rejects(() => readFile(marker), { code: "ENOENT" }, "no fallback may launch before the choice");
                    if (choices.includes("Use plugin Runtime")) return "Use plugin Runtime";
                    await assert.rejects(() => readFile(upgradeMarker), { code: "ENOENT" }, "no install may start before approval");
                    if (scenario === "upgrade-prompt-stop") return new Promise(resolve => { pendingChoice = resolve; });
                    if (scenario === "upgrade-race") await writeFile(versionFile, "0.1.5-rc.2");
                    if (scenario === "upgrade-close") return undefined;
                    return upgrading && scenario !== "upgrade-decline" ? choices.find(choice => choice.startsWith("Upgrade to ")) : "Skip upgrade";
                },
                withProgress: async (_options, action) => action({ report() {} }, {
                    onCancellationRequested(callback) {
                        if (scenario !== "upgrade-cancel") return { dispose() {} };
                        const timer = setInterval(async () => {
                            try { await readFile(upgradeMarker); clearInterval(timer); callback(); } catch {}
                        }, 20);
                        return { dispose() { clearInterval(timer); } };
                    },
                }),
            },
            ProgressLocation: { Notification: 15 },
        };
        return originalLoad.call(this, id, ...args);
    };
    const { DshRuntime } = require(join(root, "dist/dshRuntime"));
    Module._load = originalLoad;
    const runtime = new DshRuntime({ appendLine() {}, append() {} }, join(directory, "storage"));
    // Exclude external Runtime discovery/RPC only; launcher selection, subprocess
    // version probes, actual spawn, argv and lock lifecycle remain production code.
    runtime.findExistingRuntime = async () => undefined;
    runtime.probeLoopbackPort = async () => scenario === "port-occupied" ? "occupied" : scenario === "port-unknown" ? "unknown" : "free";
    if (["port-occupied", "port-unknown"].includes(scenario)) {
        runtime.isHarnessHealthy = async () => false;
        runtime.isDshAuthenticationChallenge = async () => false;
    }
    runtime.harnessState.start = () => {};
    const waitForReady = runtime.waitForReady.bind(runtime);
    let readinessCalls = 0;
    runtime.waitForReady = async (...args) => {
        readinessCalls += 1;
        if (["writer-lock", "runtime-error"].includes(scenario) ||
            (scenario === "download-fallback" && readinessCalls === 1)) return waitForReady(...args);
        if (scenario === "port-race" && readinessCalls === 1) {
            const deadline = Date.now() + 3000;
            while (Date.now() < deadline) {
                try { await readFile(marker, "utf8"); break; } catch { await pause(20); }
            }
            throw new Error("simulated EADDRINUSE: address already in use");
        }
        if (scenario === "port-race") {
            const deadline = Date.now() + 3000;
            while (Date.now() < deadline) {
                try {
                    const launches = (await readFile(attempts, "utf8")).trim().split("\n").map(line => JSON.parse(line));
                    if (launches.length >= 2 && launches.at(-1).at(-1) === "0") return "http://127.0.0.1:1";
                } catch { /* Fixture has not written its retry record yet. */ }
                await pause(20);
            }
            throw new Error("CLI did not retry after the simulated bind race");
        }
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
            try {
                const launched = JSON.parse(await readFile(marker, "utf8"));
                if (scenario !== "download-fallback" || launched.registry) {
                    return "http://127.0.0.1:1";
                }
            } catch { /* Fixture has not written its launch record yet. */ }
            await pause(20);
        }
        throw new Error("CLI never launched");
    };
    try {
        if (["writer-lock", "runtime-error", "download-fallback"].includes(scenario)) {
            if (scenario === "download-fallback") await runtime.start(directory);
            else await assert.rejects(() => runtime.start(directory),
                scenario === "writer-lock" ? /atomic-write: timed out waiting/u : /invalid profile configuration/u);
            const launches = (await readFile(attempts, "utf8")).trim().split("\n").map(line => JSON.parse(line));
            assert.equal(launches.length, scenario === "download-fallback" ? 2 : 1);
            assert.equal(runtime.getRecoveryStatus(), undefined, "writer-lock failures must not start bundle isolation");
        } else if (scenario === "upgrade-diagnose") {
            await runtime.diagnoseEnvironment(directory);
            assert.equal(prompts.length, 0);
            await assert.rejects(() => readFile(upgradeMarker), { code: "ENOENT" });
            await assert.rejects(() => readFile(marker), { code: "ENOENT" });
        } else if (["upgrade-stop", "upgrade-prompt-stop"].includes(scenario)) {
            const starting = assert.rejects(() => runtime.start(directory), /cancelled/u);
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline) {
                if (scenario === "upgrade-prompt-stop" && pendingChoice) break;
                if (scenario === "upgrade-stop") { try { await readFile(upgradeMarker); break; } catch {} }
                await pause(20);
            }
            if (scenario === "upgrade-prompt-stop") assert.ok(pendingChoice);
            else await readFile(upgradeMarker);
            await runtime.stop();
            pendingChoice?.("Upgrade to 0.1.5-rc.1");
            await starting;
            await assert.rejects(() => readFile(marker), { code: "ENOENT" });
            if (scenario === "upgrade-prompt-stop") await assert.rejects(() => readFile(upgradeMarker), { code: "ENOENT" });
        } else if (scenario.startsWith("config-")) {
            await assert.rejects(() => runtime.start(directory), /dsh\.runtimeVersion.*0\.1\.2-rc\.1.*0\.1\.5-rc\.1/u);
            await assert.rejects(() => runtime.diagnoseEnvironment(directory), /dsh\.runtimeVersion/u);
            await assert.rejects(() => readFile(probeMarker), { code: "ENOENT" });
            await assert.rejects(() => readFile(marker), { code: "ENOENT" });
            await assert.rejects(() => readFile(join(directory, "dsh-runtime.lock")), { code: "ENOENT" });
        } else if (scenario === "cancel") {
            const starting = assert.rejects(() => runtime.start(directory), /cancelled/u);
            const deadline = Date.now() + 3000;
            while (Date.now() < deadline) {
                try { await readFile(probeMarker); break; } catch { await pause(20); }
            }
            assert.equal(await readFile(probeMarker, "utf8"), "started");
            await runtime.stop();
            await starting;
            assert.equal(runtime.getStatus().state, "stopped");
            await assert.rejects(() => readFile(marker), { code: "ENOENT" });
        } else if (["explicit-missing", "legacy-version"].includes(scenario)) {
            await assert.rejects(() => runtime.start(directory), scenario === "explicit-missing" ? /absent-dsh/u : /0\.1\.2-rc\.1/u);
            await assert.rejects(() => readFile(marker), { code: "ENOENT" });
            await assert.rejects(() => readFile(join(directory, "dsh-runtime.lock")), { code: "ENOENT" });
        } else {
            await runtime.start(directory);
            const launched = JSON.parse(await readFile(marker, "utf8"));
            const expected = scenario === "prefix" ? "prefix" : (packageArgs || ["explicit-npx", "npx-fallback"].includes(scenario)) ? "npx"
                : (["local", "legacy-args", "upgrade-prerelease", "upgrade-accept", "upgrade-race"].includes(scenario) || compatibleVersions[scenario]) ? "local" : "pnpm";
            assert.equal(launched.name, expected, "default discovery must prefer a compatible local CLI and otherwise pin the fallback");
            const appPort = ["port-occupied", "port-unknown", "port-race"].includes(scenario) ? "0" : "3080";
            const appArgs = scenario === "legacy-args" ? ["web", "--no-open", "--port", "49151"] : ["web", "--no-open", "--port", appPort];
            assert.deepEqual(launched.args, expected === "pnpm" ? ["dlx", `@deepseek-ai/dsh@${targetVersion}`, ...appArgs]
                : expected === "npx" ? [...(packageArgs ? packageArgs.map(arg => arg.replace("@next", `@${targetVersion}`)) : ["--yes", `@deepseek-ai/dsh@${targetVersion}`]), ...appArgs] : appArgs);
            if (scenario === "port-race") {
                const launches = (await readFile(attempts, "utf8")).trim().split("\n").map(line => JSON.parse(line));
                assert.equal(launches.length, 2, "a bind race must retry exactly once");
                assert.deepEqual(launches.map(args => args.slice(-2)), [["--port", "3080"], ["--port", "0"]]);
            }
            if (packageArgs) assert.deepEqual(JSON.parse(await readFile(probeMarker, "utf8")), [...packageArgs, "--version"]);
            const lock = JSON.parse(await readFile(join(directory, "dsh-runtime.lock"), "utf8"));
            assert.equal(lock.runtimeVersion, compatibleVersions[scenario] ?? (scenario === "upgrade-race" ? "0.1.5-rc.2" : targetVersion));
            assert.equal(lock.runtimePid, runtime.child.pid);
            assert.equal(runtime.harnessState.runtimeVersion, lock.runtimeVersion, "host metadata must use the detected version");
        }
        if (upgrading && !["upgrade-diagnose", "upgrade-prompt-stop", "upgrade-stop"].includes(scenario)) {
            const attempted = ["upgrade-prerelease", "upgrade-accept", "upgrade-failed", "upgrade-mismatch", "upgrade-cancel"].includes(scenario);
            assert.equal(prompts.length, ["upgrade-failed", "upgrade-mismatch", "upgrade-cancel"].includes(scenario) ? 2 : 1);
            if (attempted) {
                assert.deepEqual(JSON.parse(await readFile(upgradeMarker, "utf8")), ["install", "--global", "--prefix", prefix,
                    "@deepseek-ai/dsh@0.1.5-rc.1", "--registry", "https://registry.npmmirror.com"]);
            } else await assert.rejects(() => readFile(upgradeMarker), { code: "ENOENT" });
        }
        if (scenario === "local" || compatibleVersions[scenario] || scenario === "target-newer") assert.equal(prompts.length, 0);
        console.log(`PASS ${scenario}: launcher selection, actual argv and versioned lock`);
    } finally { await runtime.dispose(); }
    await assert.rejects(() => readFile(join(directory, "dsh-runtime.lock")), { code: "ENOENT" });
}
