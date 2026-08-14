import { DshApprovalOutcome, DshQuestionAnswerItem, DshQuestionItem } from "./types";
import { parseSafeHttpUrl } from "./safeMarkdown";

export type ChatViewAction =
    | { type: "ready" }
    | { type: "sendPrompt"; text: string; mode: "queue" | "steer" }
    | { type: "retryPrompt"; id: string }
    | { type: "toggleFocus" }
    | { type: "cancel" }
    | { type: "configureApiKey" }
    | { type: "openIdeContextPicker" }
    | { type: "removeContext"; id: string }
    | { type: "toggleSelection" }
    | { type: "start" }
    | { type: "stop" }
    | { type: "openLogs" }
    | { type: "openBrowser" }
    | { type: "openExternalLink"; url: string }
    | { type: "copyCode"; renderId: string; codeBlockId: string }
    | { type: "openTrace"; seq?: number }
    | { type: "switchSession"; sessionId: string }
    | { type: "newSession" }
    | { type: "searchSession" }
    | { type: "renameSession" }
    | { type: "forkSession" }
    | { type: "archiveSession" }
    | { type: "goalCreate"; objective: string; maxGoalRounds?: number }
    | ({ type: "goalEdit" } & (
          | { objective: string; maxGoalRounds?: number }
          | { objective?: never; maxGoalRounds: number }
      ))
    | { type: "goalPause" | "goalResume" | "goalComplete" | "goalClear" }
    | { type: "refreshSubagents" }
    | { type: "openSubagent"; childSessionId: string }
    | { type: "closeSubagent" }
    | { type: "followUpSubagent"; childSessionId: string; text: string }
    | { type: "interruptSubagent"; childSessionId: string }
    | { type: "answerApproval"; key: string; outcome: DshApprovalOutcome }
    | { type: "answerQuestion"; key: string; answers: DshQuestionAnswerItem[] }
    | {
          type: "updateQueue";
          itemId: string;
          action: "edit" | "remove" | "steer";
          text?: string;
    };

export const CHAT_WEBVIEW_PROTOCOL_VERSION = 1 as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasAny(value: Record<string, unknown>, keys: readonly string[]): boolean {
    return keys.some((key) => key in value);
}

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const allowed = new Set(keys);
    return Object.keys(value).every((key) => allowed.has(key));
}

function questionAnswers(value: unknown): DshQuestionAnswerItem[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const answers: DshQuestionAnswerItem[] = [];
    for (const candidate of value) {
        if (
            !isRecord(candidate) ||
            typeof candidate.id !== "string" ||
            !Array.isArray(candidate.selected) ||
            !candidate.selected.every((item) => typeof item === "string") ||
            (candidate.custom !== undefined && typeof candidate.custom !== "string")
        ) {
            return undefined;
        }
        answers.push({
            id: candidate.id,
            selected: [...candidate.selected],
            ...(candidate.custom === undefined ? {} : { custom: candidate.custom }),
        });
    }
    return answers;
}

/** Strict trust boundary for messages originating in the webview. */
export function parseChatViewAction(value: unknown): ChatViewAction | undefined {
    if (!isRecord(value) || typeof value.type !== "string") return undefined;
    if (value.protocol !== undefined && value.protocol !== CHAT_WEBVIEW_PROTOCOL_VERSION) {
        return undefined;
    }
    switch (value.type) {
        case "ready":
        case "cancel":
        case "configureApiKey":
        case "openIdeContextPicker":
        case "toggleSelection":
        case "toggleFocus":
        case "start":
        case "stop":
        case "openLogs":
        case "openBrowser":
        case "newSession":
        case "searchSession":
        case "renameSession":
        case "forkSession":
        case "archiveSession":
        case "goalPause":
        case "goalResume":
        case "goalComplete":
        case "goalClear":
        case "refreshSubagents":
        case "closeSubagent":
            if (
                (value.type.startsWith("goal") &&
                    hasAny(value, ["sessionId", "ref", "id", "revision"])) ||
                ((value.type === "refreshSubagents" || value.type === "closeSubagent") &&
                    hasAny(value, ["sessionId", "parentSessionId", "childSessionId", "mode", "provider"]))
            ) return undefined;
            return { type: value.type };
        case "openTrace":
            if (
                hasAny(value, ["sessionId", "callId", "turn", "step"]) ||
                (value.seq !== undefined && !nonNegativeInteger(value.seq))
            ) return undefined;
            return {
                type: "openTrace",
                ...(value.seq === undefined ? {} : { seq: value.seq }),
            };
        case "openExternalLink": {
            if (!hasOnly(value, ["type", "url"])) return undefined;
            const url = parseSafeHttpUrl(value.url);
            return url ? { type: "openExternalLink", url } : undefined;
        }
        case "copyCode":
            return hasOnly(value, ["type", "renderId", "codeBlockId"]) &&
                typeof value.renderId === "string" && /^[a-f0-9]{32}$/u.test(value.renderId) &&
                nonEmptyString(value.codeBlockId) && /^code-\d{1,6}$/u.test(value.codeBlockId)
                ? {
                      type: "copyCode",
                      renderId: value.renderId,
                      codeBlockId: value.codeBlockId,
                  }
                : undefined;
        case "sendPrompt":
            return typeof value.text === "string" &&
                (value.mode === "queue" || value.mode === "steer")
                ? { type: "sendPrompt", text: value.text, mode: value.mode }
                : undefined;
        case "retryPrompt":
            return hasOnly(value, ["type", "id"]) && nonEmptyString(value.id)
                ? { type: "retryPrompt", id: value.id }
                : undefined;
        case "removeContext":
            return nonEmptyString(value.id)
                ? { type: "removeContext", id: value.id }
                : undefined;
        case "switchSession":
            return nonEmptyString(value.sessionId)
                ? { type: "switchSession", sessionId: value.sessionId }
                : undefined;
        case "goalCreate":
            if (
                hasAny(value, ["sessionId", "ref", "id", "revision"]) ||
                !nonEmptyString(value.objective) ||
                (value.maxGoalRounds !== undefined && !positiveInteger(value.maxGoalRounds))
            ) return undefined;
            return {
                type: "goalCreate",
                objective: value.objective.trim(),
                ...(value.maxGoalRounds === undefined
                    ? {}
                    : { maxGoalRounds: value.maxGoalRounds }),
            };
        case "goalEdit": {
            if (
                hasAny(value, ["sessionId", "ref", "id", "revision"]) ||
                (value.objective !== undefined && !nonEmptyString(value.objective)) ||
                (value.maxGoalRounds !== undefined && !positiveInteger(value.maxGoalRounds)) ||
                (value.objective === undefined && value.maxGoalRounds === undefined)
            ) return undefined;
            if (value.objective !== undefined) {
                return {
                    type: "goalEdit",
                    objective: value.objective.trim(),
                    ...(value.maxGoalRounds === undefined
                        ? {}
                        : { maxGoalRounds: value.maxGoalRounds }),
                };
            }
            if (value.maxGoalRounds === undefined) return undefined;
            return { type: "goalEdit", maxGoalRounds: value.maxGoalRounds };
        }
        case "openSubagent":
        case "interruptSubagent":
            if (
                hasAny(value, ["sessionId", "parentSessionId", "mode", "provider"]) ||
                !nonEmptyString(value.childSessionId)
            ) return undefined;
            return { type: value.type, childSessionId: value.childSessionId };
        case "followUpSubagent":
            if (
                hasAny(value, ["sessionId", "parentSessionId", "mode", "provider"]) ||
                !nonEmptyString(value.childSessionId) ||
                !nonEmptyString(value.text)
            ) return undefined;
            return {
                type: "followUpSubagent",
                childSessionId: value.childSessionId,
                text: value.text.trim(),
            };
        case "answerApproval":
            return nonEmptyString(value.key) &&
                (value.outcome === "allowed-once" || value.outcome === "rejected")
                ? { type: "answerApproval", key: value.key, outcome: value.outcome }
                : undefined;
        case "answerQuestion": {
            const answers = questionAnswers(value.answers);
            return nonEmptyString(value.key) && answers
                ? { type: "answerQuestion", key: value.key, answers }
                : undefined;
        }
        case "updateQueue":
            if (
                !nonEmptyString(value.itemId) ||
                (value.action !== "edit" && value.action !== "remove" && value.action !== "steer")
            ) {
                return undefined;
            }
            if (value.action === "edit") {
                return typeof value.text === "string" && value.text.trim()
                    ? {
                          type: "updateQueue",
                          itemId: value.itemId,
                          action: "edit",
                          text: value.text,
                      }
                    : undefined;
            }
            return { type: "updateQueue", itemId: value.itemId, action: value.action };
        default:
            return undefined;
    }
}

/** Validate an answer against the exact pending question frame before claiming its rpcId. */
export function validateQuestionAnswers(
    questions: readonly DshQuestionItem[],
    answers: readonly DshQuestionAnswerItem[],
): string | undefined {
    const byId = new Map(questions.map((question) => [question.id, question]));
    if (byId.size !== questions.length || answers.length !== questions.length) {
        return "问题回答与当前请求不匹配。";
    }
    const seen = new Set<string>();
    for (const answer of answers) {
        const question = byId.get(answer.id);
        if (!question || seen.has(answer.id)) {
            return "问题回答包含未知或重复的标识。";
        }
        seen.add(answer.id);
        if (!question.multiSelect && answer.selected.length > 1) {
            return "单选问题不能选择多个选项。";
        }
        const allowed = new Set((question.options ?? []).map((option) => option.label));
        if (answer.selected.some((selection) => !allowed.has(selection))) {
            return "问题回答包含当前请求未提供的选项。";
        }
    }
    return undefined;
}
