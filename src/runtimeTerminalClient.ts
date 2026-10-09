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
    controllerId?: string;
    error?: string;
}

export interface RuntimeTerminalEnvironment {
    cwd: string;
    maxInputBytes: number;
    maxCols: number;
    maxRows: number;
    scrollback: number;
}

export type RuntimeTerminalFrame =
    | { type: "snapshot"; sequence: number; screen: string; info: RuntimeTerminalInfo }
    | { type: "output"; sequence: number; data: string }
    | { type: "state"; info: RuntimeTerminalInfo };

const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function runtimeTerminalInfo(value: unknown): RuntimeTerminalInfo {
    if (!isRecord(value) || typeof value.id !== "string" || !value.id || typeof value.title !== "string" ||
        typeof value.cwd !== "string" || !natural(value.cols) || value.cols < 1 || !natural(value.rows) || value.rows < 1 ||
        !["running", "exited", "failed"].includes(String(value.state)) ||
        (value.exitCode !== null && (typeof value.exitCode !== "number" || !Number.isSafeInteger(value.exitCode))) ||
        (value.controllerId !== undefined && typeof value.controllerId !== "string") ||
        (value.error !== undefined && typeof value.error !== "string")) {
        throw new RemoteProtocolError("Runtime returned invalid terminal metadata");
    }
    return { id: value.id, title: value.title, cwd: value.cwd, cols: value.cols, rows: value.rows,
        state: value.state as RuntimeTerminalInfo["state"], exitCode: value.exitCode as number | null,
        ...(value.controllerId === undefined ? {} : { controllerId: value.controllerId }),
        ...(value.error === undefined ? {} : { error: value.error }) };
}

/** User PTYs hosted by DSH, separate from Agent tools and background Jobs. */
export class RuntimeTerminalClient {
    public constructor(private readonly unary: Pick<RemoteUnaryClient, "call">,
        private readonly connection: Pick<RemoteConnectionController, "open">) {}

    public async environment(sessionId: string): Promise<RuntimeTerminalEnvironment> {
        const value = await this.unary.call<unknown>("terminal/environment", { agentId: sessionId });
        if (!isRecord(value) || typeof value.cwd !== "string" ||
            ![value.maxInputBytes, value.maxCols, value.maxRows, value.scrollback].every(natural) ||
            Number(value.maxInputBytes) < 1 || Number(value.maxCols) < 1 || Number(value.maxRows) < 1) {
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

    public async *follow(sessionId: string, id: string, attachmentId: string, signal: AbortSignal): AsyncIterable<RuntimeTerminalFrame> {
        let sequence: number | undefined;
        for await (const value of this.connection.open("terminal/follow", { agentId: sessionId, id, attachmentId }, signal)) {
            if (!isRecord(value)) throw new RemoteProtocolError("Invalid terminal frame");
            if (sequence === undefined) {
                if (value.type !== "snapshot" || !natural(value.sequence) || typeof value.screen !== "string") {
                    throw new RemoteProtocolError("Terminal stream did not begin with a screen snapshot");
                }
                sequence = value.sequence;
                yield { type: "snapshot", sequence, screen: value.screen, info: runtimeTerminalInfo(value.info) };
            } else if (value.type === "output" && natural(value.sequence) && value.sequence === sequence + 1 && typeof value.data === "string") {
                sequence = value.sequence;
                yield { type: "output", sequence, data: value.data };
            } else if (value.type === "state") {
                yield { type: "state", info: runtimeTerminalInfo(value.info) };
            } else throw new RemoteProtocolError("Terminal output has an invalid frame or sequence gap");
        }
    }

    public write(sessionId: string, id: string, attachmentId: string, data: string): Promise<void> {
        return this.unary.call("terminal/write", { agentId: sessionId, id, attachmentId, data });
    }
    public resize(sessionId: string, id: string, attachmentId: string, cols: number, rows: number): Promise<void> {
        return this.unary.call("terminal/resize", { agentId: sessionId, id, attachmentId, cols, rows });
    }
    public close(sessionId: string, id: string): Promise<void> {
        return this.unary.call("terminal/close", { agentId: sessionId, id });
    }
}
