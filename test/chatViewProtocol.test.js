"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseChatViewAction, validateQuestionAnswers } = require("../dist/chatViewProtocol.js");

test("webview action parser accepts only typed interaction and queue messages", () => {
    assert.deepEqual(parseChatViewAction({
        type: "answerApproval",
        key: "a:r1",
        outcome: "allowed-once",
    }), { type: "answerApproval", key: "a:r1", outcome: "allowed-once" });
    assert.deepEqual(parseChatViewAction({
        type: "answerQuestion",
        key: "q:r2",
        answers: [{ id: "choice", selected: ["A"], custom: "detail" }],
    }), {
        type: "answerQuestion",
        key: "q:r2",
        answers: [{ id: "choice", selected: ["A"], custom: "detail" }],
    });
    assert.equal(parseChatViewAction({
        type: "answerApproval",
        key: "a:r1",
        outcome: "allowed-always",
    }), undefined);
    assert.equal(parseChatViewAction({
        type: "updateQueue",
        itemId: "q1",
        action: "edit",
        text: "   ",
    }), undefined);
    assert.equal(parseChatViewAction({ type: "switchSession", sessionId: 5 }), undefined);
});

test("question validation rejects forged options, duplicate ids, and multi-select on radio questions", () => {
    const questions = [{
        id: "q1",
        question: "Choose",
        options: [{ label: "A" }, { label: "B" }],
        multiSelect: false,
    }];
    assert.equal(validateQuestionAnswers(questions, [{ id: "q1", selected: ["A"] }]), undefined);
    assert.match(validateQuestionAnswers(questions, [{ id: "q1", selected: ["forged"] }]), /未提供/);
    assert.match(validateQuestionAnswers(questions, [{ id: "q1", selected: ["A", "B"] }]), /单选/);
    assert.match(validateQuestionAnswers(questions, [
        { id: "q1", selected: ["A"] },
        { id: "q1", selected: ["B"] },
    ]), /不匹配|重复/);
});

test("Goal and subagent actions accept only UI intent, never forged refs or addresses", () => {
    assert.deepEqual(parseChatViewAction({
        type: "goalCreate",
        objective: "  finish phase three  ",
        maxGoalRounds: 12,
    }), {
        type: "goalCreate",
        objective: "finish phase three",
        maxGoalRounds: 12,
    });
    assert.deepEqual(parseChatViewAction({
        type: "goalEdit",
        maxGoalRounds: 20,
    }), { type: "goalEdit", maxGoalRounds: 20 });
    assert.equal(parseChatViewAction({
        type: "goalPause",
        ref: { id: "forged", revision: 99 },
    }), undefined);
    assert.equal(parseChatViewAction({
        type: "goalCreate",
        objective: "x",
        maxGoalRounds: 0,
    }), undefined);
    assert.deepEqual(parseChatViewAction({
        type: "followUpSubagent",
        childSessionId: "child",
        text: "  continue  ",
    }), {
        type: "followUpSubagent",
        childSessionId: "child",
        text: "continue",
    });
    assert.equal(parseChatViewAction({
        type: "followUpSubagent",
        childSessionId: "child",
        parentSessionId: "forged-parent",
        mode: "continuable",
        text: "continue",
    }), undefined);
    assert.equal(parseChatViewAction({
        type: "openSubagent",
        childSessionId: "child",
        provider: "invented",
    }), undefined);
});

test("chat trace action can locate a committed message but cannot forge session scope", () => {
    assert.deepEqual(parseChatViewAction({ type: "openTrace" }), { type: "openTrace" });
    assert.deepEqual(parseChatViewAction({ type: "openTrace", seq: 0 }), {
        type: "openTrace",
        seq: 0,
    });
    assert.equal(parseChatViewAction({ type: "openTrace", seq: -1 }), undefined);
    assert.equal(parseChatViewAction({
        type: "openTrace",
        seq: 4,
        sessionId: "forged",
    }), undefined);
});
