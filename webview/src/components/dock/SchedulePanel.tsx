import React from "react";
import type { ChatViewState, DshScheduleItem } from "../../../../src/types";
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

export function SchedulePanel({ schedule }: { schedule: NonNullable<ChatViewState["schedule"]> }): React.JSX.Element {
    return (
        <div className="dsh-schedule" aria-label={t("Active reminders")}>
            <div className="dsh-card-detail">{t("Active reminders · read-only")}</div>
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
                    </li>
                ))}
            </ul>
        </div>
    );
}
