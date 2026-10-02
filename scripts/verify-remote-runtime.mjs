#!/usr/bin/env node
/** Integration smoke against a real DSH launcher, using the extension's compiled Remote clients.
 * Usage: npm run compile && node scripts/verify-remote-runtime.mjs --launcher /path/to/dsh
 * Options: --expect-version <version> (default: managed Runtime pin), --with-schedule-bundle,
 * --timed-questions, --with-team-bundle, --feature-controls, --keep.
 * All state is isolated; model requests go only to an in-process loopback mock server.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { RemoteConnectionController } = require(join(root, "dist/remote/connection"));
const { RemoteStateCoordinator } = require(join(root, "dist/remote/stateCoordinator"));
const { RemoteUnaryClient } = require(join(root, "dist/remote/unaryClient"));
const { RUNTIME_DEFAULT_VERSION } = require(join(root, "dist/managedRuntime/types"));
const { WorkspaceFilesClient, readRuntimeTextPreview, RUNTIME_TEXT_PREVIEW_MAX_BYTES } = require(join(root, "dist/workspaceFiles"));
const { detectAgentTeamsCapability, normalizeAgentTeamProjection } = require(join(root, "dist/agentTeamTypes"));
const { normalizePluginInventory, normalizePluginChange } = require(join(root, "dist/pluginInventory"));
const {
    normalizeMessageFeedbackPutResult,
    normalizeMessageFeedbackListResult,
    normalizeMessageFeedbackDeleteResult,
} = require(join(root, "dist/messageFeedback"));
const { SubagentController } = require(join(root, "dist/subagentController"));
const { historyEntries, projectionBlock: remoteProjectionBlock } = require(join(root, "dist/remote/sessionState"));
const { JobsController } = require(join(root, "dist/jobsController"));
const { UserQuestionWaitController } = require(join(root, "dist/userQuestionWait"));
const argv = process.argv.slice(2);
const launcherIndex = argv.indexOf("--launcher");
if (launcherIndex < 0 || !argv[launcherIndex + 1]) throw new Error("Pass --launcher /absolute/path/to/dsh");
const launcher = resolve(argv[launcherIndex + 1]);
const keep = argv.includes("--keep");
const withScheduleBundle = argv.includes("--with-schedule-bundle");
const withTeamBundle = argv.includes("--with-team-bundle");
const timedQuestions = argv.includes("--timed-questions");
const featureControls = argv.includes("--feature-controls");
const versionIndex = argv.indexOf("--expect-version");
if (versionIndex >= 0 && !argv[versionIndex + 1]) throw new Error("--expect-version requires a version");
const expectedVersion = versionIndex >= 0 ? argv[versionIndex + 1] : RUNTIME_DEFAULT_VERSION;
// Allowlist environment variables: do not inherit API keys, user profile paths, or loader overrides.
const env = Object.fromEntries(["PATH", "SystemRoot", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TMPDIR"]
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
env.NO_COLOR = "1";
const versionProbe = spawnSync(launcher, ["--version"], { env, encoding: "utf8", timeout: 15000 });
if (versionProbe.error) throw versionProbe.error;
assert.equal(versionProbe.status, 0, versionProbe.stderr);
const runtimeVersion = versionProbe.stdout.trim();
assert.equal(runtimeVersion, expectedVersion, "Launcher version must match the requested smoke target");
console.log(`Verified Runtime version: ${runtimeVersion}; Schedule bundle: ${withScheduleBundle ? "enabled" : "disabled"}`);
const storage = await mkdtemp(join(tmpdir(), "dsh-remote-verify-"));
const dshHome = join(storage, "home");
const workspacePath = join(storage, "workspace");
await Promise.all([mkdir(dshHome), mkdir(workspacePath)]);
await writeFile(join(workspacePath, "remote-smoke.txt"), "workspaceFiles RC.2\nsecond line\n");
await writeFile(join(workspacePath, "remote-smoke.bin"), Buffer.from([0, 1, 2, 3, 4, 5]));
await writeFile(join(workspacePath, "remote-large.txt"), Buffer.alloc(RUNTIME_TEXT_PREVIEW_MAX_BYTES + 1, 65));
if (withScheduleBundle || withTeamBundle) {
    const profileDirectory = join(dshHome, "profiles", "web");
    await mkdir(profileDirectory, { recursive: true });
    await writeFile(join(profileDirectory, "package.json"), JSON.stringify({
        private: true, type: "module",
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
            ...(withScheduleBundle ? ["@deepseek-ai/dsh-experimental-schedule-bundle"] : []),
            ...(withTeamBundle ? ["@deepseek-ai/dsh-experimental-agent-team-profile"] : [])] } },
    }, null, 2) + "\n");
}
if (timedQuestions) {
    await writeFile(join(dshHome, "cordis.patch.yml"), "- id: preset-standard\n  config:\n    id: standard\n    plugins:\n      - id: tool-ask-user\n        name: '@deepseek-ai/dsh-tool-ask-user'\n        config:\n          mode: timed\n          timeout: 1\n      - id: tool-bash\n        name: '@deepseek-ai/dsh-tool-bash'\n      - id: tool-jobs\n        name: '@deepseek-ai/dsh-tool-jobs'\n");
}
env.DSH_HOME = dshHome;
env.DSH_SMOKE_API_KEY = "local-smoke-only";
let finishStream;
let heldStream = false;
const servedQuestions = new Set();
let jobToolServed = false;
let teamTaskServed = false;
let teammateServed = false;
let modelRequests = 0;
const model = createServer(async (request, response) => {
    if (request.url === "/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [{ id: "deepseek-flash", object: "model" }] }));
        return;
    }
    if (request.url !== "/v1/messages") { response.writeHead(404); response.end(); return; }
    let body = "";
    for await (const part of request) body += part;
    const payload = JSON.parse(body);
    modelRequests += 1;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const event = data => response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    event({ type: "message_start", message: { id: randomUUID(), model: payload.model,
        usage: { input_tokens: 3, output_tokens: 0 } } });
    const messages = JSON.stringify(payload.messages);
    const questionMarker = ["TIMED_QUESTION_SMOKE", "FOREGROUND_QUESTION_SMOKE", "RECONNECT_QUESTION_SMOKE"]
        .find(marker => messages.includes(marker) && !servedQuestions.has(marker));
    const teamCall = featureControls && withTeamBundle
        ? messages.includes("TEAM_TASK_SMOKE") && !teamTaskServed ? "team_task_create"
            : messages.includes("TEAM_PANEL_SMOKE") && !teammateServed ? "spawn_teammate" : undefined
        : undefined;
    const jobCall = featureControls && messages.includes("JOBS_CONTROL_SMOKE") && !jobToolServed;
    if (teamCall || jobCall || (timedQuestions && questionMarker)) {
        if (teamCall === "spawn_teammate") teammateServed = true;
        else if (teamCall === "team_task_create") teamTaskServed = true;
        else if (jobCall) jobToolServed = true;
        else servedQuestions.add(questionMarker);
        const name = teamCall ?? (jobCall ? "bash" : "ask_user_question");
        const input = teamCall === "spawn_teammate" ? { name: "smoke-worker", description: "Isolated member for the panel smoke", prompt: "Return a short hello for TEAM_WORKER_REPLY", context: "fresh" }
            : teamCall === "team_task_create" ? { subject: "Smoke team task", description: "Verify the public task projection", write_scopes: ["src/"] }
            : jobCall ? {
            command: "for index in {1..80}; do echo job-stream-$index; sleep 0.15; done",
            description: "Isolated background output for the Remote smoke",
            run_in_background: true,
        } : {
            questions: [{ id: "scope", question: "Which scope should be used?", options: [{ label: "Tool only" }] }],
            timeout: questionMarker === "TIMED_QUESTION_SMOKE" ? 1 : 10,
        };
        event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: teamCall ?? (jobCall ? "smoke-job" : questionMarker), name, input: {} } });
        event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
        event({ type: "content_block_stop", index: 0 });
        event({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } });
        event({ type: "message_stop" });
        response.end();
        return;
    }
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } });
    if (!heldStream && JSON.stringify(payload.messages).includes("SMOKE_STREAM")) {
        heldStream = true;
        await new Promise(resolveFinish => { finishStream = resolveFinish; });
    }
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } });
    event({ type: "content_block_stop", index: 0 });
    event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } });
    event({ type: "message_stop" });
    response.end();
});
await new Promise((resolveListen, rejectListen) => {
    model.once("error", rejectListen);
    model.listen(0, "127.0.0.1", resolveListen);
});
await writeFile(join(dshHome, "settings.yaml"), `llm-deepseek:\n  apiKeyEnv: DSH_SMOKE_API_KEY\n  baseURL: http://127.0.0.1:${model.address().port}\n  thinking: disabled\n`);
const patchPath = join(storage, "smoke.patch.yml");
await writeFile(patchPath, "- id: goal-round-driver\n  name: '@deepseek-ai/dsh-goal-round-driver'\n  disabled: true\n");
const child = spawn(launcher, ["--profile", "web", "--patch", patchPath, "--no-open", "--host", "127.0.0.1", "--port", "0"], {
    cwd: workspacePath, env, stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
let exited;
let launchError;
child.stdout.on("data", data => { output += data; });
child.stderr.on("data", data => { output += data; });
child.once("error", error => { launchError = error; });
child.once("exit", (code, signal) => { exited = { code, signal }; });
let connection;
let coordinator;
const featureDisposers = [];
let jobsController;
const diagnostics = [];
const wireFrames = [];
const remoteEvents = [];
const redact = text => text.replace(/([?&]token=)[A-Za-z0-9_-]+/gu, "$1<redacted>");
async function until(check, label, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (launchError) throw launchError;
        if (exited) throw new Error(`Runtime exited: ${JSON.stringify(exited)}\n${redact(output.slice(-6000))}`);
        const value = await check();
        if (value) return value;
        await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
    throw new Error(`Timed out: ${label}\n${diagnostics.slice(-5).join("\n")}\n${redact(output.slice(-4000))}`);
}
function pass(label) { console.log(`PASS ${label}`); }
function goalReference(value) { return value.ref ?? value; }
function conversationMessages(snapshot) {
    return snapshot?.surface.nodes.filter(({ event }) => event.type === "assistant/message" ||
        (event.type === "user/message" && event.data.source.kind === "user")) ?? [];
}
async function first(endpoint, args = {}) {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(new Error(`${endpoint} timed out`)), 15000);
    try {
        for await (const frame of connection.open(endpoint, args, abort.signal)) return frame;
        throw new Error(`${endpoint} ended without a frame`);
    } finally { clearTimeout(timeout); abort.abort(); }
}
try {
    console.log(`Isolated DSH home: ${dshHome}`);
    const launchUrl = await until(() => output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/u)?.[0], "authenticated launch URL", 90000);
    const baseUrl = new URL(launchUrl).origin;
    const unauthorized = new RemoteUnaryClient({ baseUrl, timeoutMs: 10000 });
    await assert.rejects(() => unauthorized.probe(), error => error.status === 401 || error.status === 403);
    const exchange = await fetch(launchUrl, { redirect: "manual" });
    assert.equal(exchange.status, 303);
    const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const requestHeaders = () => ({ cookie });
    pass("unauthenticated RPC rejected; launch token exchanged for cookie");
    connection = new RemoteConnectionController({ baseUrl, requestHeaders,
        onEvent: frame => remoteEvents.push(frame),
        onDiagnostic: (message, cause) => diagnostics.push(`${message}: ${cause?.message ?? cause ?? ""}`) });
    // Observe decoded server frames while retaining the actual extension mux and state coordinator.
    const open = connection.open.bind(connection);
    connection.open = async function* (endpoint, args, signal) {
        for await (const frame of open(endpoint, args, signal)) {
            wireFrames.push({ endpoint, frame, generation: connection.currentGeneration });
            yield frame;
        }
    };
    let descriptions = 0;
    coordinator = new RemoteStateCoordinator(connection, {
        onHostDescription: () => { descriptions += 1; },
        onDiagnostic: (message, cause) => diagnostics.push(`${message}: ${cause?.message ?? cause ?? ""}`),
    }, { historyPageSize: 2, runtimeVersion });
    coordinator.start();
    await until(() => descriptions > 0, "coordinator baseline");
    await connection.unary.probe();
    pass("authenticated unary, mux $events, workspace and control baselines");
    const workspace = await connection.unary.call("workspace/create", { request: { path: workspacePath } });
    const workspaceId = workspace.workspace?.workspaceId ?? workspace.workspaceId;
    assert.ok(workspaceId, JSON.stringify(workspace));
    await until(() => coordinator.catalog.snapshot().workspaces.some(item => item.workspaceId === workspaceId), "workspace update");
    const created = await connection.unary.call("session/create", { request: { workspaceId, agentPreset: "minimal" } });
    assert.equal(typeof created.sessionId, "string");
    await coordinator.refreshCatalog();
    assert.ok(coordinator.catalog.snapshot().sessions.some(session => session.sessionId === created.sessionId));
    pass("workspace/create and session/create update the live catalog");
    // Let the selected Runtime persist its current format through public RPCs.
    const { sessionId: seededSessionId } = await connection.unary.call("session/create", {
        request: { workspaceId, agentPreset: "minimal" },
    });
    coordinator.watchSession(seededSessionId);
    for (let turn = 1; turn <= 8; turn += 1) {
        await connection.unary.call("session/prompt", { request: { sessionId: seededSessionId,
            requestId: randomUUID(), mode: "queue", content: [{ type: "text", text: `Smoke prompt ${turn}` }] } });
        const ended = await until(() => coordinator.sessions.get(seededSessionId)?.events.find(({ event }) =>
            event.type === "turn/end" && event.data.turn === turn), `local history turn ${turn}`);
        assert.equal(ended.event.data.reason.kind, "completed", JSON.stringify(ended.event));
    }
    await coordinator.syncHistory(seededSessionId);
    const history = await until(() => {
        const state = coordinator.sessions.get(seededSessionId);
        return conversationMessages(state).length === 16 && state.surface.complete && state;
    }, "paginated durable history");
    assert.ok(history.events.length >= 32);
    assert.equal(history.needsHistoryBaseline, false);
    assert.deepEqual(conversationMessages(history).filter(({ event }) => event.type === "user/message")
        .map(({ event }) => event.data.content[0].text), Array.from({ length: 8 }, (_, index) => `Smoke prompt ${index + 1}`));
    const tail = await first("session/follow", { request: { address: { kind: "session", sessionId: seededSessionId }, maxMessages: 2 } });
    assert.equal(tail.type, "snapshot");
    assert.equal(tail.hasMore, true);
    pass("RPC-created session/follow snapshot and backward session/page history (16 user/assistant messages)");
    if (withScheduleBundle) {
        assert.deepEqual(await connection.unary.call("schedule/list", { request: { sessionId: seededSessionId } }), []);
        assert.deepEqual(await connection.unary.call("schedule/catalog", {}), []);
        const missingRequest = { sessionId: seededSessionId, id: randomUUID() };
        assert.equal((await connection.unary.call("schedule/history", { request: { ...missingRequest, limit: 2 } })).code,
            "schedule_not_found");
        assert.deepEqual(await connection.unary.call("schedule/delete", { request: missingRequest }),
            { id: missingRequest.id, deleted: false, code: "schedule_not_found" });
        pass("optional Schedule bundle exposes list/catalog/history/delete RPCs");
    } else {
        for (const [endpoint, args] of [["schedule/list", { request: { sessionId: seededSessionId } }], ["schedule/catalog", {}]]) {
            await assert.rejects(() => connection.unary.call(endpoint, args), error => error.status === 404);
        }
        pass("standard Web composition omits Schedule list/catalog with HTTP 404");
    }
    const questionAnswer = await connection.unary.call("userQuestions/answer", {
        agentId: seededSessionId,
        callId: randomUUID(),
        answer: { answers: [] },
    });
    assert.equal(questionAnswer, false);
    const waitAbort = new AbortController();
    let waitFrames = 0;
    for await (const _frame of connection.open("userQuestions/attachWait", {
        agentId: seededSessionId,
        callId: randomUUID(),
    }, waitAbort.signal)) {
        waitFrames += 1;
    }
    waitAbort.abort();
    assert.equal(waitFrames, 0);
    pass("RC.2 userQuestions/answer and attachWait handle an unknown continued question without mutation");
    const permissionCatalog = await connection.unary.call("permissionPresets/catalog", {});
    assert.ok(Array.isArray(permissionCatalog.options));
    assert.ok(typeof permissionCatalog.defaultPreset === "string");
    pass("permissionPresets/catalog supplies the process-level preset options");
    const pluginBundles = await connection.unary.call("pluginManager/listBundles", {});
    assert.ok(Array.isArray(pluginBundles));
    pass("pluginManager/listBundles supplies read-only Runtime bundle metadata");
    const managedPlugins = await connection.unary.call("pluginManager/listPlugins", {});
    assert.ok(Array.isArray(managedPlugins));
    pass("pluginManager/listPlugins supplies read-only plugin patch metadata");
    const rawInventory = await connection.unary.call("pluginInventory/list", {});
    const inventory = normalizePluginInventory(rawInventory);
    assert.ok(inventory);
    assert.equal(detectAgentTeamsCapability(inventory).available, withTeamBundle);
    const projectionBlock = await connection.unary.call("session/projections", { request: { sessionId: seededSessionId } });
    if (withTeamBundle) {
        const team = normalizeAgentTeamProjection(projectionBlock.values.agentTeam);
        assert.ok(team);
        assert.ok(team.members.some(member => member.id === seededSessionId && member.role === "lead"));
        await assert.rejects(() => connection.unary.call("agentTeams/view", { agentId: seededSessionId }), error => error.status === 404);
        pass("Active Agent Teams publishes a Session projection; it exposes no legacy agentTeams/view RPC");
    } else {
        assert.equal(projectionBlock.values.agentTeam, undefined);
        pass("Standard composition has no Agent Teams service or projection");
    }
    const files = new WorkspaceFilesClient(connection.unary, connection);
    const remoteFiles = await files.list(seededSessionId);
    assert.ok(Array.isArray(remoteFiles.entries));
    assert.ok(remoteFiles.entries.some((entry) => entry.name === "remote-smoke.txt"));
    const remoteStat = await files.stat(seededSessionId, "remote-smoke.txt");
    assert.equal(typeof remoteStat.version, "string");
    const remoteText = await files.read(seededSessionId, "remote-smoke.txt", { offset: 2, limit: 1 });
    assert.equal(remoteText.text, "second line");
    assert.equal((await files.read(seededSessionId, "remote-smoke.txt")).lines, 2);
    assert.deepEqual([...(await files.readBytes(seededSessionId, "remote-smoke.bin")).data], [0, 1, 2, 3, 4, 5]);
    const remoteBytes = await files.readBytes(seededSessionId, "remote-smoke.bin", { range: { offset: 2, length: 2 } });
    assert.deepEqual([...remoteBytes.data], [2, 3]);
    const changesAbort = new AbortController();
    const changesTimer = setTimeout(() => changesAbort.abort(new Error("workspaceFiles watch timed out")), 8000);
    const watch = files.changes(seededSessionId, "remote-smoke.txt", changesAbort.signal)[Symbol.asyncIterator]();
    try {
        const opening = await watch.next();
        assert.equal(opening.done, false);
        assert.equal(opening.value.kind, "ready");
        await writeFile(join(workspacePath, "remote-smoke.txt"), "updated Runtime file\n");
        const update = await watch.next();
        assert.equal(update.done, false);
        assert.equal(update.value.kind, "change");
        assert.equal(typeof update.value.change.version, "string");
    } finally {
        clearTimeout(changesTimer);
        changesAbort.abort();
        await watch.return();
    }
    const preview = await readRuntimeTextPreview(files, seededSessionId, "remote-smoke.txt");
    assert.equal(preview.text, "updated Runtime file\n");
    await assert.rejects(() => readRuntimeTextPreview(files, seededSessionId, "remote-smoke.bin"), /not UTF-8 text/u);
    await assert.rejects(() => readRuntimeTextPreview(files, seededSessionId, "remote-large.txt"), /limited to 1 MiB/u);
    await assert.rejects(() => files.stat(seededSessionId, "missing-smoke.txt"), error => error.code === "workspace-file/not-found");
    pass("Workspace file client validates defaults, pagination, multipart bytes, live changes, and bounded text previews");
    await connection.unary.call("session/rename", { request: { sessionId: seededSessionId, title: "Runtime smoke renamed" } });
    await until(() => coordinator.catalog.snapshot().sessions.some(session => session.sessionId === seededSessionId && session.title === "Runtime smoke renamed"), "live title projection");
    pass("live session title projection reaches catalog");
    const messageId = history.surface.nodes.find(({ event }) => event.type === "assistant/message").event.data.message.id;
    const feedbackRequest = { sessionId: seededSessionId, messageId,
        rating: "positive", category: "task-result", note: "Useful answer", ifVersion: null };
    const feedback = normalizeMessageFeedbackPutResult(await connection.unary.call("messageFeedback/put", { request: feedbackRequest }));
    assert.equal(feedback?.ok, true);
    assert.equal(feedback.value.category, "task-result");
    const feedbackEdit = normalizeMessageFeedbackPutResult(await connection.unary.call("messageFeedback/put", {
        request: { ...feedbackRequest, rating: "negative", note: "Needs more detail", ifVersion: feedback.value.version },
    }));
    assert.equal(feedbackEdit?.ok, true);
    assert.equal(feedbackEdit.value.category, "task-result");
    const feedbackList = normalizeMessageFeedbackListResult(await connection.unary.call("messageFeedback/list", {
        request: { sessionId: seededSessionId },
    }));
    assert.equal(feedbackList?.ok, true);
    assert.deepEqual(feedbackList.value.items, [feedbackEdit.value]);
    const feedbackConflict = normalizeMessageFeedbackPutResult(await connection.unary.call("messageFeedback/put", { request: feedbackRequest }));
    assert.equal(feedbackConflict?.ok, false);
    assert.equal(feedbackConflict.error.code, "version-conflict");
    assert.equal(feedbackConflict.error.current.category, "task-result");
    const feedbackDeleted = normalizeMessageFeedbackDeleteResult(await connection.unary.call("messageFeedback/delete", {
        request: { sessionId: seededSessionId, messageId, ifVersion: feedbackEdit.value.version },
    }));
    assert.equal(feedbackDeleted?.ok, true);
    assert.equal(feedbackDeleted.value.absent, true);
    pass("positive/negative feedback categories survive edits, list reads and CAS conflicts");
    const oldGeneration = connection.currentGeneration;
    const oldDescriptions = descriptions;
    connection.reconnect();
    await until(() => connection.currentGeneration > oldGeneration && descriptions > oldDescriptions, "reconnect baselines");
    await coordinator.syncHistory(seededSessionId);
    assert.equal(conversationMessages(coordinator.sessions.get(seededSessionId)).length, 16);
    assert.equal(coordinator.catalog.snapshot().workspaces.length, 1);
    pass("reconnect reopens event/control/workspace/session streams without duplicate surfaces");
    coordinator.watchSession(created.sessionId);
    await coordinator.syncHistory(created.sessionId);
    await connection.unary.call("session/prompt", { request: { sessionId: created.sessionId,
        requestId: randomUUID(), mode: "queue", content: [{ type: "text", text: "SMOKE_STREAM" }] } });
    await until(() => JSON.stringify(coordinator.sessions.get(created.sessionId)?.assistantStream)?.includes("Hello"), "live assistant prefix");
    assert.ok(JSON.stringify(coordinator.sessions.get(created.sessionId).assistantStream).includes("Hello"));
    const streamingGeneration = connection.currentGeneration;
    connection.reconnect();
    await until(() => connection.currentGeneration > streamingGeneration &&
        wireFrames.some(({ endpoint, frame, generation }) => endpoint === "session/follow" && frame.type === "snapshot" &&
            generation === connection.currentGeneration && frame.assistantStream?.activeAttempt) &&
        JSON.stringify(coordinator.sessions.get(created.sessionId)?.assistantStream)?.includes("Hello"), "reconnected assistant prefix");
    assert.equal(typeof finishStream, "function");
    finishStream();
    await until(() => {
        const state = coordinator.sessions.get(created.sessionId);
        return !state?.assistantStream && state?.events.some(({ event }) => event.type === "turn/end");
    }, "committed assistant settlement");
    const live = coordinator.sessions.get(created.sessionId);
    const assistantMessages = live.surface.nodes.filter(({ event }) => event.type === "assistant/message");
    assert.equal(assistantMessages.length, 1);
    assert.equal(assistantMessages[0].event.data.message.content[0].text, "Hello world");
    assert.ok(wireFrames.some(({ frame }) => frame.type === "assistant-stream" && frame.frame.type === "start"));
    assert.ok(wireFrames.some(({ frame }) => frame.type === "assistant-stream" && frame.frame.type === "chunk"));
    assert.ok(wireFrames.some(({ frame }) => frame.type === "assistant-stream" && frame.frame.type === "end"));
    pass("local model live start/chunk/end, reconnect prefix, and one final committed message");
    let goalRef = goalReference(await connection.unary.call("goals/create", { agentId: created.sessionId,
        request: { objective: "Local integration smoke", maxGoalRounds: 1 } }));
    assert.equal((await connection.unary.call("goals/get", { agentId: created.sessionId })).activation, "armed");
    goalRef = goalReference(await connection.unary.call("goals/pause", { agentId: created.sessionId, ref: goalRef }));
    assert.equal((await connection.unary.call("goals/get", { agentId: created.sessionId })).activation, "disarmed");
    goalRef = goalReference(await connection.unary.call("goals/resume", { agentId: created.sessionId, ref: goalRef }));
    assert.equal((await connection.unary.call("goals/get", { agentId: created.sessionId })).activation, "armed");
    await connection.unary.call("goals/clear", { agentId: created.sessionId, ref: goalRef });
    assert.equal(await connection.unary.call("goals/get", { agentId: created.sessionId }), undefined);
    await until(() => remoteEvents.filter(event => event.event === "goal/activation-changed").length >= 4, "goal activation events");
    const activations = remoteEvents.filter(event => event.event === "goal/activation-changed")
        .map(event => event.args[0]).filter(value => value.sessionId === created.sessionId);
    assert.ok(activations.some(value => value.goal?.activation === "armed"));
    assert.ok(activations.some(value => value.goal?.activation === "disarmed"));
    assert.ok(activations.some(value => value.goal === undefined));
    pass("goal create/pause/resume/clear and process-local activation events");
    await connection.unary.call("commands/execute", { agentId: created.sessionId, line: "/help", submittedAttachments: [] });
    pass("commands/execute accepts submittedAttachments envelope");
    await assert.rejects(() => connection.unary.call("subagents/prompt", { request: {
        parentSessionId: created.sessionId, childSessionId: "missing-smoke-child", mode: "continuable",
        delivery: "queue", requestId: randomUUID(), content: [{ type: "text", text: "Smoke" }],
    } }), error => error.isDSHRemoteError === true && error.code === "subagent/not-resumable");
    pass("subagents/prompt request/delivery envelope reaches missing-child validation");
    if (timedQuestions) {
        const timedSession = await connection.unary.call("session/create", {
            request: { workspaceId, agentPreset: "standard" },
        });
        coordinator.watchSession(timedSession.sessionId);
        await connection.unary.call("session/prompt", { request: { sessionId: timedSession.sessionId,
            requestId: randomUUID(), mode: "queue", content: [{ type: "text", text: "TIMED_QUESTION_SMOKE" }] } });
        const pending = await until(() => {
            const snapshot = coordinator.sessions.get(timedSession.sessionId);
            const cell = snapshot?.projections.find(({ key }) => key === "userQuestions");
            if (!cell || typeof cell.value !== "object" || cell.value === null || Array.isArray(cell.value)) return undefined;
            const active = cell.value.active;
            if (!Array.isArray(active)) return undefined;
            const question = active.find((item) => item && item.state === "continued");
            return question && typeof question.callId === "string" ? question : undefined;
        }, "continued timed question projection", 20_000);
        const accepted = await connection.unary.call("userQuestions/answer", {
            agentId: timedSession.sessionId,
            callId: pending.callId,
            answer: { answers: [{ id: "scope", selected: ["Tool only"] }] },
        });
        assert.equal(accepted, true);
        await until(() => {
            const snapshot = coordinator.sessions.get(timedSession.sessionId);
            const cell = snapshot?.projections.find(({ key }) => key === "userQuestions");
            return cell && typeof cell.value === "object" && cell.value !== null &&
                Array.isArray(cell.value.active) && !cell.value.active.some((item) => item?.callId === pending.callId);
        }, "continued timed question settlement", 20_000);
        pass("timed ask_user_question continues after timeout and accepts a late Remote answer");
    }
    if (featureControls) {
        const optionalName = "@deepseek-ai/dsh-experimental-schedule-bundle";
        const originalBundle = (await connection.unary.call("pluginManager/listBundles", {})).find(bundle => bundle.name === optionalName);
        assert.ok(originalBundle);
        const selected = normalizePluginChange(await connection.unary.call("pluginManager/setBundleEnabled", { name: optionalName, enabled: !originalBundle.enabled }));
        assert.ok(selected && selected.application !== "failed", JSON.stringify(selected));
        assert.equal((await connection.unary.call("pluginManager/listBundles", {})).find(bundle => bundle.name === optionalName).enabled, !originalBundle.enabled);
        const restored = normalizePluginChange(await connection.unary.call("pluginManager/setBundleEnabled", { name: optionalName, enabled: originalBundle.enabled }));
        assert.ok(restored && restored.application !== "failed");
        const rows = await connection.unary.call("pluginManager/listPlugins", {});
        const mutable = rows.find(row => row.moduleName === "@deepseek-ai/dsh-file-reference-local" && row.readOnlyReason === undefined)
            ?? rows.find(row => row.moduleName === "@deepseek-ai/dsh-tool-pruner" && row.readOnlyReason === undefined);
        assert.ok(mutable, `need a mutable plugin: ${JSON.stringify(rows.map(row => ({ module: row.moduleName, reason: row.readOnlyReason })))}`);
        const pluginChanged = normalizePluginChange(await connection.unary.call("pluginManager/setPluginEnabled", { id: mutable.entryId, enabled: !mutable.enabled }));
        assert.ok(pluginChanged && pluginChanged.application !== "failed", JSON.stringify(pluginChanged));
        const pluginRestored = normalizePluginChange(await connection.unary.call("pluginManager/setPluginEnabled", { id: mutable.entryId, enabled: mutable.enabled }));
        assert.ok(pluginRestored && pluginRestored.application !== "failed");
        const protectedRow = rows.find(row => row.readOnlyReason === "management-required");
        assert.ok(protectedRow);
        const refused = normalizePluginChange(await connection.unary.call("pluginManager/setPluginEnabled", { id: protectedRow.entryId, enabled: false }));
        assert.equal(refused.application, "failed");
        assert.equal(refused.changed, false);
        pass("Plugin and Bundle switches persist changes, preserve application outcomes, and reject protected rows");

        const jobSession = await connection.unary.call("session/create", { request: { workspaceId, agentPreset: "standard" } });
        coordinator.watchSession(jobSession.sessionId);
        jobsController = new JobsController(connection.unary, connection, message => console.log(message));
        let jobRows = [];
        featureDisposers.push(jobsController.watch(jobSession.sessionId, rows => { jobRows = rows; }));
        await connection.unary.call("session/prompt", { request: { sessionId: jobSession.sessionId,
            requestId: randomUUID(), mode: "queue", content: [{ type: "text", text: "JOBS_CONTROL_SMOKE" }] } });
        await until(async () => {
            const approval = coordinator.sessions.get(jobSession.sessionId)?.interactions.find(item => item.kind === "approval" && item.status === "pending");
            if (approval) {
                coordinator.sessions.claimInteraction(jobSession.sessionId, approval.key);
                await connection.answerRemoteEvent(approval.rpcId, { kind: "result", value: "allowed-once" });
                coordinator.sessions.settleRemoteInteraction(jobSession.sessionId, approval.key);
            }
            return jobRows.find(job => job.outputText?.includes("job-stream-"));
        }, "live Job output");
        const job = jobRows.find(job => job.kind === "bash");
        assert.ok(job && job.status === "running");
        const before = job.outputText;
        const oldGeneration = connection.currentGeneration;
        connection.reconnect();
        await until(() => connection.currentGeneration > oldGeneration && jobRows.find(row => row.id === job.id)?.outputText?.length > before.length, "Job output resumed after reconnect");
        const outputAfterReconnect = jobRows.find(row => row.id === job.id).outputText;
        assert.equal((outputAfterReconnect.match(/job-stream-1\n/g) ?? []).length, 1, "resume must not duplicate output");
        assert.equal(await jobsController.killJob(jobSession.sessionId, job.id), "requested");
        await until(() => jobRows.find(row => row.id === job.id)?.status === "killed" && jobRows.find(row => row.id === job.id)?.streaming === false, "Job cancellation and output drain");
        assert.match(jobRows.find(row => row.id === job.id).outputSummary, /cancelled by the user/);
        pass("JobsController consumes real list/follow streams, resumes without duplication, and kills a running job");

        if (timedQuestions) {
            const waits = new UserQuestionWaitController(connection, message => console.log(message));
            for (const marker of ["FOREGROUND_QUESTION_SMOKE", "RECONNECT_QUESTION_SMOKE"]) {
                const asked = await connection.unary.call("session/create", { request: { workspaceId, agentPreset: "standard" } });
                coordinator.watchSession(asked.sessionId);
                await connection.unary.call("session/prompt", { request: { sessionId: asked.sessionId, requestId: randomUUID(),
                    mode: "queue", content: [{ type: "text", text: marker }] } });
                const interaction = await until(() => coordinator.sessions.get(asked.sessionId)?.interactions.find(item => item.kind === "question" && item.questionState === "open" && item.status === "pending"), "foreground question");
                let waitState;
                const release = waits.watch(asked.sessionId, interaction.continuedCallId, state => { waitState = state; }, async () => {
                    const current = coordinator.sessions.get(asked.sessionId).interactions.find(item => item.key === interaction.key);
                    await connection.answerRemoteEvent(current.rpcId, { kind: "rejected", error: { name: "UserQuestionError", code: "ASK_TIMED_OUT", message: "smoke countdown ended" } });
                });
                featureDisposers.push(release);
                await until(() => waitState?.deadline, "Host wait claim");
                if (marker === "RECONNECT_QUESTION_SMOKE") {
                    const generation = connection.currentGeneration;
                    const previousKey = interaction.key;
                    connection.reconnect();
                    await until(() => connection.currentGeneration > generation && waitState?.connected && waitState?.deadline, "question wait reattached");
                    const current = await until(() => coordinator.sessions.get(asked.sessionId)?.interactions.find(item => item.key === previousKey && item.status === "pending"), "stable question identity after reconnect");
                    assert.equal(current.continuedCallId, interaction.continuedCallId);
                    await until(() => coordinator.sessions.get(asked.sessionId)?.interactions.find(item => item.key === previousKey && item.questionState === "continued"), "Client countdown timeout transition", 20_000);
                    release();
                    const claimed = coordinator.sessions.claimInteraction(asked.sessionId, previousKey);
                    assert.ok(claimed, "projection-backed cards must be claimable");
                    assert.equal(await connection.unary.call("userQuestions/answer", { agentId: asked.sessionId, callId: interaction.continuedCallId,
                        answer: { answers: [{ id: "scope", selected: ["Tool only"] }] } }), true);
                } else {
                    await connection.answerRemoteEvent(interaction.rpcId, { kind: "result", value: { answers: [{ id: "scope", selected: ["Tool only"] }] } });
                }
                await until(() => coordinator.sessions.get(asked.sessionId)?.interactions.find(item => item.key === interaction.key)?.answers?.[0]?.selected[0] === "Tool only", "recorded answer reconciliation");
                release();
            }
            pass("Foreground questions claim Host waits; reconnect preserves identity; countdown and late reply settle the same card");
        }
    }
    if (featureControls && withTeamBundle) {
        const lead = await connection.unary.call("session/create", { request: { workspaceId, agentPreset: "standard" } });
        coordinator.watchSession(lead.sessionId);
        await connection.unary.call("session/prompt", { request: { sessionId: lead.sessionId, requestId: randomUUID(), mode: "queue",
            content: [{ type: "text", text: "TEAM_PANEL_SMOKE: explicitly create one teammate and a task for integration verification" }] } });
        await until(() => {
            const value = normalizeAgentTeamProjection(coordinator.sessions.get(lead.sessionId)?.projections.find(cell => cell.key === "agentTeam")?.value);
            return value?.members.some(member => member.name === "smoke-worker" && member.phase === "active");
        }, "Team member projection");
        await connection.unary.call("session/prompt", { request: { sessionId: lead.sessionId, requestId: randomUUID(), mode: "queue",
            content: [{ type: "text", text: "TEAM_TASK_SMOKE: create the shared task for the panel verification" }] } });
        const team = await until(() => {
            const value = normalizeAgentTeamProjection(coordinator.sessions.get(lead.sessionId)?.projections.find(cell => cell.key === "agentTeam")?.value);
            return value?.tasks.length === 1 ? value : undefined;
        }, "Team task projection");
        assert.equal(team.tasks[0].subject, "Smoke team task");
        assert.deepEqual(team.tasks[0].writeScopes, ["src"]);
        const member = team.members.find(row => row.name === "smoke-worker");
        // Team profiles disable the legacy subagents/list contribution; the durable projection is the roster.
        await assert.rejects(() => connection.unary.call("subagents/list", { parentSessionId: lead.sessionId }), error => error.status === 404);
        const history = await first("session/follow", { request: { address: { kind: "subagent", parentSessionId: lead.sessionId,
            childSessionId: member.id, mode: "continuable" } } });
        assert.equal(history.type, "snapshot");
        const panel = new SubagentController({
            runtime: {
                getUrl: () => baseUrl,
                getSessionStore: () => coordinator.sessions,
                getSessionCatalog: () => coordinator.catalog,
                listSubagents: () => { throw new Error("Team navigation must use its projection, not subagents/list"); },
                subagentHistory: async (address, _beforeSeq, _maxMessages, signal) => {
                    const abort = new AbortController();
                    try {
                        for await (const frame of connection.open("session/follow", { request: { address: { kind: "subagent", ...address }, maxMessages: 100 } }, AbortSignal.any([abort.signal, signal]))) {
                            assert.equal(frame.type, "snapshot");
                            coordinator.watchSubagent({ kind: "subagent", ...address });
                            return { events: historyEntries(frame.records), hasMore: frame.hasMore, projections: remoteProjectionBlock(frame.projections) };
                        }
                    } finally { abort.abort(); }
                    throw new Error("missing member snapshot");
                },
                promptSubagent: (address, text) => connection.unary.call("subagents/prompt", { request: { ...address, delivery: "queue", requestId: randomUUID(), content: [{ type: "text", text }] } }),
            },
            currentRootSession: () => lead.sessionId,
            onChange: () => undefined,
        });
        featureDisposers.push(() => panel.dispose());
        await panel.refreshSubagentTree(lead.sessionId);
        assert.equal(panel.tree(lead.sessionId).state, "ready");
        await panel.openSubagentHistory(member.id);
        assert.equal(panel.previewFor(lead.sessionId).state, "ready", JSON.stringify(panel.previewFor(lead.sessionId)));
        await panel.followUpSubagent(member.id, "TEAM_FOLLOWUP_SMOKE");
        assert.equal(panel.previewFor(lead.sessionId).error, undefined);
        pass("Team projection, member history and follow-up work with subagents/list absent, through the actual panel controller");
    }
    const streamTypes = [...new Set(wireFrames.map(({ endpoint, frame }) => `${endpoint}:${frame.type ?? frame.kind}`))];
    console.log(`Observed frames: ${streamTypes.join(", ")}`);
    assert.equal(diagnostics.length, 0, diagnostics.join("\n"));
    console.log(`OK: real Runtime integration smoke passed; ${modelRequests} local mock model request(s), no external model calls.`);
} catch (error) {
    console.error(error.stack ?? error);
    if (featureControls) console.error(`Feature tool/job frames: ${JSON.stringify(wireFrames.filter(item => item.endpoint.startsWith("job/") || ["tool/call", "tool/result"].includes(item.frame.event?.type)).slice(-10))}`);
    console.error(`Mock requests: ${modelRequests}; recent wire frames: ${JSON.stringify(wireFrames.slice(-8).map(item => ({ endpoint: item.endpoint, type: item.frame.type, event: item.frame.event?.type, generation: item.generation })))}`);
    process.exitCode = 1;
} finally {
    finishStream?.();
    for (const release of featureDisposers) release();
    jobsController?.dispose();
    await coordinator?.stop().catch(() => undefined);
    if (!coordinator) await connection?.stop().catch(() => undefined);
    if (!exited) child.kill("SIGTERM");
    await Promise.race([new Promise(resolveExit => {
        if (exited || launchError) resolveExit();
        else child.once("exit", resolveExit);
    }), new Promise(resolveTimeout => setTimeout(resolveTimeout, 3000))]);
    if (!exited && !launchError) { child.kill("SIGKILL"); await new Promise(resolveExit => child.once("exit", resolveExit)); }
    model.closeAllConnections();
    await new Promise(resolveClose => model.close(resolveClose));
    if (keep) console.log(`Kept isolated storage: ${storage}`);
    else await rm(storage, { recursive: true, force: true });
}
