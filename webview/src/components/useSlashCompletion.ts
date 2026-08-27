import { useCallback, useMemo, useState } from "react";
import type React from "react";
import type { ChatViewState, DshCommandDescriptor, DshSkillEntry } from "../../../src/types";
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

    const chooseSlashCommand = useCallback((name: string): void => {
        // A command that declares free-form input is completed into the draft
        // instead of run, so the user can supply that input before submitting.
        const command = available.find((candidate) => candidate.name === name);
        if (command?.takesInput) {
            setText(`${command.name} `);
            setSlashIndex(0);
        } else {
            executeSlashCommand(name);
        }
        window.requestAnimationFrame(focusTextarea);
    }, [available, executeSlashCommand, setText, focusTextarea]);

    const chooseSkill = useCallback((name: string): void => {
        const match = text.match(/(?:^|\s)\$([^\s$]*)$/u);
        if (match && match.index !== undefined) {
            const dollarOffset = match[0].lastIndexOf("$");
            const start = match.index + dollarOffset;
            setText(`${text.slice(0, start)}/${name} `);
        } else if (/^\/\S*$/u.test(text)) {
            setText(`/${name} `);
        } else {
            return;
        }
        setSlashIndex(0);
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
