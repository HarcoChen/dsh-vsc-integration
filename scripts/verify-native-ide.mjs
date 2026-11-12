#!/usr/bin/env node
/** Real VS Code extension-host smoke with isolated profiles and a loopback mock-model Runtime. */
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { spawnOwnedRuntime, terminateOwnedRuntime } = createRequire(import.meta.url)(join(root, "dist/runtimeProcess"));
const args = process.argv.slice(2);
const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : args[index + 1];
};
const launcher = option("--launcher");
if (!launcher) throw new Error("Pass --launcher /absolute/path/to/dsh and optionally --code /path/to/code");
const scratch = await mkdtemp(join(tmpdir(), "dsh-native-ide-"));
const state = join(scratch, "runtime.json");
const userData = join(scratch, "user");
const extensionDir = join(scratch, "extensions");
const helper = join(scratch, "native-smoke-extension");
await mkdir(join(userData, "User"), { recursive: true });
await mkdir(extensionDir);
await mkdir(helper);
await writeFile(join(helper, "package.json"), JSON.stringify({ name: "dsh-native-smoke", publisher: "local-smoke", version: "1.0.0",
    engines: { vscode: "^1.106.0" }, main: "index.cjs", activationEvents: ["onStartupFinished"] }));
await writeFile(join(helper, "index.cjs"), `exports.activate = async () => {
    try { await require(${JSON.stringify(join(root, "scripts/fixtures/native-ide-suite.cjs"))}).run(); }
    catch (error) { console.error(error); }
    finally { await new Promise(resolve => setTimeout(resolve, 1000)); await require('vscode').commands.executeCommand('workbench.action.quit'); }
};`);
const env = Object.fromEntries(
    ["PATH", "HOME", "SystemRoot", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TMPDIR", "DISPLAY", "XAUTHORITY"]
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]])
);
const runtime = spawnOwnedRuntime(
    process.execPath,
    [
        join(root, "scripts/verify-remote-runtime.mjs"),
        "--launcher",
        resolve(launcher),
        "--expect-version",
        option("--expect-version", "0.2.2-rc.1"),
        "--with-forge",
        "--ide-smoke",
        state,
    ],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] }
);
let runtimeOutput = "";
runtime.stdout.on("data", (chunk) => {
    runtimeOutput += chunk;
});
runtime.stderr.on("data", (chunk) => {
    runtimeOutput += chunk;
});
const runtimeDone = new Promise((resolve) => {
    runtime.on("error", resolve);
    runtime.on("exit", (code) => resolve(code));
});
const deadline = Date.now() + 180_000;
let native;
const nativeLaunches = [];
const completedLaunches = new Set();

async function cleanLaunch(launch, scope) {
    if (process.platform !== "win32" || launch.exitCode !== 0 || !completedLaunches.has(launch)) {
        await terminateOwnedRuntime(launch);
        return;
    }
    // A successful launcher may already be gone. Verify this isolated profile's process tree
    // without taskkill on an exited (and potentially reused) PID.
    const command = `
      $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
      $ids = @($all | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:DSH_SMOKE_PROCESS_SCOPE) } | ForEach-Object { $_.ProcessId })
      do {
        $before = $ids.Count
        $ids = @($ids + @($all | Where-Object { $_.ParentProcessId -in $ids } | ForEach-Object { $_.ProcessId }) | Select-Object -Unique)
      } while ($ids.Count -ne $before)
      ConvertTo-Json -InputObject @($ids) -Compress
    `;
    const deadline = Date.now() + 5000;
    do {
        const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
            env: { ...env, DSH_SMOKE_PROCESS_SCOPE: scope }, timeout: 3000, windowsHide: true,
        });
        const remaining = JSON.parse(stdout.trim());
        if (Array.isArray(remaining) && remaining.length === 0) return;
        await new Promise(resolve => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    throw new Error("Isolated smoke processes are still running after successful launcher exit");
}
try {
    let metadata;
    while (Date.now() < deadline) {
        try {
            metadata = JSON.parse(await readFile(state, "utf8"));
            break;
        } catch {}
        if (runtime.exitCode !== null) throw new Error(runtimeOutput);
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!metadata) throw new Error(`Runtime did not become ready.\n${runtimeOutput}`);
    await writeFile(
        join(userData, "User/settings.json"),
        JSON.stringify({
            "dsh.autoStart": false,
            "dsh.serverUrl": metadata.launchUrl,
            "dsh.serverRuntimeVersion": metadata.runtimeVersion,
            "dsh.persistSession": false,
            "workbench.startupEditor": "none",
            "extensions.autoUpdate": false,
            "window.restoreWindows": "all",
            "security.workspace.trust.enabled": false,
            "update.mode": "none",
        }),
        { mode: 0o600 }
    );
    for (const phase of ["initial", "restore"]) {
        if (phase === "restore") {
            const settingsPath = join(userData, "User/settings.json");
            const settings = JSON.parse(await readFile(settingsPath, "utf8"));
            await writeFile(settingsPath, JSON.stringify({ ...settings, "dsh.autoStart": true }), { mode: 0o600 });
        }
        let output = "";
        const codeCommand = option("--code", "code");
        const codeArgs = [
                "--new-window",
                "--user-data-dir",
                userData,
                "--extensions-dir",
                extensionDir,
                "--extensionDevelopmentPath",
                root,
                "--extensionDevelopmentPath",
                helper,
                "--wait",
                "--disable-extensions",
                "--skip-welcome",
                "--skip-release-notes",
                scratch,
            ];
        const useCmd = process.platform === "win32" && !/\.(exe|com)$/iu.test(codeCommand);
        const quoteCmd = value => {
            if (/["\r\n%!]/u.test(value)) throw new Error("Unsupported character in Windows CLI path or argument");
            return `"${value}"`;
        };
        native = spawnOwnedRuntime(
            useCmd ? process.env.COMSPEC || "cmd.exe" : codeCommand,
            useCmd ? ["/d", "/s", "/c", `"${[codeCommand, ...codeArgs].map(quoteCmd).join(" ")}"`] : codeArgs,
            {
                cwd: root,
                env: {
                    ...env,
                    DSH_NATIVE_SMOKE_ROOT: root,
                    DSH_NATIVE_SMOKE_STATE: state,
                    DSH_NATIVE_SMOKE_PHASE: phase,
                },
                stdio: ["ignore", "pipe", "pipe"],
                ...(useCmd ? { windowsVerbatimArguments: true } : {}),
            }
        );
        nativeLaunches.push(native);
        native.stdout.on("data", (chunk) => {
            output += chunk;
        });
        native.stderr.on("data", (chunk) => {
            output += chunk;
        });
        const status = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`VS Code ${phase} timed out.\n${output}`));
            }, 60_000);
            native.on("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
            native.on("exit", (code) => {
                clearTimeout(timer);
                resolve(code);
            });
        });
        assert.equal(status, 0, output);
        // macOS's `code` launcher can return before the extension-host suite finishes.
        let result;
        const finishedBy = Date.now() + 60_000;
        while (Date.now() < finishedBy) {
            try {
                const value = JSON.parse(await readFile(join(scratch, "result.json"), "utf8"));
                if (value.ok === false || phase === "initial" || value.restored === true) {
                    result = value;
                    break;
                }
            } catch {}
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (!result) throw new Error(`VS Code ${phase} did not publish a result.\n${output}`);
        assert.equal(result.ok, true, result.message);
        if (phase === "restore") assert.equal(result.restored, true);
        completedLaunches.add(native);
        console.log(`PASS native IDE ${phase}`);
    }
    await writeFile(state + ".done", "done");
    assert.equal(await runtimeDone, 0, runtimeOutput);
    completedLaunches.add(runtime);
    console.log(
        "PASS independent tabs, existing-tab reuse, close lifetime, real inline completion, cancellation and restored session tab"
    );
} finally {
    await writeFile(state + ".done", "done").catch(() => undefined);
    const cleanupFailures = [];
    for (const launch of nativeLaunches) {
        try { await cleanLaunch(launch, userData); }
        catch (error) { cleanupFailures.push(String(error)); }
    }
    await Promise.race([runtimeDone, new Promise((resolve) => setTimeout(resolve, 2000))]);
    try { await cleanLaunch(runtime, state); }
    catch (error) { cleanupFailures.push(String(error)); }
    if (cleanupFailures.length) { console.error(`Smoke process cleanup incomplete: ${cleanupFailures.join("; ")}`); process.exitCode = 1; }
    if (args.includes("--keep") || cleanupFailures.length) console.log(`Kept isolated smoke directory: ${scratch}`);
    else await rm(scratch, { recursive: true, force: true });
}
