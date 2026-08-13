const assert = require("node:assert/strict");
const test = require("node:test");
const { HarnessConnectionController } = require("../dist/harnessConnection");
const { HarnessApiClient } = require("../dist/harnessClient");
const { HarnessStateCoordinator } = require("../dist/harnessState");

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function waitForAbort(signal) {
    if (signal.aborted) {
        return Promise.resolve();
    }
    return new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
}

async function withTimeout(promise, milliseconds = 2_000) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("test timed out")), milliseconds);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

test("either physical stream ending reconnects the whole generation and re-runs baseline hook", async () => {
    const endFirstMux = deferred();
    let muxGenerations = 0;
    let hostGenerations = 0;
    const transport = {
        async describe() {
            return {
                version: "test",
                cwd: "/project",
                attachedSessions: 1,
                canOpenPath: false,
            };
        },
        mux(signal, onOpen) {
            const generation = ++muxGenerations;
            return (async function* () {
                onOpen?.();
                if (generation === 1) {
                    await endFirstMux.promise;
                    return;
                }
                await waitForAbort(signal);
            })();
        },
        host(signal, onOpen) {
            hostGenerations += 1;
            return (async function* () {
                onOpen?.();
                await waitForAbort(signal);
            })();
        },
    };

    const connectedGenerations = [];
    const states = [];
    const secondConnected = deferred();
    const controller = new HarnessConnectionController(
        transport,
        {
            onConnected: (_description, generation) => {
                connectedGenerations.push(generation);
                if (generation === 1) {
                    endFirstMux.resolve();
                } else {
                    secondConnected.resolve();
                }
            },
            onStateChange: (state) => states.push(state),
        },
        {
            backoffBaseMs: 1,
            backoffMaxMs: 1,
            sleep: async () => undefined,
            streamOpenTimeoutMs: 100,
        },
    );

    controller.start();
    await withTimeout(secondConnected.promise);
    await controller.stop();

    assert.deepEqual(connectedGenerations, [1, 2]);
    assert.equal(muxGenerations, 2);
    assert.equal(hostGenerations, 2);
    assert.ok(states.includes("reconnecting"));
    assert.equal(states.at(-1), "stopped");
});

test("history synchronizer paginates to seq zero and applies the tail projection baseline", async () => {
    let historyCalls = 0;
    const client = new HarnessApiClient({
        baseUrl: "http://harness.test",
        mintRpcId: () => `rpc-${historyCalls}`,
        fetch: async (_url, init) => {
            const request = JSON.parse(init.body);
            historyCalls += 1;
            const older = request.payload.beforeSeq === 2;
            const value = older
                ? {
                      events: [
                          {
                              event: {
                                  type: "user/message",
                                  seq: 0,
                                  time: 1,
                                  data: { content: [] },
                                  surfaceOp: "append",
                              },
                          },
                          {
                              event: {
                                  type: "step/start",
                                  seq: 1,
                                  time: 2,
                                  data: { turn: 0, step: 0 },
                              },
                          },
                      ],
                      hasMore: false,
                  }
                : {
                      events: [
                          {
                              event: {
                                  type: "assistant/message",
                                  seq: 2,
                                  time: 3,
                                  data: { message: { content: [] } },
                                  surfaceOp: "append",
                                  sourceEventSeqs: [],
                              },
                          },
                      ],
                      hasMore: true,
                      projections: { asOfSeq: 2, values: { title: "Rebased" } },
                  };
            return Response.json({
                type: "server-response",
                rpcId: request.rpcId,
                result: { ok: true, value },
            });
        },
    });
    const coordinator = new HarnessStateCoordinator(client);

    await Promise.all([
        coordinator.syncHistory("s1"),
        coordinator.syncHistory("s1"),
    ]);
    const session = coordinator.sessions.get("s1");

    assert.equal(historyCalls, 2, "concurrent repair requests should coalesce");
    assert.deepEqual(session.events.map((stored) => stored.event.seq), [0, 1, 2]);
    assert.deepEqual(session.surface.nodes.map((node) => node.seq), [0, 2]);
    assert.deepEqual(session.projections, [
        { key: "title", value: "Rebased", seq: 2 },
    ]);
    await coordinator.stop();
});

