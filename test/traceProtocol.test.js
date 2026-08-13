"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
    parseTraceLocation,
    parseTraceWebviewAction,
} = require("../dist/traceProtocol.js");

test("trace command location uses stable protocol identities", () => {
    assert.deepEqual(parseTraceLocation({
        sessionId: "session-a",
        seq: 0,
        callId: "call-1",
        turn: 2,
        step: 3,
    }), {
        sessionId: "session-a",
        seq: 0,
        callId: "call-1",
        turn: 2,
        step: 3,
    });
    assert.equal(parseTraceLocation({ sessionId: "", seq: 1 }), undefined);
    assert.equal(parseTraceLocation({ sessionId: "s", seq: -1 }), undefined);
    assert.equal(parseTraceLocation({ sessionId: "s", turn: 1.5 }), undefined);
});

test("trace webview parser accepts bounded UI intent and rejects forged session scope", () => {
    assert.deepEqual(parseTraceWebviewAction({ type: "ready" }), { type: "ready" });
    assert.deepEqual(parseTraceWebviewAction({ type: "selectRow", rowId: "tool:c1" }), {
        type: "selectRow",
        rowId: "tool:c1",
    });
    assert.deepEqual(parseTraceWebviewAction({ type: "page", direction: "latest" }), {
        type: "page",
        direction: "latest",
    });
    assert.equal(parseTraceWebviewAction({
        type: "selectRow",
        rowId: "tool:c1",
        sessionId: "forged",
    }), undefined);
    assert.equal(parseTraceWebviewAction({ type: "setQuery", query: "x".repeat(501) }), undefined);
    assert.equal(parseTraceWebviewAction({ type: "page", direction: "all" }), undefined);
});
