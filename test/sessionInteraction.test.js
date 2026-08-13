"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { HarnessSessionStore } = require("../dist/sessionStore.js");

function envelope(rpcId, payload) {
    return { rpcId, method: payload.type, payload };
}

test("approval waits recover by rpcId, lock double clicks, and settle only on resolved", () => {
    const store = new HarnessSessionStore(undefined, () => 1234);
    const requested = envelope("approval-rpc", {
        type: "approval/requested",
        sessionId: "s1",
        approvalId: "approval-1",
        toolName: "bash",
        reason: "needs workspace write",
    });
    store.applyMuxEnvelope(requested);
    assert.match(store.get("s1").interactions[0].key, /^a:approval-rpc$/);

    const claimed = store.claimInteraction("s1", "a:approval-rpc");
    assert.equal(claimed.status, "submitting");
    assert.equal(store.claimInteraction("s1", "a:approval-rpc"), undefined);
    store.settleInteractionReceipt("s1", "a:approval-rpc", { accepted: true });
    assert.equal(store.get("s1").interactions[0].status, "submitting");

    store.applyMuxEnvelope(envelope("resolved-frame", {
        type: "approval/resolved",
        sessionId: "s1",
        approvalId: "approval-1",
        outcome: "allowed-once",
    }));
    assert.deepEqual(
        { status: store.get("s1").interactions[0].status, outcome: store.get("s1").interactions[0].outcome },
        { status: "resolved", outcome: "allowed-once" },
    );

    store.applyMuxEnvelope(envelope("subscribed", {
        type: "session/subscribed",
        sessionId: "s1",
        lastSeq: -1,
    }));
    assert.deepEqual(store.get("s1").interactions, []);
    store.applyMuxEnvelope(requested);
    assert.equal(store.get("s1").interactions[0].status, "pending");
});

test("rejected receipts fail closed and question resolution addresses the requested rpcId", () => {
    const store = new HarnessSessionStore();
    store.applyMuxEnvelope(envelope("question-rpc", {
        type: "question/requested",
        sessionId: "s2",
        questions: [{ id: "q", question: "Continue?" }],
    }));
    assert.equal(store.claimInteraction("s2", "q:question-rpc").kind, "question");
    store.settleInteractionReceipt("s2", "q:question-rpc", {
        accepted: false,
        reason: "bad-response",
    });
    assert.equal(store.get("s2").interactions[0].status, "failed");
    assert.equal(store.claimInteraction("s2", "q:question-rpc"), undefined);
    store.applyMuxEnvelope(envelope("question-resolved", {
        type: "question/resolved",
        sessionId: "s2",
        questionRpcId: "question-rpc",
        outcome: "answered",
    }));
    assert.equal(store.get("s2").interactions[0].status, "resolved");
});
