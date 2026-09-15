#!/usr/bin/env node
// Exercise real orphan-process recovery with an isolated fake DSH entrypoint and local listener.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
if (!process.argv.includes("--worker")) {
    const directory = await mkdtemp(join(tmpdir(), "dsh-migration-verify-"));
    try {
        const worker = spawn(process.execPath, [script, "--worker", ...process.argv.slice(2)], {
            env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory,
                DSH_MIGRATION_VERIFY_DIRECTORY: directory }, stdio: "inherit",
        });
        process.exitCode = await new Promise((done, reject) => {
            worker.once("error", reject); worker.once("exit", code => done(code ?? 1));
        });
    } finally { await rm(directory, { recursive: true, force: true }); }
} else {
    assert.ok(process.env.DSH_MIGRATION_VERIFY_DIRECTORY);
    assert.equal(resolve(tmpdir()), resolve(process.env.DSH_MIGRATION_VERIFY_DIRECTORY));
    const require = createRequire(import.meta.url);
    const Module = require("node:module");
    const originalLoad = Module._load;
    let confirmed = false;
    const prompts = [];
    Module._load = function (id, ...args) {
        if (id === "vscode") return { window: { showWarningMessage: async (...values) => {
            prompts.push(values);
            return confirmed ? values.at(-1) : undefined;
        } } };
        return originalLoad.call(this, id, ...args);
    };
    const root = resolve(dirname(script), "..");
    const { DshRuntime } = require(join(root, "dist/dshRuntime"));
    Module._load = originalLoad;
    const { readRuntimeLock } = require(join(root, "dist/runtimeLock"));
    const { inspectLegacyRuntime, stopLegacyRuntime } = require(join(root, "dist/runtimeMigration"));
    const runtime = () => Object.assign(Object.create(DshRuntime.prototype), {
        harnessState: { setRuntimeVersion() {} },
        runtimeLockWrite: Promise.resolve(), output: { appendLine() {} }, isHarnessHealthy: async () => false,
    });
    const stubborn = process.argv.includes("--stubborn");
    const versioned = process.argv.includes("--versioned");
    const lockPath = join(tmpdir(), "dsh-runtime.lock");
    const fixture = join(tmpdir(), "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
    await mkdir(dirname(fixture), { recursive: true });
    await writeFile(fixture, 'const server=require("node:net").createServer(s=>s.end()); server.listen(0,"127.0.0.1",()=>process.send({port:server.address().port})); process.on("SIGTERM",()=>{ if (!process.argv.includes("--stubborn")) server.close(()=>process.exit(0)); });');
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise(done => dead.once("exit", done));
    const child = spawn(process.execPath, [fixture, ...(stubborn ? ["--stubborn"] : [])], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    const childExit = new Promise(done => child.once("exit", done));
    try {
        const { port } = await new Promise((done, reject) => { child.once("message", done); child.once("error", reject); });
        await writeFile(lockPath, JSON.stringify({ pid: dead.pid, url: `http://127.0.0.1:${port}`, ...(versioned ? { runtimeVersion: "0.1.5-rc.2" } : {}) }));
        const snapshot = await readRuntimeLock(lockPath);
        const identity = await inspectLegacyRuntime(snapshot);
        assert.equal(identity.pid, child.pid);
        await assert.rejects(() => runtime().findExistingRuntime(0), versioned ? /not responding/u : /unversioned/u);
        assert.equal(prompts.at(-1)[1].modal, true);
        assert.equal(child.exitCode, null);
        assert.ok(await readRuntimeLock(lockPath));
        console.log("PASS declined migration preserves the actual orphan process and lock");

        await writeFile(lockPath, JSON.stringify({ pid: process.pid, url: identity.baseUrl }));
        assert.equal(await inspectLegacyRuntime(await readRuntimeLock(lockPath)), undefined);
        await assert.rejects(() => stopLegacyRuntime(snapshot, identity, lockPath), /lock changed/u);
        assert.equal(child.exitCode, null);
        console.log("PASS live owner and changed lock cannot authorize process termination");

        await writeFile(lockPath, snapshot.contents);
        confirmed = true;
        const originalKill = process.kill;
        let exitRaceInjected = false;
        if (process.argv.includes("--exit-race")) {
            process.kill = (pid, signal) => {
                if (pid === child.pid && signal === "SIGKILL") {
                    originalKill(pid, signal);
                    exitRaceInjected = true;
                    throw Object.assign(new Error("process already exited"), { code: "ESRCH" });
                }
                return originalKill(pid, signal);
            };
        }
        try {
            assert.equal(await runtime().findExistingRuntime(0), undefined);
            if (process.argv.includes("--exit-race")) assert.equal(exitRaceInjected, true);
        } finally { process.kill = originalKill; }
        await childExit;
        if (stubborn) assert.equal(child.signalCode, "SIGKILL");
        else assert.equal(child.exitCode, 0);
        assert.equal(await readRuntimeLock(lockPath), undefined);
        const replacement = runtime();
        assert.equal(await replacement.acquireRuntimeLock("0.1.5-rc.2"), true);
        assert.equal((await readRuntimeLock(lockPath)).record.runtimeVersion, "0.1.5-rc.2");
        assert.equal((await readRuntimeLock(lockPath)).record.pid, process.pid);
        await replacement.releaseRuntimeLock();
        console.log(`PASS ${versioned ? "versioned" : "unversioned"} orphan ${stubborn ? "forced" : "graceful"} stop, lock cleanup, and replacement acquisition`);
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await childExit;
    }

    const unrelated = spawn(process.execPath, ["-e", 'const s=require("net").createServer(c=>c.end());s.listen(0,"127.0.0.1",()=>process.send(s.address().port));'], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    const unrelatedExit = new Promise(done => unrelated.once("exit", done));
    try {
        const port = await new Promise(done => unrelated.once("message", done));
        await writeFile(lockPath, JSON.stringify({ pid: dead.pid, url: `http://127.0.0.1:${port}`, ...(versioned ? { runtimeVersion: "0.1.5-rc.2" } : {}) }));
        assert.equal(await inspectLegacyRuntime(await readRuntimeLock(lockPath)), undefined);
        assert.equal(unrelated.exitCode, null);
        console.log("PASS an unrelated listener is never eligible for automatic upgrade termination");
    } finally { unrelated.kill("SIGTERM"); await unrelatedExit; }
}
