import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ChatViewState } from "../../../src/types";
import { postAction, registerInsertTextHandler } from "../bridge";
import { CloseIcon, EyeIcon, EyeOffIcon, PlusIcon, SendIcon, StopIcon } from "./icons";

const MIN_HEIGHT = 68;
const MAX_HEIGHT = 180;

interface ComposerProps {
    state: ChatViewState;
}

export function Composer({ state }: ComposerProps): React.JSX.Element {
    const [text, setText] = useState("");
    const [promptMode, setPromptMode] = useState<"queue" | "steer">("queue");
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Legacy behavior: the queue/steer choice resets to queue once the session is idle.
    useEffect(() => {
        if (!state.busy) setPromptMode("queue");
    }, [state.busy]);

    const autoGrow = useCallback((): void => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, textarea.scrollHeight))}px`;
    }, []);

    useEffect(() => {
        autoGrow();
    }, [text, autoGrow]);

    // Host-initiated insertion (dsh.insertEditorReference): insert at the caret,
    // separated by a space when the preceding char is not whitespace, then focus.
    useEffect(() => {
        registerInsertTextHandler((insertion) => {
            const textarea = textareaRef.current;
            if (!textarea) return;
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const before = textarea.value.slice(0, start);
            const separator = before && !/\s$/.test(before) ? " " : "";
            const next = before + separator + insertion + textarea.value.slice(end);
            setText(next);
            const cursor = start + separator.length + insertion.length;
            window.requestAnimationFrame(() => {
                textarea.setSelectionRange(cursor, cursor);
                textarea.focus();
            });
        });
        return () => registerInsertTextHandler(undefined);
    }, []);

    const send = useCallback((): void => {
        if (state.submitting) return;
        const value = textareaRef.current?.value ?? text;
        if (!value.trim()) return;
        postAction({
            type: "sendPrompt",
            text: value,
            mode: state.busy ? promptMode : "queue",
        });
        setText("");
    }, [state.busy, state.submitting, promptMode, text]);

    const selection = state.selection;
    const selectionRange = selection?.range;
    const selectionLines = selectionRange
        ? Math.max(1, selectionRange.endLine - selectionRange.startLine + 1)
        : 0;

    const sendLabel = state.busy ? (promptMode === "steer" ? "转向" : "排队") : "发送";

    return (
        <div className="dsh-composer">
            {selection || state.context.length ? (
                <div className="dsh-context-items">
                    {selection ? (
                        <div
                            className={`dsh-chip${state.selectionEnabled ? "" : " dsh-chip-disabled"}`}
                            title="发送时重新读取当前选区"
                        >
                            <span className="dsh-chip-label">
                                Selection · {selection.label} · {selectionLines} lines
                            </span>
                            <button
                                type="button"
                                className="dsh-chip-button"
                                title="启用或关闭自动选区"
                                onClick={() => postAction({ type: "toggleSelection" })}
                            >
                                {state.selectionEnabled ? <EyeIcon /> : <EyeOffIcon />}
                            </button>
                        </div>
                    ) : null}
                    {state.context.map((item) => (
                        <div className="dsh-chip" title="本轮一次性附件" key={item.id}>
                            <span className="dsh-chip-label">{item.label}</span>
                            <button
                                type="button"
                                className="dsh-chip-button"
                                title="移除"
                                onClick={() => postAction({ type: "removeContext", id: item.id })}
                            >
                                <CloseIcon />
                            </button>
                        </div>
                    ))}
                </div>
            ) : null}
            {state.busy ? (
                <div className="dsh-send-mode" aria-label="运行时消息方式">
                    <button
                        type="button"
                        className={promptMode === "queue" ? "active" : ""}
                        disabled={state.submitting}
                        onClick={() => setPromptMode("queue")}
                    >
                        排队
                    </button>
                    <button
                        type="button"
                        className={promptMode === "steer" ? "active" : ""}
                        disabled={state.submitting}
                        onClick={() => setPromptMode("steer")}
                    >
                        转向
                    </button>
                </div>
            ) : null}
            <div className="dsh-composer-row">
                <button
                    type="button"
                    className="dsh-icon-button dsh-add-context"
                    title="添加一次性 IDE context（/ide）"
                    onClick={() => postAction({ type: "openIdeContextPicker" })}
                >
                    <PlusIcon />
                </button>
                <textarea
                    ref={textareaRef}
                    className="dsh-prompt"
                    placeholder="描述任务，使用 @ 引用文件或选区…"
                    value={text}
                    disabled={state.submitting}
                    rows={3}
                    onChange={(event) => setText(event.target.value)}
                    onKeyDown={(event) => {
                        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                            event.preventDefault();
                            send();
                        }
                    }}
                />
                {state.busy ? (
                    <button
                        type="button"
                        className="dsh-send-button dsh-button-secondary"
                        title="停止"
                        disabled={state.cancelling}
                        onClick={() => postAction({ type: "cancel" })}
                    >
                        <StopIcon />
                        {state.cancelling ? "停止中…" : "停止"}
                    </button>
                ) : null}
                <button
                    type="button"
                    className="dsh-send-button"
                    title={sendLabel}
                    disabled={state.submitting || !text.trim()}
                    onClick={send}
                >
                    <SendIcon />
                    {sendLabel}
                </button>
            </div>
            <div className="dsh-hint">Ctrl/Cmd + Enter 发送 · 当前选区会在发送时重新读取</div>
        </div>
    );
}
