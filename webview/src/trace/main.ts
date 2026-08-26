import type {
    TraceDetailMessage,
    TracePanelState,
    TraceRowMessage,
    TraceWebviewAction,
} from "../../../src/traceProtocol";
import type { TraceTokenUsage } from "../../../src/traceProjector";

/**
 * Trace panel client.
 *
 * Ported verbatim from the template literal that used to live in
 * src/tracePanel.ts, so behaviour is unchanged — the point of the move is that
 * tsc now checks this code against the host's own wire contract.
 *
 * The host still owns the surrounding markup and all localization: strings and
 * the session id arrive through the bootstrap JSON block rather than being
 * interpolated into the script.
 */

/** Localized strings the host hands to the dynamic parts of this view. */
type TraceStrings = Readonly<Record<string, string>>;

interface Bootstrap {
    sessionId: string;
    strings: TraceStrings;
}

interface VsCodeApi {
    postMessage(message: TraceWebviewAction): void;
    setState(value: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

function bootstrap(): Bootstrap {
    const node = document.getElementById("trace-bootstrap");
    if (!node?.textContent) throw new Error("Trace bootstrap data is missing");
    return JSON.parse(node.textContent) as Bootstrap;
}

const { sessionId, strings: i18n } = bootstrap();
const vscode = acquireVsCodeApi();
vscode.setState({ sessionId });

/** The first paint happens before any host state arrives, so every field is optional. */
let state: Partial<TracePanelState> = { rows: [], projections: [], query: "" };
let detail: TraceDetailMessage | undefined;
let activeTab = "summary";
let searchTimer: ReturnType<typeof setTimeout> | undefined;
const collapsed = new Set<string>();

/** Throws rather than silently no-oping: every id here is in the host's markup. */
function el<E extends HTMLElement = HTMLElement>(id: string): E {
    const node = document.getElementById(id);
    if (!node) throw new Error(`Trace panel element #${id} is missing`);
    return node as E;
}

function escapeHtml(value: string | number): string {
    return String(value).replace(/[&<>'"]/gu, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        "\"": "&quot;",
    }[character] ?? character));
}

function formatTime(value: number): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const pad = (number: number, size = 2): string => String(number).padStart(size, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function duration(row: TraceRowMessage): string {
    return row.durationMs === undefined
        ? "—"
        : `${Math.round(row.durationMs).toLocaleString()} ms`;
}

function tokenLabel(tokens: TraceTokenUsage | undefined): string {
    if (!tokens) return "";
    const parts = [`in ${tokens.inputTokens}`, `out ${tokens.outputTokens}`];
    if (tokens.cacheReadTokens !== undefined) parts.push(`cache-read ${tokens.cacheReadTokens}`);
    if (tokens.cacheWriteTokens !== undefined) parts.push(`cache-write ${tokens.cacheWriteTokens}`);
    if (tokens.reasoningTokens !== undefined) parts.push(`think ${tokens.reasoningTokens}`);
    return parts.join(" · ");
}

function compactNumber(value: number | undefined): string {
    return Number(value || 0).toLocaleString();
}

function compactDuration(value: number | undefined): string {
    if (value === undefined) return "—";
    if (value < 1000) return `${Math.round(value)} ms`;
    if (value < 60000) return `${(value / 1000).toFixed(1)} s`;
    return `${Math.floor(value / 60000)}m ${Math.round((value % 60000) / 1000)}s`;
}

/** A row is hidden when any shallower ancestor above it is collapsed. */
function hasCollapsedAncestor(rows: readonly TraceRowMessage[], index: number): boolean {
    const depth = Number(rows[index]?.depth || 0);
    for (let i = index - 1; i >= 0; i -= 1) {
        const candidate = rows[i];
        if (candidate && Number(candidate.depth || 0) < depth) {
            if (collapsed.has(candidate.id)) return true;
            return hasCollapsedAncestor(rows, i);
        }
    }
    return false;
}

function hasChildren(rows: readonly TraceRowMessage[], index: number): boolean {
    return index + 1 < rows.length &&
        Number(rows[index + 1]?.depth || 0) > Number(rows[index]?.depth || 0);
}

const TIMELINE_LANES: ReadonlyArray<readonly [string, string]> = [
    ["input", "Input"],
    ["model", "Model"],
    ["tools", "Tools"],
];

function renderOverview(): void {
    const overview = state.overview;
    el("metricDuration").textContent = compactDuration(overview?.durationMs);
    el("metricTurns").textContent = compactNumber(overview?.turns);
    el("metricCalls").textContent = compactNumber(overview?.calls);
    el("metricErrors").textContent = compactNumber(overview?.errors);
    el("metricInput").textContent = compactNumber(overview?.inputTokens);
    el("metricOutput").textContent = compactNumber(overview?.outputTokens);
    el("metricCacheRead").textContent = compactNumber(overview?.cacheReadTokens);
    el("metricCacheWrite").textContent = compactNumber(overview?.cacheWriteTokens);
    const modeButton = el("timelineMode");
    modeButton.textContent = state.timelineMode === "duration" ? i18n.duration : i18n.sequence;
    modeButton.classList.toggle("active", state.timelineMode === "duration");

    const timeline = state.timeline ?? [];
    const timelineLanes = el("timelineLanes");
    timelineLanes.innerHTML = "";
    for (const [lane, label] of TIMELINE_LANES) {
        const laneEl = document.createElement("div");
        laneEl.className = "timeline-lane";
        const labelEl = document.createElement("span");
        labelEl.className = "timeline-lane-label";
        labelEl.textContent = label;
        const trackEl = document.createElement("div");
        trackEl.className = "timeline-track";
        for (const item of timeline.filter((candidate) => candidate.lane === lane)) {
            const bar = document.createElement("div");
            bar.className = `timeline-item ${item.category}`;
            bar.dataset.timelineId = item.id;
            bar.title = `${item.eventType} · ${compactDuration(item.durationMs)} · ${item.summary}`;
            // Use CSSOM instead of inline style attributes so the
            // webview CSP does not strip the positioning.
            bar.style.left = `${item.left}%`;
            bar.style.width = `${item.width}%`;
            trackEl.appendChild(bar);
        }
        laneEl.appendChild(labelEl);
        laneEl.appendChild(trackEl);
        timelineLanes.appendChild(laneEl);
    }
    el("timelineStart").textContent = state.timelineStart === undefined
        ? "—"
        : formatTime(state.timelineStart);
    el("timelineEnd").textContent =
        state.timelineStart !== undefined && state.timelineEnd !== undefined
            ? `+${compactDuration(state.timelineEnd - state.timelineStart)}`
            : "—";
}

/**
 * Asks the host to open the file location a clicked element carries.
 *
 * @returns true when the click was consumed, so the caller stops propagation.
 */
function openFileLocation(target: EventTarget | null): boolean {
    const link = target instanceof Element
        ? target.closest<HTMLElement>("[data-file-path]")
        : undefined;
    const path = link?.dataset.filePath;
    if (!path) return false;
    const line = Number(link?.dataset.fileLine);
    const column = link?.dataset.fileColumn === undefined
        ? undefined
        : Number(link.dataset.fileColumn);
    if (
        !Number.isSafeInteger(line) || line <= 0 ||
        (column !== undefined && (!Number.isSafeInteger(column) || column <= 0))
    ) return false;
    vscode.postMessage({
        type: "openFileLocation",
        path,
        line,
        ...(column === undefined ? {} : { column }),
    });
    return true;
}

function rowMarkup(
    row: TraceRowMessage,
    index: number,
    sourceRows: readonly TraceRowMessage[],
): string {
    if (hasCollapsedAncestor(sourceRows, index)) return "";
    const group = (row.turn === undefined ? "session" : `T${row.turn}`) +
        (row.step === undefined ? "" : ` · S${row.step}`);
    const meta = [row.tool?.name, row.callId, tokenLabel(row.tokens)]
        .filter(Boolean).join(" · ");
    const summary = row.summary + (meta ? ` · ${meta}` : "");
    // summaryHtml and errorHtml are host-escaped markup; do not escape again.
    const summaryHtml = row.summaryHtml + (meta ? ` · ${escapeHtml(meta)}` : "");
    const toggle = hasChildren(sourceRows, index)
        ? `<button class="tree-toggle secondary" data-toggle-row="${escapeHtml(row.id)}" title="${collapsed.has(row.id) ? i18n.expand : i18n.collapse}">${collapsed.has(row.id) ? "+" : "−"}</button>`
        : "";
    const classes = `trace-row ${escapeHtml(row.category)} depth-${Math.min(8, Number(row.depth || 0))}` +
        (row.error ? " error" : "") +
        (state.selectedId === row.id ? " selected" : "");
    return `<div class="${classes}" data-row-id="${escapeHtml(row.id)}">` +
        `<div class="seq">#${Number(state.offset || 0) + index + 1} · ${escapeHtml(row.seq)}${row.endSeq === undefined ? "" : `→${escapeHtml(row.endSeq)}`}</div>` +
        `<div class="event">${toggle}${escapeHtml(row.eventType)}</div>` +
        `<div class="meta">${escapeHtml(group)}</div>` +
        `<div class="summary" title="${escapeHtml(summary)}">${summaryHtml}${row.error ? ` · ${row.errorHtml}` : ""}</div>` +
        `<div class="time">${escapeHtml(formatTime(row.time))}<br>${escapeHtml(duration(row))}</div>` +
        `</div>`;
}

function render(): void {
    el("title").textContent = `DSH Trace: ${state.title || state.sessionId || ""}`;
    const status = state.status;
    el("dot").className = "dot " + (
        status?.error || state.error
            ? "error"
            : status?.attention ? "attention" : status?.running ? "running" : ""
    );
    el("statusText").textContent = state.error
        ? i18n.loadingFailed
        : status?.error
          ? i18n.sessionError
          : status?.attention
            ? i18n.waitingForAction
            : status?.running ? i18n.running : i18n.idle;
    const search = el<HTMLInputElement>("search");
    if (document.activeElement !== search) search.value = state.query || "";
    el("counts").textContent =
        `${state.filteredRows || 0} ${i18n.rows} / ${state.totalRows || 0} ${i18n.projected} / ${state.totalEvents || 0} ${i18n.raw}` +
        (state.needsHistoryBaseline ? ` · ${i18n.historySyncing}` : "") +
        (state.followLatest ? ` · ${i18n.followLive}` : "");
    el<HTMLButtonElement>("older").disabled = !state.hasOlder;
    el<HTMLButtonElement>("newer").disabled = !state.hasNewer;
    el<HTMLButtonElement>("latest").disabled = Boolean(state.followLatest);
    renderOverview();

    const projections = state.projections ?? [];
    // valueHtml is host-escaped markup; the key is escaped here.
    el("projections").innerHTML = projections.length
        ? projections.map((item) =>
              `<div class="projection${state.selectedId === item.id ? " selected" : ""}" data-projection-key="${escapeHtml(item.key)}">` +
              `<div class="projection-head"><span class="projection-key">${escapeHtml(item.key)}</span>` +
              `<span class="seq">seq ${escapeHtml(item.seq)}</span></div>` +
              `<div class="projection-value">${item.valueHtml}</div></div>`,
          ).join("")
        : `<div class="empty">${escapeHtml(i18n.noProjections)}</div>`;

    const rows = state.rows ?? [];
    const ledger = el("ledger");
    if (state.error) {
        ledger.innerHTML = `<div class="error-box">${escapeHtml(state.error)}</div>`;
    } else if (rows.length === 0) {
        ledger.innerHTML = `<div class="empty">${escapeHtml(i18n.noRows)}</div>`;
    } else {
        ledger.innerHTML = rows.map((row, index) => rowMarkup(row, index, rows)).join("");
    }
    renderDetail();
}

function renderDetail(): void {
    document.querySelector(".inspector")?.classList.toggle("visible", Boolean(detail));
    el("detailKind").textContent = detail ? detail.kind : "Inspector";
    el("detailTitle").textContent = detail ? detail.title : i18n.selectRecord;
    const summary = el("summaryDetail");
    // valueHtml and rawHtml are host-escaped markup.
    summary.innerHTML = detail
        ? (detail.summary ?? []).map((field) =>
              `<div class="field"><div class="field-label">${escapeHtml(field.label)}</div>` +
              `<div class="field-value">${field.valueHtml}</div></div>`,
          ).join("")
        : `<div class="empty">${escapeHtml(i18n.deferredDetail)}</div>`;
    const raw = el("rawDetail");
    raw.innerHTML = detail ? detail.rawHtml : "";
    summary.classList.toggle("hidden", activeTab !== "summary");
    raw.classList.toggle("hidden", activeTab !== "raw");
    for (const tab of document.querySelectorAll<HTMLElement>("[data-tab]")) {
        tab.classList.toggle("active", tab.dataset.tab === activeTab);
    }
}

/**
 * Clears the selection locally and tells the host, repainting immediately.
 *
 * The local clear is deliberate: it keeps the click feeling instant instead of
 * waiting for the host's next state frame to drop the highlight.
 */
function clearSelection(): void {
    detail = undefined;
    state.selectedId = undefined;
    vscode.postMessage({ type: "clearSelection" });
    render();
}

/** Toggles a row off when it is already selected, otherwise asks the host for it. */
function selectOrClearRow(rowId: string): void {
    if (state.selectedId === rowId) clearSelection();
    else vscode.postMessage({ type: "selectRow", rowId });
}

document.addEventListener("click", (event) => {
    if (!openFileLocation(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
}, true);

document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (!openFileLocation(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
}, true);

el("ledger").addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : undefined;
    const toggle = target?.closest<HTMLElement>("[data-toggle-row]");
    if (toggle?.dataset.toggleRow) {
        const id = toggle.dataset.toggleRow;
        if (collapsed.has(id)) collapsed.delete(id);
        else collapsed.add(id);
        render();
        return;
    }
    const row = target?.closest<HTMLElement>("[data-row-id]");
    if (row?.dataset.rowId) selectOrClearRow(row.dataset.rowId);
});

el("timelineLanes").addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : undefined;
    const item = target?.closest<HTMLElement>("[data-timeline-id]");
    if (item?.dataset.timelineId) selectOrClearRow(item.dataset.timelineId);
});

el("projections").addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : undefined;
    const item = target?.closest<HTMLElement>("[data-projection-key]");
    if (!item?.dataset.projectionKey) return;
    // Projections compare by rendered element rather than id: the selected id
    // belongs to the projection's row identity, not to its key.
    if (state.selectedId && document.querySelector(".projection.selected") === item) {
        clearSelection();
    } else {
        vscode.postMessage({ type: "selectProjection", key: item.dataset.projectionKey });
    }
});

document.querySelector(".tabs")?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : undefined;
    const tab = target?.closest<HTMLElement>("[data-tab]");
    if (!tab?.dataset.tab) return;
    activeTab = tab.dataset.tab;
    renderDetail();
});

el("search").addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    const query = (event.target as HTMLInputElement).value;
    searchTimer = setTimeout(() => vscode.postMessage({ type: "setQuery", query }), 120);
});

el("timelineMode").addEventListener("click", () => {
    vscode.postMessage({
        type: "setTimelineMode",
        mode: state.timelineMode === "duration" ? "sequence" : "duration",
    });
});

el("older").addEventListener("click", () => vscode.postMessage({ type: "page", direction: "older" }));
el("newer").addEventListener("click", () => vscode.postMessage({ type: "page", direction: "newer" }));
el("latest").addEventListener("click", () => vscode.postMessage({ type: "page", direction: "latest" }));

window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (typeof message !== "object" || message === null) return;
    const envelope = message as { type?: unknown };
    if (envelope.type === "state") {
        state = (message as { state: TracePanelState }).state;
        if (state.selectedId === undefined || state.selectedId === null) detail = undefined;
        render();
    } else if (envelope.type === "detail") {
        detail = (message as { detail: TraceDetailMessage }).detail;
        renderDetail();
    }
});

render();
vscode.postMessage({ type: "ready" });
