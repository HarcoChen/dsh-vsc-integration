import type { RemoteUnaryClient } from "./remote/unaryClient";
import type { RemoteConnectionController } from "./remote/connection";
import { RemoteProtocolError } from "./remote/errors";
import { isRecord } from "./guards";

export interface RuntimeTerminalInfo {
    id: string;
    title: string;
    cwd: string;
    cols: number;
    rows: number;
    state: "running" | "exited" | "failed";
    exitCode: number | null;
    error?: string;
}

export interface RuntimeTerminalEnvironment {
    cwd: string;
    maxInputBytes: number;
    maxBufferedBytes: number;
    maxCols: number;
    maxRows: number;
    scrollback: number;
}

export type RuntimeTerminalFrame =
    | { type: "snapshot"; sequence: number; screen: string; info: RuntimeTerminalInfo; writable: boolean; inputWindow?: { maxBytes: number; frameOverheadBytes: number } }
    | { type: "output"; sequence: number; data: string }
    | { type: "state"; info: RuntimeTerminalInfo; writable: boolean }
    | { type: "ack"; sequence: number; refusal?: "read-only" | "not-running" };

const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function runtimeTerminalInfo(value: unknown): RuntimeTerminalInfo {
    if (!isRecord(value) || typeof value.id !== "string" || !value.id || typeof value.title !== "string" ||
        typeof value.cwd !== "string" || !natural(value.cols) || value.cols < 1 || !natural(value.rows) || value.rows < 1 ||
        !["running", "exited", "failed"].includes(String(value.state)) ||
        (value.exitCode !== null && (typeof value.exitCode !== "number" || !Number.isSafeInteger(value.exitCode))) ||
        (value.error !== undefined && typeof value.error !== "string")) {
        throw new RemoteProtocolError("Runtime returned invalid terminal metadata");
    }
    return { id: value.id, title: value.title, cwd: value.cwd, cols: value.cols, rows: value.rows,
        state: value.state as RuntimeTerminalInfo["state"], exitCode: value.exitCode as number | null,
        ...(value.error === undefined ? {} : { error: value.error }) };
}

/** User PTYs hosted by DSH, separate from Agent tools and background Jobs. */
export class RuntimeTerminalClient {
    public constructor(private readonly unary: Pick<RemoteUnaryClient, "call">,
        private readonly connection: Pick<RemoteConnectionController, "open">) {}

    public async environment(sessionId: string): Promise<RuntimeTerminalEnvironment> {
        const value = await this.unary.call<unknown>("terminal/environment", { agentId: sessionId });
        if (!isRecord(value) || typeof value.cwd !== "string" ||
            ![value.maxInputBytes, value.maxBufferedBytes, value.maxCols, value.maxRows, value.scrollback].every(natural) ||
            Number(value.maxInputBytes) < 1 || Number(value.maxBufferedBytes) < 1 || Number(value.maxCols) < 1 || Number(value.maxRows) < 1) {
            throw new RemoteProtocolError("Runtime returned invalid terminal limits");
        }
        return value as unknown as RuntimeTerminalEnvironment;
    }

    public async list(sessionId: string): Promise<RuntimeTerminalInfo[]> {
        const value = await this.unary.call<unknown>("terminal/list", { sessionId });
        if (!Array.isArray(value)) throw new RemoteProtocolError("Runtime returned invalid terminal list");
        return value.map(runtimeTerminalInfo);
    }

    public async create(sessionId: string, id: string, cols: number, rows: number): Promise<RuntimeTerminalInfo> {
        return runtimeTerminalInfo(await this.unary.call("terminal/create", { agentId: sessionId, request: { id, cols, rows } }));
    }

    public async *retain(sessionId: string, id: string, signal: AbortSignal): AsyncIterable<void> {
        for await (const value of this.connection.open("terminal/retain", { sessionId, id }, signal)) {
            if (!isRecord(value) || value.type !== "retained") throw new RemoteProtocolError("Invalid terminal retention acknowledgement");
            yield;
        }
    }

    public attach(sessionId: string, id: string, limits: RuntimeTerminalEnvironment, signal: AbortSignal): RuntimeTerminalAttachment {
        return new RuntimeTerminalAttachment(this.connection, sessionId, id, limits, signal);
    }
    public close(sessionId: string, id: string): Promise<void> {
        return this.unary.call("terminal/close", { agentId: sessionId, id });
    }
}

type TerminalInput = { type: "write"; sequence: number; data: string } |
    { type: "resize"; sequence: number; cols: number; rows: number };

/** One attachment owns its input queue. Disconnection discards input, including unacknowledged commands. */
export class RuntimeTerminalAttachment {
    public writable = false;
    private sequence = 0;
    private acknowledged = 0;
    private bytes = 0;
    private bufferedBytes = 0;
    private inFlightBytes = 0;
    private window?: { maxBytes: number; frameOverheadBytes: number };
    private readonly queue: { command: TerminalInput; bytes: number; cost: number }[] = [];
    private readonly pending = new Map<number, { bytes: number; cost: number }>();
    private wake?: () => void;
    private ended = false;

    public constructor(private readonly connection: Pick<RemoteConnectionController, "open">,
        private readonly sessionId: string, private readonly id: string,
        private readonly limits: RuntimeTerminalEnvironment, private readonly signal: AbortSignal) {}

    public write(data: string): boolean {
        return this.send({ type: "write", sequence: this.sequence + 1, data }, Buffer.byteLength(data, "utf8"));
    }

    public resize(cols: number, rows: number): boolean {
        return this.send({ type: "resize", sequence: this.sequence + 1,
            cols: Math.max(1, Math.min(cols, this.limits.maxCols)), rows: Math.max(1, Math.min(rows, this.limits.maxRows)) }, 0);
    }

    private send(command: TerminalInput, bytes: number): boolean {
        if (!this.writable || this.ended || this.signal.aborted) return false;
        const cost = Buffer.byteLength(JSON.stringify(command), "utf8") + (this.window?.frameOverheadBytes ?? 0);
        if (this.bytes + bytes > this.limits.maxInputBytes || this.bufferedBytes + cost > this.limits.maxBufferedBytes ||
            (this.window && cost > this.window.maxBytes)) return false;
        this.sequence = command.sequence;
        this.bytes += bytes;
        this.bufferedBytes += cost;
        this.queue.push({ command, bytes, cost });
        this.wake?.();
        return true;
    }

    private async *input(): AsyncGenerator<TerminalInput> {
        while (!this.ended && !this.signal.aborted) {
            const next = this.queue[0];
            if (this.writable && next && (!this.window || this.inFlightBytes + next.cost <= this.window.maxBytes)) {
                this.queue.shift();
                this.pending.set(next.command.sequence, next);
                this.inFlightBytes += next.cost;
                yield next.command;
            } else await new Promise<void>(resolve => { this.wake = resolve; });
        }
    }

    public async *[Symbol.asyncIterator](): AsyncGenerator<RuntimeTerminalFrame> {
        let outputSequence: number | undefined;
        const abort = (): void => { this.ended = true; this.writable = false; this.wake?.(); };
        this.signal.addEventListener("abort", abort, { once: true });
        try {
            for await (const value of this.connection.open("terminal/attach", { agentId: this.sessionId, id: this.id }, this.signal, this.input())) {
                if (!isRecord(value)) throw new RemoteProtocolError("Invalid terminal frame");
                if (outputSequence === undefined) {
                    if (value.type !== "snapshot" || !natural(value.sequence) || typeof value.screen !== "string" || typeof value.writable !== "boolean") {
                        throw new RemoteProtocolError("Terminal stream did not begin with a screen snapshot");
                    }
                    if (value.inputWindow !== undefined) {
                        if (!isRecord(value.inputWindow) || !natural(value.inputWindow.maxBytes) || value.inputWindow.maxBytes < 1 ||
                            !natural(value.inputWindow.frameOverheadBytes)) throw new RemoteProtocolError("Invalid terminal input window");
                        this.window = { maxBytes: value.inputWindow.maxBytes, frameOverheadBytes: value.inputWindow.frameOverheadBytes };
                    }
                    outputSequence = value.sequence;
                    const info = runtimeTerminalInfo(value.info);
                    this.writable = value.writable && info.state === "running";
                    yield { type: "snapshot", sequence: outputSequence, screen: value.screen, info, writable: this.writable,
                        ...(this.window ? { inputWindow: this.window } : {}) };
                } else if (value.type === "output" && natural(value.sequence) && value.sequence === outputSequence + 1 && typeof value.data === "string") {
                    outputSequence = value.sequence;
                    yield { type: "output", sequence: outputSequence, data: value.data };
                } else if (value.type === "state" && typeof value.writable === "boolean") {
                    const info = runtimeTerminalInfo(value.info);
                    this.writable = value.writable && info.state === "running";
                    this.wake?.();
                    yield { type: "state", info, writable: this.writable };
                } else if (value.type === "ack" && natural(value.sequence)) {
                    const pending = this.pending.get(value.sequence);
                    if (!pending || value.sequence !== this.acknowledged + 1 ||
                        (value.refusal !== undefined && value.refusal !== "read-only" && value.refusal !== "not-running")) {
                        throw new RemoteProtocolError("Invalid terminal input acknowledgement");
                    }
                    this.acknowledged = value.sequence;
                    this.pending.delete(value.sequence);
                    this.bytes -= pending.bytes;
                    this.bufferedBytes -= pending.cost;
                    this.inFlightBytes -= pending.cost;
                    if (value.refusal !== undefined) this.writable = false;
                    this.wake?.();
                    yield { type: "ack", sequence: value.sequence, ...(value.refusal === undefined ? {} : { refusal: value.refusal }) };
                } else throw new RemoteProtocolError("Terminal output has an invalid frame or sequence gap");
            }
        } finally {
            abort();
            this.signal.removeEventListener("abort", abort);
            this.queue.length = 0;
            this.pending.clear();
        }
    }
}
