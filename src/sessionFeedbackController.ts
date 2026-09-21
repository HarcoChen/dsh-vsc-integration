import { errorMessage } from "./errors";
import type { DshRuntime } from "./dshRuntime";
import { t } from "./localize";
import type {
    DshFeedbackCategory,
    DshSessionFeedbackRecordRequest,
    DshSessionFeedbackStateView,
} from "./types";

interface SessionFeedbackState {
    open: boolean;
    status: DshSessionFeedbackStateView["status"];
    sequence: number;
    error?: string;
}

export interface SessionFeedbackControllerDeps {
    readonly runtime: DshRuntime;
    /** The chat view's current root session, read live at every use. */
    readonly currentRootSession: () => string | undefined;
    /** Repaint request; only fired when the affected session is current. */
    readonly onChange: () => void;
}

/** Owns the optional session-level feedback dialog and its single RPC mutation. */
export class SessionFeedbackController {
    private readonly states = new Map<string, SessionFeedbackState>();
    private readonly resetTimers = new Map<string, ReturnType<typeof setTimeout>>();

    public constructor(private readonly deps: SessionFeedbackControllerDeps) {}

    public open(sessionId: string | undefined): void {
        if (!sessionId) return;
        this.clearResetTimer(sessionId);
        const state = this.states.get(sessionId) ?? {
            open: false,
            status: "idle" as const,
            sequence: 0,
        };
        if (state.status === "submitting") return;
        state.open = true;
        state.status = "idle";
        state.error = undefined;
        state.sequence += 1;
        this.states.set(sessionId, state);
        this.notifyIfCurrent(sessionId);
    }

    public dismiss(sessionId: string | undefined): void {
        if (!sessionId) return;
        const state = this.states.get(sessionId);
        if (!state) return;
        if (state.status === "submitting") return;
        this.clearResetTimer(sessionId);
        state.open = false;
        state.status = "idle";
        state.error = undefined;
        this.notifyIfCurrent(sessionId);
    }

    public async record(
        sessionId: string | undefined,
        text: string,
        category?: DshFeedbackCategory,
    ): Promise<void> {
        if (!sessionId) return;
        const state = this.states.get(sessionId) ?? {
            open: true,
            status: "idle" as const,
            sequence: 0,
        };
        if (state.status === "submitting") return;
        this.clearResetTimer(sessionId);
        state.open = true;
        state.status = "submitting";
        state.error = undefined;
        this.states.set(sessionId, state);
        this.notifyIfCurrent(sessionId);

        const request: DshSessionFeedbackRecordRequest = {
            sessionId,
            ...(text.trim().length === 0 ? {} : { text: text.trim() }),
            ...(category === undefined ? {} : { category }),
        };
        try {
            const result = await this.deps.runtime.recordSessionFeedback(request);
            if (result === undefined) {
                state.open = false;
                state.status = "unavailable";
                state.error = t("Session feedback is unavailable in this Runtime.");
                this.scheduleReset(sessionId);
                return;
            }
            if (!result.ok) {
                state.open = true;
                state.status = "error";
                state.error = result.error.code === "session-not-found"
                    ? t("This session is no longer available for feedback.")
                    : t("The feedback operation was rejected.");
                return;
            }
            state.open = false;
            state.status = "success";
            state.error = undefined;
            this.scheduleReset(sessionId);
        } catch (error) {
            state.open = true;
            state.status = "error";
            state.error = errorMessage(error);
        } finally {
            this.notifyIfCurrent(sessionId);
        }
    }

    public view(sessionId: string | undefined): DshSessionFeedbackStateView | undefined {
        if (!sessionId || !this.deps.runtime.getUrl()) return undefined;
        const state = this.states.get(sessionId);
        return state === undefined ? undefined : {
            open: state.open,
            status: state.status,
            sequence: state.sequence,
            ...(state.error === undefined ? {} : { error: state.error }),
        };
    }

    public dispose(): void {
        for (const timer of this.resetTimers.values()) clearTimeout(timer);
        this.resetTimers.clear();
    }

    private notifyIfCurrent(sessionId: string): void {
        if (sessionId === this.deps.currentRootSession()) this.deps.onChange();
    }

    private scheduleReset(sessionId: string): void {
        this.clearResetTimer(sessionId);
        const timer = setTimeout(() => {
            this.resetTimers.delete(sessionId);
            const state = this.states.get(sessionId);
            if (!state || state.open || state.status === "submitting") return;
            state.status = "idle";
            state.error = undefined;
            this.notifyIfCurrent(sessionId);
        }, 3_500);
        this.resetTimers.set(sessionId, timer);
    }

    private clearResetTimer(sessionId: string): void {
        const timer = this.resetTimers.get(sessionId);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.resetTimers.delete(sessionId);
        }
    }
}
