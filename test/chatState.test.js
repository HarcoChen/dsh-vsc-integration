"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
    hiddenViewBadge,
    focusChatMessages,
    projectChatMessages,
    projectTurnStatus,
    queueDockItems,
    resolvePromptMode,
} = require("../dist/chatState.js");
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

test("tool cards pair calls and results and prefer host presentation views", () => {
    const store = new HarnessSessionStore();
    store.applyMuxEnvelope({
        rpcId: "call",
        method: "session/event",
        payload: {
            type: "session/event",
            sessionId: "tools",
            event: event(1, "tool/call", {
                turn: 1,
                step: 1,
                callId: "call-1",
                name: "shell",
                arguments: "{\"command\":\"ignored fallback\"}",
            }),
            view: {
                for: "call",
                view: { title: "Run tests", description: "npm test", cwd: "/workspace" },
            },
        },
    });

    let tool = projectChatMessages(store.get("tools"), [])[0];
    assert.equal(tool.role, "tool");
    assert.deepEqual(tool.tool, {
        callId: "call-1",
        name: "shell",
        title: "Run tests",
        status: "running",
        args: "npm test · /workspace",
    });

    store.applyMuxEnvelope({
        rpcId: "result",
        method: "session/event",
        payload: {
            type: "session/event",
            sessionId: "tools",
            event: { ...event(2, "tool/result", {
                message: {
                    source: { kind: "tool", callId: "call-1" },
                    content: [{
                        type: "tool-result",
                        toolCallId: "call-1",
                        isError: false,
                        content: [{ type: "text", text: "fallback output" }],
                    }],
                },
            }), time: 2501 },
            view: { for: "result", view: { output: "18 tests passed", exitCode: 0 } },
        },
    });
    tool = projectChatMessages(store.get("tools"), [])[0];
    assert.deepEqual(tool.tool, {
        callId: "call-1",
        name: "shell",
        title: "Run tests",
        status: "completed",
        args: "npm test · /workspace",
        result: "18 tests passed · exit 0",
        durationMs: 1500,
    });
});

test("tool cards expose structured and provider-reported failures", () => {
    const store = new HarnessSessionStore();
    store.applyMuxEnvelope(envelope("call", {
        type: "session/event",
        sessionId: "failed-tool",
        event: event(4, "tool/call", {
            callId: "bad-call",
            name: "write",
            arguments: { path: "secret.txt", authorization: "hidden" },
        }),
    }));
    store.applyMuxEnvelope(envelope("result", {
        type: "session/event",
        sessionId: "failed-tool",
        event: event(5, "tool/result", {
            callId: "bad-call",
            error: { code: "DENIED", message: "permission rejected" },
            content: [{ type: "text", text: "not written" }],
        }),
    }));
    const tool = projectChatMessages(store.get("failed-tool"), [])[0].tool;
    assert.equal(tool.status, "failed");
    assert.equal(tool.error, "DENIED · permission rejected");
    assert.match(tool.args, /\[redacted\]/);
    assert.doesNotMatch(tool.args, /hidden/);
});

test("tool card JSON-string arguments redact sensitive keys before reaching the webview", () => {
    const store = new HarnessSessionStore();
    store.applyMuxEnvelope(envelope("call", {
        type: "session/event",
        sessionId: "redacted-tool",
        event: event(1, "tool/call", {
            callId: "secret-call",
            name: "request",
            arguments: JSON.stringify({ url: "https://example.test", apiKey: "must-not-render" }),
        }),
    }));
    const args = projectChatMessages(store.get("redacted-tool"), [])[0].tool.args;
    assert.match(args, /example\.test/);
    assert.match(args, /\[redacted\]/);
    assert.doesNotMatch(args, /must-not-render/);
});

test("turn status maps Harness lifecycle reasons and transient priority", () => {
    const lifecycle = (reason) => {
        const store = new HarnessSessionStore();
        store.applyMuxEnvelope(envelope("start", {
            type: "session/event",
            sessionId: "turn",
            event: event(1, "turn/start", { turn: 3 }),
        }));
        if (reason) store.applyMuxEnvelope(envelope("end", {
            type: "session/event",
            sessionId: "turn",
            event: event(2, "turn/end", { turn: 3, reason }),
        }));
        return store;
    };

    assert.deepEqual(projectTurnStatus(lifecycle().get("turn"), false), {
        phase: "running",
        turn: 3,
    });
    assert.deepEqual(projectTurnStatus(lifecycle({ kind: "completed" }).get("turn"), false), {
        phase: "completed",
        turn: 3,
    });
    assert.deepEqual(projectTurnStatus(lifecycle({ kind: "aborted", reason: { kind: "user" } }).get("turn"), false), {
        phase: "cancelled",
        turn: 3,
    });
    assert.deepEqual(projectTurnStatus(lifecycle({ kind: "interrupted" }).get("turn"), false), {
        phase: "cancelled",
        turn: 3,
    });
    assert.deepEqual(projectTurnStatus(lifecycle({ kind: "max-tokens" }).get("turn"), false), {
        phase: "failed",
        turn: 3,
        detail: "达到最大输出 token",
    });
    assert.deepEqual(projectTurnStatus(
        lifecycle({ kind: "completed" }).get("turn"),
        false,
        "provider unavailable",
    ), {
        phase: "failed",
        turn: 3,
        detail: "provider unavailable",
    });

    const queued = lifecycle({ kind: "completed" });
    queued.applyMuxEnvelope(envelope("queue", {
        type: "session/queue",
        sessionId: "turn",
        items: [{ id: "q1", placement: "queued", message: {} }],
    }));
    assert.equal(projectTurnStatus(queued.get("turn"), false).phase, "queued");
    assert.equal(projectTurnStatus(queued.get("turn"), true).phase, "running");

    queued.applyMuxEnvelope(envelope("approval", {
        type: "approval/requested",
        sessionId: "turn",
        approvalId: "approval-1",
        toolName: "shell",
    }));
    assert.equal(projectTurnStatus(queued.get("turn"), true).phase, "waiting");
});

test("hidden view badge deduplicates completed and attention sessions", () => {
    const badge = hiddenViewBadge([
        { sessionId: "attention", pendingInteraction: "approval" },
        { sessionId: "idle" },
    ], new Set(["attention", "completed"]));
    assert.deepEqual(badge, { value: 2, tooltip: "1 个会话等待操作" });
    assert.equal(hiddenViewBadge([{ sessionId: "idle" }], new Set()), undefined);
});

test("prompt mode permits steer only while the selected session is running", () => {
    assert.equal(resolvePromptMode("queue", false), "queue");
    assert.equal(resolvePromptMode("queue", true), "queue");
    assert.equal(resolvePromptMode("steer", false), "queue");
    assert.equal(resolvePromptMode("steer", true), "steer");
});

test("Focus view removes tool rows and reasoning without mutating the transcript", () => {
    const messages = [
        { id: "u", role: "user", text: "question", createdAt: 1 },
        {
            id: "a",
            role: "assistant",
            text: "final answer",
            reasoning: "hidden thought",
            reasoningState: "complete",
            renderedReasoningHtml: "<p>hidden thought</p>",
            reasoningRenderId: "render-reasoning",
            createdAt: 2,
        },
        {
            id: "tool:1",
            role: "tool",
            text: "shell",
            tool: { callId: "1", name: "shell", title: "Run", status: "completed" },
            createdAt: 3,
        },
        { id: "system", role: "system", text: "notice", createdAt: 4 },
    ];
    const focused = focusChatMessages(messages, true);
    assert.deepEqual(focused.map((message) => [message.role, message.text]), [
        ["user", "question"],
        ["assistant", "final answer"],
        ["system", "notice"],
    ]);
    assert.equal("reasoning" in focused[1], false);
    assert.equal(messages[1].reasoning, "hidden thought");
    assert.notEqual(focusChatMessages(messages, false)[0], messages[0]);
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
