import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { DshRuntime } from "./dshRuntime";
import { renderFileLocationsHtml } from "./fileLocations";
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
import { openWorkspaceFileLocation } from "./workspaceNavigation";
import { t } from "./localize";

const PAGE_SIZE = 250;
const RAW_DETAIL_LIMIT = 65_536;

interface TracePanelStatus {
    running: boolean;
    attention: boolean;
    error?: string;
}

interface TraceOverview {
    durationMs?: number;
    turns: number;
    calls: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}

interface TraceTimelineItem {
    id: string;
    lane: "input" | "model" | "tools";
    slot: number;
    category: string;
    eventType: string;
    left: number;
    width: number;
    durationMs?: number;
    summary: string;
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
        const timeline = timelineRows.map((row, index): TraceTimelineItem => ({
            id: row.id,
            lane: row.category === "assistant" || row.category === "compaction" ? "model" :
                row.category === "tool" || row.category === "subtool" ? "tools" : "input",
            slot: index,
            category: row.category,
            eventType: row.eventType,
            // Use wall-clock positions within the visible timeline domain so
            // idle gaps stay visible and the lanes are not artificially filled.
            left: Math.max(0, Math.min(100, ((row.time - timelineFirst) / timeSpan) * 100)),
            width: row.durationMs === undefined
                ? blockWidth
                : Math.max(blockWidth, Math.min(100, (row.durationMs / timeSpan) * 100)),
            ...(row.durationMs === undefined ? {} : { durationMs: row.durationMs }),
            summary: row.summary,
        }));
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
                overview,
                timeline,
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
        const raw = safeTraceJson(source.raw, RAW_DETAIL_LIMIT);
        void this.panel.webview.postMessage({
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
    const language = vscode.env.language.replace(/[^a-z0-9-]/giu, "") || "en";
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
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <style nonce="${nonce}">
        :root { color-scheme: light dark; }
        * { box-sizing: border-box; }
        body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 12px var(--vscode-font-family); overflow: hidden; }
        button, input { font: inherit; }
        button { border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; padding: 4px 8px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
        button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
        button:disabled { opacity: .5; cursor: default; }
        .app { height: 100vh; display: grid; grid-template-rows: auto auto auto auto minmax(0, 1fr); }
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
        .overview { display: grid; grid-template-columns: repeat(8, minmax(90px, 1fr)); gap: 1px; padding: 8px 12px; background: var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border); }
        .metric { min-width: 0; padding: 7px 9px; background: var(--vscode-editor-background); }
        .metric-label { color: var(--vscode-descriptionForeground); font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
        .metric-value { margin-top: 3px; font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .timeline { min-height: 70px; padding: 8px 12px 10px; border-bottom: 1px solid var(--vscode-panel-border); overflow: hidden; }
        .timeline-lanes { display: grid; gap: 3px; margin-top: 7px; }
        .timeline-lane { display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 6px; align-items: center; }
        .timeline-lane-label { color: var(--vscode-descriptionForeground); font-size: 10px; }
        .timeline-track { position: relative; height: 21px; padding: 2px 3px; background: color-mix(in srgb, var(--vscode-panel-border) 35%, transparent); border-radius: 3px; overflow: hidden; }
        .timeline-item { position: absolute; top: 2px; height: 16px; border-radius: 2px; opacity: .9; cursor: pointer; }
        .timeline-item:hover { opacity: 1; outline: 1px solid var(--vscode-focusBorder); }
        .timeline-item.user { background: #4f8cca; } .timeline-item.assistant { background: #8d6bb3; } .timeline-item.tool, .timeline-item.subtool { background: #d88924; } .timeline-item.error { background: #d94c4c; } .timeline-item.compaction { background: #4ca879; } .timeline-item.context { background: #6a7178; } .timeline-item.boundary { background: #5d9a75; } .timeline-item.system { background: #7a8088; } .timeline-item.generic { background: #9b7b4a; }
        .timeline-scale { display: flex; justify-content: space-between; color: var(--vscode-descriptionForeground); font: 10px var(--vscode-editor-font-family); }
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
        .event::before { content: ''; display: inline-block; width: 7px; height: 7px; margin: 0 6px 1px 0; border-radius: 50%; background: var(--vscode-descriptionForeground); }
        .trace-row.user .event { color: #4f8cca; } .trace-row.user .event::before { background: #4f8cca; }
        .trace-row.context .event { color: #6a7178; } .trace-row.context .event::before { background: #6a7178; }
        .trace-row.assistant .event { color: #8d6bb3; } .trace-row.assistant .event::before { background: #8d6bb3; }
        .trace-row.tool .event, .trace-row.subtool .event { color: #d88924; } .trace-row.tool .event::before, .trace-row.subtool .event::before { background: #d88924; }
        .trace-row.compaction .event { color: #4ca879; } .trace-row.compaction .event::before { background: #4ca879; }
        .trace-row.system .event { color: #7a8088; } .trace-row.system .event::before { background: #7a8088; }
        .trace-row.boundary .event { color: #5d9a75; } .trace-row.boundary .event::before { background: #5d9a75; }
        .trace-row.generic .event { color: #9b7b4a; } .trace-row.generic .event::before { background: #9b7b4a; }
        .trace-row.error .event::before { background: var(--vscode-errorForeground); }
        .tree-toggle { min-width: 18px; width: 18px; height: 18px; padding: 0; margin-right: 4px; line-height: 14px; vertical-align: -2px; }
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
        .file-location-link { color: var(--vscode-textLink-foreground); text-decoration: underline dotted; text-underline-offset: 2px; cursor: pointer; }
        .file-location-link:hover { color: var(--vscode-textLink-activeForeground); text-decoration-style: solid; }
        pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.45 var(--vscode-editor-font-family); }
        .hidden { display: none; }
        @media (max-width: 900px) {
            body { overflow: auto; }
            .app { height: auto; min-height: 100vh; }
            .layout { display: block; }
            .ledger-shell { min-height: 520px; border-right: 0; }
            .inspector { min-height: 360px; border-top: 1px solid var(--vscode-panel-border); }
            .overview { grid-template-columns: repeat(4, minmax(90px, 1fr)); }
        }
    </style>
</head>
<body>
    <div class="app">
        <header><div id="title" class="title">DSH Trace</div><div class="status"><span id="dot" class="dot"></span><span id="statusText">${escapeHtml(strings.loading)}</span></div></header>
        <div class="toolbar">
            <input id="search" placeholder="${escapeHtml(strings.searchPlaceholder)}">
            <span id="counts" class="counts"></span>
            <button id="older" class="secondary">${escapeHtml(strings.older)}</button><button id="newer" class="secondary">${escapeHtml(strings.newer)}</button><button id="latest" class="secondary">${escapeHtml(strings.followLatest)}</button>
        </div>
        <section class="overview"><div class="metric"><div class="metric-label">${escapeHtml(strings.duration)}</div><div id="metricDuration" class="metric-value">—</div></div><div class="metric"><div class="metric-label">${escapeHtml(strings.turns)}</div><div id="metricTurns" class="metric-value">—</div></div><div class="metric"><div class="metric-label">${escapeHtml(strings.calls)}</div><div id="metricCalls" class="metric-value">—</div></div><div class="metric"><div class="metric-label">${escapeHtml(strings.errors)}</div><div id="metricErrors" class="metric-value">—</div></div><div class="metric"><div class="metric-label">${escapeHtml(strings.inputTokens)}</div><div id="metricInput" class="metric-value">—</div></div><div class="metric"><div class="metric-label">${escapeHtml(strings.outputTokens)}</div><div id="metricOutput" class="metric-value">—</div></div><div class="metric"><div class="metric-label">${escapeHtml(strings.cacheRead)}</div><div id="metricCacheRead" class="metric-value">—</div></div><div class="metric"><div class="metric-label">${escapeHtml(strings.cacheWrite)}</div><div id="metricCacheWrite" class="metric-value">—</div></div></section>
        <section class="timeline"><div class="section-title">${escapeHtml(strings.timeline)}</div><div class="timeline-scale"><span id="timelineStart">—</span><span id="timelineEnd">—</span></div><div id="timelineLanes" class="timeline-lanes"></div></section>
        <div class="layout">
            <div class="ledger-shell">
                <section class="section"><div class="section-title">${escapeHtml(strings.projectionInspector)}</div><div id="projections" class="projections"></div></section>
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
                    return '<div class="trace-row ' + escapeHtml(row.category) + (row.error ? ' error' : '') + (state.selectedId === row.id ? ' selected' : '') + '" data-row-id="' + escapeHtml(row.id) + '" style="padding-left:' + Math.min(8, Number(row.depth || 0)) * 12 + 'px"><div class="seq">#' + (Number(state.offset || 0) + index + 1) + ' · ' + escapeHtml(row.seq) + (row.endSeq === undefined ? '' : '→' + escapeHtml(row.endSeq)) + '</div><div class="event">' + toggle + escapeHtml(row.eventType) + '</div><div class="meta">' + escapeHtml(group) + '</div><div class="summary" title="' + escapeHtml(summary) + '">' + summaryHtml + (row.error ? ' · ' + row.errorHtml : '') + '</div><div class="time">' + escapeHtml(formatTime(row.time)) + '<br>' + escapeHtml(duration(row)) + '</div></div>';
                }).join('');
            }
            renderDetail();
        }
        function renderDetail() {
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
            if (row) vscode.postMessage({ type: 'selectRow', rowId: row.dataset.rowId });
        });
        document.getElementById('timelineLanes').addEventListener('click', (event) => {
            const item = event.target.closest('[data-timeline-id]');
            if (item) vscode.postMessage({ type: 'selectRow', rowId: item.dataset.timelineId });
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
