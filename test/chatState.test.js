"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { projectChatMessages, queueDockItems } = require("../dist/chatState.js");
const { HarnessSessionStore } = require("../dist/sessionStore.js");

function envelope(rpcId, payload) {
    return { rpcId, method: payload.type, payload };
}

function event(seq, type, data, extras = {}) {
    return { type, seq, time: 1000 + seq, data, ...extras };
}

test("chat projection reconciles an optimistic user row and replaces chunks with final assistant", () => {
    const store = new HarnessSessionStore();
    store.applyMuxEnvelope(envelope("u", {
        type: "session/event",
        sessionId: "s1",
        event: event(0, "user/message", {
            id: "m-user",
            role: "user",
            content: [{ type: "text", text: "hello\n\n<ide_context>\nctx</ide_context>" }],
            source: { kind: "user" },
        }, { surfaceOp: "append" }),
    }));
    store.applyMuxEnvelope(envelope("c", {
        type: "session/event",
        sessionId: "s1",
        event: event(1, "assistant/chunk", {
            turn: 1,
            step: 1,
            chunk: { type: "text-delta", index: 0, text: "par" },
        }),
    }));
    const optimistic = [{
        id: "optimistic:1",
        sessionId: "s1",
        displayText: "hello",
        wireText: "hello\n\n<ide_context>\nctx</ide_context>",
        afterSeq: -1,
        createdAt: 900,
    }];

    let rows = projectChatMessages(store.get("s1"), optimistic);
    assert.deepEqual(rows.map((row) => [row.role, row.text, row.state]), [
        ["user", "hello", "committed"],
        ["assistant", "par", "streaming"],
    ]);

    store.applyMuxEnvelope(envelope("a", {
        type: "session/event",
        sessionId: "s1",
        event: event(2, "assistant/message", {
            turn: 1,
            step: 1,
            message: {
                id: "m-assistant",
                role: "assistant",
                content: [{ type: "text", text: "partial complete" }],
                source: { kind: "model", provider: "p", model: "m" },
            },
        }, { surfaceOp: "append", sourceEventSeqs: [1] }),
    }));
    rows = projectChatMessages(store.get("s1"), optimistic);
    assert.deepEqual(rows.filter((row) => row.role === "assistant").map((row) => row.text), [
        "partial complete",
    ]);
});

test("queue dock uses the authoritative snapshot and never exposes context placement", () => {
    const items = queueDockItems([
        {
            id: "q1",
            placement: "queued",
            message: { content: [{ type: "text", text: "next task" }] },
        },
        {
            id: "q2",
            placement: "steering",
            message: { content: [{ type: "image" }, { type: "text", text: "look" }] },
        },
        {
            id: "secret-context",
            placement: "context",
            message: { content: [{ type: "text", text: "must stay hidden" }] },
        },
    ]);
    assert.deepEqual(items.map((item) => item.id), ["q1", "q2"]);
    assert.equal(items[0].editableText, "next task");
    assert.equal(items[1].editableText, undefined);
});
