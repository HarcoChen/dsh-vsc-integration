import React, { useState } from "react";
import type { DshTodoItemView } from "../../../src/types";
import { t } from "../i18n";

function progressLabel(todos: readonly DshTodoItemView[]): string {
    const done = todos.filter((item) => item.status === "completed").length;
    const active = todos.filter((item) => item.status === "in_progress").length;
    const pending = todos.length - done - active;
    return [
        done > 0 ? t("{count} completed", { count: done }) : "",
        active > 0 ? t("{count} in progress", { count: active }) : "",
        pending > 0 ? t("{count} pending", { count: pending }) : "",
    ].filter(Boolean).join(" · ");
}

export function TodoPanel({ todos }: { todos: readonly DshTodoItemView[] }): React.JSX.Element | null {
    const [collapsed, setCollapsed] = useState(true);
    if (todos.length === 0) return null;
    return (
        <section className="dsh-todo-panel" aria-label={t("Todo list")}>
            <button
                type="button"
                className="dsh-todo-header"
                aria-expanded={!collapsed}
                onClick={() => setCollapsed((value) => !value)}
            >
                <span className="dsh-todo-lead" aria-hidden="true" />
                <span className="dsh-todo-title">{t("Todo list")}</span>
                <span className="dsh-todo-progress">{progressLabel(todos)}</span>
                <span
                    className={`dsh-todo-chevron ${collapsed ? "collapsed" : "expanded"}`}
                    aria-hidden="true"
                />
            </button>
            {!collapsed ? (
                <ul className="dsh-todo-items">
                    {/* DshTodoItemView carries no id, and the host does not guarantee
                        distinct content, so position is the only stable identity here.
                        The list is a wholesale-replaced projection with no per-row state,
                        which is what makes an index key safe. */}
                    {todos.map((item, position) => (
                        <li key={position} className={`dsh-todo-item ${item.status}`}>
                            <span className="dsh-todo-status" aria-hidden="true" />
                            <span className="dsh-todo-content">{item.content}</span>
                        </li>
                    ))}
                </ul>
            ) : null}
        </section>
    );
}
