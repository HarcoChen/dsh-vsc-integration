"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
    GoalMutationGate,
    normalizeGoalRef,
    normalizeSubagentCatalog,
    parseGoalProjection,
    presentGoalHud,
    presentJobCenter,
    presentSubagentTree,
    projectSubagentHistory,
    SubagentTreeStore,
} = require("../dist/sessionFeatures.js");

function goalValue(overrides = {}) {
    return {
        goal: {
            id: "goal-1",
            revision: 2,
            objective: "ship the extension",
            phase: "active",
            maxGoalRounds: 8,
            ...overrides,
        },
        roundsStarted: 3,
        createdAt: 100,
        updatedAt: 200,
    };
}

test("Goal HUD exists only for the public goal projection and preserves exact protocol fields", () => {
    assert.deepEqual(normalizeGoalRef({ id: "goal-1", revision: 2, phase: "ignored" }), {
        id: "goal-1",
        revision: 2,
    });
    assert.equal(normalizeGoalRef({ id: "goal-1", revision: 0 }), undefined);
    assert.equal(presentGoalHud(undefined, { pending: false }), undefined);
    assert.deepEqual(
        presentGoalHud({ key: "goal", value: null, seq: -1 }, { pending: false }),
        { state: "empty" },
    );
    assert.deepEqual(parseGoalProjection(goalValue()), { ok: true, value: goalValue() });
    assert.deepEqual(
        presentGoalHud({ key: "goal", value: goalValue(), seq: 7 }, { pending: false }),
        { state: "present", ...goalValue() },
    );
    assert.equal(
        parseGoalProjection(goalValue({ phase: "blocked" })).ok,
        false,
        "blocked goals require the official blockedReason",
    );
});

test("Goal mutation gate prevents double submit and waits for a higher-seq projection", () => {
    const gate = new GoalMutationGate();
    assert.equal(gate.claim("s1", "edit", 4), true);
    assert.equal(gate.claim("s1", "pause", 4), false);
    gate.acknowledgeRef("s1", { id: "goal-1", revision: 3 });
    gate.observe("s1", { key: "goal", value: goalValue(), seq: 4 });
    assert.equal(gate.snapshot("s1").pending, true);
    gate.observe("s1", {
        key: "goal",
        value: goalValue({ revision: 3, objective: "new" }),
        seq: 5,
    });
    assert.deepEqual(gate.snapshot("s1"), { pending: false });

    assert.equal(gate.claim("s2", "pause", 9), true);
    gate.fail("s2", "CAS conflict");
    assert.deepEqual(gate.snapshot("s2"), {
        pending: false,
        operation: "pause",
        error: "CAS conflict",
    });
    assert.equal(gate.claim("s2", "resume", 10), true, "errors release the action gate");
    assert.equal(gate.snapshot("s1").pending, false, "sessions do not share action state");
});

test("Subagent presenter uses only list fields, builds hierarchy, and fences stale generations", () => {
    const root = normalizeSubagentCatalog({
        parentAvailable: true,
        entries: [{
            kind: "child",
            id: "child-1",
            mode: "continuable",
            activity: "running",
            hasChildren: true,
            label: "worker",
            provider: "must-not-leak",
        }],
    });
    const child = normalizeSubagentCatalog({
        parentAvailable: false,
        entries: [{
            kind: "child",
            id: "leaf",
            mode: "one-shot",
            activity: "inactive",
            hasChildren: false,
        }],
    });
    assert.ok(root);
    assert.ok(child);
    const catalogs = new Map([["root", root], ["child-1", child]]);
    const nodes = presentSubagentTree("root", catalogs);
    assert.deepEqual(nodes.map((node) => [node.id, node.parentSessionId, node.depth]), [
        ["child-1", "root", 1],
        ["leaf", "child-1", 2],
    ]);
    assert.equal(nodes[0].mode, "continuable");
    assert.equal(nodes[1].parentAvailable, false);
    assert.equal("provider" in nodes[0], false, "public subagent.list has no provider field");

    const store = new SubagentTreeStore();
    const stale = store.begin("root");
    const current = store.begin("root");
    assert.equal(store.resolve("root", stale, catalogs), false);
    assert.equal(store.resolve("root", current, catalogs), true);
    assert.equal(store.get("root").nodes.length, 2);
    assert.equal(store.get("other"), undefined);
});

test("Subagent history uses the same visible surface projector", () => {
    const messages = projectSubagentHistory("child", {
        hasMore: false,
        events: [{
            event: {
                type: "assistant/message",
                seq: 1,
                time: 10,
                data: {
                    message: {
                        id: "m1",
                        role: "assistant",
                        content: [
                            { type: "reasoning", text: "subagent thought" },
                            { type: "text", text: "done" },
                        ],
                    },
                },
                surfaceOp: "append",
                sourceEventSeqs: [],
            },
        }],
    });
    assert.deepEqual(messages.map((message) => [
        message.role,
        message.text,
        message.reasoning,
        message.reasoningState,
    ]), [["assistant", "done", "subagent thought", "complete"]]);
});

test("Job Center is read-only and exposes detail as the only available output summary", () => {
    const jobs = presentJobCenter("owner-session", [{
        id: "j1",
        kind: "shell",
        label: "Build",
        status: "completed",
        detail: "exit 0",
        startedAt: 10,
        finishedAt: 20,
        stop: true,
        readOutput: "/private/output",
    }]);
    assert.deepEqual(jobs, [{
        id: "j1",
        kind: "shell",
        label: "Build",
        ownerSessionId: "owner-session",
        status: "completed",
        outputSummary: "exit 0",
        startedAt: 10,
        finishedAt: 20,
    }]);
    assert.equal("stop" in jobs[0], false);
    assert.equal("readOutput" in jobs[0], false);
});
