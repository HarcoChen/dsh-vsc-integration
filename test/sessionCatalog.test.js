"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { HarnessCatalogStore } = require("../dist/sessionCatalog.js");

function envelope(rpcId, payload) {
    return { rpcId, method: payload.type, payload };
}

test("catalog merges public baselines with host status, title projection, errors and archive snapshots", () => {
    const catalog = new HarnessCatalogStore(() => 500);
    const baseline = catalog.baselineRevision();
    catalog.seedSessions({ items: [{
        sessionId: "s1",
        updatedAt: 100,
        running: false,
        blank: true,
        projections: { asOfSeq: 1, values: { title: "Cold title" } },
    }] }, baseline);
    catalog.seedWorkspaces({
        items: [{
            workspaceId: "w1",
            path: "/tmp/project",
            title: "Project",
            sessionIds: ["s1"],
            createdAt: "2026-01-01",
            updatedAt: "2026-01-01",
        }],
        archivedSessionIds: [],
    }, baseline);
    assert.equal(catalog.snapshot().sessions[0].title, "Cold title");

    catalog.applyHostEnvelope(envelope("status", {
        type: "host/session-status",
        sessionId: "s1",
        running: true,
    }));
    catalog.applyMuxEnvelope(envelope("title", {
        type: "session/projection",
        sessionId: "s1",
        key: "title",
        value: "Live title",
        seq: 2,
    }));
    catalog.applyHostEnvelope(envelope("error", {
        type: "host/agent-error",
        sessionId: "s1",
        message: "provider unavailable",
    }));
    catalog.applyHostEnvelope(envelope("archive", {
        type: "host/archived-sessions-changed",
        archivedSessionIds: ["s1"],
    }));
    assert.deepEqual(
        {
            title: catalog.snapshot().sessions[0].title,
            running: catalog.snapshot().sessions[0].running,
            blank: catalog.snapshot().sessions[0].blank,
            error: catalog.snapshot().sessions[0].lastAgentError,
            archived: catalog.snapshot().archivedSessionIds,
        },
        {
            title: "Live title",
            running: true,
            blank: false,
            error: "provider unavailable",
            archived: ["s1"],
        },
    );
});

test("late session list baseline cannot overwrite a newer live row", () => {
    const catalog = new HarnessCatalogStore(() => 900);
    const baseline = catalog.baselineRevision();
    catalog.applyHostEnvelope(envelope("added", {
        type: "host/session-added",
        sessionId: "new-live",
        blank: true,
        cwd: "/live",
    }));
    catalog.seedSessions({ items: [] }, baseline);
    assert.deepEqual(catalog.snapshot().sessions.map((item) => item.sessionId), ["new-live"]);
});
