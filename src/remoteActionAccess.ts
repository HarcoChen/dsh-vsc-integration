import type { ChatViewAction } from "./chatViewProtocol";
import type { RemoteAccessState } from "./remote/access";

/** Editor actions with no Host mutation remain usable by readers. Unmapped mutations require ownership. */
export function canUseChatAction(access: RemoteAccessState, action: ChatViewAction, sessionId?: string): boolean {
    if (access.snapshot.owner && access.snapshot.available) return true;
    const local = new Set(["ready", "start", "newSession", "newSessionInCurrentWorkspace", "toggleFocus", "openLogs", "openExternalLink", "openBrowser", "manageSettings", "refreshPluginInventory",
        "openIdeContextPicker", "openTerminalCommandPicker", "openDiagnosticsPicker", "openPromptTemplatePicker", "removeContext", "toggleSelection",
        "fileReferenceQuery", "closeSubagent", "searchSession", "openSessionCenter", "dismissSessionFeedback",
        "stop", "cancelRecovery", "exportRecoveryDiagnostics", "restoreRecovery", "captureAppShot", "insertCode", "applyCode"]);
    if (local.has(action.type)) return true;
    if (action.type === "switchSession") return access.allows("session/follow", { kind: "session", id: action.sessionId });
    if (action.type === "openSubagent") return access.allows("session/follow", { kind: "session", id: action.childSessionId });
    if (action.type === "followUpSubagent" || action.type === "interruptSubagent") {
        const endpoint = action.type === "followUpSubagent" ? "subagents/prompt" : "subagents/interruptByParent";
        return !!sessionId && [sessionId, action.childSessionId].every(id => access.allows(endpoint, { kind: "session", id }));
    }
    if (action.type === "updateQueue") {
        const endpoint = "session/updateQueue";
        return !!sessionId && access.allows(endpoint, { kind: "session", id: sessionId });
    }
    const session: Partial<Record<ChatViewAction["type"], string>> = {
        sendPrompt: "session/prompt", retryPrompt: "session/prompt", cancel: "session/cancel",
        selectModel: "session/selectModel", selectReasoningEffort: "session/selectModel", openReasoningEffort: "session/modelCatalog",
        selectAgentPreset: "agentPresets/select", renameSession: "session/rename", forkSession: "session/fork", forkFromMessage: "session/fork",
        archiveSession: "workspace/archiveSession", killJob: "job/kill", openRuntimeTerminal: "terminal/attach",
        goalCreate: "goal/create", goalEdit: "goal/edit", goalPause: "goal/pause", goalResume: "goal/resume", goalClear: "goal/clear", goalComplete: "goal/complete",
        setPermissionPreset: "commands/execute", setPlanMode: "commands/execute",
        editScheduleContent: "schedule/update", deleteSchedule: "schedule/delete", loadScheduleHistory: "schedule/history",
        refreshSubagents: "session/projections", openTeamMember: "session/follow",
        toggleMessageFeedback: "messageFeedback/put", submitMessageFeedback: "messageFeedback/put", saveMessageFeedbackNote: "messageFeedback/put",
        openSessionFeedback: "sessionFeedback/record", recordSessionFeedback: "sessionFeedback/record",
        openTrace: "session/follow", copyMessage: "session/follow", copyCode: "session/follow", openCode: "session/follow",
        openFileLocation: "session/follow", openChangeDiff: "session/follow", openToolDiff: "session/follow", loadImage: "session/attachment",
    };
    const global: Partial<Record<ChatViewAction["type"], string>> = {
        configureWebSearch: "settings/mutate", mutateSettings: "settings/mutate", manageProviders: "settings/mutate",
        configureApiKey: "credentials/set", refreshScheduleCatalog: "schedule/catalog", openSettingsDocument: "settings/openSettingsDocument",
        setPluginEnabled: "pluginManager/setPluginEnabled", setBundleEnabled: "pluginManager/setBundleEnabled",
        managePlugins: "pluginManager/installBundle", newSession: "session/create", newSessionInCurrentWorkspace: "session/create",
    };
    const scoped = session[action.type];
    if (scoped) return !!sessionId && access.allows(scoped, { kind: "session", id: sessionId });
    const endpoint = global[action.type];
    return endpoint !== undefined && access.allows(endpoint);
}
