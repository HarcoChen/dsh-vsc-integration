import { isAbsolute } from "node:path";
import * as vscode from "vscode";
import { t } from "./localize";

const DEBUG_CONTEXT_MAX_BYTES = 180_000;
const DEBUG_REQUEST_TIMEOUT_MS = 5_000;
const MAX_STACK_FRAMES = 10;
const MAX_SCOPES = 4;
const MAX_VARIABLES = 60;
const MAX_VARIABLE_VALUE_CHARS = 1_200;
const MAX_DIAGNOSTICS = 80;
const MAX_DIAGNOSTICS_BYTES = 32_000;
const SOURCE_CONTEXT_LINES = 24;
const MAX_SOURCE_LINE_CHARS = 600;
const SENSITIVE_VARIABLE_NAME = /(?:password|passwd|secret|token|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|credential|authorization|cookie|session)/iu;

interface RecordValue {
    [key: string]: unknown;
}

interface DapSource {
    name?: string;
    path?: string;
    sourceReference?: number;
}

interface StackFrameSnapshot {
    id: number;
    name: string;
    source?: DapSource;
    line?: number;
    column?: number;
}

interface ScopeSnapshot {
    name: string;
    variablesReference: number;
    expensive: boolean;
    presentationHint?: string;
}

interface VariableSnapshot {
    name: string;
    value: string;
    type?: string;
    variablesReference?: number;
    namedVariables?: number;
    indexedVariables?: number;
}

interface SourceExcerpt {
    path: string;
    language?: string;
    text: string;
}

export interface DebugStopInfo {
    reason?: string;
    description?: string;
    text?: string;
    threadId?: number;
    allThreadsStopped?: boolean;
}

export interface DebugContextCapture {
    label: string;
    path?: string;
    language?: string;
    content: string;
    truncated: boolean;
}

/** Tracks the last DAP stopped event so a snapshot can explain why execution paused. */
export class DebugContextTracker implements vscode.Disposable {
    private readonly stopped = new Map<string, DebugStopInfo>();
    private readonly trackerRegistration: vscode.Disposable;
    private readonly terminationSubscription: vscode.Disposable;

    public constructor() {
        this.trackerRegistration = vscode.debug.registerDebugAdapterTrackerFactory("*", {
            createDebugAdapterTracker: (session) => ({
                onDidSendMessage: (message: unknown) => this.observe(session.id, message),
            }),
        });
        this.terminationSubscription = vscode.debug.onDidTerminateDebugSession((session) => {
            this.stopped.delete(session.id);
        });
    }

    public get(sessionId: string): DebugStopInfo | undefined {
        const info = this.stopped.get(sessionId);
        return info ? { ...info } : undefined;
    }

    public dispose(): void {
        this.trackerRegistration.dispose();
        this.terminationSubscription.dispose();
        this.stopped.clear();
    }

    private observe(sessionId: string, message: unknown): void {
        const record = asRecord(message);
        if (record?.type !== "event") return;
        const event = stringValue(record.event);
        if (event === "stopped") {
            const body = asRecord(record.body);
            const reason = stringValue(body?.reason);
            const description = stringValue(body?.description);
            const text = stringValue(body?.text);
            const threadId = safeInteger(body?.threadId);
            const allThreadsStopped = typeof body?.allThreadsStopped === "boolean"
                ? body.allThreadsStopped
                : undefined;
            this.stopped.set(sessionId, {
                ...(reason ? { reason } : {}),
                ...(description ? { description } : {}),
                ...(text ? { text } : {}),
                ...(threadId === undefined ? {} : { threadId }),
                ...(allThreadsStopped === undefined ? {} : { allThreadsStopped }),
            });
            return;
        }
        if (event === "continued" || event === "terminated" || event === "exited") {
            this.stopped.delete(sessionId);
        }
    }
}

export interface CaptureDebugContextOptions {
    tracker?: DebugContextTracker;
    maxBytes?: number;
}

/** Captures a bounded, read-only snapshot of the focused VS Code debug state. */
export async function captureDebugContext(
    options: CaptureDebugContextOptions = {},
): Promise<DebugContextCapture> {
    const active = vscode.debug.activeStackItem;
    if (!active) {
        throw new Error(t("There is no focused debug thread or stack frame."));
    }

    const session = active.session;
    const threadId = active.threadId;
    const focusedFrameId = stackFrameId(active);
    const stopInfo = options.tracker?.get(session.id);
    const warnings: string[] = [];

    let stackFrames: StackFrameSnapshot[] = [];
    try {
        const response = await debugRequest(session, "stackTrace", {
            threadId,
            levels: MAX_STACK_FRAMES,
        });
        stackFrames = parseStackFrames(response).slice(0, MAX_STACK_FRAMES);
        if (stackFrames.length === 0) warnings.push("The debug adapter returned an empty call stack.");
    } catch (error) {
        warnings.push(`Call stack unavailable: ${safeError(error)}`);
    }

    const selectedFrame = selectFrame(stackFrames, focusedFrameId);
    const scopeFrame = selectedFrame ?? (
        focusedFrameId === undefined
            ? undefined
            : { id: focusedFrameId, name: "Focused stack frame" }
    );
    let scopes: ScopeSnapshot[] = [];
    let variablesByScope: Array<{ scope: ScopeSnapshot; variables: VariableSnapshot[] }> = [];
    if (scopeFrame) {
        try {
            const response = await debugRequest(session, "scopes", {
                frameId: scopeFrame.id,
            });
            scopes = parseScopes(response);
        } catch (error) {
            warnings.push(`Frame scopes unavailable: ${safeError(error)}`);
        }

        const selectedScopes = scopes
            .filter((scope) => !scope.expensive && !isRegisterScope(scope))
            .sort((left, right) => scopeRank(left) - scopeRank(right))
            .slice(0, MAX_SCOPES);
        let remainingVariables = MAX_VARIABLES;
        for (const scope of selectedScopes) {
            if (remainingVariables <= 0) break;
            try {
                const response = await debugRequest(session, "variables", {
                    variablesReference: scope.variablesReference,
                    start: 0,
                    count: remainingVariables,
                });
                const variables = parseVariables(response)
                    .slice(0, remainingVariables)
                    .map((variable) => redactVariable(variable));
                variablesByScope.push({ scope, variables });
                remainingVariables -= variables.length;
            } catch (error) {
                warnings.push(`Variables unavailable for ${scope.name}: ${safeError(error)}`);
            }
        }
    }

    const effectiveFrame = scopeFrame;
    const sourceUri = effectiveFrame?.source
        ? resolveSourceUri(effectiveFrame.source, session)
        : undefined;
    const sourcePath = effectiveFrame?.source
        ? sourceLabel(effectiveFrame.source, sourceUri)
        : undefined;
    let sourceExcerpt: SourceExcerpt | undefined;
    if (sourceUri && effectiveFrame?.line !== undefined) {
        try {
            sourceExcerpt = await readSourceExcerpt(sourceUri, effectiveFrame.line);
        } catch (error) {
            warnings.push(`Source excerpt unavailable: ${safeError(error)}`);
        }
    }

    let diagnostics: string[] = [];
    try {
        diagnostics = collectDiagnostics(sourceUri);
    } catch (error) {
        warnings.push(`Diagnostics unavailable: ${safeError(error)}`);
    }

    const sessionLabel = session.name.trim() || session.type;
    const content = renderSnapshot({
        sessionLabel,
        sessionType: session.type,
        threadId,
        stopInfo,
        stackFrames,
        selectedFrame: effectiveFrame,
        variablesByScope,
        sourceExcerpt,
        sourcePath,
        diagnostics,
        warnings,
    });
    const limit = Math.max(
        1_000,
        Math.min(options.maxBytes ?? DEBUG_CONTEXT_MAX_BYTES, DEBUG_CONTEXT_MAX_BYTES),
    );
    const limited = truncateUtf8(content, limit);

    return {
        label: t("Debug Context: {session}", { session: sessionLabel }),
        ...(sourcePath ? { path: sourcePath } : {}),
        ...(sourceExcerpt?.language ? { language: sourceExcerpt.language } : {}),
        content: limited.text,
        truncated: limited.truncated,
    };
}

function isStackFrame(item: vscode.DebugThread | vscode.DebugStackFrame): item is vscode.DebugStackFrame {
    return "frameId" in item && typeof item.frameId === "number";
}

function stackFrameId(item: vscode.DebugThread | vscode.DebugStackFrame): number | undefined {
    return isStackFrame(item) ? item.frameId : undefined;
}

async function debugRequest(
    session: vscode.DebugSession,
    command: string,
    args: Record<string, unknown>,
): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const pending = Promise.resolve(session.customRequest(command, args));
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => reject(new Error(`debug adapter request ${command} timed out`)),
                DEBUG_REQUEST_TIMEOUT_MS,
            );
        });
        return await Promise.race([pending, timeout]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

function selectFrame(
    frames: readonly StackFrameSnapshot[],
    focusedFrameId: number | undefined,
): StackFrameSnapshot | undefined {
    if (focusedFrameId !== undefined) {
        return frames.find((frame) => frame.id === focusedFrameId);
    }
    return frames[0];
}

function parseStackFrames(value: unknown): StackFrameSnapshot[] {
    const record = responseRecord(value);
    const entries = Array.isArray(value)
        ? value
        : record && Array.isArray(record.stackFrames)
            ? record.stackFrames
            : [];
    return entries.flatMap((entry): StackFrameSnapshot[] => {
        const frame = asRecord(entry);
        const id = safeInteger(frame?.id);
        if (id === undefined) return [];
        const source = parseSource(frame?.source);
        const line = positiveInteger(frame?.line);
        const column = positiveInteger(frame?.column);
        return [{
            id,
            name: stringValue(frame?.name) ?? `Frame ${id}`,
            ...(source ? { source } : {}),
            ...(line === undefined ? {} : { line }),
            ...(column === undefined ? {} : { column }),
        }];
    });
}

function parseSource(value: unknown): DapSource | undefined {
    const record = asRecord(value);
    if (!record) return undefined;
    const name = stringValue(record.name);
    const sourcePath = stringValue(record.path);
    const sourceReference = positiveInteger(record.sourceReference);
    if (!name && !sourcePath && sourceReference === undefined) return undefined;
    return {
        ...(name ? { name } : {}),
        ...(sourcePath ? { path: sourcePath } : {}),
        ...(sourceReference === undefined ? {} : { sourceReference }),
    };
}

function parseScopes(value: unknown): ScopeSnapshot[] {
    const record = responseRecord(value);
    const entries = record && Array.isArray(record.scopes) ? record.scopes : [];
    return entries.flatMap((entry): ScopeSnapshot[] => {
        const scope = asRecord(entry);
        const variablesReference = safeInteger(scope?.variablesReference);
        if (variablesReference === undefined || variablesReference <= 0) return [];
        return [{
            name: stringValue(scope?.name) ?? "Scope",
            variablesReference,
            expensive: scope?.expensive === true,
            ...(stringValue(scope?.presentationHint)
                ? { presentationHint: stringValue(scope?.presentationHint) }
                : {}),
        }];
    });
}

function parseVariables(value: unknown): VariableSnapshot[] {
    const record = responseRecord(value);
    const entries = record && Array.isArray(record.variables) ? record.variables : [];
    return entries.flatMap((entry): VariableSnapshot[] => {
        const variable = asRecord(entry);
        const name = stringValue(variable?.name);
        if (!name) return [];
        const variablesReference = positiveInteger(variable?.variablesReference);
        const namedVariables = positiveInteger(variable?.namedVariables);
        const indexedVariables = positiveInteger(variable?.indexedVariables);
        return [{
            name,
            value: stringValue(variable?.value) ?? "<unavailable>",
            ...(stringValue(variable?.type) ? { type: stringValue(variable?.type) } : {}),
            ...(variablesReference === undefined ? {} : { variablesReference }),
            ...(namedVariables === undefined ? {} : { namedVariables }),
            ...(indexedVariables === undefined ? {} : { indexedVariables }),
        }];
    });
}

function redactVariable(variable: VariableSnapshot): VariableSnapshot {
    if (SENSITIVE_VARIABLE_NAME.test(variable.name)) {
        return { ...variable, value: "[redacted by dsh-ide]" };
    }
    return {
        ...variable,
        value: compactValue(variable.value, MAX_VARIABLE_VALUE_CHARS),
    };
}

function compactValue(value: string, maxChars: number): string {
    const normalized = value.replace(/[\r\n]+/gu, "\\n");
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, Math.max(0, maxChars - 18))}...[truncated]`;
}

function scopeRank(scope: ScopeSnapshot): number {
    if (/\b(local|locals)\b/iu.test(scope.name)) return 0;
    if (/\b(argument|arguments|args)\b/iu.test(scope.name)) return 1;
    if (/\b(register|global|closure)\b/iu.test(scope.name)) return 3;
    return 2;
}

function isRegisterScope(scope: ScopeSnapshot): boolean {
    return /\bregisters?\b/iu.test(scope.name) || /\bregisters?\b/iu.test(scope.presentationHint ?? "");
}

function resolveSourceUri(source: DapSource, session: vscode.DebugSession): vscode.Uri | undefined {
    try {
        if (source.path || source.sourceReference !== undefined) {
            return vscode.debug.asDebugSourceUri(
                source as vscode.DebugProtocolSource,
                session,
            );
        }
    } catch {
        // Fall through to the ordinary file/URI paths below.
    }

    const sourcePath = source.path?.trim();
    if (!sourcePath) return undefined;
    if (/^[a-z][a-z\d+.-]*:\/\//iu.test(sourcePath)) {
        try {
            return vscode.Uri.parse(sourcePath);
        } catch {
            return undefined;
        }
    }
    if (isAbsolute(sourcePath)) return vscode.Uri.file(sourcePath);
    const folder = session.workspaceFolder;
    return folder
        ? vscode.Uri.joinPath(folder.uri, sourcePath.replace(/\\/gu, "/"))
        : undefined;
}

function sourceLabel(source: DapSource, uri: vscode.Uri | undefined): string | undefined {
    if (uri) return displayUri(uri);
    return source.path?.trim() || source.name?.trim()
        || (source.sourceReference === undefined ? undefined : `debug:${source.sourceReference}`);
}

async function readSourceExcerpt(uri: vscode.Uri, line: number): Promise<SourceExcerpt> {
    const document = await vscode.workspace.openTextDocument(uri);
    const targetLine = document.lineCount === 0
        ? 0
        : Math.min(document.lineCount - 1, Math.max(0, line - 1));
    const start = Math.max(0, targetLine - SOURCE_CONTEXT_LINES);
    const end = Math.min(document.lineCount, targetLine + SOURCE_CONTEXT_LINES + 1);
    const sourceLines: string[] = [];
    for (let index = start; index < end; index += 1) {
        const marker = index === targetLine ? ">" : " ";
        const text = document.lineAt(index).text;
        const compact = text.length > MAX_SOURCE_LINE_CHARS
            ? `${text.slice(0, MAX_SOURCE_LINE_CHARS - 15)}...[truncated]`
            : text;
        sourceLines.push(`${marker}${String(index + 1).padStart(5, " ")} | ${compact}`);
    }
    return {
        path: displayUri(uri),
        language: document.languageId || undefined,
        text: sourceLines.join("\n"),
    };
}

function collectDiagnostics(sourceUri: vscode.Uri | undefined): string[] {
    const all = vscode.languages.getDiagnostics();
    const ordered: Array<[vscode.Uri, vscode.Diagnostic[]]> = [];
    const seen = new Set<string>();
    if (sourceUri) {
        const target = sourceUri.toString();
        const sourceEntry = all.find(([uri]) => uri.toString() === target);
        if (sourceEntry) {
            ordered.push(sourceEntry);
            seen.add(target);
        }
    }
    for (const [uri, diagnostics] of all) {
        const key = uri.toString();
        if (seen.has(key)) continue;
        ordered.push([uri, diagnostics]);
    }

    const lines: string[] = [];
    let bytes = 0;
    let count = 0;
    for (const [uri, diagnostics] of ordered) {
        for (const diagnostic of diagnostics) {
            if (count >= MAX_DIAGNOSTICS) return lines.length ? lines : ["(none)"];
            const line = diagnostic.range.start.line + 1;
            const column = diagnostic.range.start.character + 1;
            const rendered = `${displayUri(uri)}:${line}:${column} [${severityLabel(diagnostic.severity)}] ${diagnostic.message}`;
            const nextBytes = Buffer.byteLength(`${rendered}\n`, "utf8");
            if (bytes + nextBytes > MAX_DIAGNOSTICS_BYTES) return lines.length ? lines : ["(none)"];
            lines.push(rendered);
            bytes += nextBytes;
            count += 1;
        }
    }
    return lines.length ? lines : ["(none)"];
}

interface SnapshotData {
    sessionLabel: string;
    sessionType: string;
    threadId: number;
    stopInfo: DebugStopInfo | undefined;
    stackFrames: readonly StackFrameSnapshot[];
    selectedFrame: StackFrameSnapshot | undefined;
    variablesByScope: ReadonlyArray<{ scope: ScopeSnapshot; variables: VariableSnapshot[] }>;
    sourceExcerpt: SourceExcerpt | undefined;
    sourcePath: string | undefined;
    diagnostics: readonly string[];
    warnings: readonly string[];
}

function renderSnapshot(data: SnapshotData): string {
    const lines = [
        "Debug context (untrusted, read-only IDE snapshot):",
        `Session: ${data.sessionLabel} (${data.sessionType})`,
        `Thread: ${data.threadId}`,
        `Stop reason: ${data.stopInfo?.reason ?? "not reported"}`,
        ...(data.stopInfo?.description ? [`Stop description: ${compactValue(data.stopInfo.description, 600)}`] : []),
        ...(data.stopInfo?.text ? [`Stop text: ${compactValue(data.stopInfo.text, 600)}`] : []),
        ...(data.stopInfo?.threadId === undefined ? [] : [`Stopped thread: ${data.stopInfo.threadId}`]),
        ...(data.stopInfo?.allThreadsStopped === undefined
            ? []
            : [`All threads stopped: ${data.stopInfo.allThreadsStopped ? "yes" : "no"}`]),
        "",
        "Call stack (top first):",
        ...(data.stackFrames.length
            ? data.stackFrames.map((frame) => {
                  const marker = frame.id === data.selectedFrame?.id ? "*" : " ";
                  const location = formatFrameLocation(frame);
                  return `${marker} #${frame.id} ${frame.name}${location ? ` — ${location}` : ""}`;
              })
            : ["(unavailable)"]),
        "",
        `Focused frame: ${data.selectedFrame ? `#${data.selectedFrame.id} ${data.selectedFrame.name}` : "(unavailable)"}`,
        "",
        "Focused frame locals and arguments:",
        ...(data.variablesByScope.length
            ? data.variablesByScope.flatMap(({ scope, variables }) => [
                  `[${scope.name}]`,
                  ...(variables.length
                      ? variables.map(formatVariable)
                      : ["  (none)"]),
              ])
            : ["(unavailable)"]),
        "",
        "Current source excerpt:",
        ...(data.sourceExcerpt
            ? [
                  `File: ${data.sourceExcerpt.path}`,
                  ...(data.selectedFrame?.line === undefined
                      ? []
                      : [`Stopped near line ${data.selectedFrame.line}${data.selectedFrame.column ? `, column ${data.selectedFrame.column}` : ""}`]),
                  data.sourceExcerpt.text,
              ]
            : [data.sourcePath ? `File: ${data.sourcePath}` : "(unavailable)"]),
        "",
        "Workspace diagnostics:",
        ...data.diagnostics,
        ...(data.warnings.length
            ? ["", "Capture notes:", ...data.warnings.map((warning) => `- ${warning}`)]
            : []),
    ];
    return lines.join("\n");
}

function formatVariable(variable: VariableSnapshot): string {
    const type = variable.type ? `: ${variable.type}` : "";
    const children = variable.variablesReference
        ? ` (${(variable.namedVariables ?? 0) + (variable.indexedVariables ?? 0) || "nested"} children)`
        : "";
    return `  ${variable.name}${type} = ${variable.value}${children}`;
}

function formatFrameLocation(frame: StackFrameSnapshot): string | undefined {
    const source = frame.source;
    const path = source ? sourceLabel(source, undefined) : undefined;
    if (!path && frame.line === undefined) return undefined;
    const line = frame.line === undefined ? "?" : String(frame.line);
    const column = frame.column === undefined ? "" : `:${frame.column}`;
    return `${path ?? "<unknown>"}:${line}${column}`;
}

function displayUri(uri: vscode.Uri): string {
    if (uri.scheme !== "file") return uri.toString();
    const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/gu, "/");
    if (relative && relative !== uri.fsPath) return relative;
    return uri.fsPath;
}

function severityLabel(severity: vscode.DiagnosticSeverity): string {
    switch (severity) {
        case vscode.DiagnosticSeverity.Error:
            return "error";
        case vscode.DiagnosticSeverity.Warning:
            return "warning";
        case vscode.DiagnosticSeverity.Information:
            return "info";
        case vscode.DiagnosticSeverity.Hint:
            return "hint";
        default:
            return "diagnostic";
    }
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
    if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
    const suffix = "\n\n[... debug context truncated by dsh-ide ...]";
    const suffixBytes = Buffer.byteLength(suffix, "utf8");
    const prefix = truncateUtf8WithoutSuffix(value, Math.max(0, maxBytes - suffixBytes));
    return { text: `${prefix}${suffix}`, truncated: true };
}

function truncateUtf8WithoutSuffix(value: string, maxBytes: number): string {
    if (maxBytes <= 0) return "";
    if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
    let low = 0;
    let high = value.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes) low = middle;
        else high = middle - 1;
    }
    let result = value.slice(0, low);
    const last = result.charCodeAt(result.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) result = result.slice(0, -1);
    return result;
}

function asRecord(value: unknown): RecordValue | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as RecordValue
        : undefined;
}

function responseRecord(value: unknown): RecordValue | undefined {
    const record = asRecord(value);
    return asRecord(record?.body) ?? record;
}

function stringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function safeInteger(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
    const number = safeInteger(value);
    return number !== undefined && number > 0 ? number : undefined;
}

function safeError(error: unknown): string {
    const value = error instanceof Error ? error.message : String(error);
    return compactValue(value, 240);
}
