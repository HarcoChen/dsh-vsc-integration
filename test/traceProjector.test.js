"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
    projectSessionTrace,
    safeTraceJson,
    traceRowView,
} = require("../dist/traceProjector.js");

function stored(seq, type, time, data, extras = {}, view) {
    return {
        event: { type, seq, time, data, ...extras },
        ...(view === undefined ? {} : { view }),
        source: "history",
    };
}

function snapshot(events, projections = []) {
    return {
        sessionId: "session-a",
        events,
        surface: { nodes: [], replacements: [], complete: true, issues: [] },
        projections,
        queue: { items: [], revision: 0, source: "initial" },
        jobs: { items: [], revision: 0, source: "initial" },
        interactions: [],
        needsHistoryBaseline: false,
    };
}

test("trace projector folds chunks and pairs native and nested tool lifecycles", () => {
    const events = [
        stored(0, "turn/start", 1_000, { turn: 1 }),
        stored(1, "user/message", 1_010, {
            id: "u1",
            role: "user",
            content: [{ type: "text", text: "inspect config" }],
            source: { kind: "user" },
        }, { surfaceOp: "append" }),
        stored(2, "step/start", 1_100, { turn: 1, step: 1 }),
        stored(3, "assistant/chunk", 1_120, {
            turn: 1,
            step: 1,
            chunk: { type: "text-delta", index: 0, text: "I will inspect it." },
        }),
        stored(4, "assistant/chunk", 1_130, {
            turn: 1,
            step: 1,
            chunk: {
                type: "usage",
                usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 1 },
            },
        }),
        stored(5, "assistant/message", 1_200, {
            turn: 1,
            step: 1,
            message: {
                id: "a1",
                role: "assistant",
                content: [{ type: "text", text: "I will inspect it." }],
                source: { kind: "model", provider: "deepseek", model: "chat" },
            },
            usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 1 },
        }, { surfaceOp: "append", sourceEventSeqs: [3, 4] }),
        stored(6, "tool/call", 1_210, {
            turn: 1,
            step: 1,
            callId: "call-1",
            name: "read_file",
            arguments: "{\"path\":\"settings.json\"}",
        }, {}, {
            for: "call",
            view: { card: "tool", title: "Read config", rawInput: { path: "settings.json" } },
        }),
        stored(7, "tool/code-dispatch-start", 1_220, {
            rootCallId: "call-1",
            parentCallId: "call-1",
            subCallId: "call-1:code:0",
            name: "stat",
            arguments: { path: "settings.json" },
        }),
        stored(8, "tool/code-dispatch", 1_240, {
            rootCallId: "call-1",
            parentCallId: "call-1",
            subCallId: "call-1:code:0",
            name: "stat",
            arguments: { path: "settings.json" },
            isError: false,
            content: [{ type: "text", text: "12 bytes" }],
        }),
        stored(9, "tool/result", 1_260, {
            turn: 1,
            step: 1,
            message: {
                id: "r1",
                role: "tool",
                content: [{
                    type: "tool-result",
                    toolCallId: "call-1",
                    content: [{ type: "text", text: "done" }],
                    isError: false,
                }],
                source: { kind: "tool", callId: "call-1" },
            },
        }, { surfaceOp: "append" }, {
            for: "result",
            view: { card: "terminal", title: "Output", output: "done", exitCode: 0 },
        }),
        stored(10, "step/end", 1_270, { turn: 1, step: 1 }),
        stored(11, "turn/end", 1_300, { turn: 1, reason: { kind: "completed" } }),
        stored(12, "plugin/future-event", 1_310, { future: true, note: "keep me" }),
    ];
    const result = projectSessionTrace(snapshot(events, [
        { key: "goal", seq: 11, value: { goal: { id: "g1" } } },
        { key: "plugin/future", seq: 12, value: { accessToken: "hidden", enabled: true } },
    ]));

    const assistant = result.rows.find((row) => row.category === "assistant");
    assert.ok(assistant);
    assert.equal(assistant.summary, "I will inspect it.");
    assert.equal(assistant.durationMs, 100);
    assert.deepEqual(assistant.tokens, {
        inputTokens: 10,
        outputTokens: 4,
        reasoningTokens: 1,
    });
    assert.ok(assistant.detail.summary.some((field) => field.label === "TTFT" && field.value === "20 ms"));
    assert.equal(result.seqToRowId.get(3), assistant.id);
    assert.equal(result.seqToRowId.get(4), assistant.id);
    assert.equal(result.rows.some((row) => row.id === "event:3"), false);

    const tool = result.rows.find((row) => row.id === "tool:call-1");
    assert.ok(tool);
    assert.equal(tool.durationMs, 50);
    assert.equal(tool.tool.name, "read_file");
    assert.match(tool.tool.args, /settings\.json/);
    assert.match(tool.tool.result, /Output.*done.*exit 0/);
    assert.equal(result.seqToRowId.get(9), tool.id);

    const subtool = result.rows.find((row) => row.id === "subtool:call-1:code:0");
    assert.ok(subtool);
    assert.equal(subtool.parentCallId, "call-1");
    assert.equal(subtool.depth, 1);
    assert.equal(subtool.durationMs, 20);
    assert.match(subtool.tool.result, /12 bytes/);
    assert.equal(result.seqToRowId.get(8), subtool.id);

    const turn = result.rows.find((row) => row.id === "event:0");
    assert.equal(turn.durationMs, 300);
    const unknown = result.rows.find((row) => row.id === "event:12");
    assert.ok(unknown);
    assert.equal(unknown.category, "generic");
    assert.match(unknown.searchText, /keep me/);

    assert.deepEqual(result.projections.map((item) => [item.key, item.seq]), [
        ["goal", 11],
        ["plugin/future", 12],
    ]);
    assert.match(result.projections[1].valuePreview, /\[redacted\]/);
    assert.equal("detail" in traceRowView(tool), false, "extension-only raw detail is not posted with rows");
    assert.equal("searchText" in traceRowView(tool), false);
});

test("trace projector never invents duration for open boundaries or tool calls", () => {
    const result = projectSessionTrace(snapshot([
        stored(0, "turn/start", 1_000, { turn: 1 }),
        stored(1, "step/start", 1_100, { turn: 1, step: 1 }),
        stored(2, "tool/call", 1_200, {
            turn: 1,
            step: 1,
            callId: "open-call",
            name: "wait",
            arguments: "{}",
        }),
    ]));
    assert.equal(result.rows.find((row) => row.id === "event:0").durationMs, undefined);
    assert.equal(result.rows.find((row) => row.id === "event:1").durationMs, undefined);
    assert.equal(result.rows.find((row) => row.id === "tool:open-call").durationMs, undefined);
});

test("raw trace JSON is redacted and size bounded without hiding token counts", () => {
    const raw = safeTraceJson({
        apiKey: "secret-a",
        accessToken: "secret-b",
        nested: { password: "secret-c" },
        inputTokens: 42,
        outputTokens: 7,
        text: "x".repeat(10_000),
    }, 600);
    assert.doesNotMatch(raw, /secret-[abc]/);
    assert.match(raw, /\[redacted\]/);
    assert.match(raw, /"inputTokens": 42/);
    assert.match(raw, /raw detail truncated/);
    assert.ok(raw.length <= 600);
});
