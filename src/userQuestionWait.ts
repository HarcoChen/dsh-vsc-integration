/** Claim and countdown for one RC.2 foreground user question. */
import type { RemoteConnectionController } from "./remote/connection";
import { RemoteCarrierError, RemoteProtocolError } from "./remote/errors";
import { errorMessage } from "./errors";
import { isRecord as isRemoteRecord } from "./guards";

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export class UserQuestionWaitController {
    public constructor(
        private readonly connection: Pick<RemoteConnectionController, "open">,
        private readonly log: (message: string) => void,
    ) {}

    /** Hold the foreground claim and reject its waterfall when the Host countdown expires. */
    public watch(
        sessionId: string,
        callId: string,
        onState: (state: { deadline?: number; connected: boolean; error?: string }) => void,
        onTimeout: () => Promise<void>,
    ): () => void {
        const abort = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        void (async () => {
            while (!abort.signal.aborted) {
                try {
                    for await (const raw of this.connection.open("userQuestions/attachWait", {
                        agentId: sessionId, callId,
                    }, abort.signal)) {
                        if (!isRemoteRecord(raw) || typeof raw.remainingMs !== "number" || !Number.isSafeInteger(raw.remainingMs) || raw.remainingMs < 0) {
                            throw new RemoteProtocolError("Remote userQuestions/attachWait returned an invalid frame");
                        }
                        clearTimeout(timer);
                        onState({ deadline: Date.now() + raw.remainingMs, connected: true });
                        timer = setTimeout(() => { void onTimeout().catch(error => this.log(`[dsh:questions] timeout failed: ${errorMessage(error)}`)); }, raw.remainingMs);
                    }
                    clearTimeout(timer);
                    if (!abort.signal.aborted) onState({ connected: true });
                    return;
                } catch (error) {
                    clearTimeout(timer);
                    if (abort.signal.aborted) return;
                    if (!(error instanceof RemoteCarrierError)) {
                        onState({ connected: false, error: errorMessage(error) });
                        return;
                    }
                    onState({ connected: false });
                    await delay(500);
                }
            }
        })();
        return () => { clearTimeout(timer); abort.abort(); };
    }

}
