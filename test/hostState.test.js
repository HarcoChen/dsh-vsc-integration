const assert = require("node:assert/strict");
const test = require("node:test");

const { parseHostDescription, presentHostBaseline } = require("../dist/hostState.js");

test("host baseline preserves only the public host.describe fields", () => {
    const value = {
        version: "0.4.0",
        cwd: "/work/project",
        provider: "deepseek",
        model: "deepseek-chat",
        attachedSessions: 3,
        canOpenPath: false,
        protocolVersion: "invented",
    };

    assert.deepEqual(parseHostDescription(value), {
        version: "0.4.0",
        cwd: "/work/project",
        provider: "deepseek",
        model: "deepseek-chat",
        attachedSessions: 3,
        canOpenPath: false,
    });
    assert.deepEqual(presentHostBaseline(value), {
        version: "0.4.0",
        cwd: "/work/project",
        provider: "deepseek",
        model: "deepseek-chat",
        attachedSessions: 3,
        canOpenPath: false,
    });
});

test("host baseline rejects malformed or capability-like descriptions", () => {
    assert.equal(parseHostDescription({ version: "0.4.0", cwd: "/work" }), undefined);
    assert.equal(
        parseHostDescription({
            version: "0.4.0",
            cwd: "/work",
            attachedSessions: -1,
            canOpenPath: true,
        }),
        undefined,
    );
    assert.equal(
        parseHostDescription({
            version: "0.4.0",
            cwd: "/work",
            attachedSessions: 0,
            canOpenPath: "native",
        }),
        undefined,
    );
});
