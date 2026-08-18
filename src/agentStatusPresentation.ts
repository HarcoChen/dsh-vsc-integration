import * as vscode from "vscode";

/** A plugin-provided label shown while the active DSH agent is streaming. */
export interface AgentStatusPresentation {
    /** Plain text or emoji label, for example: "🐋 深潜中". */
    label: string;
}

/** Public API exported by the DSH extension for companion extensions. */
export interface DshExtensionApi {
    /**
     * Registers an agent-status label. The most recently registered label wins.
     * Dispose the returned registration to restore the prior label.
     */
    registerAgentStatusPresentation(presentation: AgentStatusPresentation): vscode.Disposable;
}

/** Keeps presentation registrations independent from the runtime's agent state. */
export class AgentStatusPresentationRegistry implements vscode.Disposable {
    private readonly entries = new Map<number, AgentStatusPresentation>();
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    private nextId = 0;

    public readonly onDidChange = this.changeEmitter.event;

    public registerAgentStatusPresentation(presentation: AgentStatusPresentation): vscode.Disposable {
        if (!presentation || typeof presentation.label !== "string") {
            throw new Error("Agent status presentation must provide a string label.");
        }
        const label = presentation.label.trim();
        if (!label) throw new Error("Agent status presentation label must not be empty.");
        if (label.length > 256) {
            throw new Error("Agent status presentation label must be 256 characters or fewer.");
        }

        const id = this.nextId++;
        this.entries.set(id, { label });
        this.changeEmitter.fire();
        return new vscode.Disposable(() => {
            if (this.entries.delete(id)) this.changeEmitter.fire();
        });
    }

    public current(): AgentStatusPresentation | undefined {
        let current: AgentStatusPresentation | undefined;
        for (const entry of this.entries.values()) current = entry;
        return current;
    }

    public dispose(): void {
        this.entries.clear();
        this.changeEmitter.dispose();
    }
}
