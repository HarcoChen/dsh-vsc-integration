import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ChatViewState } from "../../../src/types";
import type { ChatViewAction } from "../../../src/chatViewProtocol";
import { postAction, registerInsertTextHandler, registerSetTextHandler } from "../bridge";
import { t } from "../i18n";
import { CloseIcon, EyeIcon, EyeOffIcon, PlusIcon, SendIcon, StopIcon } from "./icons";

const MIN_HEIGHT = 68;
const MAX_HEIGHT = 180;

const SLASH_COMMANDS = [
    { name: "/ide", description: t("Add one-shot IDE context"), action: { type: "openIdeContextPicker" } },
    { name: "/new", description: t("New session"), action: { type: "newSession" } },
    { name: "/search", description: t("Search sessions"), action: { type: "searchSession" } },
    { name: "/model", description: t("Select the current session model"), action: { type: "selectModel" } },
    { name: "/mode", description: t("Select agent mode"), action: { type: "selectAgentPreset" } },
    { name: "/focus", description: t("Toggle focus mode"), action: { type: "toggleFocus" } },
    { name: "/trace", description: t("Open the current session trace"), action: { type: "openTrace" } },
    { name: "/stop", description: t("Stop the dsh runtime"), action: { type: "stop" } },
] satisfies ReadonlyArray<{ name: string; description: string; action: ChatViewAction }>;

interface ComposerProps {
    state: ChatViewState;
}

export function Composer({ state }: ComposerProps): React.JSX.Element {
    const [text, setText] = useState("");
    const [promptMode, setPromptMode] = useState<"queue" | "steer">("queue");
    const [slashIndex, setSlashIndex] = useState(0);
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

    useEffect(() => {
        registerSetTextHandler((draft) => {
            setText(draft);
            setSlashIndex(0);
            window.requestAnimationFrame(() => {
                const textarea = textareaRef.current;
                if (!textarea) return;
                textarea.setSelectionRange(draft.length, draft.length);
                textarea.focus();
            });
        });
        return () => registerSetTextHandler(undefined);
    }, []);

    const executeSlashCommand = useCallback((name: string): boolean => {
        const mode = name.match(/^\/mode(?:\s+(.+))?$/iu);
        if (mode) {
            const agentPreset = mode[1]?.trim();
            postAction({
                type: "selectAgentPreset",
                ...(agentPreset ? { agentPreset } : {}),
            });
            setText("");
            setSlashIndex(0);
            return true;
        }
        const command = SLASH_COMMANDS.find((candidate) => candidate.name === name.toLowerCase());
        if (!command) return false;
        postAction(command.action);
        setText("");
        setSlashIndex(0);
        return true;
    }, []);

    const send = useCallback((): void => {
        if (state.submitting) return;
        const value = textareaRef.current?.value ?? text;
        if (!value.trim()) return;
        if (executeSlashCommand(value.trim())) return;
        postAction({
            type: "sendPrompt",
            text: value,
            mode: state.busy ? promptMode : "queue",
        });
        setText("");
    }, [executeSlashCommand, state.busy, state.submitting, promptMode, text]);

    const slashQuery = text.match(/^\/(\S*)$/u)?.[1]?.toLowerCase();
    const slashMatches = slashQuery === undefined
        ? []
        : SLASH_COMMANDS.filter((command) => command.name.slice(1).startsWith(slashQuery));
    const chooseSlashCommand = useCallback((name: string): void => {
        executeSlashCommand(name);
        window.requestAnimationFrame(() => textareaRef.current?.focus());
    }, [executeSlashCommand]);

    const selection = state.selection;
    const selectionRange = selection?.range;
    const selectionLines = selectionRange
        ? Math.max(1, selectionRange.endLine - selectionRange.startLine + 1)
        : 0;

    const sendLabel = state.busy ? (promptMode === "steer" ? t("Steer") : t("Queue")) : t("Send");
    const promptItems = [
        ...(selection && state.selectionEnabled ? [selection] : []),
        ...state.context,
    ];
    const promptBytes = promptItems.reduce((total, item) => total + item.byteLength, 0);
    const referenceMatch = text.match(/(?:^|\s)@([^\s@]*)$/u);
    const referenceQuery = referenceMatch?.[1] ?? "";
    useEffect(() => {
        postAction({ type: "fileReferenceQuery", query: referenceQuery });
    }, [referenceQuery]);

    return (
        <div className="dsh-composer">
            {selection || state.context.length ? (
                <div className="dsh-context-items">
                    {selection ? (
                        <div
                            className={`dsh-chip${state.selectionEnabled ? "" : " dsh-chip-disabled"}`}
                            title={t("The current selection is read again when sending")}
                        >
                            <span className="dsh-chip-label">
                                Selection · {selection.label} · {selectionLines} lines · {selection.byteLength.toLocaleString()} B
                                {selection.truncated ? ` · ${t("truncated")}` : ""}
                            </span>
                            <button
                                type="button"
                                className="dsh-chip-button"
                                title={t("Toggle automatic selection context")}
                                onClick={() => postAction({ type: "toggleSelection" })}
                            >
                                {state.selectionEnabled ? <EyeIcon /> : <EyeOffIcon />}
                            </button>
                        </div>
                    ) : null}
                    {state.context.map((item) => (
                        <div className="dsh-chip" title={t("One-shot attachment")} key={item.id}>
                            <span className="dsh-chip-label">
                                {item.label} · {item.byteLength.toLocaleString()} B
                                {item.truncated ? ` · ${t("truncated")}` : ""}
                            </span>
                            <button
                                type="button"
                                className="dsh-chip-button"
                                title={t("Remove")}
                                onClick={() => postAction({ type: "removeContext", id: item.id })}
                            >
                                <CloseIcon />
                            </button>
                        </div>
                    ))}
                </div>
            ) : null}
            {promptItems.length ? (
                <div className="dsh-context-summary">
                    {t("This send includes {count} context item(s), {bytes} B in the prompt", {
                        count: promptItems.length,
                        bytes: promptBytes.toLocaleString(),
                    })}
                </div>
            ) : null}
            {referenceMatch && state.fileReferenceCandidates?.length ? (
                <div className="dsh-file-reference-menu" role="listbox">
                    {state.fileReferenceCandidates.map((candidate) => (
                        <button type="button" key={candidate} onMouseDown={(event) => event.preventDefault()} onClick={() => {
                            const prefix = text.slice(0, text.length - referenceQuery.length);
                            setText(`${prefix}${candidate} `);
                            window.requestAnimationFrame(() => textareaRef.current?.focus());
                        }}>
                            @{candidate}
                        </button>
                    ))}
                </div>
            ) : null}
            {state.busy ? (
                <div className="dsh-send-mode" aria-label={t("Runtime message mode")}>
                    <button
                        type="button"
                        className={promptMode === "queue" ? "active" : ""}
                        disabled={state.submitting}
                        onClick={() => setPromptMode("queue")}
                    >
                        {t("Queue")}
                    </button>
                    <button
                        type="button"
                        className={promptMode === "steer" ? "active" : ""}
                        disabled={state.submitting}
                        onClick={() => setPromptMode("steer")}
                    >
                        {t("Steer")}
                    </button>
                </div>
            ) : null}
            <div className="dsh-composer-row">
                <button
                    type="button"
                    className="dsh-icon-button dsh-add-context"
                    title={t("Add one-shot IDE context (/ide)")}
                    onClick={() => postAction({ type: "openIdeContextPicker" })}
                >
                    <PlusIcon />
                </button>
                <textarea
                    ref={textareaRef}
                    className="dsh-prompt"
                    placeholder={t("Describe a task; use @ to reference files or selections...")}
                    value={text}
                    disabled={state.submitting}
                    rows={3}
                    onChange={(event) => {
                        setText(event.target.value);
                        setSlashIndex(0);
                    }}
                    onKeyDown={(event) => {
                        if (slashMatches.length) {
                            if (event.key === "ArrowDown") {
                                event.preventDefault();
                                setSlashIndex((current) => (current + 1) % slashMatches.length);
                                return;
                            }
                            if (event.key === "ArrowUp") {
                                event.preventDefault();
                                setSlashIndex((current) => (current - 1 + slashMatches.length) % slashMatches.length);
                                return;
                            }
                            if (event.key === "Tab" || event.key === "Enter") {
                                event.preventDefault();
                                chooseSlashCommand(slashMatches[slashIndex].name);
                                return;
                            }
                        }
                        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                            event.preventDefault();
                            send();
                        }
                    }}
                />
                {slashMatches.length ? (
                    <div className="dsh-slash-menu" role="listbox" aria-label="Slash commands">
                        {slashMatches.map((command, index) => (
                            <button
                                type="button"
                                role="option"
                                aria-selected={index === slashIndex}
                                className={index === slashIndex ? "active" : ""}
                                key={command.name}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => chooseSlashCommand(command.name)}
                            >
                                <strong>{command.name}</strong>
                                <span>{command.description}</span>
                            </button>
                        ))}
                    </div>
                ) : null}
                {state.busy ? (
                    <button
                        type="button"
                        className="dsh-send-button dsh-button-secondary"
                        title={t("Stop")}
                        disabled={state.cancelling}
                        onClick={() => postAction({ type: "cancel" })}
                    >
                        <StopIcon />
                        {state.cancelling ? t("Stopping...") : t("Stop")}
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
            <div className="dsh-hint">{t("Ctrl/Cmd + Enter to send · the current selection is read again when sending")}</div>
        </div>
    );
}
