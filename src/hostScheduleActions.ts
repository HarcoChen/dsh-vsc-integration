import * as vscode from "vscode";
import type { DshRuntime } from "./dshRuntime";
import { isRecord } from "./guards";
import { t } from "./localize";
import { errorMessage } from "./errors";
import {
    normalizeHostTask,
    normalizeHostTaskPage,
    type HostTask,
    type HostTaskTarget,
    type HostTaskTiming,
    type HostScheduleView,
} from "./hostSchedule";

/** Host-wide tasks deliberately use no current-Session scope. Mutations use the Host's revision guard. */
export class HostScheduleController {
    private state: HostScheduleView = {
        page: { items: [], shown: 0, total: 0, limit: 100, offset: 0 },
        loading: false,
        canCreate: false,
    };
    private generation = 0;
    private endpoint?: string;
    private epoch = 0;
    public constructor(
        private readonly runtime: DshRuntime,
        private readonly changed: () => void
    ) {}
    public view(): HostScheduleView {
        return this.state;
    }
    public ensure(): void {
        if (this.endpoint !== this.runtime.getUrl()) void this.refresh(0);
    }
    public reset(): void {
        ++this.generation;
        ++this.epoch;
        this.endpoint = undefined;
        this.state = {
            ...this.state,
            page: { ...this.state.page, items: [], shown: 0, total: 0, offset: 0 },
            loading: false,
            pending: undefined,
            error: undefined,
            canCreate: false,
        };
    }
    public async refresh(
        offset = this.state.page.offset,
        active: boolean | null | undefined = this.state.active
    ): Promise<void> {
        const endpoint = this.runtime.getUrl();
        if (!endpoint) return;
        this.endpoint = endpoint;
        const generation = ++this.generation;
        this.state = {
            ...this.state,
            loading: true,
            error: undefined,
            canCreate: this.runtime.remoteAccess.allows("schedule/create"),
        };
        this.changed();
        try {
            const page = normalizeHostTaskPage(
                await this.runtime.hostScheduleCall("list", {
                    limit: 100,
                    offset,
                    ...(active == null ? {} : { active }),
                })
            );
            if (!page) throw new Error(t("The Runtime returned invalid task data."));
            if (generation !== this.generation || this.runtime.getUrl() !== endpoint) return;
            if (page.total > 0 && page.offset >= page.total) {
                await this.refresh(Math.floor((page.total - 1) / page.limit) * page.limit, active);
                return;
            }
            this.state = { ...this.state, page, active: active ?? undefined, loading: false };
        } catch (error) {
            if (generation !== this.generation || this.runtime.getUrl() !== endpoint) return;
            this.state = { ...this.state, loading: false, error: errorMessage(error) };
        }
        this.changed();
    }
    private assertEndpoint(endpoint: string, epoch = this.epoch): void {
        if (this.runtime.getUrl() !== endpoint || epoch !== this.epoch)
            throw new Error(t("The connected Runtime changed. Reopen task management."));
    }
    public async manage(id: string | undefined, sessionId: string | undefined): Promise<void> {
        if (this.state.pending) return;
        const endpoint = this.runtime.getUrl();
        if (!endpoint) return;
        const epoch = this.epoch;
        this.state = { ...this.state, pending: id ?? "create", error: undefined };
        this.changed();
        try {
            if (!id) {
                if (!this.runtime.remoteAccess.allows("schedule/create"))
                    throw new Error(t("This action is unavailable with your Runtime permissions."));
                const title = await this.input("Task title", "", 120);
                if (title === undefined) return;
                const prompt = await this.input("Task instructions", "", 100_000);
                if (prompt === undefined) return;
                const timing = await this.timing();
                if (!timing) return;
                const target = await this.target(sessionId);
                if (!target) return;
                this.assertEndpoint(endpoint, epoch);
                const created = normalizeHostTask(await this.runtime.hostScheduleCall("create", { title, prompt, timing, target }));
                if (!created) throw new Error(t("The Runtime returned invalid task data."));
            } else {
                const task = normalizeHostTask(await this.runtime.hostScheduleCall("view", { id }));
                if (!task) throw new Error(t("This task is no longer available."));
                this.assertEndpoint(endpoint, epoch);
                const choices = [
                    { label: t("Edit task"), action: "edit", endpoint: "schedule/edit" },
                    {
                        label: t(task.status === "active" ? "Pause task" : "Resume task"),
                        action: "toggle",
                        endpoint: "schedule/edit",
                    },
                    { label: t("Run task now"), action: "run", endpoint: "schedule/run" },
                    { label: t("Delivery history"), action: "history", endpoint: "schedule/history" },
                    { label: t("Delete task"), action: "delete", endpoint: "schedule/edit" },
                ].filter((choice) => this.runtime.remoteAccess.allows(choice.endpoint) &&
                    !(task.status === "ended" && choice.action === "toggle" && (task.kind === "at" || task.kind === "after")));
                const choice = await vscode.window.showQuickPick(choices, { title: task.title });
                if (!choice) return;
                if (choice.action === "history") {
                    await this.history(task, endpoint, epoch);
                    return;
                }
                let patch: Record<string, unknown> = {};
                if (choice.action === "edit") {
                    const title = await this.input("Task title", task.title, 120);
                    if (title === undefined) return;
                    const prompt = await this.input("Task instructions", task.prompt, 100_000);
                    if (prompt === undefined) return;
                    patch = { title, prompt };
                    const change = await vscode.window.showQuickPick(
                        ["Keep timing and destination", "Change timing", "Change destination"].map((key) => ({
                            label: t(key),
                            key,
                        })),
                        { title: t("Task options") }
                    );
                    if (!change) return;
                    if (change.key === "Change timing") {
                        const timing = await this.timing();
                        if (!timing) return;
                        patch.timing = timing;
                    }
                    if (change.key === "Change destination") {
                        const target = await this.target(sessionId);
                        if (!target) return;
                        patch.target = target;
                    }
                } else if (choice.action === "toggle") patch = { active: task.status !== "active" };
                if (choice.action === "delete") {
                    const confirm = t("Delete task");
                    if (
                        (await vscode.window.showWarningMessage(
                            t("Delete {title} and its saved deliveries?", { title: task.title }),
                            { modal: true },
                            confirm
                        )) !== confirm
                    )
                        return;
                }
                this.assertEndpoint(endpoint, epoch);
                const result =
                    choice.action === "run"
                        ? await this.runtime.hostScheduleCall("run", { id })
                        : await this.runtime.hostScheduleCall("edit", {
                              id,
                              action: choice.action === "delete" ? "delete" : "update",
                              ...(choice.action === "delete" ? {} : { patch }),
                              expectedUpdatedAt: task.updatedAt ?? null,
                          });
                if (isRecord(result) && typeof result.code === "string") {
                    throw new Error(
                        t(
                            result.code === "schedule_conflict"
                                ? "This task changed elsewhere. Refresh and try again."
                                : result.code === "schedule_execution_pending"
                                  ? "This task already has an execution pending."
                                  : "This task is no longer available."
                        )
                    );
                }
                if (!normalizeHostTask(result) && !(isRecord(result) && result.id === id && result.deleted === true)) {
                    throw new Error(t("The Runtime returned invalid task data."));
                }
            }
            this.assertEndpoint(endpoint, epoch);
            await this.refresh();
        } catch (error) {
            if (this.runtime.getUrl() === endpoint && this.epoch === epoch)
                this.state = { ...this.state, error: errorMessage(error) };
        } finally {
            if (this.epoch === epoch) {
                this.state = { ...this.state, pending: undefined };
                this.changed();
            }
        }
    }
    private async input(title: string, value: string, maximum: number): Promise<string | undefined> {
        const result = await vscode.window.showInputBox({
            title: t(title),
            value,
            ignoreFocusOut: true,
            validateInput: (input) =>
                !input.trim() || input.trim().length > maximum
                    ? t("Enter a non-empty value up to {count} characters.", { count: maximum })
                    : undefined,
        });
        return result?.trim();
    }
    private async timing(): Promise<HostTaskTiming | undefined> {
        const selected = await vscode.window.showQuickPick(
            ["after", "at", "every", "daily", "weekly", "cron", "rrule"].map((kind) => ({
                label: t(
                    {
                        after: "After a delay",
                        at: "At a date and time",
                        every: "Repeat at an interval",
                        daily: "Daily",
                        weekly: "Weekly",
                        cron: "Cron expression",
                        rrule: "Calendar recurrence (RRULE)",
                    }[kind]!
                ),
                rule: kind,
            })),
            { title: t("Task timing") }
        );
        if (!selected) return undefined;
        if (selected.rule === "after" || selected.rule === "every") {
            const seconds = await vscode.window.showInputBox({
                title: t("Interval in seconds"),
                value: "3600",
                ignoreFocusOut: true,
                validateInput: (value) =>
                    !Number.isSafeInteger(Number(value)) || Number(value) < (selected.rule === "after" ? 1 : 60)
                        ? t("Enter a valid interval in seconds.")
                        : undefined,
            });
            if (seconds === undefined) return undefined;
            return selected.rule === "after"
                ? { kind: "after", after_seconds: Number(seconds) }
                : { kind: "every", every_seconds: Number(seconds) };
        }
        if (selected.rule === "at") {
            const value = await vscode.window.showInputBox({
                title: t("Future date and time with UTC offset"),
                placeHolder: "2026-12-01T09:00:00+08:00",
                ignoreFocusOut: true,
                validateInput: (input) =>
                    !/(Z|[+-]\d{2}:\d{2})$/u.test(input) ||
                    !Number.isFinite(Date.parse(input)) ||
                    Date.parse(input) <= Date.now()
                        ? t("Enter a future ISO date with a UTC offset.")
                        : undefined,
            });
            return value === undefined ? undefined : { kind: "at", at: new Date(value).toISOString() };
        }
        if (selected.rule === "rrule") {
            const rrule = await this.input("DTSTART and RRULE (use \\n between lines)", "", 4096);
            return rrule === undefined ? undefined : { kind: "rrule", rrule: rrule.replace(/\\n/gu, "\n") };
        }
        const value = await this.input(
            selected.rule === "daily" || selected.rule === "weekly" ? "Local time (HH:mm:ss)" : "Five-field cron expression",
            selected.rule === "daily" || selected.rule === "weekly" ? "09:00:00" : "0 9 * * *",
            256
        );
        if (value === undefined) return undefined;
        const zone = await this.input("IANA time zone", Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", 128);
        if (!zone) return undefined;
        if (selected.rule === "weekly") {
            const days = await vscode.window.showQuickPick(Array.from({ length: 7 }, (_, index) => ({
                label: new Intl.DateTimeFormat(undefined, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, index + 1))),
                day: index + 1,
            })), { title: t("Choose weekdays"), canPickMany: true });
            if (!days?.length) return undefined;
            return { kind: "weekly", weekly: { time: value, time_zone: zone, weekdays: days.map(day => day.day).sort((a, b) => a - b) } };
        }
        return selected.rule === "daily"
            ? { kind: "daily", daily: { time: value, time_zone: zone } }
            : { kind: "cron", cron: { expression: value, time_zone: zone } };
    }
    private async target(currentId: string | undefined): Promise<HostTaskTarget | undefined> {
        const catalog = this.runtime.getSessionCatalog().snapshot();
        const archived = new Set(catalog.archivedSessionIds);
        const workspace = catalog.workspaces.find(item => currentId && item.sessionIds.includes(currentId));
        const create = workspace ? { cwd: workspace.path } : undefined;
        const choices = [
            { label: t("Create one session and reuse it"), description: workspace?.title,
                target: { kind: "new_once" as const, ...(create ? { create } : {}) } },
            { label: t("Create a new session for every delivery"), description: workspace?.title,
                target: { kind: "new" as const, ...(create ? { create } : {}) } },
            ...catalog.sessions
                .filter((item) => item.origin !== "subagent" && !archived.has(item.sessionId))
                .map((item) => ({
                    label: `${item.sessionId === currentId ? "$(check) " : ""}${item.title || item.sessionId}`,
                    description: item.cwd,
                    target: { kind: "session" as const, sessionId: item.sessionId },
                })),
        ];
        return (await vscode.window.showQuickPick(choices, { title: t("Task destination"), matchOnDescription: true }))
            ?.target;
    }
    private async history(task: HostTask, endpoint: string, epoch: number): Promise<void> {
        const sections = [`# ${task.title}\n`];
        let before: string | undefined;
        const cursors = new Set<string>();
        for (;;) {
            this.assertEndpoint(endpoint, epoch);
            const page = await this.runtime.hostScheduleCall("history", {
                id: task.id,
                limit: 100,
                ...(before ? { before } : {}),
            });
            this.assertEndpoint(endpoint, epoch);
            if (!isRecord(page) || !Array.isArray(page.records))
                throw new Error(t("The Runtime returned invalid delivery history."));
            for (const record of page.records)
                if (isRecord(record))
                    sections.push(
                        `## ${String(record.deliveredAt)}\n\n${String(record.prompt ?? "")}\n\nSession: ${String(record.targetSessionId ?? "")}\n`
                    );
            if (page.earlierRecordsUnavailable || page.earlierRecordsPruned)
                sections.push(t("Earlier deliveries may be unavailable or pruned."));
            if (typeof page.nextBefore !== "string") break;
            if (cursors.has(page.nextBefore)) throw new Error(t("The Runtime returned invalid delivery history."));
            cursors.add(page.nextBefore);
            const more = t("Load more");
            if (
                (await vscode.window.showQuickPick([more, t("Open history")], { title: t("Delivery history") })) !==
                more
            )
                break;
            before = page.nextBefore;
        }
        this.assertEndpoint(endpoint, epoch);
        await vscode.window.showTextDocument(
            await vscode.workspace.openTextDocument({ language: "markdown", content: sections.join("\n") }),
            { preview: true }
        );
    }
}
