const assert = require("node:assert/strict");
const test = require("node:test");
const { HarnessApiClient, takeSseData } = require("../dist/harnessClient");

function envelope(rpcId, payload) {
    return JSON.stringify({
        type: "server-request",
        rpcId,
        method: payload.type,
        payload,
    });
}

function chunkedResponse(chunks) {
    const encoder = new TextEncoder();
    return new Response(
        new ReadableStream({
            start(controller) {
                for (const chunk of chunks) {
                    controller.enqueue(encoder.encode(chunk));
                }
                controller.close();
            },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
    );
}

test("SSE parser extracts multiple records, CRLF, multiline data, and skips empty frames", () => {
    const first = envelope("one", {
        type: "session/subscribed",
        sessionId: "s1",
        lastSeq: -1,
    });
    const second = envelope("two", {
        type: "session/jobs",
        sessionId: "s1",
        jobs: [],
    });
    const split = Math.floor(second.length / 2);
    const parsed = takeSseData(
        `data: ${first}\r\n\r\n: heartbeat\r\n\r\ndata: ${second.slice(0, split)}\r\ndata: ${second.slice(split)}\r\n\r\n\r\n`,
    );

    assert.deepEqual(parsed.values, [first, `${second.slice(0, split)}\n${second.slice(split)}`]);
    assert.equal(parsed.rest, "\r\n");
});

test("stream reader handles multiple events in one chunk and an event split across chunks", async () => {
    const one = envelope("one", {
        type: "session/subscribed",
        sessionId: "s1",
        lastSeq: 2,
    });
    const two = envelope("two", {
        type: "session/queue",
        sessionId: "s1",
        items: [],
    });
    const streamText = `data: ${one}\n\ndata: ${two}\r\n\r\n`;
    const client = new HarnessApiClient({
        baseUrl: "http://harness.test",
        fetch: async () =>
            chunkedResponse([
                streamText.slice(0, 11),
                streamText.slice(11, streamText.length - 5),
                streamText.slice(streamText.length - 5),
            ]),
    });

    const frames = [];
    for await (const frame of client.mux(new AbortController().signal)) {
        frames.push(frame);
    }

    assert.deepEqual(
        frames.map((frame) => [frame.rpcId, frame.payload.type]),
        [
            ["one", "session/subscribed"],
            ["two", "session/queue"],
        ],
    );
});

test("typed unary carrier validates echoed rpcId", async () => {
    const client = new HarnessApiClient({
        baseUrl: "http://harness.test",
        mintRpcId: () => "request-1",
        fetch: async (_url, init) => {
            const body = JSON.parse(init.body);
            assert.equal(body.method, "host.describe");
            assert.deepEqual(body.payload, {});
            return Response.json({
                type: "server-response",
                rpcId: "request-1",
                result: {
                    ok: true,
                    value: {
                        version: "0.1.0",
                        cwd: "/tmp/project",
                        attachedSessions: 1,
                        canOpenPath: false,
                    },
                },
            });
        },
    });

    assert.equal((await client.describe()).version, "0.1.0");
});

test("respond posts the original requested rpcId without minting a client request", async () => {
    const client = new HarnessApiClient({
        baseUrl: "http://harness.test",
        mintRpcId: () => {
            throw new Error("respond must not mint a replacement rpcId");
        },
        fetch: async (url, init) => {
            assert.equal(url, "http://harness.test/api/respond");
            assert.deepEqual(JSON.parse(init.body), {
                type: "client-response",
                rpcId: "pending-question-rpc",
                result: {
                    ok: true,
                    value: {
                        sessionId: "s1",
                        answer: { answers: [{ id: "q1", selected: ["yes"] }] },
                    },
                },
            });
            return Response.json({ accepted: true });
        },
    });

    assert.deepEqual(await client.respond({
        type: "client-response",
        rpcId: "pending-question-rpc",
        result: {
            ok: true,
            value: {
                sessionId: "s1",
                answer: { answers: [{ id: "q1", selected: ["yes"] }] },
            },
        },
    }), { accepted: true });
});

test("typed carrier preserves the official goal and subagent RPC payload shapes", async () => {
    const expected = [
        ["goal.create", { sessionId: "s1", objective: "ship", maxGoalRounds: 4 }, { ref: { id: "g1", revision: 1 } }],
        ["goal.edit", { sessionId: "s1", ref: { id: "g1", revision: 1 }, objective: "ship well" }, { ref: { id: "g1", revision: 2 } }],
        ["goal.pause", { sessionId: "s1", ref: { id: "g1", revision: 2 } }, { ref: { id: "g1", revision: 3 } }],
        ["goal.resume", { sessionId: "s1", ref: { id: "g1", revision: 3 } }, { ref: { id: "g1", revision: 4 } }],
        ["goal.complete", { sessionId: "s1", ref: { id: "g1", revision: 4 } }, { ref: { id: "g1", revision: 5 } }],
        ["goal.clear", { sessionId: "s1", ref: { id: "g1", revision: 5 } }, { cleared: true }],
        ["subagent.list", { parentSessionId: "s1" }, { entries: [], parentAvailable: true }],
        ["subagent.history", { parentSessionId: "s1", childSessionId: "c1", mode: "one-shot", maxMessages: 50 }, { events: [], hasMore: false }],
        ["subagent.prompt", { parentSessionId: "s1", childSessionId: "c2", mode: "continuable", content: [{ type: "text", text: "continue" }] }, { messageId: "m1" }],
        ["subagent.interrupt", { parentSessionId: "s1", childSessionId: "c2", mode: "continuable" }, { accepted: true }],
    ];
    let index = 0;
    const client = new HarnessApiClient({
        baseUrl: "http://harness.test",
        mintRpcId: () => `rpc-${index}`,
        fetch: async (url, init) => {
            const [method, payload, value] = expected[index];
            const body = JSON.parse(init.body);
            assert.equal(url, `http://harness.test/api/${method}`);
            assert.equal(body.method, method);
            assert.deepEqual(body.payload, payload);
            const rpcId = body.rpcId;
            index += 1;
            return Response.json({
                type: "server-response",
                rpcId,
                result: { ok: true, value },
            });
        },
    });

    for (const [method, payload] of expected) {
        await client.call(method, payload);
    }
    assert.equal(index, expected.length);
});
