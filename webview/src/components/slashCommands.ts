import type { ChatViewAction } from "../../../src/chatViewProtocol";
import { postAction } from "../bridge";
import { t } from "../i18n";

export interface SlashCommand {
    name: string;
    description: string;
    action?: ChatViewAction;
}

export const SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
    { name: "/compact", description: t("Compact the current session history"), action: { type: "sendPrompt", text: "/compact", mode: "queue" } },
    { name: "/ide", description: t("Add one-shot IDE context"), action: { type: "openIdeContextPicker" } },
    { name: "/new", description: t("New session"), action: { type: "newSession" } },
    { name: "/search", description: t("Search sessions"), action: { type: "searchSession" } },
    { name: "/model", description: t("Select the current session model"), action: { type: "selectModel" } },
    { name: "/effort", description: t("Select reasoning effort") },
    { name: "/mode", description: t("Select agent mode"), action: { type: "selectAgentPreset" } },
    { name: "/preset", description: t("Select agent mode"), action: { type: "selectAgentPreset" } },
    { name: "/focus", description: t("Toggle focus mode"), action: { type: "toggleFocus" } },
    { name: "/trace", description: t("Open the current session trace"), action: { type: "openTrace" } },
    { name: "/stop", description: t("Stop the dsh runtime"), action: { type: "stop" } },
];

export interface SlashCommandContext {
    /** Whether reasoning effort options are already loaded; if not, /effort asks the host. */
    reasoningEffortAvailable: boolean;
    /** Called when the /effort panel should become visible. */
    onShowEffort: () => void;
}

/**
 * Executes a slash command by name. Returns true when the input was consumed
 * (the caller should clear the draft), false when nothing matched.
 */
export function runSlashCommand(name: string, context: SlashCommandContext): boolean {
    const mode = name.match(/^\/(?:mode|preset)(?:\s+(.+))?$/iu);
    if (mode) {
        const agentPreset = mode[1]?.trim();
        postAction({
            type: "selectAgentPreset",
            ...(agentPreset ? { agentPreset } : {}),
        });
        return true;
    }
    const command = SLASH_COMMANDS.find((candidate) => candidate.name === name.toLowerCase());
    if (!command) return false;
    if (command.name === "/effort") {
        context.onShowEffort();
        if (!context.reasoningEffortAvailable) {
            postAction({ type: "openReasoningEffort" });
        }
    } else if (command.action) {
        postAction(command.action);
    }
    return true;
}
