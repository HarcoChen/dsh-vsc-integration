import { DshApprovalOutcome, DshImageUpload, DshQuestionAnswerItem, DshQuestionItem } from "./types";
import { t } from "./localize";
import { parseSafeHttpUrl } from "./safeMarkdown";
import {
    MAX_FILE_LOCATION_INDEX,
    MAX_FILE_LOCATION_PATH_CHARACTERS,
} from "./fileLocations";

export type ChatViewAction =
    | { type: "ready" }
    | { type: "sendPrompt"; text: string; mode: "queue" | "steer"; images?: DshImageUpload[] }
    | { type: "retryPrompt"; id: string }
    | { type: "toggleFocus" }
    | { type: "cancel" }
    | { type: "configureApiKey" }
    | { type: "manageProviders" }
    | { type: "manageAgentPresets" }
    | { type: "manageWorkspaces" }
    | { type: "openIdeContextPicker" }
    | { type: "removeContext"; id: string }
    | { type: "loadImage"; attachmentId: string }
    | { type: "fileReferenceQuery"; query: string }
    | { type: "toggleSelection" }
    | { type: "start" }
    | { type: "stop" }
    | { type: "openLogs" }
    | { type: "openBrowser" }
    | { type: "openExternalLink"; url: string }
    | { type: "openFileLocation"; path: string; line: number; column?: number }
    | { type: "copyCode"; renderId: string; codeBlockId: string }
    | { type: "insertCode"; renderId: string; codeBlockId: string }
    | { type: "openCode"; renderId: string; codeBlockId: string; language?: string }
    | { type: "applyCode"; renderId: string; codeBlockId: string; language?: string }
    | { type: "openTrace"; seq?: number }
    | { type: "openChangeDiff"; turn: number; fileId: string }
    | { type: "restoreTurnChanges"; turn: number }
    | { type: "switchSession"; sessionId: string }
    | { type: "newSession" }
    | { type: "newSessionInCurrentWorkspace" }
    | { type: "searchSession" }
    | { type: "selectModel" }
    | { type: "selectReasoningEffort"; effort: string }
    | { type: "selectAgentPreset"; agentPreset?: string }
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

const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_BASE64_CHARACTERS = 16 * 1024 * 1024;
const MAX_MESSAGE_IMAGE_BASE64_CHARACTERS = 128 * 1024 * 1024;

function imageUploads(value: unknown): DshImageUpload[] | undefined {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 100) return undefined;
    const images: DshImageUpload[] = [];
    let totalCharacters = 0;
    for (const candidate of value) {
        if (!isRecord(candidate) || !hasOnly(candidate, ["mediaType", "data", "name"])) return undefined;
        if (
            typeof candidate.mediaType !== "string" ||
            !IMAGE_MEDIA_TYPES.has(candidate.mediaType) ||
            typeof candidate.data !== "string" ||
            candidate.data.length === 0 ||
            candidate.data.length > MAX_IMAGE_BASE64_CHARACTERS ||
            (candidate.name !== undefined &&
                (typeof candidate.name !== "string" || candidate.name.length > 512))
        ) return undefined;
        totalCharacters += candidate.data.length;
        if (totalCharacters > MAX_MESSAGE_IMAGE_BASE64_CHARACTERS) return undefined;
        images.push({
            mediaType: candidate.mediaType as DshImageUpload["mediaType"],
            data: candidate.data,
            ...(candidate.name === undefined ? {} : { name: candidate.name }),
        });
    }
    return images;
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
        case "manageProviders":
        case "manageWorkspaces":
        case "openIdeContextPicker":
        case "toggleSelection":
        case "toggleFocus":
        case "start":
        case "stop":
        case "openLogs":
        case "openBrowser":
        case "newSession":
        case "newSessionInCurrentWorkspace":
        case "searchSession":
        case "selectModel":
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
        case "manageAgentPresets":
            return hasOnly(value, ["type", "protocol"])
                ? { type: "manageAgentPresets" }
                : undefined;
        case "selectReasoningEffort":
            return hasOnly(value, ["type", "effort"]) &&
                nonEmptyString(value.effort) &&
                value.effort.length <= 128
                ? { type: "selectReasoningEffort", effort: value.effort.trim() }
                : undefined;
        case "openTrace":
            if (
                hasAny(value, ["sessionId", "callId", "turn", "step"]) ||
                (value.seq !== undefined && !nonNegativeInteger(value.seq))
            ) return undefined;
            return {
                type: "openTrace",
                ...(value.seq === undefined ? {} : { seq: value.seq }),
            };
        case "openChangeDiff":
            if (!positiveInteger(value.turn) || typeof value.fileId !== "string" ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.fileId) ||
                !hasOnly(value, ["type", "turn", "fileId"])) return undefined;
            return { type: "openChangeDiff", turn: value.turn, fileId: value.fileId };
        case "restoreTurnChanges":
            if (!positiveInteger(value.turn) || !hasOnly(value, ["type", "turn"])) return undefined;
            return { type: "restoreTurnChanges", turn: value.turn };
        case "openExternalLink": {
            if (!hasOnly(value, ["type", "url"])) return undefined;
            const url = parseSafeHttpUrl(value.url);
            return url ? { type: "openExternalLink", url } : undefined;
        }
        case "openFileLocation":
            if (
                !hasOnly(value, ["type", "path", "line", "column"]) ||
                !nonEmptyString(value.path) ||
                value.path.length > MAX_FILE_LOCATION_PATH_CHARACTERS ||
                value.path.includes("\0") ||
                !positiveInteger(value.line) ||
                value.line > MAX_FILE_LOCATION_INDEX ||
                (value.column !== undefined &&
                    (!positiveInteger(value.column) || value.column > MAX_FILE_LOCATION_INDEX))
            ) return undefined;
            return {
                type: "openFileLocation",
                path: value.path,
                line: value.line,
                ...(value.column === undefined ? {} : { column: value.column }),
            };
        case "copyCode":
        case "insertCode":
        case "openCode":
        case "applyCode": {
            const hasLanguage = value.language !== undefined;
            const allowedKeys = value.type === "copyCode" || value.type === "insertCode"
                ? ["type", "renderId", "codeBlockId"]
                : ["type", "renderId", "codeBlockId", "language"];
            if (
                !hasOnly(value, allowedKeys) ||
                typeof value.renderId !== "string" ||
                !/^[a-f0-9]{32}$/u.test(value.renderId) ||
                !nonEmptyString(value.codeBlockId) ||
                !/^code-\d{1,6}$/u.test(value.codeBlockId) ||
                (hasLanguage && (
                    typeof value.language !== "string" ||
                    !/^[\p{L}\p{N}_+.#-]{1,40}$/u.test(value.language)
                ))
            ) return undefined;
            if (value.type === "copyCode") {
                return { type: "copyCode", renderId: value.renderId, codeBlockId: value.codeBlockId };
            }
            if (value.type === "insertCode") {
                return { type: "insertCode", renderId: value.renderId, codeBlockId: value.codeBlockId };
            }
            const language = value.language as string | undefined;
            return value.type === "openCode"
                ? {
                      type: "openCode",
                      renderId: value.renderId,
                      codeBlockId: value.codeBlockId,
                      ...(language === undefined ? {} : { language }),
                  }
                : {
                      type: "applyCode",
                      renderId: value.renderId,
                      codeBlockId: value.codeBlockId,
                      ...(language === undefined ? {} : { language }),
                  };
        }
        case "sendPrompt":
            if (!hasOnly(value, ["type", "text", "mode", "images"]) ||
                typeof value.text !== "string" ||
                (value.mode !== "queue" && value.mode !== "steer")) return undefined;
            {
                const images = imageUploads(value.images);
                if (!images || (!value.text.trim() && images.length === 0)) return undefined;
                return {
                    type: "sendPrompt",
                    text: value.text,
                    mode: value.mode,
                    ...(images.length === 0 ? {} : { images }),
                };
            }
        case "retryPrompt":
            return hasOnly(value, ["type", "id"]) && nonEmptyString(value.id)
                ? { type: "retryPrompt", id: value.id }
                : undefined;
        case "removeContext":
            return nonEmptyString(value.id)
                ? { type: "removeContext", id: value.id }
                : undefined;
        case "loadImage":
            return hasOnly(value, ["type", "attachmentId"]) &&
                nonEmptyString(value.attachmentId) && value.attachmentId.length <= 256
                ? { type: "loadImage", attachmentId: value.attachmentId }
                : undefined;
        case "fileReferenceQuery":
            return hasOnly(value, ["type", "query"]) && typeof value.query === "string" && value.query.length <= 256
                ? { type: "fileReferenceQuery", query: value.query }
                : undefined;
        case "switchSession":
            return nonEmptyString(value.sessionId)
                ? { type: "switchSession", sessionId: value.sessionId }
                : undefined;
        case "selectAgentPreset":
            if (!hasOnly(value, ["type", "agentPreset"])) return undefined;
            if (value.agentPreset === undefined) return { type: "selectAgentPreset" };
            return nonEmptyString(value.agentPreset) && value.agentPreset.length <= 128
                ? { type: "selectAgentPreset", agentPreset: value.agentPreset.trim() }
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
        return t("The answers do not match the current request.");
    }
    const seen = new Set<string>();
    for (const answer of answers) {
        const question = byId.get(answer.id);
        if (!question || seen.has(answer.id)) {
            return t("The answers contain an unknown or duplicate identifier.");
        }
        seen.add(answer.id);
        if (!question.multiSelect && answer.selected.length > 1) {
            return t("A single-choice question cannot have multiple selections.");
        }
        const allowed = new Set((question.options ?? []).map((option) => option.label));
        if (answer.selected.some((selection) => !allowed.has(selection))) {
            return t("The answers contain an option that was not provided by the current request.");
        }
    }
    return undefined;
}
