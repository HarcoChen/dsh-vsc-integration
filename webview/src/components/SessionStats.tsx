import React from "react";
import type { ChatViewState } from "../../../src/types";
import { t } from "../i18n";

function formatStatsDuration(milliseconds: number): string {
    const totalSeconds = Math.round(Math.max(0, milliseconds) / 1_000);
    if (totalSeconds < 60) return `${totalSeconds}s`;
    return `${Math.floor(totalSeconds / 60)}m${totalSeconds % 60}s`;
}

function formatStatsThroughput(tokensPerSecond: number): string {
    const value = Math.max(0, tokensPerSecond);
    return value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}

function sessionStatsGroups(state: ChatViewState): string[] {
    const stats = state.sessionStats;
    if (!stats || stats.steps <= 0) return [];
    const groups = [`${stats.turns} ${t("turns")} · ${stats.steps} ${t("steps")}`];
    const durations = [
        stats.llmMs > 0 ? `${t("LLM")} ${formatStatsDuration(stats.llmMs)}` : "",
        stats.toolMs > 0 ? `${t("Tool call")} ${formatStatsDuration(stats.toolMs)}` : "",
    ].filter(Boolean);
    if (durations.length > 0) groups.push(durations.join(" · "));
    const speeds = [
        stats.ttftSteps > 0 ? `${t("Average first token")} ${formatStatsDuration(stats.ttftMs / stats.ttftSteps)}` : "",
        stats.decodeMs > 0 ? `${formatStatsThroughput(stats.decodeTokens / (stats.decodeMs / 1_000))} tok/s` : "",
    ].filter(Boolean);
    if (speeds.length > 0) groups.push(speeds.join(" · "));
    return groups;
}

export function SessionStats({ state }: { state: ChatViewState }): React.JSX.Element | null {
    const groups = sessionStatsGroups(state);
    if (groups.length === 0) return null;
    return (
        <div className="dsh-stats" aria-label={t("Session statistics")}>
            <div className="dsh-stats-top">
                {groups.slice(0, 2).map((group, index) => (
                    <React.Fragment key={group}>
                        {index > 0 ? <span className="dsh-stats-separator" aria-hidden="true">|</span> : null}
                        <span>{group}</span>
                    </React.Fragment>
                ))}
            </div>
            {groups[2] ? <div className="dsh-stats-bottom">{groups[2]}</div> : null}
        </div>
    );
}
