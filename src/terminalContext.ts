import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { DshReferenceCandidate } from "./types";

/**
 * A shell command observed through VS Code's shell-integration events.
 *
 * The output is deliberately kept in memory only. Terminal scrollback is not
 * persisted by the extension, and commands that ran before activation cannot
 * be reconstructed from the stable VS Code API.
 */
export interface DshTerminalCommand {
    id: string;
    terminalName: string;
    command: string;
    cwd?: string;
    output: string;
    outputTruncated: boolean;
    exitCode?: number;
    startedAt: number;
    endedAt: number;
}

export interface TerminalPromptReferenceResolution {
    text: string;
    commands: DshTerminalCommand[];
    missing: string[];
}

interface PendingTerminalCommand {
    terminal: vscode.Terminal;
    execution: vscode.TerminalShellExecution;
    command: string;
    startedAt: number;
    chunks: string[];
    outputBytes: number;
    outputTruncated: boolean;
    readComplete: boolean;
    ended: boolean;
    exitCode?: number;
    endedAt?: number;
    finalizeTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_HISTORY_SIZE = 20;
const MAX_HISTORY_SIZE = 100;
const MAX_OUTPUT_BYTES = 300_000;
const FINALIZE_GRACE_MS = 500;

/** Captures terminal commands without depending on private terminal APIs. */
export class TerminalContextStore implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private readonly listeners = new Set<() => void>();
    private readonly captureListeners = new Set<(command: DshTerminalCommand) => void>();
    private readonly pending = new Map<vscode.TerminalShellExecution, PendingTerminalCommand>();
    private readonly byTerminal = new Map<vscode.Terminal, DshTerminalCommand[]>();

    public constructor() {
        // These APIs are stable in the extension's minimum VS Code version,
        // but keeping the guards makes the host tolerant of older test shells
        // and remote extension hosts that have not exposed shell integration.
        const onStart = vscode.window.onDidStartTerminalShellExecution;
        if (typeof onStart === "function") {
            this.disposables.push(onStart((event) => this.handleStart(event)));
        }
        const onEnd = vscode.window.onDidEndTerminalShellExecution;
        if (typeof onEnd === "function") {
            this.disposables.push(onEnd((event) => this.handleEnd(event)));
        }
        const onClose = vscode.window.onDidCloseTerminal;
        if (typeof onClose === "function") {
            this.disposables.push(onClose((terminal) => this.handleClose(terminal)));
        }
    }

    public onDidChange(listener: () => void): vscode.Disposable {
        this.listeners.add(listener);
        return new vscode.Disposable(() => this.listeners.delete(listener));
    }

    public onDidCapture(listener: (command: DshTerminalCommand) => void): vscode.Disposable {
        this.captureListeners.add(listener);
        return new vscode.Disposable(() => this.captureListeners.delete(listener));
    }

    /** Returns newest-first records across all terminals, bounded by the setting. */
    public recent(limit = this.historySize()): DshTerminalCommand[] {
        this.trimHistory();
        const records = [...this.byTerminal.values()].flat();
        records.sort((left, right) => right.endedAt - left.endedAt);
        return records.slice(0, Math.max(0, limit)).map((record) => ({ ...record }));
    }

    /**
     * Resolves a `terminal:<selector>` token. `last` is the newest captured
     * command; every other selector searches command text, terminal name,
     * working directory, or a complete/short command id.
     */
    public resolve(selector: string): DshTerminalCommand | undefined {
        const normalized = selector.trim().replace(/^terminal:/iu, "").toLowerCase();
        if (!normalized) return undefined;
        const records = this.recent(MAX_HISTORY_SIZE);
        if (normalized === "last") return records[0];

        const ordinal = /^(.*)#(\d+)$/u.exec(normalized);
        const query = ordinal?.[1] || normalized;
        const matching = records.filter((record) => this.matches(record, query));
        if (ordinal) {
            const index = Number(ordinal[2]) - 1;
            return Number.isSafeInteger(index) && index >= 0 ? matching[index] : undefined;
        }
        return matching[0];
    }

    /** Returns completion rows only while the active @ token targets terminal history. */
    public referenceCandidates(query: string): DshReferenceCandidate[] {
        const normalized = query.trim();
        const lower = normalized.toLowerCase();
        const terminalPrefix = lower.length === 0 || "terminal".startsWith(lower) || lower.startsWith("terminal:");
        if (!terminalPrefix) return [];
        const records = this.matchingRecords(normalized);
        const terminalSelector = normalized.replace(/^terminal:?/iu, "").toLowerCase();
        const lastHint = lower.length === 0 || (lower !== "terminal:" && "terminal".startsWith(lower));
        const seen = new Set<string>();
        return records.map((record, index) => {
            const commandToken = this.commandToken(record.command) || record.id.slice(0, 8);
            let selector = terminalSelector === "last" || (lastHint && index === 0) ? "last" : commandToken;
            if (seen.has(selector)) selector = `${selector}#${index + 1}`;
            seen.add(selector);
            const exit = record.exitCode === undefined ? "?" : String(record.exitCode);
            const description = `${record.terminalName} · exit ${exit}${record.cwd ? ` · ${record.cwd}` : ""}`;
            return {
                kind: "terminal",
                label: `terminal:${selector}`,
                insertText: `@terminal:${selector}`,
                description: `${record.command} · ${description}`,
            } satisfies DshReferenceCandidate;
        });
    }

    /**
     * Resolves all explicit `@terminal:<selector>` mentions in one prompt.
     * The mention is replaced with neutral prose so the Harness file-reference
     * parser does not mistake `terminal:...` for a workspace path. The command
     * itself is attached separately as untrusted IDE context by the caller.
     */
    public resolvePromptReferences(text: string): TerminalPromptReferenceResolution {
        const commands: DshTerminalCommand[] = [];
        const missing: string[] = [];
        const seen = new Set<string>();
        const pattern = /(^|[\s([{"'])@terminal:([^\s,.;!?)}\]>'"]+)/giu;
        const replaced = text.replace(pattern, (match, prefix: string, selector: string) => {
            const command = this.resolve(selector);
            if (!command) {
                missing.push(selector);
            } else if (!seen.has(command.id)) {
                seen.add(command.id);
                commands.push(command);
            }
            return `${prefix}the attached terminal command`;
        });
        return { text: replaced, commands, missing };
    }

    public dispose(): void {
        for (const disposable of this.disposables.splice(0)) disposable.dispose();
        for (const pending of this.pending.values()) {
            if (pending.finalizeTimer) clearTimeout(pending.finalizeTimer);
        }
        this.pending.clear();
        this.byTerminal.clear();
        this.listeners.clear();
        this.captureListeners.clear();
    }

    private handleStart(event: vscode.TerminalShellExecutionStartEvent): void {
        const command = cleanCommand(event.execution.commandLine.value);
        if (!command) return;

        const pending: PendingTerminalCommand = {
            terminal: event.terminal,
            execution: event.execution,
            command,
            startedAt: Date.now(),
            chunks: [],
            outputBytes: 0,
            outputTruncated: false,
            readComplete: false,
            ended: false,
        };
        this.pending.set(event.execution, pending);
        // read() must be called synchronously from the start event turn so no
        // output is lost. The async iterator itself can continue in the next
        // microtask while this event handler returns to VS Code.
        void this.readOutput(pending);
    }

    private handleEnd(event: vscode.TerminalShellExecutionEndEvent): void {
        const pending = this.pending.get(event.execution);
        if (!pending) return;
        pending.ended = true;
        pending.exitCode = event.exitCode;
        pending.endedAt = Date.now();
        this.finishWhenReady(pending);
    }

    private handleClose(terminal: vscode.Terminal): void {
        for (const pending of this.pending.values()) {
            if (pending.terminal !== terminal || pending.ended) continue;
            pending.ended = true;
            pending.endedAt = Date.now();
            this.finishWhenReady(pending);
        }
    }

    private async readOutput(pending: PendingTerminalCommand): Promise<void> {
        try {
            for await (const chunk of pending.execution.read()) {
                if (typeof chunk !== "string") continue;
                this.appendOutput(pending, chunk);
            }
        } catch {
            // Shell integration can end the stream abruptly when a terminal is
            // closed. The command metadata remains useful without its suffix.
        } finally {
            pending.readComplete = true;
            this.finishWhenReady(pending);
        }
    }

    private appendOutput(pending: PendingTerminalCommand, chunk: string): void {
        const cleaned = cleanTerminalOutput(chunk);
        if (!cleaned) return;
        const remaining = MAX_OUTPUT_BYTES - pending.outputBytes;
        if (remaining <= 0) {
            pending.outputTruncated = true;
            return;
        }
        const limited = truncateUtf8(cleaned, remaining);
        pending.chunks.push(limited);
        pending.outputBytes += Buffer.byteLength(limited, "utf8");
        if (limited.length < cleaned.length) pending.outputTruncated = true;
    }

    private finishWhenReady(pending: PendingTerminalCommand): void {
        if (!pending.ended) return;
        if (pending.readComplete) {
            this.finish(pending);
            return;
        }
        if (pending.finalizeTimer) return;
        pending.finalizeTimer = setTimeout(() => this.finish(pending), FINALIZE_GRACE_MS);
    }

    private finish(pending: PendingTerminalCommand): void {
        if (!this.pending.delete(pending.execution)) return;
        if (pending.finalizeTimer) clearTimeout(pending.finalizeTimer);
        const command = cleanCommand(pending.execution.commandLine.value) || pending.command;
        const cwd = pending.execution.cwd?.fsPath || pending.execution.cwd?.toString();
        const record: DshTerminalCommand = {
            id: randomUUID(),
            terminalName: pending.terminal.name || "Terminal",
            command,
            ...(cwd ? { cwd } : {}),
            output: pending.chunks.join(""),
            outputTruncated: pending.outputTruncated,
            ...(pending.exitCode === undefined ? {} : { exitCode: pending.exitCode }),
            startedAt: pending.startedAt,
            endedAt: pending.endedAt ?? Date.now(),
        };
        const history = this.byTerminal.get(pending.terminal) ?? [];
        history.unshift(record);
        this.byTerminal.set(pending.terminal, history);
        this.trimHistory();
        for (const listener of this.captureListeners) listener({ ...record });
        this.notify();
    }

    private matchingRecords(query: string): DshTerminalCommand[] {
        const raw = query.trim().toLowerCase();
        if (!raw || (raw !== "terminal:" && "terminal".startsWith(raw))) return this.recent(1);
        const normalized = raw.replace(/^terminal:?/iu, "");
        if (!normalized) return this.recent(8);
        if (normalized === "last") return this.recent(1);
        return this.recent(MAX_HISTORY_SIZE).filter((record) => this.matches(record, normalized));
    }

    private matches(record: DshTerminalCommand, query: string): boolean {
        if (record.id.toLowerCase() === query || record.id.toLowerCase().startsWith(query)) return true;
        return [record.command, record.terminalName, record.cwd]
            .filter((value): value is string => Boolean(value))
            .some((value) => value.toLowerCase().includes(query));
    }

    private commandToken(command: string): string | undefined {
        const token = command.trim().match(/^[\p{L}\p{N}._/-]+/u)?.[0];
        return token?.toLowerCase();
    }

    private historySize(): number {
        const configured = vscode.workspace.getConfiguration("dsh").get<number>(
            "terminalHistorySize",
            DEFAULT_HISTORY_SIZE,
        );
        if (!Number.isFinite(configured)) return DEFAULT_HISTORY_SIZE;
        return Math.min(MAX_HISTORY_SIZE, Math.max(1, Math.floor(configured)));
    }

    private trimHistory(): void {
        const limit = this.historySize();
        for (const history of this.byTerminal.values()) {
            if (history.length > limit) history.splice(limit);
        }
    }

    private notify(): void {
        for (const listener of this.listeners) listener();
    }
}

function cleanCommand(value: string): string {
    return value.replace(/[\r\n\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 4_096);
}

function cleanTerminalOutput(value: string): string {
    return value
        // OSC hyperlinks/title updates and CSI/2-byte ANSI control sequences.
        .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
        .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/gu, "")
        .replace(/\r\n?/gu, "\n")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}

function truncateUtf8(value: string, maxBytes: number): string {
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
