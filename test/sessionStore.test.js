const assert = require("node:assert/strict");
const test = require("node:test");
const {
    GenericProjectionStore,
    HarnessSessionStore,
    SessionEventStore,
    foldSessionSurface,
} = require("../dist/sessionStore");

function event(seq, type, surfaceOp, sourceEventSeqs) {
    return {
        seq,
        type,
        time: 1_000 + seq,
        data: { seq },
        ...(surfaceOp === undefined ? {} : { surfaceOp }),
        ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
    };
}

function mux(rpcId, payload) {
    return { rpcId, method: payload.type, payload };
}

test("surface fold applies inclusive replacement and retains provenance", () => {
    const folded = foldSessionSurface([
        { event: event(0, "user/message", "append") },
        { event: event(1, "assistant/message", "append", []) },
        { event: event(2, "tool/result", "append") },
        { event: event(3, "step/end") },
        {
            event: event(
                4,
                "assistant/message",
                { op: "replace", start: 0, end: 2 },
                [0, 1, 2],
            ),
        },
    ]);

    assert.deepEqual(folded.nodes.map((node) => node.seq), [4]);
    assert.deepEqual(folded.nodes[0].sourceEventSeqs, [0, 1, 2]);
    assert.deepEqual(folded.replacements, [
        { seq: 4, start: 0, end: 2, shadowedSeqs: [0, 1, 2] },
    ]);
    assert.deepEqual(folded.issues, []);
});

test("surface fold rejects unknown surface carriers and incomplete provenance", () => {
    const folded = foldSessionSurface([
        { event: event(0, "user/message", "append") },
        { event: event(1, "plugin/custom", "append") },
        {
            event: event(
                2,
                "assistant/message",
                { op: "replace", start: 0, end: 0 },
                [],
            ),
        },
    ]);

    assert.deepEqual(folded.nodes.map((node) => node.seq), [0]);
    assert.equal(folded.issues.length, 2);
});

test("projection baseline never overwrites a newer live cell", () => {
    const projections = new GenericProjectionStore();
    assert.equal(projections.apply("goal", { phase: "active" }, 12), true);
    assert.equal(
        projections.seed({
            asOfSeq: 10,
            values: { goal: { phase: "paused" }, title: "Initial" },
        }),
        true,
    );
    assert.deepEqual(projections.get("goal"), {
        key: "goal",
        value: { phase: "active" },
        seq: 12,
    });
    assert.equal(projections.get("title").seq, 10);
    assert.equal(projections.apply("goal", { phase: "complete" }, 12), false);

    projections.apply("removedCapability", true, 8);
    projections.seed({ asOfSeq: 11, values: { title: "Current" } });
    assert.equal(projections.get("removedCapability"), undefined);
    assert.equal(projections.get("goal").seq, 12, "newer live cells survive an older baseline");
});

test("event store deduplicates by seq and flags a live gap until history rebaseline", () => {
    const store = new SessionEventStore("s1");
    store.subscribed(2);
    store.ingestLive(event(2, "assistant/message", "append", []));
    assert.equal(store.needsHistoryBaseline, true);
    store.ingestHistory([
        { event: event(0, "user/message", "append") },
        { event: event(1, "step/start") },
        { event: event(2, "assistant/message", "append", []) },
    ]);
    assert.equal(store.needsHistoryBaseline, false);
    assert.equal(store.ordered().length, 3);
    assert.deepEqual(store.surface().nodes.map((node) => node.seq), [0, 2]);
});

test("queue and jobs are complete snapshots and subscribed clears absent baselines", () => {
    let clock = 10;
    const store = new HarnessSessionStore(undefined, () => clock++);
    store.applyMuxEnvelope(
        mux("q1", {
            type: "session/queue",
            sessionId: "s1",
            items: [{ id: "m1", placement: "queued", message: { role: "user" } }],
        }),
    );
    store.applyMuxEnvelope(
        mux("j1", {
            type: "session/jobs",
            sessionId: "s1",
            jobs: [
                {
                    id: "bash-1",
                    kind: "bash",
                    label: "npm test",
                    status: "running",
                    startedAt: 1,
                },
            ],
        }),
    );
    assert.equal(store.get("s1").queue.items.length, 1);
    assert.equal(store.get("s1").jobs.items.length, 1);

    store.applyMuxEnvelope(
        mux("sub", { type: "session/subscribed", sessionId: "s1", lastSeq: -1 }),
    );
    assert.deepEqual(store.get("s1").queue.items, []);
    assert.deepEqual(store.get("s1").jobs.items, []);
    assert.equal(store.get("s1").jobs.source, "subscribed-clear");

    store.applyMuxEnvelope(
        mux("j2", { type: "session/jobs", sessionId: "s1", jobs: [] }),
    );
    assert.equal(store.get("s1").jobs.source, "frame");
    assert.equal(store.get("s1").jobs.rpcId, "j2");
});

test("history baseline and live projection use higher-seq-wins per session", () => {
    const store = new HarnessSessionStore();
    store.applyMuxEnvelope(
        mux("p1", {
            type: "session/projection",
            sessionId: "s1",
            key: "plan",
            value: ["live"],
            seq: 4,
        }),
    );
    store.rebaseline("s1", {
        events: [],
        projections: { asOfSeq: 3, values: { plan: ["old"], unknownPlugin: 42 } },
    });

    const projections = Object.fromEntries(
        store.get("s1").projections.map((cell) => [cell.key, cell]),
    );
    assert.deepEqual(projections.plan.value, ["live"]);
    assert.equal(projections.unknownPlugin.value, 42);
});
