import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { DshRuntime } from "./dshRuntime";
import { escapeHtml, renderFileLocationsHtml } from "./fileLocations";
import { SessionStateSnapshot } from "./sessionStore";
import {
    ProjectedTraceRow,
    projectSessionTrace,
    safeTraceJson,
    TraceDetailSource,
    TraceProjectionItem,
    TraceProjectionResult,
    traceRowView,
} from "./traceProjector";
import {
    parseTraceLocation,
    parseTraceWebviewAction,
    TraceLocation,
    TraceOverview,
    TracePanelMessage,
    TracePanelStatus,
    TraceTimelineItem,
    TraceTimelineMode,
} from "./traceProtocol";
import { openWorkspaceFileLocation } from "./workspaceNavigation";
import { t } from "./localize";
import { errorMessage } from "./errors";

const PAGE_SIZE = 250;
const RAW_DETAIL_LIMIT = 65_536;

function scriptJson(value: unknown): string {
    return JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (character) => {
        const code = character.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000";
        return `\\u${code}`;
    });
}

export class TracePanelManager implements vscode.Disposable, vscode.WebviewPanelSerializer {
    public static readonly viewType = "dsh.traceEditor";
    private readonly panels = new Map<string, TracePanelController>();
    private disposed = false;

    public constructor(
        private readonly runtime: DshRuntime,
        private readonly output: vscode.OutputChannel,
        private readonly workspaceRoot: () => string | undefined,
        private readonly extensionUri: vscode.Uri,
    ) {}

    public async open(locationValue: unknown): Promise<void> {
        const location = parseTraceLocation(locationValue);
        if (!location) throw new Error(t("Trace location is invalid or missing sessionId."));
        const existing = this.panels.get(location.sessionId);
        if (existing) {
            existing.reveal();
            existing.locate(location);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            TracePanelManager.viewType,
            this.panelTitle(location.sessionId),
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: false,
                localResourceRoots: [],
            },
        );
        const controller = this.attach(panel, location.sessionId);
        controller.locate(location);
        await this.ensureSession(controller);
    }

    public async deserializeWebviewPanel(
        webviewPanel: vscode.WebviewPanel,
        state: unknown,
    ): Promise<void> {
        const location = parseTraceLocation(state);
        if (!location || this.disposed) {
            webviewPanel.title = t("DSH Trace (cannot restore)");
            webviewPanel.webview.options = { enableScripts: false, localResourceRoots: [] };
            webviewPanel.webview.html = this.errorHtml(t("The restore state for this Trace tab is invalid."));
            return;
        }
        const existing = this.panels.get(location.sessionId);
        if (existing) {
            webviewPanel.dispose();
            existing.reveal();
            existing.locate(location);
            return;
        }
        const controller = this.attach(webviewPanel, location.sessionId);
        controller.locate(location);
        await this.ensureSession(controller);
    }

    public dispose(): void {
        this.disposed = true;
        for (const controller of [...this.panels.values()]) controller.dispose();
        this.panels.clear();
    }

    private attach(panel: vscode.WebviewPanel, sessionId: string): TracePanelController {
        // The extension root is the only readable root: the panel loads its
        // stylesheet from webview/dist and nothing else.
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };
        panel.webview.html = traceHtml(sessionId, panel.webview, this.extensionUri);
        const controller = new TracePanelController(
            panel,
            sessionId,
            this.runtime,
            this.output,
            () => {
                if (this.panels.get(sessionId) === controller) this.panels.delete(sessionId);
            },
        );
        this.panels.set(sessionId, controller);
        controller.update(this.runtime.getSessionStore().get(sessionId));
        return controller;
    }

    private async ensureSession(controller: TracePanelController): Promise<void> {
        try {
            if (!this.runtime.getUrl()) await this.runtime.start(this.workspaceRoot());
            await this.runtime.syncSession(controller.sessionId);
            const snapshot = this.runtime.getSessionStore().get(controller.sessionId);
            if (!snapshot) throw new Error(t("History was not found for session {sessionId}.", { sessionId: controller.sessionId }));
            controller.update(snapshot);
        } catch (error) {
            const message = errorMessage(error);
            this.output.appendLine(`[dsh:trace] ${controller.sessionId}: ${message}`);
            controller.setError(message);
        }
    }

    private panelTitle(sessionId: string): string {
        const title = this.runtime
            .getSessionCatalog()
            .snapshot()
            .sessions.find((session) => session.sessionId === sessionId)?.title;
        return `DSH Trace: ${(title || sessionId).slice(0, 80)}`;
    }

    private errorHtml(message: string): string {
        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';"><title>DSH Trace</title></head><body><p>${escapeHtml(message)}</p></body></html>`;
    }
}

class TracePanelController implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private readonly unsubscribeStore: () => void;
    private readonly unsubscribeCatalog: () => void;
    private snapshot: SessionStateSnapshot | undefined;
    private projection: TraceProjectionResult = {
        rows: [],
        projections: [],
        seqToRowId: new Map(),
    };
    private query = "";
    private offset = 0;
    private followLatest = true;
    private selectedId: string | undefined;
    private timelineMode: TraceTimelineMode = "sequence";
    private pendingLocation: TraceLocation | undefined;
    private error: string | undefined;
    private updateTimer: ReturnType<typeof setTimeout> | undefined;
    private disposed = false;

    public constructor(
        private readonly panel: vscode.WebviewPanel,
        public readonly sessionId: string,
        private readonly runtime: DshRuntime,
        private readonly output: vscode.OutputChannel,
        onDispose: () => void,
    ) {
        this.unsubscribeStore = runtime.getSessionStore().onDidChange((sessionId, snapshot) => {
            if (sessionId === this.sessionId) this.scheduleUpdate(snapshot);
        });
        this.unsubscribeCatalog = runtime.getSessionCatalog().onDidChange(() => {
            if (!this.disposed) {
                this.updateTitle();
                this.publish();
            }
        });
        this.disposables.push(
            panel.onDidDispose(() => {
                this.cleanup();
                onDispose();
            }),
            panel.webview.onDidReceiveMessage((message: unknown) => this.onMessage(message)),
        );
        this.updateTitle();
    }

    public reveal(): void {
        this.panel.reveal(this.panel.viewColumn, false);
    }

    public locate(location: TraceLocation): void {
        if (location.sessionId !== this.sessionId) return;
        this.pendingLocation = location;
        this.applyPendingLocation();
        this.publish();
    }

    public update(snapshot: SessionStateSnapshot | undefined): void {
        if (this.disposed) return;
        this.snapshot = snapshot;
        if (snapshot) {
            this.error = undefined;
            this.projection = projectSessionTrace(snapshot);
        }
        this.applyPendingLocation();
        this.publish();
        this.refreshSelectedDetail();
    }

    public setError(message: string): void {
        if (this.disposed) return;
        this.error = message;
        this.publish();
    }

    public dispose(): void {
        if (this.disposed) return;
        this.cleanup();
        this.panel.dispose();
    }

    private cleanup(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.updateTimer) clearTimeout(this.updateTimer);
        this.unsubscribeStore();
        this.unsubscribeCatalog();
        for (const disposable of this.disposables) disposable.dispose();
    }

    private scheduleUpdate(snapshot: SessionStateSnapshot): void {
        this.snapshot = snapshot;
        if (this.updateTimer) return;
        this.updateTimer = setTimeout(() => {
            this.updateTimer = undefined;
            if (this.snapshot) this.update(this.snapshot);
        }, 32);
    }

    private onMessage(value: unknown): void {
        const action = parseTraceWebviewAction(value);
        if (!action) {
            this.output.appendLine(`[dsh:trace] ignored malformed webview action for ${this.sessionId}`);
            return;
        }
        if (action.type === "ready") {
            this.publish();
            this.refreshSelectedDetail();
        } else if (action.type === "selectRow") {
            if (!this.projection.rows.some((row) => row.id === action.rowId)) return;
            this.selectedId = action.rowId;
            this.publish();
            this.postRowDetail(action.rowId);
        } else if (action.type === "selectProjection") {
            const item = this.projection.projections.find((projection) => projection.key === action.key);
            if (!item) return;
            this.selectedId = item.id;
            this.publish();
            this.postProjectionDetail(item);
        } else if (action.type === "openFileLocation") {
            const session = this.runtime
                .getSessionCatalog()
                .snapshot()
                .sessions.find((candidate) => candidate.sessionId === this.sessionId);
            void openWorkspaceFileLocation(action, session?.cwd).catch((error: unknown) => {
                const message = errorMessage(error);
                this.output.appendLine(`[dsh:trace] file navigation failed: ${message}`);
                void vscode.window.showWarningMessage(`DSH: ${message}`);
            });
        } else if (action.type === "setQuery") {
            this.query = action.query;
            this.followLatest = true;
            this.selectedId = undefined;
            this.publish();
        } else if (action.type === "page") {
            this.page(action.direction);
        } else if (action.type === "setTimelineMode") {
            this.timelineMode = action.mode;
            this.publish();
        } else if (action.type === "clearSelection") {
            this.selectedId = undefined;
            this.publish();
        }
    }

    private page(direction: "older" | "newer" | "latest"): void {
        const filtered = this.filteredRows();
        const maximum = Math.max(0, filtered.length - PAGE_SIZE);
        if (direction === "older") {
            this.followLatest = false;
            this.offset = Math.max(0, this.offset - PAGE_SIZE);
        } else if (direction === "newer") {
            this.offset = Math.min(maximum, this.offset + PAGE_SIZE);
            this.followLatest = this.offset >= maximum;
        } else {
            this.followLatest = true;
            this.offset = maximum;
        }
        this.publish();
    }

    private filteredRows(): ProjectedTraceRow[] {
        const query = this.query.trim().toLocaleLowerCase();
        return query
            ? this.projection.rows.filter((row) => row.searchText.includes(query))
            : this.projection.rows;
    }

    private publish(): void {
        if (this.disposed) return;
        const filtered = this.filteredRows();
        const maximum = Math.max(0, filtered.length - PAGE_SIZE);
        this.offset = this.followLatest ? maximum : Math.min(Math.max(0, this.offset), maximum);
        const rows = filtered.slice(this.offset, this.offset + PAGE_SIZE).map((row) => {
            const view = traceRowView(row);
            return {
                ...view,
                summaryHtml: renderFileLocationsHtml(view.summary),
                ...(view.error === undefined
                    ? {}
                    : { errorHtml: renderFileLocationsHtml(view.error) }),
            };
        });
        const allRows = this.projection.rows;
        const turns = new Set(allRows.flatMap((row) => row.turn === undefined ? [] : [row.turn])).size;
        const callIds = new Set(allRows.flatMap((row) => row.callId ? [row.callId] : []));
        const tokenTotals = allRows.reduce((totals, row) => {
            if (!row.tokens) return totals;
            totals.inputTokens += row.tokens.inputTokens;
            totals.outputTokens += row.tokens.outputTokens;
            totals.cacheReadTokens += row.tokens.cacheReadTokens ?? 0;
            totals.cacheWriteTokens += row.tokens.cacheWriteTokens ?? 0;
            return totals;
        }, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
        const firstTime = allRows[0]?.time;
        const lastTime = allRows.at(-1)?.time;
        const overview: TraceOverview = {
            ...(firstTime !== undefined && lastTime !== undefined && lastTime >= firstTime
                ? { durationMs: lastTime - firstTime }
                : {}),
            turns,
            calls: callIds.size || allRows.filter((row) => row.category === "tool" || row.category === "subtool").length,
            errors: allRows.filter((row) => row.error !== undefined || row.category === "error").length,
            ...tokenTotals,
        };
        const timelineStart = firstTime ?? 0;
        const timelineEnd = Math.max(lastTime ?? timelineStart, timelineStart + 1);
        // Only include records that exist in the official Trajectory timeline.
        // Boundary/step markers, request headers, retries and unknown events are
        // not timeline cells; compaction belongs to the Model lane, not Input.
        const timelineRows = allRows.filter((row) =>
            row.category === "user" ||
            row.category === "context" ||
            row.category === "assistant" ||
            row.category === "tool" ||
            row.category === "subtool" ||
            row.category === "compaction"
        ).slice(-180);
        const blockWidth = Math.max(0.8, Math.min(8, (100 / Math.max(1, timelineRows.length)) * 0.72));
        // The timeline domain is based on the visible timeline records only, not
        // on the whole raw event log. Otherwise a long idle session would push
        // every real record into a tiny left sliver and make the timeline blank.
        const timelineFirst = timelineRows[0]?.time ?? timelineStart;
        const timelineLast = timelineRows.at(-1)?.time ?? timelineEnd;
        const timeSpan = Math.max(1, timelineLast - timelineFirst);
        const useSequence = this.timelineMode === "sequence";
        const timeline = timelineRows.map((row, index): TraceTimelineItem => {
            const lane = row.category === "assistant" || row.category === "compaction" ? "model" :
                row.category === "tool" || row.category === "subtool" ? "tools" : "input";
            const left = useSequence
                ? (timelineRows.length <= 1 ? 0 : (index / (timelineRows.length - 1)) * 100)
                : Math.max(0, Math.min(100, ((row.time - timelineFirst) / timeSpan) * 100));
            const width = useSequence
                ? 100 / Math.max(1, timelineRows.length)
                : row.durationMs === undefined
                    ? blockWidth
                    : Math.max(blockWidth, Math.min(100, (row.durationMs / timeSpan) * 100));
            return {
                id: row.id,
                lane,
                slot: index,
                category: row.category,
                eventType: row.eventType,
                left,
                width,
                ...(row.durationMs === undefined ? {} : { durationMs: row.durationMs }),
                summary: row.summary,
            };
        });
        const catalog = this.runtime.getSessionCatalog().snapshot();
        const session = catalog.sessions.find((candidate) => candidate.sessionId === this.sessionId);
        const status: TracePanelStatus = {
            running: session?.running === true,
            attention: session?.pendingInteraction !== undefined,
            ...(session?.lastAgentError === undefined ? {} : { error: session.lastAgentError }),
        };
        const message: TracePanelMessage = {
            type: "state",
            state: {
                sessionId: this.sessionId,
                title: session?.title || this.sessionId,
                status,
                query: this.query,
                rows,
                totalEvents: this.snapshot?.events.length ?? 0,
                totalRows: this.projection.rows.length,
                overview,
                timeline,
                timelineMode: this.timelineMode,
                timelineStart: timelineFirst,
                timelineEnd: timelineLast,
                filteredRows: filtered.length,
                offset: this.offset,
                pageSize: PAGE_SIZE,
                hasOlder: this.offset > 0,
                hasNewer: this.offset + rows.length < filtered.length,
                followLatest: this.followLatest,
                projections: this.projection.projections.map((projection) => ({
                    id: projection.id,
                    key: projection.key,
                    seq: projection.seq,
                    valuePreview: projection.valuePreview,
                    valueHtml: renderFileLocationsHtml(projection.valuePreview),
                })),
                selectedId: this.selectedId,
                needsHistoryBaseline: this.snapshot?.needsHistoryBaseline === true,
                ...(this.error === undefined ? {} : { error: this.error }),
            },
        };
        void this.panel.webview.postMessage(message);
    }

    private applyPendingLocation(): void {
        const location = this.pendingLocation;
        if (!location) return;
        let rowId = location.seq === undefined
            ? undefined
            : this.projection.seqToRowId.get(location.seq);
        if (!rowId && location.callId) {
            rowId = this.projection.rows.find((row) => row.callId === location.callId)?.id;
        }
        if (!rowId && location.turn !== undefined) {
            rowId = this.projection.rows.find((row) =>
                row.turn === location.turn &&
                (location.step === undefined || row.step === location.step))?.id;
        }
        if (!rowId) return;
        this.pendingLocation = undefined;
        this.query = "";
        this.followLatest = false;
        this.selectedId = rowId;
        const index = this.projection.rows.findIndex((row) => row.id === rowId);
        this.offset = index < 0 ? 0 : Math.floor(index / PAGE_SIZE) * PAGE_SIZE;
        this.postRowDetail(rowId);
    }

    private refreshSelectedDetail(): void {
        if (!this.selectedId) return;
        const row = this.projection.rows.find((candidate) => candidate.id === this.selectedId);
        if (row) {
            this.postDetail(row.id, row.summary, "Event", row.detail);
            return;
        }
        const projection = this.projection.projections.find((candidate) => candidate.id === this.selectedId);
        if (projection) this.postProjectionDetail(projection);
    }

    private postRowDetail(rowId: string): void {
        const row = this.projection.rows.find((candidate) => candidate.id === rowId);
        if (row) this.postDetail(row.id, row.summary, "Event", row.detail);
    }

    private postProjectionDetail(item: TraceProjectionItem): void {
        this.postDetail(item.id, item.key, "Projection", item.detail);
    }

    private postDetail(
        id: string,
        title: string,
        kind: "Event" | "Projection",
        source: TraceDetailSource,
    ): void {
        const raw = safeTraceJson(source.raw, RAW_DETAIL_LIMIT);
        const message: TracePanelMessage = {
            type: "detail",
            detail: {
                id,
                title,
                kind,
                summary: source.summary.map((field) => ({
                    ...field,
                    valueHtml: renderFileLocationsHtml(field.value),
                })),
                raw,
                rawHtml: renderFileLocationsHtml(raw),
            },
        };
        void this.panel.webview.postMessage(message);
    }

    private updateTitle(): void {
        const title = this.runtime
            .getSessionCatalog()
            .snapshot()
            .sessions.find((session) => session.sessionId === this.sessionId)?.title;
        this.panel.title = `DSH Trace: ${(title || this.sessionId).slice(0, 80)}`;
    }
}

function traceHtml(
    sessionId: string,
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
): string {
    const nonce = randomUUID().replace(/-/gu, "");
    const language = vscode.env.language.replace(/[^a-z0-9-]/giu, "") || "en";
    const styleUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, "webview", "dist", "trace.css"),
    );
    const serialized = scriptJson({ sessionId });
    const strings = {
        loading: t("Loading"),
        searchPlaceholder: t("Search events, content, tool arguments, or results..."),
        older: t("Older"),
        newer: t("Newer"),
        followLatest: t("Follow latest"),
        projectionInspector: t("Projection Inspector · read-only"),
        selectRecord: t("Select a record or projection"),
        loadingFailed: t("Loading failed"),
        sessionError: t("Session error"),
        waitingForAction: t("Waiting for action"),
        running: t("Running"),
        idle: t("Idle"),
        historySyncing: t("history syncing"),
        noProjections: t("The current history baseline has no projection keys."),
        noRows: t("No matching Trace rows."),
        deferredDetail: t("Details are loaded on selection so the full log is not sent to the webview at once."),
        event: t("Event"),
        turnStep: t("Turn / Step"),
        summary: t("Summary"),
        time: t("Time"),
        rows: t("rows"),
        projected: t("projected"),
        raw: t("raw"),
        followLive: t("follow live"),
        overview: t("Run overview"),
        timeline: t("Timeline"),
        sequence: t("Sequence"),
        duration: t("Duration"),
        turns: t("Turns"),
        calls: t("Calls"),
        errors: t("Errors"),
        inputTokens: t("Input tokens"),
        outputTokens: t("Output tokens"),
        cacheRead: t("Cache read"),
        cacheWrite: t("Cache write"),
        collapse: t("Collapse"),
        expand: t("Expand"),
    };
    const serializedStrings = scriptJson(strings);
    return `<!DOCTYPE html>
<html lang="${language}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${styleUri}">
</head>
<body>
    <div class="app">
        <header><div id="title" class="title">DSH Trace</div><div class="status"><span id="dot" class="dot"></span><span id="statusText">${escapeHtml(strings.loading)}</span></div></header>
        <div class="toolbar">
            <input id="search" placeholder="${escapeHtml(strings.searchPlaceholder)}">
            <span id="counts" class="counts"></span>
            <button id="timelineMode" class="secondary" title="${escapeHtml(strings.timeline)}">${escapeHtml(strings.sequence)}</button>
            <button id="older" class="secondary">${escapeHtml(strings.older)}</button><button id="newer" class="secondary">${escapeHtml(strings.newer)}</button><button id="latest" class="secondary">${escapeHtml(strings.followLatest)}</button>
        </div>
        <section class="overview"><div class="metric"><div class="metric-label">${escapeHtml(strings.duration)}</div><div id="metricDuration" class="metric-value">—</div></div><div class="metric"><div class="metric-label">${escapeHtml(strings.turns)}</div><div id="metricTurns" class="metric-value">—</div></div><div class="metric"><div class="metric-label">${escapeHtml(strings.calls)}</div><div id="metricCalls" class="metric-value">—</div></div><div class="metric"><div class="metric-label">${escapeHtml(strings.errors)}</div><div id="metricErrors" class="metric-value">—</div></div><div class="metric"><div class="metric-label">${escapeHtml(strings.inputTokens)}</div><div id="metricInput" class="metric-value">—</div></div><div class="metric"><div class="metric-label">${escapeHtml(strings.outputTokens)}</div><div id="metricOutput" class="metric-value">—</div></div><div class="metric"><div class="metric-label">${escapeHtml(strings.cacheRead)}</div><div id="metricCacheRead" class="metric-value">—</div></div><div class="metric"><div class="metric-label">${escapeHtml(strings.cacheWrite)}</div><div id="metricCacheWrite" class="metric-value">—</div></div></section>
        <section class="timeline"><div class="section-title">${escapeHtml(strings.timeline)}</div><div class="timeline-scale"><span id="timelineStart">—</span><span id="timelineEnd">—</span></div><div id="timelineLanes" class="timeline-lanes"></div></section>
        <div class="layout">
            <div class="ledger-shell">
                <section class="section projection-section"><div class="section-title">${escapeHtml(strings.projectionInspector)}</div><div id="projections" class="projections"></div></section>
                <div class="ledger-head"><div># / seq</div><div>${escapeHtml(strings.event)}</div><div>${escapeHtml(strings.turnStep)}</div><div>${escapeHtml(strings.summary)}</div><div>${escapeHtml(strings.time)}</div></div>
                <div id="ledger" class="ledger"></div>
            </div>
            <aside class="inspector">
                <div class="inspector-head"><div id="detailKind" class="inspector-kind">Inspector</div><div id="detailTitle" class="inspector-title">${escapeHtml(strings.selectRecord)}</div></div>
                <div class="tabs"><button data-tab="summary" class="active">${escapeHtml(strings.summary)}</button><button data-tab="raw">${escapeHtml(strings.raw)}</button></div>
                <div class="detail"><div id="summaryDetail"></div><pre id="rawDetail" class="hidden"></pre></div>
            </aside>
        </div>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const i18n = ${serializedStrings};
        vscode.setState(${serialized});
        let state = { rows: [], projections: [], status: {}, query: '' };
        let detail = undefined;
        let activeTab = 'summary';
        let searchTimer;
        const collapsed = new Set();

        function escapeHtml(value) {
            return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
        }
        function formatTime(value) {
            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return String(value);
            const pad = (number, size = 2) => String(number).padStart(size, '0');
            return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) + '.' + pad(date.getMilliseconds(), 3);
        }
        function duration(row) {
            return row.durationMs === undefined ? '—' : Math.round(row.durationMs).toLocaleString() + ' ms';
        }
        function tokenLabel(tokens) {
            if (!tokens) return '';
            const parts = ['in ' + tokens.inputTokens, 'out ' + tokens.outputTokens];
            if (tokens.cacheReadTokens !== undefined) parts.push('cache-read ' + tokens.cacheReadTokens);
            if (tokens.cacheWriteTokens !== undefined) parts.push('cache-write ' + tokens.cacheWriteTokens);
            if (tokens.reasoningTokens !== undefined) parts.push('think ' + tokens.reasoningTokens);
            return parts.join(' · ');
        }
        function compactNumber(value) {
            return Number(value || 0).toLocaleString();
        }
        function compactDuration(value) {
            if (value === undefined) return '—';
            if (value < 1000) return Math.round(value) + ' ms';
            if (value < 60000) return (value / 1000).toFixed(1) + ' s';
            return Math.floor(value / 60000) + 'm ' + Math.round((value % 60000) / 1000) + 's';
        }
        function hasCollapsedAncestor(rows, index) {
            const depth = Number(rows[index].depth || 0);
            for (let i = index - 1; i >= 0; i -= 1) {
                const candidate = rows[i];
                if (Number(candidate.depth || 0) < depth) {
                    if (collapsed.has(candidate.id)) return true;
                    return hasCollapsedAncestor(rows, i);
                }
            }
            return false;
        }
        function hasChildren(rows, index) {
            return index + 1 < rows.length && Number(rows[index + 1].depth || 0) > Number(rows[index].depth || 0);
        }
        function renderOverview() {
            const overview = state.overview || {};
            document.getElementById('metricDuration').textContent = compactDuration(overview.durationMs);
            document.getElementById('metricTurns').textContent = compactNumber(overview.turns);
            document.getElementById('metricCalls').textContent = compactNumber(overview.calls);
            document.getElementById('metricErrors').textContent = compactNumber(overview.errors);
            document.getElementById('metricInput').textContent = compactNumber(overview.inputTokens);
            document.getElementById('metricOutput').textContent = compactNumber(overview.outputTokens);
            document.getElementById('metricCacheRead').textContent = compactNumber(overview.cacheReadTokens);
            document.getElementById('metricCacheWrite').textContent = compactNumber(overview.cacheWriteTokens);
            const modeButton = document.getElementById('timelineMode');
            if (modeButton) {
                modeButton.textContent = state.timelineMode === 'duration' ? i18n.duration : i18n.sequence;
                modeButton.classList.toggle('active', state.timelineMode === 'duration');
            }
            const timeline = state.timeline || [];
            const lanes = [
                ['input', 'Input'],
                ['model', 'Model'],
                ['tools', 'Tools'],
            ];
            const timelineLanes = document.getElementById('timelineLanes');
            timelineLanes.innerHTML = '';
            for (const [lane, label] of lanes) {
                const items = timeline.filter((item) => item.lane === lane);
                const laneEl = document.createElement('div');
                laneEl.className = 'timeline-lane';
                const labelEl = document.createElement('span');
                labelEl.className = 'timeline-lane-label';
                labelEl.textContent = label;
                const trackEl = document.createElement('div');
                trackEl.className = 'timeline-track';
                for (const item of items) {
                    const bar = document.createElement('div');
                    bar.className = 'timeline-item ' + item.category;
                    bar.dataset.timelineId = item.id;
                    bar.title = item.eventType + ' · ' + compactDuration(item.durationMs) + ' · ' + item.summary;
                    // Use CSSOM instead of inline style attributes so the
                    // webview CSP does not strip the positioning.
                    bar.style.left = item.left + '%';
                    bar.style.width = item.width + '%';
                    trackEl.appendChild(bar);
                }
                laneEl.appendChild(labelEl);
                laneEl.appendChild(trackEl);
                timelineLanes.appendChild(laneEl);
            }
            document.getElementById('timelineStart').textContent = state.timelineStart === undefined ? '—' : formatTime(state.timelineStart);
            document.getElementById('timelineEnd').textContent = state.timelineStart !== undefined && state.timelineEnd !== undefined ? '+' + compactDuration(state.timelineEnd - state.timelineStart) : '—';
        }
        function openFileLocation(target) {
            const link = target instanceof Element ? target.closest('[data-file-path]') : undefined;
            if (!link || !link.dataset.filePath) return false;
            const line = Number(link.dataset.fileLine);
            const column = link.dataset.fileColumn === undefined ? undefined : Number(link.dataset.fileColumn);
            if (!Number.isSafeInteger(line) || line <= 0 || (column !== undefined && (!Number.isSafeInteger(column) || column <= 0))) return false;
            vscode.postMessage({ type: 'openFileLocation', path: link.dataset.filePath, line, ...(column === undefined ? {} : { column }) });
            return true;
        }
        function render() {
            document.getElementById('title').textContent = 'DSH Trace: ' + (state.title || state.sessionId || '');
            const status = state.status || {};
            const dot = document.getElementById('dot');
            dot.className = 'dot ' + (status.error || state.error ? 'error' : (status.attention ? 'attention' : (status.running ? 'running' : '')));
            document.getElementById('statusText').textContent = state.error ? i18n.loadingFailed : (status.error ? i18n.sessionError : (status.attention ? i18n.waitingForAction : (status.running ? i18n.running : i18n.idle)));
            const search = document.getElementById('search');
            if (document.activeElement !== search) search.value = state.query || '';
            document.getElementById('counts').textContent = (state.filteredRows || 0) + ' ' + i18n.rows + ' / ' + (state.totalRows || 0) + ' ' + i18n.projected + ' / ' + (state.totalEvents || 0) + ' ' + i18n.raw + (state.needsHistoryBaseline ? ' · ' + i18n.historySyncing : '') + (state.followLatest ? ' · ' + i18n.followLive : '');
            document.getElementById('older').disabled = !state.hasOlder;
            document.getElementById('newer').disabled = !state.hasNewer;
            document.getElementById('latest').disabled = Boolean(state.followLatest);
            renderOverview();

            const projections = document.getElementById('projections');
            projections.innerHTML = (state.projections || []).length
                ? state.projections.map((item) => '<div class="projection' + (state.selectedId === item.id ? ' selected' : '') + '" data-projection-key="' + escapeHtml(item.key) + '"><div class="projection-head"><span class="projection-key">' + escapeHtml(item.key) + '</span><span class="seq">seq ' + escapeHtml(item.seq) + '</span></div><div class="projection-value">' + item.valueHtml + '</div></div>').join('')
                : '<div class="empty">' + escapeHtml(i18n.noProjections) + '</div>';

            const ledger = document.getElementById('ledger');
            if (state.error) {
                ledger.innerHTML = '<div class="error-box">' + escapeHtml(state.error) + '</div>';
            } else if (!(state.rows || []).length) {
                ledger.innerHTML = '<div class="empty">' + escapeHtml(i18n.noRows) + '</div>';
            } else {
                ledger.innerHTML = state.rows.map((row, index, sourceRows) => {
                    if (hasCollapsedAncestor(sourceRows, index)) return '';
                    const group = (row.turn === undefined ? 'session' : 'T' + row.turn) + (row.step === undefined ? '' : ' · S' + row.step);
                    const meta = [row.tool && row.tool.name, row.callId, tokenLabel(row.tokens)].filter(Boolean).join(' · ');
                    const summary = row.summary + (meta ? ' · ' + meta : '');
                    const summaryHtml = row.summaryHtml + (meta ? ' · ' + escapeHtml(meta) : '');
                    const toggle = hasChildren(sourceRows, index) ? '<button class="tree-toggle secondary" data-toggle-row="' + escapeHtml(row.id) + '" title="' + (collapsed.has(row.id) ? i18n.expand : i18n.collapse) + '">' + (collapsed.has(row.id) ? '+' : '−') + '</button>' : '';
                    return '<div class="trace-row ' + escapeHtml(row.category) + ' depth-' + Math.min(8, Number(row.depth || 0)) + (row.error ? ' error' : '') + (state.selectedId === row.id ? ' selected' : '') + '" data-row-id="' + escapeHtml(row.id) + '"><div class="seq">#' + (Number(state.offset || 0) + index + 1) + ' · ' + escapeHtml(row.seq) + (row.endSeq === undefined ? '' : '→' + escapeHtml(row.endSeq)) + '</div><div class="event">' + toggle + escapeHtml(row.eventType) + '</div><div class="meta">' + escapeHtml(group) + '</div><div class="summary" title="' + escapeHtml(summary) + '">' + summaryHtml + (row.error ? ' · ' + row.errorHtml : '') + '</div><div class="time">' + escapeHtml(formatTime(row.time)) + '<br>' + escapeHtml(duration(row)) + '</div></div>';
                }).join('');
            }
            renderDetail();
        }
        function renderDetail() {
            const inspector = document.querySelector('.inspector');
            if (inspector) inspector.classList.toggle('visible', Boolean(detail));
            document.getElementById('detailKind').textContent = detail ? detail.kind : 'Inspector';
            document.getElementById('detailTitle').textContent = detail ? detail.title : i18n.selectRecord;
            const summary = document.getElementById('summaryDetail');
            summary.innerHTML = detail
                ? (detail.summary || []).map((field) => '<div class="field"><div class="field-label">' + escapeHtml(field.label) + '</div><div class="field-value">' + field.valueHtml + '</div></div>').join('')
                : '<div class="empty">' + escapeHtml(i18n.deferredDetail) + '</div>';
            const raw = document.getElementById('rawDetail');
            raw.innerHTML = detail ? detail.rawHtml : '';
            summary.classList.toggle('hidden', activeTab !== 'summary');
            raw.classList.toggle('hidden', activeTab !== 'raw');
            for (const tab of document.querySelectorAll('[data-tab]')) tab.classList.toggle('active', tab.dataset.tab === activeTab);
        }
        document.addEventListener('click', (event) => {
            if (!openFileLocation(event.target)) return;
            event.preventDefault();
            event.stopPropagation();
        }, true);
        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            if (!openFileLocation(event.target)) return;
            event.preventDefault();
            event.stopPropagation();
        }, true);
        document.getElementById('ledger').addEventListener('click', (event) => {
            const toggle = event.target.closest('[data-toggle-row]');
            if (toggle) {
                const id = toggle.dataset.toggleRow;
                if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
                render();
                return;
            }
            const row = event.target.closest('[data-row-id]');
            if (row) {
                if (state.selectedId === row.dataset.rowId) {
                    detail = undefined;
                    state.selectedId = undefined;
                    vscode.postMessage({ type: 'clearSelection' });
                    render();
                } else {
                    vscode.postMessage({ type: 'selectRow', rowId: row.dataset.rowId });
                }
            }
        });
        document.getElementById('timelineLanes').addEventListener('click', (event) => {
            const item = event.target.closest('[data-timeline-id]');
            if (item) {
                if (state.selectedId === item.dataset.timelineId) {
                    detail = undefined;
                    state.selectedId = undefined;
                    vscode.postMessage({ type: 'clearSelection' });
                    render();
                } else {
                    vscode.postMessage({ type: 'selectRow', rowId: item.dataset.timelineId });
                }
            }
        });
        document.getElementById('projections').addEventListener('click', (event) => {
            const item = event.target.closest('[data-projection-key]');
            if (item) {
                if (state.selectedId && document.querySelector('.projection.selected') === item) {
                    detail = undefined;
                    state.selectedId = undefined;
                    vscode.postMessage({ type: 'clearSelection' });
                    render();
                } else {
                    vscode.postMessage({ type: 'selectProjection', key: item.dataset.projectionKey });
                }
            }
        });
        document.querySelector('.tabs').addEventListener('click', (event) => {
            const tab = event.target.closest('[data-tab]');
            if (!tab) return;
            activeTab = tab.dataset.tab;
            renderDetail();
        });
        document.getElementById('search').addEventListener('input', (event) => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => vscode.postMessage({ type: 'setQuery', query: event.target.value }), 120);
        });
        document.getElementById('timelineMode').addEventListener('click', () => {
            const next = state.timelineMode === 'duration' ? 'sequence' : 'duration';
            vscode.postMessage({ type: 'setTimelineMode', mode: next });
        });
        document.getElementById('older').addEventListener('click', () => vscode.postMessage({ type: 'page', direction: 'older' }));
        document.getElementById('newer').addEventListener('click', () => vscode.postMessage({ type: 'page', direction: 'newer' }));
        document.getElementById('latest').addEventListener('click', () => vscode.postMessage({ type: 'page', direction: 'latest' }));
        window.addEventListener('message', (event) => {
            if (event.data && event.data.type === 'state') {
                state = event.data.state;
                if (state.selectedId === undefined || state.selectedId === null) detail = undefined;
                render();
            } else if (event.data && event.data.type === 'detail') {
                detail = event.data.detail;
                renderDetail();
            }
        });
        render();
        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
}
