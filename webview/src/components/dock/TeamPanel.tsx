import React, { useState } from "react";
import type { DshTeamProjection } from "../../../../src/agentTeamTypes";
import type { SubagentHistoryPreview, SubagentTreeView } from "../../../../src/types";
import { SubagentPreviewCard } from "./SubagentsPanel";
import { postAction } from "../../bridge";
import { t } from "../../i18n";

export function TeamPanel({ team, currentSessionId, preview, subagents, autoOpenReasoning }: {
    team: DshTeamProjection; currentSessionId?: string; preview?: SubagentHistoryPreview; subagents?: SubagentTreeView; autoOpenReasoning?: boolean;
}): React.JSX.Element {
    const [filter, setFilter] = useState("all");
    const tasks = team.tasks.filter(task => filter === "all" || task.status === filter);
    return (
        <div className="dsh-team-panel">
            {team.failure ? <div className="dsh-card-error">{team.failure}</div> : null}
            <section>
                <div className="dsh-card-detail">{t("Members")}</div>
                <ul className="dsh-team-members">
                    {team.members.map((member) => (
                        <li key={member.id}>
                            <button
                                type="button"
                                className="dsh-button dsh-button-secondary"
                                disabled={member.id === currentSessionId || member.phase !== "active"}
                                onClick={() => postAction({ type: "openTeamMember", memberId: member.id })}
                            >
                                {member.name} · {t(({ running: "Running", inactive: "Inactive", active: "Ready", provisioning: "Provisioning", failed: "Failed" })[subagents?.nodes.find(node => node.id === member.id)?.activity ?? member.phase])}
                            </button>
                            {member.error ? <small className="dsh-card-error">{member.error}</small> : null}
                        </li>
                    ))}
                </ul>
            </section>
            <section>
                <div className="dsh-card-detail">{t("Tasks")}</div>
                <select className="dsh-dock-input" aria-label={t("Filter team tasks")} value={filter} onChange={event => setFilter(event.target.value)}>
                    <option value="all">{t("All tasks")}</option>
                    <option value="pending">{t("Pending")}</option>
                    <option value="in_progress">{t("In progress")}</option>
                    <option value="completed">{t("Completed")}</option>
                </select>
                {team.tasks.length === 0 ? <div className="dsh-settings-empty">{t("No team tasks yet.")}</div> : (
                    <ul className="dsh-team-tasks">
                        {tasks.map((task) => (
                            <li key={task.id} className={`dsh-team-task dsh-team-task-${task.status}`}>
                                <strong>{task.subject}</strong>
                                <span>{task.id} · {t(({pending: "Pending", in_progress: "In progress", completed: "Completed", deleted: "Deleted"})[task.status])}{task.ownerName ? ` · ${task.ownerName}` : ""}</span>
                                {task.description ? <small>{task.description}</small> : null}
                                {!task.ready && task.blockedBy.length > 0 ? <small>{t("Blocked by {tasks}", { tasks: task.blockedBy.join(", ") })}</small> : null}
                                {task.writeScopes.length > 0 ? <small>{t("Write scopes")}: {task.writeScopes.join(", ")}</small> : null}
                                {task.writeScopeWarnings.length > 0 ? <small className="dsh-card-error">{task.writeScopeWarnings.join(" · ")}</small> : null}
                            </li>
                        ))}
                    </ul>
                )}
            </section>
            {preview ? <SubagentPreviewCard preview={preview} now={Date.now()} autoOpenReasoning={autoOpenReasoning} /> : null}
        </div>
    );
}
