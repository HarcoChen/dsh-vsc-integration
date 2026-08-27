import { useCallback, useMemo, useState } from "react";
import type React from "react";
import type { ChatViewState, DshCommandDescriptor, DshSkillEntry } from "../../../src/types";
import { postAction } from "../bridge";
import { mergeSlashCommands, runSlashCommand, type SlashCommand } from "./slashCommands";

export const SLASH_MENU_ID = "dsh-slash-completion";
export const SKILL_MENU_ID = "dsh-skill-completion";

export interface SlashCompletionOptions {
    text: string;
    setText: (text: string) => void;
    skills: DshSkillEntry[];
    /** Host-registered commands for the current session. */
    commands: DshCommandDescriptor[];
    reasoningEffort: ChatViewState["reasoningEffort"];
    onShowEffort: () => void;
    focusTextarea: () => void;
}

export interface SlashCompletion {
    slashIndex: number;
    resetSlashIndex: () => void;
    slashMatches: SlashCommand[];
    slashSkillMatches: DshSkillEntry[];
    skillMatches: DshSkillEntry[];
    slashCandidateCount: number;
    executeSlashCommand: (name: string) => boolean;
    chooseSlashCommand: (name: string) => void;
    chooseSkill: (name: string) => void;
    /** Handles completion key bindings; returns true when the event was consumed. */
    handleCompletionKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

export function useSlashCompletion({
    text,
    setText,
    skills,
    commands,
    reasoningEffort,
    onShowEffort,
    focusTextarea,
}: SlashCompletionOptions): SlashCompletion {
    const [slashIndex, setSlashIndex] = useState(0);
    const resetSlashIndex = useCallback((): void => setSlashIndex(0), []);

    const available = useMemo(() => mergeSlashCommands(commands), [commands]);

    const executeSlashCommand = useCallback((name: string): boolean => {
        const handled = runSlashCommand(name, {
            reasoningEffortAvailable: !!reasoningEffort?.options.length,
            onShowEffort,
            commands: available,
        });
        if (!handled) return false;
        setText("");
        setSlashIndex(0);
        return true;
    }, [reasoningEffort, onShowEffort, setText, available]);

    const slashQuery = text.match(/^\/(\S*)$/u)?.[1]?.toLowerCase();
    const slashMatches = slashQuery === undefined
        ? []
        : available.filter((command) => command.name.slice(1).startsWith(slashQuery));
    const slashSkillMatches = slashQuery === undefined
        ? []
        : skills.filter((skill) =>
              skill.name.toLowerCase().startsWith(slashQuery) &&
              !available.some((command) => command.name.slice(1) === skill.name.toLowerCase()),
          );
    const slashCandidateCount = slashMatches.length + slashSkillMatches.length;
    const skillMatch = text.match(/(?:^|\s)\$([^\s$]*)$/u);
    const skillQuery = skillMatch?.[1]?.toLowerCase();
    const skillMatches = skillQuery === undefined
        ? []
        : skills.filter((skill) => {
              const query = skillQuery.trim();
              return !query || skill.name.toLowerCase().includes(query) ||
                  skill.description.toLowerCase().includes(query) ||
                  skill.whenToUse?.toLowerCase().includes(query);
          });

    // Picking from the menu runs the command. A command that also takes free-form
    // input is still reachable with it: typing a space past the name closes the
    // menu, so the line is submitted as ordinary text and dispatched the same way.
    const chooseSlashCommand = useCallback((name: string): void => {
        executeSlashCommand(name);
        window.requestAnimationFrame(focusTextarea);
    }, [executeSlashCommand, focusTextarea]);

    /**
     * The two skill gestures differ in intent, so they differ in outcome.
     * `$name` mid-prompt is a reference: it completes into the draft, where the
     * rest of the sentence still has to be written. A leading `/name` is a
     * direct invocation and submits immediately, matching how the command menu
     * beside it behaves.
     */
    const chooseSkill = useCallback((name: string): void => {
        const match = text.match(/(?:^|\s)\$([^\s$]*)$/u);
        if (match && match.index !== undefined) {
            const dollarOffset = match[0].lastIndexOf("$");
            const start = match.index + dollarOffset;
            setText(`${text.slice(0, start)}/${name} `);
            setSlashIndex(0);
        } else if (/^\/\S*$/u.test(text)) {
            postAction({ type: "sendPrompt", text: `/${name}`, mode: "queue" });
            setText("");
            setSlashIndex(0);
        } else {
            return;
        }
        window.requestAnimationFrame(focusTextarea);
    }, [text, setText, focusTextarea]);

    const handleCompletionKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
        if (skillMatches.length) {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                setSlashIndex((current) => (current + 1) % skillMatches.length);
                return true;
            }
            if (event.key === "ArrowUp") {
                event.preventDefault();
                setSlashIndex((current) => (current - 1 + skillMatches.length) % skillMatches.length);
                return true;
            }
            if (event.key === "Tab" || event.key === "Enter") {
                event.preventDefault();
                chooseSkill(skillMatches[slashIndex]?.name ?? skillMatches[0].name);
                return true;
            }
        } else if (slashCandidateCount) {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                setSlashIndex((current) => (current + 1) % slashCandidateCount);
                return true;
            }
            if (event.key === "ArrowUp") {
                event.preventDefault();
                setSlashIndex((current) => (current - 1 + slashCandidateCount) % slashCandidateCount);
                return true;
            }
            if (event.key === "Tab" || event.key === "Enter") {
                event.preventDefault();
                const command = slashMatches[slashIndex];
                if (command) {
                    chooseSlashCommand(command.name);
                } else {
                    const skill = slashSkillMatches[slashIndex - slashMatches.length];
                    if (skill) chooseSkill(skill.name);
                }
                return true;
            }
        }
        return false;
    };

    return {
        slashIndex,
        resetSlashIndex,
        slashMatches,
        slashSkillMatches,
        skillMatches,
        slashCandidateCount,
        executeSlashCommand,
        chooseSlashCommand,
        chooseSkill,
        handleCompletionKeyDown,
    };
}
