import React, { useEffect, useRef, useState } from "react";
import type { ChatViewState } from "../../../../src/types";
import { t } from "../../i18n";
import { ChangesPanel } from "./ChangesPanel";
import { GoalPanel } from "./GoalPanel";
import { JobsPanel } from "./JobsPanel";
import { PermissionsPanel } from "./PermissionsPanel";
import { QueuePanel } from "./QueuePanel";
import { SubagentsPanel } from "./SubagentsPanel";

type DockTab = "goal" | "queue" | "changes" | "subagents" | "jobs" | "permissions";

interface TabDef {
    id: DockTab;
    label: string;
    count?: number;
}

export function ActivityDock({ state }: { state: ChatViewState }): React.JSX.Element | null {
    const [active, setActive] = useState<DockTab | null>(null);
    const [collapsed, setCollapsed] = useState(true);
    const tabRefs = useRef(new Map<DockTab, HTMLButtonElement>());
    const agentPresetLabel = state.agentPresetLabel?.trim();
    const shortAgentPreset = agentPresetLabel ? Array.from(agentPresetLabel).slice(0, 4).join("") : undefined;

    const tabs: TabDef[] = [];
    if (state.goal) tabs.push({ id: "goal", label: "Goal" });
    if (state.queue.length) tabs.push({ id: "queue", label: t("Queue"), count: state.queue.length });
    if (state.changeReviews.length) {
        const count = state.changeReviews.reduce((total, review) => total + review.files.length, 0);
        tabs.push({ id: "changes", label: t("Changes"), count: count || undefined });
    }
    if (state.subagents && state.sessionId) {
        tabs.push({ id: "subagents", label: t("Subagents"), count: state.subagents.nodes.length || undefined });
    }
    if (state.jobs.length) tabs.push({ id: "jobs", label: "Jobs", count: state.jobs.length });
    if (state.permissions) tabs.push({ id: "permissions", label: t("Permissions") });

    const available = tabs.map((tab) => tab.id).join(",");
    useEffect(() => {
        if (active && !available.split(",").includes(active)) {
            setActive(null);
            setCollapsed(true);
        }
    }, [available, active]);

    if (!tabs.length) return null;
    // Keep one tab selected for the ARIA tab pattern even while the dock body
    // is collapsed. The selected panel remains in the DOM and is hidden until
    // the user opens a tab, so every aria-controls reference stays resolvable.
    const selectedTab = active && tabs.some((tab) => tab.id === active) ? active : tabs[0].id;

    const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
        let nextIndex: number | undefined;
        if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
        else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === "Home") nextIndex = 0;
        else if (event.key === "End") nextIndex = tabs.length - 1;
        if (nextIndex === undefined) return;
        event.preventDefault();
        const next = tabs[nextIndex];
        setActive(next.id);
        tabRefs.current.get(next.id)?.focus();
    };

    const preview = state.subagentPreview?.rootSessionId === state.sessionId ? state.subagentPreview : undefined;

    return (
        <div className="dsh-dock">
            <div
                className="dsh-dock-tabs"
                role="tablist"
                aria-label={t("Activity tabs")}
                aria-orientation="horizontal"
            >
                {tabs.map((tab, index) => (
                    <button
                        key={tab.id}
                        id={`dsh-dock-tab-${tab.id}`}
                        ref={(element) => {
                            if (element) tabRefs.current.set(tab.id, element);
                            else tabRefs.current.delete(tab.id);
                        }}
                        type="button"
                        role="tab"
                        aria-selected={selectedTab === tab.id}
                        aria-expanded={selectedTab === tab.id && !collapsed}
                        aria-controls={`dsh-dock-panel-${tab.id}`}
                        tabIndex={selectedTab === tab.id ? 0 : -1}
                        className={`dsh-dock-tab${selectedTab === tab.id && !collapsed ? " active" : ""}`}
                        onClick={() => {
                            if (selectedTab === tab.id && !collapsed) {
                                setCollapsed(true);
                            } else {
                                setActive(tab.id);
                                setCollapsed(false);
                            }
                        }}
                        onKeyDown={(event) => onTabKeyDown(event, index)}
                    >
                        {tab.label}
                        {tab.count !== undefined ? <span className="dsh-badge">{tab.count}</span> : null}
                    </button>
                ))}
                {shortAgentPreset ? (
                    <span
                        className="dsh-dock-preset"
                        title={agentPresetLabel}
                        aria-label={t("Current preset: {preset}", { preset: agentPresetLabel })}
                    >
                        {shortAgentPreset}
                    </span>
                ) : null}
            </div>
            {tabs.map((tab) => (
                <div
                    key={tab.id}
                    className="dsh-dock-panel"
                    role="tabpanel"
                    id={`dsh-dock-panel-${tab.id}`}
                    aria-labelledby={`dsh-dock-tab-${tab.id}`}
                    hidden={collapsed || selectedTab !== tab.id}
                >
                    {!collapsed && selectedTab === "goal" && tab.id === "goal" && state.goal ? <GoalPanel goal={state.goal} /> : null}
                    {!collapsed && selectedTab === "queue" && tab.id === "queue" ? <QueuePanel queue={state.queue} running={state.sessionStatus?.running === true} /> : null}
                    {!collapsed && selectedTab === "changes" && tab.id === "changes" ? <ChangesPanel reviews={state.changeReviews} running={state.sessionStatus?.running === true} /> : null}
                    {!collapsed && selectedTab === "subagents" && tab.id === "subagents" && state.subagents ? <SubagentsPanel tree={state.subagents} preview={preview} /> : null}
                    {!collapsed && selectedTab === "jobs" && tab.id === "jobs" ? <JobsPanel jobs={state.jobs} /> : null}
                    {!collapsed && selectedTab === "permissions" && tab.id === "permissions" && state.permissions ? <PermissionsPanel permissions={state.permissions} /> : null}
                </div>
            ))}
        </div>
    );
}
