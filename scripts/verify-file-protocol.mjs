#!/usr/bin/env node
// Webview -> Host sendPrompt trust-boundary smoke for general file drafts.
// Usage: npx tsc -p tsconfig.json && node scripts/verify-file-protocol.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { parseChatViewAction } = require("../dist/chatViewProtocol");

const failures = [];
function scenario(label, run) {
    try { run(); console.log(`PASS ${label}`); }
    catch (error) { failures.push(error); console.error(`FAIL ${label}: ${error.message}`); }
}

const draft = { name: "notes.pdf", data: Buffer.from("pdf").toString("base64") };
const send = (extra) => parseChatViewAction({ type: "sendPrompt", text: "", mode: "queue", ...extra });

scenario("a prompt carrying only a file is accepted", () => {
    const action = send({ files: [draft] });
    assert.equal(action?.type, "sendPrompt");
    // Without this, an attachment-only send would be dropped as empty.
    assert.equal(action.files.length, 1);
    assert.equal(action.files[0].name, "notes.pdf");
});

scenario("an empty text with no attachment is still rejected", () => {
    assert.equal(send({}), undefined);
});

scenario("a file draft rejects fields outside the upload contract", () => {
    assert.equal(send({ files: [{ ...draft, preview: "data:image/png;base64,AA" }] }), undefined);
    assert.equal(send({ files: [{ ...draft, extra: 1 }] }), undefined);
});

scenario("malformed file drafts are rejected rather than partially accepted", () => {
    assert.equal(send({ files: [{ data: draft.data }] }), undefined);
    assert.equal(send({ files: [{ name: "a", data: "" }] }), undefined);
    assert.equal(send({ files: "nope" }), undefined);
    assert.equal(send({ files: Array.from({ length: 21 }, () => draft) }), undefined);
});

scenario("images and files travel together on one prompt", () => {
    const action = send({
        images: [{ mediaType: "image/png", data: "AAAA" }],
        files: [draft],
    });
    assert.equal(action.images.length, 1);
    assert.equal(action.files.length, 1);
});

if (failures.length > 0) {
    console.error(`${failures.length} scenario(s) failed`);
    process.exit(1);
}
console.log("file-protocol smoke: all scenarios passed");
