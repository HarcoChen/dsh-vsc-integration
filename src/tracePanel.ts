import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { DshRuntime } from "./dshRuntime";
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
} from "./traceProtocol";

const PAGE_SIZE = 250;
const RAW_DETAIL_LIMIT = 65_536;

interface TracePanelStatus {
    running: boolean;
    attention: boolean;
    error?: string;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>'"]/gu, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        "\"": "&quot;",
    })[character] ?? character);
}

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
    ) {}

    public async open(locationValue: unknown): Promise<void> {
        const location = parseTraceLocation(locationValue);
        if (!location) throw new Error("Trace location 无效或缺少 sessionId。");
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
            webviewPanel.title = "DSH Trace（无法恢复）";
            webviewPanel.webview.options = { enableScripts: false, localResourceRoots: [] };
            webviewPanel.webview.html = this.errorHtml("Trace tab 的恢复状态无效。");
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
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [],
        };
        panel.webview.html = traceHtml(sessionId);
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
            if (!snapshot) throw new Error(`找不到 session ${controller.sessionId} 的 history。`);
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
        } else if (action.type === "setQuery") {
            this.query = action.query;
            this.followLatest = true;
            this.selectedId = undefined;
            this.publish();
        } else if (action.type === "page") {
            this.page(action.direction);
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
        const rows = filtered.slice(this.offset, this.offset + PAGE_SIZE).map(traceRowView);
        const catalog = this.runtime.getSessionCatalog().snapshot();
        const session = catalog.sessions.find((candidate) => candidate.sessionId === this.sessionId);
        const status: TracePanelStatus = {
            running: session?.running === true,
            attention: session?.pendingInteraction !== undefined,
            ...(session?.lastAgentError === undefined ? {} : { error: session.lastAgentError }),
        };
        void this.panel.webview.postMessage({
            type: "state",
            state: {
                sessionId: this.sessionId,
                title: session?.title || this.sessionId,
                status,
                query: this.query,
                rows,
                totalEvents: this.snapshot?.events.length ?? 0,
                totalRows: this.projection.rows.length,
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
                })),
                selectedId: this.selectedId,
                needsHistoryBaseline: this.snapshot?.needsHistoryBaseline === true,
                error: this.error,
            },
        });
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
        void this.panel.webview.postMessage({
            type: "detail",
            detail: {
                id,
                title,
                kind,
                summary: source.summary,
                raw: safeTraceJson(source.raw, RAW_DETAIL_LIMIT),
            },
        });
    }

    private updateTitle(): void {
        const title = this.runtime
            .getSessionCatalog()
            .snapshot()
            .sessions.find((session) => session.sessionId === this.sessionId)?.title;
        this.panel.title = `DSH Trace: ${(title || this.sessionId).slice(0, 80)}`;
    }
}

function traceHtml(sessionId: string): string {
    const nonce = randomUUID().replace(/-/gu, "");
    const serialized = scriptJson({ sessionId });
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <style nonce="${nonce}">
        :root { color-scheme: light dark; }
        * { box-sizing: border-box; }
        body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 12px var(--vscode-font-family); overflow: hidden; }
        button, input { font: inherit; }
        button { border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; padding: 4px 8px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
        button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
        button:disabled { opacity: .5; cursor: default; }
        .app { height: 100vh; display: grid; grid-template-rows: auto auto minmax(0, 1fr); }
        header { display: flex; gap: 10px; align-items: center; padding: 9px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
        .title { font-weight: 700; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .status { display: flex; align-items: center; gap: 5px; color: var(--vscode-descriptionForeground); }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
        .dot.running { background: #4ec994; }
        .dot.attention { background: #e5b567; }
        .dot.error { background: #f14c4c; }
        .toolbar { display: flex; gap: 6px; align-items: center; padding: 7px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
        .toolbar input { width: min(420px, 45vw); padding: 5px 7px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
        .counts { flex: 1; color: var(--vscode-descriptionForeground); }
        .layout { min-height: 0; display: grid; grid-template-columns: minmax(480px, 1fr) minmax(300px, 38%); }
        .ledger-shell { min-width: 0; min-height: 0; display: grid; grid-template-rows: auto minmax(0, auto) minmax(0, 1fr); border-right: 1px solid var(--vscode-panel-border); }
        .section { padding: 7px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
        .section-title { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 5px; }
        .projections { max-height: 145px; overflow: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 5px; }
        .projection { min-width: 0; padding: 5px 7px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; cursor: pointer; }
        .projection.selected { outline: 1px solid var(--vscode-focusBorder); }
        .projection-head { display: flex; justify-content: space-between; gap: 6px; }
        .projection-key { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
        .projection-value { margin-top: 3px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ledger { min-height: 0; overflow: auto; }
        .ledger-head, .trace-row { display: grid; grid-template-columns: 70px minmax(155px, .7fr) 120px minmax(240px, 2fr) 110px; align-items: center; }
        .ledger-head { position: sticky; top: 0; z-index: 2; min-height: 28px; color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
        .ledger-head > div, .trace-row > div { min-width: 0; padding: 5px 7px; }
        .trace-row { min-height: 35px; border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent); cursor: pointer; }
        .trace-row:hover { background: var(--vscode-list-hoverBackground); }
        .trace-row.selected { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
        .seq, .meta, .time { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-size: 11px; }
        .event { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .summary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .trace-row.error .event, .trace-row.error .summary { color: var(--vscode-errorForeground); }
        .empty, .error-box { padding: 24px; color: var(--vscode-descriptionForeground); text-align: center; }
        .error-box { color: var(--vscode-errorForeground); }
        .inspector { min-width: 0; min-height: 0; display: grid; grid-template-rows: auto auto minmax(0, 1fr); }
        .inspector-head { padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
        .inspector-kind { color: var(--vscode-descriptionForeground); font-size: 10px; text-transform: uppercase; }
        .inspector-title { margin-top: 3px; font-weight: 600; overflow-wrap: anywhere; }
        .tabs { display: flex; gap: 4px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
        .tabs button { color: var(--vscode-foreground); background: transparent; }
        .tabs button.active { background: var(--vscode-toolbar-hoverBackground); }
        .detail { min-height: 0; overflow: auto; padding: 10px 12px; }
        .field { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--vscode-panel-border); }
        .field-label { color: var(--vscode-descriptionForeground); }
        .field-value { white-space: pre-wrap; overflow-wrap: anywhere; }
        pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.45 var(--vscode-editor-font-family); }
        .hidden { display: none; }
        @media (max-width: 900px) {
            body { overflow: auto; }
            .app { height: auto; min-height: 100vh; }
            .layout { display: block; }
            .ledger-shell { min-height: 520px; border-right: 0; }
            .inspector { min-height: 360px; border-top: 1px solid var(--vscode-panel-border); }
        }
    </style>
</head>
<body>
    <div class="app">
        <header><div id="title" class="title">DSH Trace</div><div class="status"><span id="dot" class="dot"></span><span id="statusText">加载中</span></div></header>
        <div class="toolbar">
            <input id="search" placeholder="搜索 event、内容、tool 参数或结果…">
            <span id="counts" class="counts"></span>
            <button id="older" class="secondary">较早</button><button id="newer" class="secondary">较新</button><button id="latest" class="secondary">跟随尾部</button>
        </div>
        <div class="layout">
            <div class="ledger-shell">
                <section class="section"><div class="section-title">Projection Inspector · 只读</div><div id="projections" class="projections"></div></section>
                <div class="ledger-head"><div># / seq</div><div>Event</div><div>Turn / Step</div><div>Summary</div><div>Time</div></div>
                <div id="ledger" class="ledger"></div>
            </div>
            <aside class="inspector">
                <div class="inspector-head"><div id="detailKind" class="inspector-kind">Inspector</div><div id="detailTitle" class="inspector-title">选择一条记录或 projection</div></div>
                <div class="tabs"><button data-tab="summary" class="active">Summary</button><button data-tab="raw">Raw</button></div>
                <div class="detail"><div id="summaryDetail"></div><pre id="rawDetail" class="hidden"></pre></div>
            </aside>
        </div>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        vscode.setState(${serialized});
        let state = { rows: [], projections: [], status: {}, query: '' };
        let detail = undefined;
        let activeTab = 'summary';
        let searchTimer;

        function escapeHtml(value) {
            return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
        }
        function formatTime(value) {
            const date = new Date(value);
            return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString([], { hour12: false, fractionalSecondDigits: 3 });
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
        function render() {
            document.getElementById('title').textContent = 'DSH Trace: ' + (state.title || state.sessionId || '');
            const status = state.status || {};
            const dot = document.getElementById('dot');
            dot.className = 'dot ' + (status.error || state.error ? 'error' : (status.attention ? 'attention' : (status.running ? 'running' : '')));
            document.getElementById('statusText').textContent = state.error ? '加载失败' : (status.error ? '会话错误' : (status.attention ? '等待操作' : (status.running ? '运行中' : '空闲')));
            const search = document.getElementById('search');
            if (document.activeElement !== search) search.value = state.query || '';
            document.getElementById('counts').textContent = (state.filteredRows || 0) + ' rows / ' + (state.totalRows || 0) + ' projected / ' + (state.totalEvents || 0) + ' raw' + (state.needsHistoryBaseline ? ' · history 同步中' : '') + (state.followLatest ? ' · follow live' : '');
            document.getElementById('older').disabled = !state.hasOlder;
            document.getElementById('newer').disabled = !state.hasNewer;
            document.getElementById('latest').disabled = Boolean(state.followLatest);

            const projections = document.getElementById('projections');
            projections.innerHTML = (state.projections || []).length
                ? state.projections.map((item) => '<div class="projection' + (state.selectedId === item.id ? ' selected' : '') + '" data-projection-key="' + escapeHtml(item.key) + '"><div class="projection-head"><span class="projection-key">' + escapeHtml(item.key) + '</span><span class="seq">seq ' + escapeHtml(item.seq) + '</span></div><div class="projection-value">' + escapeHtml(item.valuePreview) + '</div></div>').join('')
                : '<div class="empty">当前 history baseline 没有 projection key。</div>';

            const ledger = document.getElementById('ledger');
            if (state.error) {
                ledger.innerHTML = '<div class="error-box">' + escapeHtml(state.error) + '</div>';
            } else if (!(state.rows || []).length) {
                ledger.innerHTML = '<div class="empty">没有匹配的 Trace rows。</div>';
            } else {
                ledger.innerHTML = state.rows.map((row, index) => {
                    const group = (row.turn === undefined ? 'session' : 'T' + row.turn) + (row.step === undefined ? '' : ' · S' + row.step);
                    const meta = [row.tool && row.tool.name, row.callId, tokenLabel(row.tokens)].filter(Boolean).join(' · ');
                    const summary = row.summary + (meta ? ' · ' + meta : '');
                    return '<div class="trace-row ' + escapeHtml(row.category) + (row.error ? ' error' : '') + (state.selectedId === row.id ? ' selected' : '') + '" data-row-id="' + escapeHtml(row.id) + '" style="padding-left:' + Math.min(8, Number(row.depth || 0)) * 12 + 'px"><div class="seq">#' + (Number(state.offset || 0) + index + 1) + ' · ' + escapeHtml(row.seq) + (row.endSeq === undefined ? '' : '→' + escapeHtml(row.endSeq)) + '</div><div class="event">' + escapeHtml(row.eventType) + '</div><div class="meta">' + escapeHtml(group) + '</div><div class="summary" title="' + escapeHtml(summary) + '">' + escapeHtml(summary) + (row.error ? ' · ' + escapeHtml(row.error) : '') + '</div><div class="time">' + escapeHtml(formatTime(row.time)) + '<br>' + escapeHtml(duration(row)) + '</div></div>';
                }).join('');
            }
            renderDetail();
        }
        function renderDetail() {
            document.getElementById('detailKind').textContent = detail ? detail.kind : 'Inspector';
            document.getElementById('detailTitle').textContent = detail ? detail.title : '选择一条记录或 projection';
            const summary = document.getElementById('summaryDetail');
            summary.innerHTML = detail
                ? (detail.summary || []).map((field) => '<div class="field"><div class="field-label">' + escapeHtml(field.label) + '</div><div class="field-value">' + escapeHtml(field.value) + '</div></div>').join('')
                : '<div class="empty">详情按选择延迟加载，不会把完整日志一次性发送到 webview。</div>';
            const raw = document.getElementById('rawDetail');
            raw.textContent = detail ? detail.raw : '';
            summary.classList.toggle('hidden', activeTab !== 'summary');
            raw.classList.toggle('hidden', activeTab !== 'raw');
            for (const tab of document.querySelectorAll('[data-tab]')) tab.classList.toggle('active', tab.dataset.tab === activeTab);
        }
        document.getElementById('ledger').addEventListener('click', (event) => {
            const row = event.target.closest('[data-row-id]');
            if (row) vscode.postMessage({ type: 'selectRow', rowId: row.dataset.rowId });
        });
        document.getElementById('projections').addEventListener('click', (event) => {
            const item = event.target.closest('[data-projection-key]');
            if (item) vscode.postMessage({ type: 'selectProjection', key: item.dataset.projectionKey });
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
        document.getElementById('older').addEventListener('click', () => vscode.postMessage({ type: 'page', direction: 'older' }));
        document.getElementById('newer').addEventListener('click', () => vscode.postMessage({ type: 'page', direction: 'newer' }));
        document.getElementById('latest').addEventListener('click', () => vscode.postMessage({ type: 'page', direction: 'latest' }));
        window.addEventListener('message', (event) => {
            if (event.data && event.data.type === 'state') {
                state = event.data.state;
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
