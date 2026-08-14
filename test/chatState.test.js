"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { projectChatMessages, queueDockItems } = require("../dist/chatState.js");
const { HarnessSessionStore } = require("../dist/sessionStore.js");
const { renderSafeMarkdown } = require("../dist/safeMarkdown.js");

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
    store.applyMuxEnvelope(envelope("r", {
        type: "session/event",
        sessionId: "s1",
        event: event(2, "assistant/chunk", {
            turn: 1,
            step: 1,
            chunk: { type: "reasoning-delta", index: 1, text: "draft thought" },
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
    const partial = rows.find((row) => row.role === "assistant");
    assert.equal(partial.reasoning, "draft thought");
    assert.equal(partial.reasoningState, "streaming");

    store.applyMuxEnvelope(envelope("a", {
        type: "session/event",
        sessionId: "s1",
        event: event(3, "assistant/message", {
            turn: 1,
            step: 1,
            message: {
                id: "m-assistant",
                role: "assistant",
                content: [
                    { type: "reasoning", text: "final thought" },
                    { type: "text", text: "partial complete" },
                ],
                source: { kind: "model", provider: "p", model: "m" },
            },
        }, { surfaceOp: "append", sourceEventSeqs: [1, 2] }),
    }));
    rows = projectChatMessages(store.get("s1"), optimistic);
    const assistants = rows.filter((row) => row.role === "assistant");
    assert.equal(assistants.length, 1, "final assistant atomically replaces all partial channels");
    assert.deepEqual(assistants[0], {
        id: "event:3",
        role: "assistant",
        text: "partial complete",
        reasoning: "final thought",
        reasoningState: "complete",
        createdAt: 1003,
        seq: 3,
        state: "committed",
    });
});

test("final ContentBlocks preserve text and reasoning order in separate channels", () => {
    const store = new HarnessSessionStore();
    store.applyMuxEnvelope(envelope("u", {
        type: "session/event",
        sessionId: "blocks",
        event: event(0, "user/message", {
            id: "u1",
            role: "user",
            content: [
                { type: "reasoning", text: "user-hidden" },
                { type: "text", text: "question" },
            ],
            source: { kind: "user" },
        }, { surfaceOp: "append" }),
    }));
    store.applyMuxEnvelope(envelope("a", {
        type: "session/event",
        sessionId: "blocks",
        event: event(1, "assistant/message", {
            turn: 1,
            step: 1,
            message: {
                id: "a1",
                role: "assistant",
                content: [
                    { type: "reasoning", text: "think-1" },
                    { type: "text", text: "answer-1" },
                    { type: "image", attachment: { id: "ignored" } },
                    { type: "reasoning", text: "think-2" },
                    { type: "text", text: "answer-2" },
                ],
                source: { kind: "model", provider: "p", model: "m" },
            },
        }, { surfaceOp: "append", sourceEventSeqs: [] }),
    }));
    store.applyMuxEnvelope(envelope("end", {
        type: "session/event",
        sessionId: "blocks",
        event: event(2, "turn/end", {
            turn: 1,
            reason: {
                kind: "error",
                error: { code: "FAILED", message: "visible failure", reasoning: "system-hidden" },
            },
        }),
    }));
    const rows = projectChatMessages(store.get("blocks"), []);
    const user = rows.find((row) => row.role === "user");
    const assistant = rows.find((row) => row.role === "assistant");
    const system = rows.find((row) => row.role === "system");
    assert.equal(user.text, "question");
    assert.equal("reasoning" in user, false, "user messages never expose a reasoning channel");
    assert.equal(assistant.text, "answer-1answer-2");
    assert.equal(assistant.reasoning, "think-1think-2");
    assert.equal(assistant.reasoningState, "complete");
    assert.equal(system.text, "[FAILED] visible failure");
    assert.equal("reasoning" in system, false, "system diagnostics never expose reasoning");
});

test("stream chunks assemble indexed text and reasoning independently", () => {
    const store = new HarnessSessionStore();
    const chunks = [
        { type: "block-start", index: 1, blockType: "reasoning" },
        { type: "reasoning-delta", index: 1, text: "think-1" },
        { type: "block-start", index: 0, blockType: "text" },
        { type: "text-delta", index: 0, text: "answer-1" },
        { type: "reasoning-delta", index: 1, text: "think-2" },
        { type: "block-end", index: 0, block: { type: "text", text: "answer-final" } },
    ];
    chunks.forEach((chunk, seq) => store.applyMuxEnvelope(envelope(`c${seq}`, {
        type: "session/event",
        sessionId: "stream",
        event: event(seq, "assistant/chunk", { turn: 2, step: 3, chunk }),
    })));
    const rows = projectChatMessages(store.get("stream"), []);
    assert.deepEqual(rows, [{
        id: "partial:2:3",
        role: "assistant",
        text: "answer-final",
        reasoning: "think-1think-2",
        reasoningState: "streaming",
        createdAt: 1005,
        state: "streaming",
    }]);
});

test("reasoning-only assistant uses a visible placeholder and safe folded reasoning", () => {
    const streamingStore = new HarnessSessionStore();
    streamingStore.applyMuxEnvelope(envelope("r", {
        type: "session/event",
        sessionId: "reasoning-stream",
        event: event(0, "assistant/chunk", {
            turn: 1,
            step: 1,
            chunk: { type: "reasoning-delta", index: 0, text: "working" },
        }),
    }));
    const streaming = projectChatMessages(streamingStore.get("reasoning-stream"), [])[0];
    assert.equal(streaming.text, "（无可见回答）");
    assert.equal(streaming.reasoning, "working");
    assert.equal(streaming.reasoningState, "streaming");

    const store = new HarnessSessionStore();
    store.applyMuxEnvelope(envelope("a", {
        type: "session/event",
        sessionId: "reasoning-only",
        event: event(0, "assistant/message", {
            turn: 1,
            step: 1,
            message: {
                id: "a1",
                role: "assistant",
                content: [{ type: "reasoning", text: '<img src=x onerror="boom"> **private**' }],
                source: { kind: "model", provider: "p", model: "m" },
            },
        }, { surfaceOp: "append", sourceEventSeqs: [] }),
    }));
    const assistant = projectChatMessages(store.get("reasoning-only"), [])[0];
    assert.equal(assistant.text, "（无可见回答）");
    assert.notEqual(assistant.text, assistant.reasoning);
    assert.equal(assistant.reasoningState, "complete");
    const reasoningHtml = renderSafeMarkdown(assistant.reasoning);
    assert.doesNotMatch(reasoningHtml, /<img/u);
    assert.match(reasoningHtml, /&lt;img src=x onerror=&quot;boom&quot;&gt; <strong>private<\/strong>/);
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
