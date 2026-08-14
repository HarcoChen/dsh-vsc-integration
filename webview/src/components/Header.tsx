import React, { useEffect, useRef, useState } from "react";
import type { ChatViewState } from "../../../src/types";
import type { ChatViewAction } from "../../../src/chatViewProtocol";
import { postAction } from "../bridge";
import { statusLabel, TURN_LABELS } from "../state";
import { CheckIcon, MoreIcon, PlusIcon, SearchIcon } from "./icons";

interface HeaderProps {
    state: ChatViewState;
}

interface MenuItem {
    key: string;
    label: string;
    action: ChatViewAction;
    disabled?: boolean;
    active?: boolean;
    separatorBefore?: boolean;
}

export function Header({ state }: HeaderProps): React.JSX.Element {
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!menuOpen) return;
        const onPointerDown = (event: MouseEvent): void => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setMenuOpen(false);
            }
        };
        const onEscape = (event: KeyboardEvent): void => {
            if (event.key === "Escape") setMenuOpen(false);
        };
        document.addEventListener("mousedown", onPointerDown);
        document.addEventListener("keydown", onEscape);
        return () => {
            document.removeEventListener("mousedown", onPointerDown);
            document.removeEventListener("keydown", onEscape);
        };
    }, [menuOpen]);

    const status = state.status;
    const sessionStatus = state.sessionStatus;
    const turn = sessionStatus?.turn;
    const dotClass = sessionStatus?.error
        ? "error"
        : sessionStatus?.attention
          ? "starting"
          : status.state;
    const label =
        (turn && TURN_LABELS[turn.phase]) ||
        (sessionStatus?.error ? "会话错误" : statusLabel(status));
    const statusTitle =
        (turn && Number.isSafeInteger(turn.turn) ? `Turn ${turn.turn}` : "") +
        (turn?.detail ? ` · ${turn.detail}` : "");

    const sessions = state.sessions;
    const hasSession = Boolean(state.sessionId);
    const runtimeRunning = status.state === "running" || status.state === "starting";

    const menuItems: MenuItem[] = [
        { key: "rename", label: "重命名会话", action: { type: "renameSession" }, disabled: !hasSession },
        { key: "fork", label: "Fork 会话", action: { type: "forkSession" }, disabled: !hasSession },
        { key: "archive", label: "归档会话", action: { type: "archiveSession" }, disabled: !hasSession },
        { key: "trace", label: "打开会话 Trace", action: { type: "openTrace" }, disabled: !hasSession },
        {
            key: "runtime",
            label: runtimeRunning ? "停止运行时" : "启动运行时",
            action: { type: runtimeRunning ? "stop" : "start" },
            disabled: status.state === "starting",
            separatorBefore: true,
        },
        { key: "logs", label: "打开运行日志", action: { type: "openLogs" } },
        { key: "browser", label: "在浏览器中打开", action: { type: "openBrowser" } },
        { key: "key", label: "配置 API Key", action: { type: "configureApiKey" }, separatorBefore: true },
        {
            key: "focus",
            label: state.focusMode ? "Focus 模式：开" : "Focus 模式：关",
            action: { type: "toggleFocus" },
            active: state.focusMode,
        },
    ];

    return (
        <header className="dsh-header">
            <div className="dsh-status" title={statusTitle || undefined}>
                <span className={`dsh-dot ${dotClass}`} />
                <span className={`dsh-status-label${turn ? ` dsh-turn-${turn.phase}` : ""}`}>
                    {label}
                </span>
            </div>
            <select
                className="dsh-session-select"
                title="切换会话"
                value={state.sessionId ?? ""}
                disabled={sessions.length === 0}
                onChange={(event) => {
                    if (event.target.value) {
                        postAction({ type: "switchSession", sessionId: event.target.value });
                    }
                }}
            >
                {sessions.length === 0 ? (
                    <option value="">暂无会话</option>
                ) : (
                    sessions.map((session) => (
                        <option key={session.sessionId} value={session.sessionId}>
                            {session.attention ? "● " : session.running ? "▶ " : ""}
                            {session.title}
                        </option>
                    ))
                )}
            </select>
            <button
                type="button"
                className="dsh-icon-button"
                title="新建会话"
                onClick={() => postAction({ type: "newSession" })}
            >
                <PlusIcon />
            </button>
            <button
                type="button"
                className="dsh-icon-button"
                title="搜索会话"
                onClick={() => postAction({ type: "searchSession" })}
            >
                <SearchIcon />
            </button>
            <div className="dsh-menu-anchor" ref={menuRef}>
                <button
                    type="button"
                    className={`dsh-icon-button${menuOpen ? " active" : ""}`}
                    title="更多操作"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    onClick={() => setMenuOpen((open) => !open)}
                >
                    <MoreIcon />
                </button>
                {menuOpen ? (
                    <div className="dsh-menu" role="menu">
                        {menuItems.map((item) => (
                            <React.Fragment key={item.key}>
                                {item.separatorBefore ? <div className="dsh-menu-separator" /> : null}
                                <button
                                    type="button"
                                    role="menuitem"
                                    className={`dsh-menu-item${item.active ? " active" : ""}`}
                                    disabled={item.disabled}
                                    onClick={() => {
                                        setMenuOpen(false);
                                        postAction(item.action);
                                    }}
                                >
                                    <span className="dsh-menu-check">
                                        {item.active ? <CheckIcon /> : null}
                                    </span>
                                    {item.label}
                                </button>
                            </React.Fragment>
                        ))}
                    </div>
                ) : null}
            </div>
        </header>
    );
}
