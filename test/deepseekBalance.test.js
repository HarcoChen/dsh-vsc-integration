const assert = require("node:assert/strict");
const test = require("node:test");
const { fetchDeepSeekBalance } = require("../dist/deepseekBalance");

test("fetchDeepSeekBalance sends the bearer key and normalizes balance details", async () => {
    let requestUrl;
    let requestInit;
    const balance = await fetchDeepSeekBalance("sk-test", {
        endpoint: "https://balance.test/user/balance",
        fetch: async (url, init) => {
            requestUrl = url;
            requestInit = init;
            return Response.json({
                is_available: true,
                balance_infos: [
                    {
                        currency: "USD",
                        total_balance: "12.50",
                        granted_balance: "2.50",
                        topped_up_balance: "10.00",
                    },
                ],
            });
        },
    });

    assert.equal(requestUrl, "https://balance.test/user/balance");
    assert.equal(requestInit.method, "GET");
    assert.equal(requestInit.headers.Authorization, "Bearer sk-test");
    assert.deepEqual(balance, {
        isAvailable: true,
        balanceInfos: [
            {
                currency: "USD",
                totalBalance: "12.50",
                grantedBalance: "2.50",
                toppedUpBalance: "10.00",
            },
        ],
    });
});

test("fetchDeepSeekBalance does not echo a key on HTTP failure", async () => {
    await assert.rejects(
        fetchDeepSeekBalance("sk-secret", {
            fetch: async () => new Response(null, { status: 401 }),
        }),
        (error) => {
            assert.match(error.message, /HTTP 401/);
            assert.doesNotMatch(error.message, /sk-secret/);
            return true;
        },
    );
});

test("fetchDeepSeekBalance rejects malformed responses", async () => {
    await assert.rejects(
        fetchDeepSeekBalance("sk-test", {
            fetch: async () => Response.json({ balance_infos: [] }),
        }),
        /response is invalid/,
    );
});
