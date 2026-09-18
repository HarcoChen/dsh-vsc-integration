/**
 * The debug tools exposed to the runtime over the local MCP server.
 *
 * Everything here goes through the IDE's own debug adapter plumbing, so the
 * agent sees exactly what the user sees in Run and Debug — and is limited to
 * what the user configured: a tool may start a launch configuration that
 * already exists, never invent one.
 */
import { isAbsolute, resolve as resolvePath } from "node:path";
import * as vscode from "vscode";
import { captureDebugContext, debugRequest, type DebugContextTracker, type DebugLifecycleEvent } from "./debugContext";

type JsonRecord = { [key: string]: unknown };

export interface DebugToolInfo {
    name: string;
    description: string;
    inputSchema: JsonRecord;
}

export interface DebugToolOutcome {
    text: string;
    isError: boolean;
}

export interface DebugToolHostOptions {
    tracker: DebugContextTracker;
    log?: (message: string) => void;
    maxContextBytes?: number;
}

export interface DebugToolHost extends vscode.Disposable {
    readonly tools: readonly DebugToolInfo[];
    execute(name: string, args: unknown): Promise<DebugToolOutcome>;
}

/** Stays below the MCP client's 60s per-call timeout so a wait never severs the connection. */
const WAIT_DEFAULT_MS = 10_000;
const WAIT_MAX_MS = 45_000;
const MAX_LISTED_BREAKPOINTS = 60;
const SESSION_SETTLE_MS = 1_500;

const TOOL_DEFINITIONS: readonly DebugToolInfo[] = [
    {
        name: "debug_start",
        description: "Start one of the workspace's existing launch configurations in the IDE. Returns the session id to pass to the other debug tools.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                configurationName: { type: "string", description: "Name of the launch configuration to start. Omit only when the workspace has exactly one." },
                workspaceFolder: { type: "string", description: "Workspace folder holding the configuration; defaults to the first folder." },
                noDebug: { type: "boolean", description: "Run without debugging (breakpoints ignored)." },
            },
        },
    },
    {
        name: "debug_breakpoint",
        description: "Add, remove, or list source breakpoints in the IDE, including whether the debugger has verified each one.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["action"],
            properties: {
                action: { type: "string", enum: ["add", "remove", "list"] },
                file: { type: "string", description: "File holding the breakpoint; absolute, or relative to the workspace folder." },
                line: { type: "number", description: "1-based line number." },
                condition: { type: "string", description: "Expression that must be true for execution to stop (action=add)." },
                hitCondition: { type: "string", description: "Hit count expression (action=add)." },
                logMessage: { type: "string", description: "Log-and-continue message; supports {expressions} (action=add)." },
                enabled: { type: "boolean", description: "Whether the breakpoint is active (action=add, default true)." },
                sessionId: { type: "string", description: "Report each breakpoint's verified state in this session (action=list)." },
            },
        },
    },
    {
        name: "debug_control",
        description: "Drive execution of a debug session: continue, pause, step, list threads, or wait for the next pause.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["action"],
            properties: {
                action: { type: "string", enum: ["continue", "pause", "next", "stepIn", "stepOut", "threads", "wait"] },
                sessionId: { type: "string", description: "Session id or name from debug_start. Omit when only one session is live." },
                threadId: { type: "number", description: "Thread to act on; defaults to the stopped thread." },
                singleThread: { type: "boolean", description: "Restrict continue/step to one thread." },
                granularity: { type: "string", enum: ["instruction", "line", "statement"], description: "Step granularity (stepping actions)." },
                timeoutMs: { type: "number", description: "How long to wait for a pause, up to 45000ms (action=wait)." },
            },
        },
    },
    {
        name: "debug_context",
        description: "Read a bounded snapshot of a debug session: stop reason, call stack, the paused frame's locals and arguments, surrounding source, and diagnostics.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                sessionId: { type: "string", description: "Session id or name; defaults to the session this tool started, then to the IDE's focused frame." },
                threadId: { type: "number" },
                frameId: { type: "number", description: "Stack frame id from a previous snapshot; defaults to the paused frame." },
            },
        },
    },
];

class DebugToolHostImpl implements DebugToolHost {
    private readonly sessions = new Map<string, vscode.DebugSession>();
    private readonly startWaiters = new Set<(session: vscode.DebugSession) => void>();
    private lastStartedId: string | undefined;
    private readonly subscriptions: vscode.Disposable[] = [];
    private disposed = false;

    public constructor(private readonly options: DebugToolHostOptions) {
        this.subscriptions.push(
            vscode.debug.onDidStartDebugSession((session) => {
                this.sessions.set(session.id, session);
                this.lastStartedId = session.id;
                const waiter = this.startWaiters.values().next().value;
                if (waiter) {
                    this.startWaiters.delete(waiter);
                    waiter(session);
                }
            }),
            vscode.debug.onDidTerminateDebugSession((session) => {
                this.sessions.delete(session.id);
                if (this.lastStartedId === session.id) this.lastStartedId = undefined;
            }),
        );
    }

    public get tools(): readonly DebugToolInfo[] {
        return TOOL_DEFINITIONS;
    }

    public async execute(name: string, args: unknown): Promise<DebugToolOutcome> {
        const record: JsonRecord = isRecord(args) ? args : {};
        switch (name) {
            case "debug_start":
                return this.start(record);
            case "debug_breakpoint":
                return this.breakpoint(record);
            case "debug_control":
                return this.control(record);
            case "debug_context":
                return this.context(record);
            default:
                return failure(`Unknown debug tool "${name}".`);
        }
    }

    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const subscription of this.subscriptions) subscription.dispose();
        this.subscriptions.length = 0;
        this.sessions.clear();
        this.startWaiters.clear();
    }

    private async start(args: JsonRecord): Promise<DebugToolOutcome> {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const wanted = text(args.workspaceFolder);
        let folder: vscode.WorkspaceFolder | undefined;
        if (wanted) {
            folder = folders.find((candidate) => candidate.name === wanted);
            if (!folder) {
                return failure(`Unknown workspace folder "${wanted}". Known folders: ${list(folders.map((entry) => entry.name)) || "(none)"}`);
            }
        } else {
            folder = folders[0];
        }

        const configurations = (vscode.workspace
            .getConfiguration("launch", folder?.uri)
            .get<JsonRecord[]>("configurations") ?? []).filter(isRecord);
        const names = configurations
            .map((configuration) => text(configuration.name))
            .filter((value): value is string => value !== undefined);
        if (configurations.length === 0) {
            return failure("The workspace has no launch configurations. Ask the user to add one to .vscode/launch.json.");
        }

        const requested = text(args.configurationName);
        if (!requested && configurations.length > 1) {
            return failure(`Pass configurationName; the workspace offers ${list(names)}.`);
        }
        const configuration = requested
            ? configurations.find((entry) => text(entry.name) === requested)
            : configurations[0];
        if (!configuration) {
            return failure(`Unknown launch configuration "${requested}". Available: ${list(names)}`);
        }
        const name = text(configuration.name) ?? requested ?? "launch configuration";

        let started: boolean;
        try {
            started = await vscode.debug.startDebugging(folder, name, {
                noDebug: args.noDebug === true,
            });
        } catch (error) {
            return failure(`VS Code could not start "${name}": ${message(error)}`);
        }
        if (!started) {
            return failure(`VS Code declined the launch of "${name}" — the configuration may be invalid or another session is exclusive.`);
        }

        const session = await this.settleStartedSession();
        this.options.log?.(`debug_start launched ${name}`);
        return success([
            `Started debug session "${name}"${session ? ` (id ${session.id}, type ${session.type})` : ""}.`,
            "Use debug_breakpoint before continuing if you need a pause point, then debug_control action=wait and debug_context.",
        ].join(" "));
    }

    private async breakpoint(args: JsonRecord): Promise<DebugToolOutcome> {
        const action = text(args.action);
        if (action === "list") return this.listBreakpoints(text(args.sessionId));
        if (action !== "add" && action !== "remove") {
            return failure('action must be "add", "remove", or "list".');
        }
        const located = this.resolveBreakpointTarget(args);
        if (typeof located === "string") return failure(located);
        const { uri, line } = located;
        const matches = vscode.debug.breakpoints.filter((breakpoint): breakpoint is vscode.SourceBreakpoint =>
            breakpoint instanceof vscode.SourceBreakpoint
            && breakpoint.location.uri.toString() === uri.toString()
            && breakpoint.location.range.start.line === line - 1);

        if (action === "remove") {
            if (matches.length === 0) return success(`No breakpoint at ${displayUri(uri)}:${line}.`);
            vscode.debug.removeBreakpoints(matches);
            return success(`Removed ${matches.length} breakpoint(s) at ${displayUri(uri)}:${line}.`);
        }

        const condition = text(args.condition);
        const hitCondition = text(args.hitCondition);
        const logMessage = text(args.logMessage);
        const existing = matches.find((breakpoint) => breakpointMatchesOptions(breakpoint, condition, hitCondition, logMessage));
        if (existing) {
            return success(`A breakpoint at ${displayUri(uri)}:${line} already covers this request.`);
        }
        vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(
            new vscode.Location(uri, new vscode.Position(line - 1, 0)),
            args.enabled !== false,
            condition,
            hitCondition,
            logMessage,
        )]);
        return success([
            `Added breakpoint at ${displayUri(uri)}:${line}${condition ? ` when ${condition}` : ""}${logMessage ? ` (log: ${logMessage})` : ""}.`,
            "It is verified only once the target loads that module — confirm with debug_breakpoint action=list after starting.",
        ].join(" "));
    }

    private async listBreakpoints(sessionId: string | undefined): Promise<DebugToolOutcome> {
        const breakpoints = vscode.debug.breakpoints.filter(
            (breakpoint): breakpoint is vscode.SourceBreakpoint => breakpoint instanceof vscode.SourceBreakpoint,
        );
        if (breakpoints.length === 0) return success("No source breakpoints are set in the IDE.");
        const session = this.optionalSession(sessionId);
        const lines: string[] = [];
        for (const breakpoint of breakpoints.slice(0, MAX_LISTED_BREAKPOINTS)) {
            const location = breakpoint.location;
            const parts = [
                `- ${displayUri(location.uri)}:${location.range.start.line + 1}`,
                breakpoint.enabled ? "enabled" : "disabled",
            ];
            if (breakpoint.condition) parts.push(`condition=${breakpoint.condition}`);
            if (breakpoint.hitCondition) parts.push(`hits=${breakpoint.hitCondition}`);
            if (breakpoint.logMessage) parts.push(`log=${breakpoint.logMessage}`);
            if (session) parts.push(await verifiedLabel(session, breakpoint));
            lines.push(parts.join(" "));
        }
        if (breakpoints.length > MAX_LISTED_BREAKPOINTS) {
            lines.push(`(${breakpoints.length - MAX_LISTED_BREAKPOINTS} more breakpoints not listed)`);
        }
        return success([
            "Source breakpoints in the IDE:",
            ...lines,
            session ? "" : "Pass sessionId to also report whether the debugger verified each one.",
        ].filter(Boolean).join("\n"));
    }

    /** Session lookup that never fails a listing: an unknown id just means "no verification". */
    private optionalSession(sessionId: string | undefined): vscode.DebugSession | undefined {
        const resolved = this.resolveSession(sessionId);
        return typeof resolved === "string" ? undefined : resolved;
    }

    private async control(args: JsonRecord): Promise<DebugToolOutcome> {
        const action = text(args.action);
        if (!action) return failure("action is required: continue, pause, next, stepIn, stepOut, threads, wait.");
        const resolved = this.resolveSession(text(args.sessionId));
        if (typeof resolved === "string") return failure(resolved);
        const session = resolved;

        if (action === "threads") {
            try {
                const response = await debugRequest(session, "threads", {});
                const body = asRecord(responseBody(response));
                const threads = Array.isArray(body?.threads) ? body.threads : [];
                if (threads.length === 0) return success("The session reported no threads.");
                const lines = threads.flatMap((entry): string[] => {
                    const thread = asRecord(entry);
                    if (!thread) return [];
                    const id = typeof thread.id === "number" ? thread.id : undefined;
                    if (id === undefined) return [];
                    const name = typeof thread.name === "string" ? ` ${thread.name}` : "";
                    return [`- thread ${id}${name}`];
                });
                const stopped = this.options.tracker.get(session.id);
                return success([
                    `Threads of session "${session.name}" (id ${session.id}):`,
                    ...lines,
                    stopped ? `Stopped: ${stopReason(stopped)}` : "No stop event reported for this session.",
                ].join("\n"));
            } catch (error) {
                return failure(`threads request failed: ${message(error)}`);
            }
        }

        if (action === "wait") {
            return this.wait(session, args.timeoutMs);
        }

        if (action !== "continue" && action !== "pause" && action !== "next"
            && action !== "stepIn" && action !== "stepOut") {
            return failure(`Unknown action "${action}". Use continue, pause, next, stepIn, stepOut, threads, or wait.`);
        }

        const threadId = await this.threadFor(session, args.threadId);
        if (threadId === undefined) {
            return failure(`Could not determine a thread id for session "${session.name}"; pass threadId (see action=threads).`);
        }
        const request: JsonRecord = { threadId };
        if (typeof args.singleThread === "boolean") request.singleThread = args.singleThread;
        const granularity = text(args.granularity);
        if (granularity && action !== "continue" && action !== "pause") request.granularity = granularity;

        try {
            const response = await debugRequest(session, action, request);
            if (action === "continue") {
                const body = asRecord(responseBody(response));
                const all = typeof body?.allThreadsContinued === "boolean" ? body.allThreadsContinued : undefined;
                return success(`Resumed session "${session.name}"${all === false ? " (other threads stayed stopped)" : ""}. Use debug_control action=wait to reach the next pause.`);
            }
            return success(`Sent ${action} to thread ${threadId} of session "${session.name}". Read the result with debug_context.`);
        } catch (error) {
            return failure(`${action} failed on session "${session.name}": ${message(error)}`);
        }
    }

    private async wait(session: vscode.DebugSession, timeoutValue: unknown): Promise<DebugToolOutcome> {
        const alreadyStopped = this.options.tracker.get(session.id);
        if (alreadyStopped) {
            return success(`Session "${session.name}" is already stopped (${stopReason(alreadyStopped)}). Call debug_context.`);
        }
        const requested = typeof timeoutValue === "number" && Number.isFinite(timeoutValue)
            ? Math.max(250, Math.floor(timeoutValue))
            : WAIT_DEFAULT_MS;
        const timeoutMs = Math.min(requested, WAIT_MAX_MS);
        const event = await this.awaitStop(session.id, timeoutMs);
        if (!event) {
            return success(`No pause within ${timeoutMs}ms: the target is still running (or already paused and never continued). Increase timeoutMs, or call debug_context to check.`);
        }
        if (event.kind === "stopped") {
            return success(`Session "${session.name}" paused (${stopReason(event.stopInfo ?? {})}). Call debug_context for the stack, variables and source.`);
        }
        this.options.log?.(`debug wait saw termination of ${session.name}`);
        return success(`Debug session "${session.name}" terminated before reaching a pause. Start another one with debug_start if the run needs to continue.`);
    }

    private async awaitStop(sessionId: string, timeoutMs: number): Promise<DebugLifecycleEvent | undefined> {
        return new Promise<DebugLifecycleEvent | undefined>((resolve) => {
            let done = false;
            const finish = (event: DebugLifecycleEvent | undefined) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                subscription.dispose();
                resolve(event);
            };
            const timer = setTimeout(() => finish(undefined), timeoutMs);
            const subscription = this.options.tracker.onDidLifecycleChange((event) => {
                if (event.sessionId !== sessionId) return;
                if (event.kind === "running") return;
                finish(event);
            });
        });
    }

    private async context(args: JsonRecord): Promise<DebugToolOutcome> {
        const requested = text(args.sessionId);
        let session: vscode.DebugSession | undefined;
        if (requested) {
            const resolved = this.resolveSession(requested);
            if (typeof resolved === "string") return failure(resolved);
            session = resolved;
        } else {
            const known = this.lastStartedId ? this.sessions.get(this.lastStartedId) : undefined;
            session = known ?? (this.sessions.size === 1 ? Array.from(this.sessions.values())[0] : undefined);
        }
        const threadId = typeof args.threadId === "number" && Number.isInteger(args.threadId) ? args.threadId : undefined;
        const frameId = typeof args.frameId === "number" && Number.isInteger(args.frameId) ? args.frameId : undefined;
        try {
            const capture = await captureDebugContext({
                tracker: this.options.tracker,
                ...(session ? { session } : {}),
                ...(threadId === undefined ? {} : { threadId }),
                ...(frameId === undefined ? {} : { frameId }),
                ...(this.options.maxContextBytes === undefined ? {} : { maxBytes: this.options.maxContextBytes }),
            });
            return success(`${capture.content}${capture.truncated ? "\n\n(snapshot truncated; request a specific frameId to narrow it)" : ""}`);
        } catch (error) {
            return failure(`debug_context: ${message(error)}`);
        }
    }

    private resolveSession(sessionId: string | undefined): vscode.DebugSession | string {
        const live = Array.from(this.sessions.values());
        if (sessionId) {
            const byId = live.find((session) => session.id === sessionId);
            if (byId) return byId;
            const byName = live.filter((session) => session.name === sessionId);
            if (byName.length === 1) return byName[0];
            return `No live debug session matches "${sessionId}". Live sessions: ${list(live.map((session) => `${session.name} (id ${session.id})`)) || "(none)"}`;
        }
        const lastStarted = this.lastStartedId ? this.sessions.get(this.lastStartedId) : undefined;
        if (lastStarted) return lastStarted;
        if (live.length === 1) return live[0];
        return `Pass sessionId: ${live.length ? `${list(live.map((session) => `${session.name} (id ${session.id})`))}` : "no debug session is live, so start one with debug_start"}.`;
    }

    private resolveBreakpointTarget(args: JsonRecord): { uri: vscode.Uri; line: number } | string {
        const file = text(args.file);
        if (!file) return "file is required.";
        const line = typeof args.line === "number" && Number.isInteger(args.line) ? args.line : undefined;
        if (line === undefined || line < 1) return "line must be a positive 1-based integer.";
        const folder = vscode.workspace.workspaceFolders?.[0];
        const path = isAbsolute(file) ? file : resolvePath(folder?.uri.fsPath ?? process.cwd(), file);
        return { uri: vscode.Uri.file(path), line };
    }

    private async threadFor(session: vscode.DebugSession, explicit: unknown): Promise<number | undefined> {
        if (typeof explicit === "number" && Number.isInteger(explicit)) return explicit;
        const stopped = this.options.tracker.get(session.id);
        if (stopped?.threadId !== undefined) return stopped.threadId;
        try {
            const response = await debugRequest(session, "threads", {});
            const body = asRecord(responseBody(response));
            const threads = Array.isArray(body?.threads) ? body.threads : [];
            for (const entry of threads) {
                const id = asRecord(entry)?.id;
                if (typeof id === "number") return id;
            }
        } catch {
            // The caller reports the missing thread id.
        }
        return undefined;
    }

    /**
     * The session the launch just created. VS Code normally fires
     * `onDidStartDebugSession` before `startDebugging` resolves; the wait covers
     * an adapter that reports it later.
     */
    private settleStartedSession(): Promise<vscode.DebugSession | undefined> {
        if (this.lastStartedId) return Promise.resolve(this.sessions.get(this.lastStartedId));
        return new Promise((resolve) => {
            let settled = false;
            const waiter = (session: vscode.DebugSession) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.startWaiters.delete(waiter);
                resolve(session);
            };
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                this.startWaiters.delete(waiter);
                resolve(undefined);
            }, SESSION_SETTLE_MS);
            this.startWaiters.add(waiter);
        });
    }
}

/** Whether the adapter has bound this breakpoint, as the given session reports it. */
async function verifiedLabel(
    session: vscode.DebugSession,
    breakpoint: vscode.SourceBreakpoint,
): Promise<string> {
    try {
        // vscode.DebugProtocolBreakpoint is an opaque stand-in for the DAP Breakpoint type.
        const protocol = await session.getDebugProtocolBreakpoint(breakpoint) as unknown as JsonRecord | undefined;
        if (!protocol) return "state=not-loaded";
        return protocol.verified === true
            ? "state=verified"
            : `state=unverified${typeof protocol.message === "string" ? ` (${protocol.message})` : ""}`;
    } catch {
        return "state=unknown";
    }
}

function breakpointMatchesOptions(
    breakpoint: vscode.SourceBreakpoint,
    condition: string | undefined,
    hitCondition: string | undefined,
    logMessage: string | undefined,
): boolean {
    return (condition === undefined || breakpoint.condition === condition)
        && (hitCondition === undefined || breakpoint.hitCondition === hitCondition)
        && (logMessage === undefined || breakpoint.logMessage === logMessage);
}

function stopReason(info: { reason?: string; description?: string; text?: string; threadId?: number }): string {
    const parts = [`reason ${info.reason ?? "reported"}`];
    if (info.threadId !== undefined) parts.push(`thread ${info.threadId}`);
    if (info.description) parts.push(`"${info.description}"`);
    else if (info.text) parts.push(`"${info.text}"`);
    return parts.join(", ");
}

function displayUri(uri: vscode.Uri): string {
    const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/gu, "/");
    if (relative && relative !== uri.fsPath) return relative;
    return uri.fsPath;
}

function responseBody(value: unknown): unknown {
    const record = isRecord(value) ? value : undefined;
    return record && "body" in record ? record.body : value;
}

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord | undefined {
    return isRecord(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function list(values: readonly string[]): string {
    return values.join(", ");
}

function message(error: unknown): string {
    const value = error instanceof Error ? error.message : String(error);
    return value.length > 240 ? `${value.slice(0, 237)}...` : value;
}

function success(textValue: string): DebugToolOutcome {
    return { text: textValue, isError: false };
}

function failure(textValue: string): DebugToolOutcome {
    return { text: textValue, isError: true };
}

/** Builds the debug tool host; the caller owns its disposal. */
export function createDebugToolHost(options: DebugToolHostOptions): DebugToolHost {
    return new DebugToolHostImpl(options);
}
