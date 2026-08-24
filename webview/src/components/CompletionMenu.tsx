import React from "react";
import type { DshSkillEntry } from "../../../src/types";
import { t } from "../i18n";
import type { SlashCommand } from "./slashCommands";
import { SKILL_MENU_ID, SLASH_MENU_ID } from "./useSlashCompletion";

export function SlashCompletionMenu({
    commands,
    skills,
    activeIndex,
    onChooseCommand,
    onChooseSkill,
}: {
    commands: SlashCommand[];
    skills: DshSkillEntry[];
    activeIndex: number;
    onChooseCommand: (name: string) => void;
    onChooseSkill: (name: string) => void;
}): React.JSX.Element | null {
    if (commands.length + skills.length === 0) return null;
    return (
        <div className="dsh-slash-menu" role="listbox" aria-label={t("Slash commands")} id={SLASH_MENU_ID}>
            {commands.map((command, index) => (
                <button
                    type="button"
                    role="option"
                    id={`${SLASH_MENU_ID}-option-${index}`}
                    aria-selected={index === activeIndex}
                    className={index === activeIndex ? "active" : ""}
                    key={command.name}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onChooseCommand(command.name)}
                >
                    <strong>{command.name}</strong>
                    <span>{command.description}{command.hint ? ` · ${command.hint}` : ""}</span>
                </button>
            ))}
            {skills.map((skill, offset) => {
                const index = commands.length + offset;
                return (
                    <button
                        type="button"
                        role="option"
                        id={`${SLASH_MENU_ID}-option-${index}`}
                        aria-selected={index === activeIndex}
                        className={index === activeIndex ? "active" : ""}
                        key={`skill:${skill.name}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => onChooseSkill(skill.name)}
                    >
                        <strong>/{skill.name}</strong>
                        <span>{skill.whenToUse || skill.description}</span>
                    </button>
                );
            })}
        </div>
    );
}

export function SkillCompletionMenu({
    skills,
    activeIndex,
    onChooseSkill,
}: {
    skills: DshSkillEntry[];
    activeIndex: number;
    onChooseSkill: (name: string) => void;
}): React.JSX.Element | null {
    if (skills.length === 0) return null;
    return (
        <div className="dsh-slash-menu" role="listbox" aria-label={t("Skill candidates")} id={SKILL_MENU_ID}>
            {skills.map((skill, index) => (
                <button
                    type="button"
                    role="option"
                    id={`${SKILL_MENU_ID}-option-${index}`}
                    aria-selected={index === activeIndex}
                    className={index === activeIndex ? "active" : ""}
                    key={skill.name}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onChooseSkill(skill.name)}
                >
                    <strong>${skill.name}</strong>
                    <span>{skill.whenToUse || skill.description}</span>
                </button>
            ))}
        </div>
    );
}
