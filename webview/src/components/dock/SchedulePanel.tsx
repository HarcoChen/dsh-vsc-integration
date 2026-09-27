import React, { useState } from "react";
import type { ChatViewState, DshScheduleItem } from "../../../../src/types";
import { postAction } from "../../bridge";
import { t } from "../../i18n";

function formatInterval(seconds: number): string {
    let remaining = seconds;
    const days = Math.floor(remaining / 86_400);
    remaining %= 86_400;
    const hours = Math.floor(remaining / 3_600);
    remaining %= 3_600;
    const minutes = Math.floor(remaining / 60);
    const values = [
        days > 0 ? `${days}d` : "",
        hours > 0 ? `${hours}h` : "",
        minutes > 0 ? `${minutes}m` : "",
        remaining % 60 > 0 || (days === 0 && hours === 0 && minutes === 0) ? `${remaining % 60}s` : "",
    ].filter(Boolean);
    return values.join(" ");
}

function formatScheduledAt(value: string): string {
    const date = new Date(value);
    if (!Number.isFinite(date.valueOf())) return value;
    try {
        return new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
        }).format(date);
    } catch {
        return value;
    }
}

function formatLocalTime(value: string): string {
    const [clock, milliseconds] = value.split(".");
    const [hours, minutes, seconds] = clock.split(":");
    if (seconds === "00" && milliseconds === "000") return `${hours}:${minutes}`;
    if (milliseconds === "000") return `${hours}:${minutes}:${seconds}`;
    return value;
}

function formatWeekday(day: number): string {
    const date = new Date(Date.UTC(2024, 0, day));
    try {
        return new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" }).format(date);
    } catch {
        return String(day);
    }
}

function ruleLabel(item: DshScheduleItem): string {
    if (item.kind === "after") return t("After {duration}", { duration: formatInterval(item.afterSeconds) });
    if (item.kind === "every") return t("Every {duration}", { duration: formatInterval(item.everySeconds) });
    if (item.kind === "daily") {
        return t("Daily at {time} ({timeZone})", {
            time: formatLocalTime(item.time),
            timeZone: item.timeZone,
        });
    }
    if (item.kind === "weekly") {
        return t("Weekly on {days} at {time} ({timeZone})", {
            days: item.weekdays.map(formatWeekday).join(", "),
            time: formatLocalTime(item.time),
            timeZone: item.timeZone,
        });
    }
    if (item.kind === "cron") {
        return t("Cron {expression} ({timeZone})", {
            expression: item.expression,
            timeZone: item.timeZone,
        });
    }
    return t("One-time");
}

export function SchedulePanel({
    schedule,
    managementAvailable,
    mutationPendingId,
    history,
}: {
    schedule: NonNullable<ChatViewState["schedule"]>;
    managementAvailable: boolean;
    mutationPendingId?: string;
    history?: ChatViewState["scheduleHistory"];
}): React.JSX.Element {
    const [editingId, setEditingId] = useState<string>();
    const [confirmingDeleteId, setConfirmingDeleteId] = useState<string>();
    const [expandedHistoryId, setExpandedHistoryId] = useState<string>();
    const [draftTitle, setDraftTitle] = useState("");
    const [draftPrompt, setDraftPrompt] = useState("");

    return (
        <div className="dsh-schedule" aria-label={t("Active reminders")}>
            <div className="dsh-card-detail">
                {managementAvailable ? t("Active reminders · managed by this session") : t("Active reminders · read-only")}
            </div>
            <ul className="dsh-schedule-items" tabIndex={0}>
                {schedule.map((item) => (
                    <li className="dsh-schedule-item" key={item.id}>
                        {item.title ? <div className="dsh-schedule-title">{item.title}</div> : null}
                        <div className="dsh-schedule-prompt">{item.prompt}</div>
                        <div className="dsh-schedule-meta">
                            <span>{ruleLabel(item)}</span>
                            <span aria-hidden="true"> · </span>
                            <time dateTime={item.scheduledAt} title={item.scheduledAt}>
                                {t("Next at {time}", { time: formatScheduledAt(item.scheduledAt) })}
                            </time>
                        </div>
                        <div className="dsh-schedule-id">{t("ID {id}", { id: item.id })}</div>
                        {managementAvailable ? (
                            <div className="dsh-schedule-actions">
                                {editingId === item.id ? (
                                    <div className="dsh-schedule-form">
                                        <label>
                                            {t("Reminder title")}
                                            <input
                                                aria-label={t("Reminder title")}
                                                maxLength={120}
                                                value={draftTitle}
                                                onChange={(event) => setDraftTitle(event.target.value)}
                                            />
                                        </label>
                                        <label>
                                            {t("Reminder instructions")}
                                            <textarea
                                                aria-label={t("Reminder instructions")}
                                                rows={3}
                                                maxLength={32_768}
                                                value={draftPrompt}
                                                onChange={(event) => setDraftPrompt(event.target.value)}
                                            />
                                        </label>
                                        <button
                                            type="button"
                                            className="dsh-button"
                                            disabled={mutationPendingId !== undefined || !draftTitle.trim() || !draftPrompt.trim()}
                                            onClick={() => {
                                                postAction({
                                                    type: "editScheduleContent",
                                                    scheduleId: item.id,
                                                    title: draftTitle,
                                                    prompt: draftPrompt,
                                                });
                                                setEditingId(undefined);
                                            }}
                                        >
                                            {mutationPendingId === item.id ? t("Saving…") : t("Save")}
                                        </button>
                                        <button type="button" className="dsh-button dsh-button-secondary" onClick={() => setEditingId(undefined)}>
                                            {t("Cancel")}
                                        </button>
                                    </div>
                                ) : (
                                    <>
                                        {item.title ? (
                                            <button
                                                type="button"
                                                className="dsh-button dsh-button-secondary"
                                                disabled={mutationPendingId !== undefined}
                                                onClick={() => {
                                                    setEditingId(item.id);
                                                    setDraftTitle(item.title ?? "");
                                                    setDraftPrompt(item.prompt);
                                                    setConfirmingDeleteId(undefined);
                                                }}
                                            >
                                                {t("Edit")}
                                            </button>
                                        ) : null}
                                        <button
                                            type="button"
                                            className="dsh-button dsh-button-secondary"
                                            disabled={mutationPendingId !== undefined}
                                            onClick={() => {
                                                setExpandedHistoryId((current) => current === item.id ? undefined : item.id);
                                                if (expandedHistoryId !== item.id) {
                                                    postAction({ type: "loadScheduleHistory", scheduleId: item.id });
                                                }
                                            }}
                                        >
                                            {expandedHistoryId === item.id ? t("Hide history") : t("Delivery history")}
                                        </button>
                                        {confirmingDeleteId === item.id ? (
                                            <>
                                                <span className="dsh-schedule-confirm" role="status">
                                                    {t("Remove {title} and its saved delivery history?", { title: item.title || item.id })}
                                                </span>
                                                <button
                                                    type="button"
                                                    className="dsh-button danger"
                                                    disabled={mutationPendingId !== undefined}
                                                    onClick={() => {
                                                        postAction({ type: "deleteSchedule", scheduleId: item.id });
                                                        setConfirmingDeleteId(undefined);
                                                    }}
                                                >
                                                    {mutationPendingId === item.id ? t("Removing…") : t("Confirm")}
                                                </button>
                                                <button type="button" className="dsh-button dsh-button-secondary" onClick={() => setConfirmingDeleteId(undefined)}>
                                                    {t("Cancel")}
                                                </button>
                                            </>
                                        ) : (
                                            <button
                                                type="button"
                                                className="dsh-button dsh-button-secondary"
                                                disabled={mutationPendingId !== undefined}
                                                onClick={() => {
                                                    setConfirmingDeleteId(item.id);
                                                    setEditingId(undefined);
                                                }}
                                            >
                                                {t("Remove reminder")}
                                            </button>
                                        )}
                                    </>
                                )}
                            </div>
                        ) : null}
                        {managementAvailable && expandedHistoryId === item.id ? (
                            <div className="dsh-schedule-history">
                                {history?.id === item.id && history.loading && history.records.length === 0
                                    ? <div className="dsh-card-detail">{t("Loading history...")}</div>
                                    : null}
                                {history?.id === item.id && history.error
                                    ? <div className="dsh-card-error">{history.error}</div>
                                    : null}
                                {history?.id === item.id && history.earlierRecordsUnavailable
                                    ? <div className="dsh-card-detail">{t("Some earlier delivery records are unavailable.")}</div>
                                    : null}
                                {history?.id === item.id && history.earlierRecordsPruned
                                    ? <div className="dsh-card-detail">{t("Some older delivery records were removed by retention limits.")}</div>
                                    : null}
                                {history?.id === item.id && history.records.map((record) => (
                                    <div className="dsh-schedule-delivery" key={`${record.messageId}:${record.scheduledAt}`}>
                                        <div>{t("Delivered {time}", { time: formatScheduledAt(record.deliveredAt) })}</div>
                                        <div>{t("Scheduled for {time}", { time: formatScheduledAt(record.scheduledAt) })}</div>
                                        {record.prompt ? <div className="dsh-schedule-prompt">{record.prompt}</div> : null}
                                        <div className="dsh-schedule-id">{t("Message {id}", { id: record.messageId })}</div>
                                    </div>
                                ))}
                                {history?.id === item.id && !history.loading && !history.error && history.records.length === 0
                                    ? <div className="dsh-card-detail">{t("No saved deliveries.")}</div>
                                    : null}
                                {history?.id === item.id && history.nextBefore ? (
                                    <button
                                        type="button"
                                        className="dsh-button dsh-button-secondary"
                                        disabled={history.loading}
                                        onClick={() => postAction({
                                            type: "loadScheduleHistory",
                                            scheduleId: item.id,
                                            before: history.nextBefore,
                                        })}
                                    >
                                        {history.loading ? t("Loading…") : t("Load earlier deliveries")}
                                    </button>
                                ) : null}
                            </div>
                        ) : null}
                    </li>
                ))}
            </ul>
        </div>
    );
}
