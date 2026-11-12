import React from "react";
import type { HostScheduleView } from "../../../../src/hostSchedule";
import type { ChatViewState } from "../../../../src/types";
import { postAction } from "../../bridge";
import { t } from "../../i18n";

export function HostSchedulePanel({
    view,
    sessions,
}: {
    view: HostScheduleView;
    sessions: ChatViewState["sessions"];
}): React.JSX.Element {
    const { page, loading, pending } = view;
    return (
        <div className="dsh-schedule" aria-label={t("Host tasks")}>
            <div className="dsh-card-actions">
                <button
                    type="button"
                    className="dsh-button"
                    disabled={!view.canCreate || !!pending}
                    onClick={() => postAction({ type: "manageHostTask" })}
                >
                    {t("Create task")}
                </button>
                <button
                    type="button"
                    className="dsh-button dsh-button-secondary"
                    disabled={loading}
                    onClick={() => postAction({ type: "refreshHostTasks" })}
                >
                    {t("Refresh")}
                </button>
                <select
                    aria-label={t("Task status")}
                    value={view.active === undefined ? "all" : String(view.active)}
                    disabled={loading}
                    onChange={(event) =>
                        postAction({
                            type: "refreshHostTasks",
                            offset: 0,
                            active: event.target.value === "all" ? null : event.target.value === "true",
                        })
                    }
                >
                    <option value="all">{t("All tasks")}</option>
                    <option value="true">{t("Active")}</option>
                    <option value="false">{t("Paused and ended")}</option>
                </select>
            </div>
            <div className="dsh-card-detail">
                {t("Host-wide tasks · {count} total", { count: page.total })}
                {loading ? ` · ${t("Loading...")}` : ""}
            </div>
            {view.error ? (
                <div className="dsh-card-error" role="alert">
                    {view.error}
                </div>
            ) : null}
            <ul className="dsh-schedule-items">
                {page.items.map((item) => {
                    const targetId = item.target.kind !== "new" ? item.target.sessionId : undefined;
                    const target = targetId
                        ? (sessions.find((session) => session.sessionId === targetId)?.title ?? targetId)
                        : t(item.target.kind === "new" ? "New session per delivery" : "New session on first delivery");
                    return (
                        <li className="dsh-schedule-item" key={item.id}>
                            <div className="dsh-schedule-title">{item.title}</div>
                            <div className="dsh-schedule-prompt">{item.prompt}</div>
                            <div className="dsh-schedule-meta">
                                {t({ active: "Active", paused: "Paused", ended: "Ended" }[item.status])} · {item.kind} ·{" "}
                                {target}
                            </div>
                            <div className="dsh-card-detail">
                                {t(item.status === "active" ? "Next at {time}" : "Scheduled at {time}", { time: new Date(item.scheduledAt).toLocaleString() })}
                                {item.executionActive ? ` · ${t("Running")}` : ""}
                            </div>
                            {item.kind === "rrule" ? <pre>{item.rrule}</pre> : null}
                            <div className="dsh-card-actions">
                                <button
                                    type="button"
                                    className="dsh-button dsh-button-secondary"
                                    disabled={!!pending}
                                    onClick={() => postAction({ type: "manageHostTask", id: item.id })}
                                >
                                    {pending === item.id ? t("Working...") : t("Manage task")}
                                </button>
                                {targetId && sessions.some((session) => session.sessionId === targetId) ? (
                                    <button
                                        type="button"
                                        className="dsh-button dsh-button-secondary"
                                        onClick={() => postAction({ type: "switchSession", sessionId: targetId })}
                                    >
                                        {t("Open session")}
                                    </button>
                                ) : null}
                            </div>
                        </li>
                    );
                })}
            </ul>
            {!loading && !view.error && page.total === 0 ? <div className="dsh-card-detail">{t(view.active === undefined ? "No tasks yet." : "No matching tasks.")}</div> : null}
            <div className="dsh-card-actions">
                <button
                    type="button"
                    className="dsh-button dsh-button-secondary"
                    disabled={loading || page.offset === 0}
                    onClick={() =>
                        postAction({ type: "refreshHostTasks", offset: Math.max(0, page.offset - page.limit) })
                    }
                >
                    {t("Previous page")}
                </button>
                <button
                    type="button"
                    className="dsh-button dsh-button-secondary"
                    disabled={loading || page.offset + page.shown >= page.total}
                    onClick={() => postAction({ type: "refreshHostTasks", offset: page.offset + page.limit })}
                >
                    {t("Next page")}
                </button>
            </div>
        </div>
    );
}
