import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ChatViewState } from "../../../src/types";
import type { ChatViewAction } from "../../../src/chatViewProtocol";
import { postAction, registerInsertTextHandler, registerSetTextHandler } from "../bridge";
import { t } from "../i18n";
import { CloseIcon, EyeIcon, EyeOffIcon, ImageIcon, PlusIcon, SendIcon, StopIcon } from "./icons";
import { ImageDraftRail, useImageDrafts } from "./ImageDrafts";

const MIN_HEIGHT = 68;
const MAX_HEIGHT = 180;

const SLASH_COMMANDS: ReadonlyArray<{
    name: string;
    description: string;
    action?: ChatViewAction;
}> = [
    { name: "/compact", description: t("Compact the current session history"), action: { type: "sendPrompt", text: "/compact", mode: "queue" } },
    { name: "/ide", description: t("Add one-shot IDE context"), action: { type: "openIdeContextPicker" } },
    { name: "/new", description: t("New session"), action: { type: "newSession" } },
    { name: "/search", description: t("Search sessions"), action: { type: "searchSession" } },
    { name: "/model", description: t("Select the current session model"), action: { type: "selectModel" } },
    { name: "/effort", description: t("Select reasoning effort") },
    { name: "/mode", description: t("Select agent mode"), action: { type: "selectAgentPreset" } },
    { name: "/focus", description: t("Toggle focus mode"), action: { type: "toggleFocus" } },
    { name: "/trace", description: t("Open the current session trace"), action: { type: "openTrace" } },
    { name: "/stop", description: t("Stop the dsh runtime"), action: { type: "stop" } },
];

interface ComposerProps {
    state: ChatViewState;
}

function formatStatsDuration(milliseconds: number): string {
    const totalSeconds = Math.round(Math.max(0, milliseconds) / 1_000);
    if (totalSeconds < 60) return `${totalSeconds}s`;
    return `${Math.floor(totalSeconds / 60)}m${totalSeconds % 60}s`;
}

function formatStatsThroughput(tokensPerSecond: number): string {
    const value = Math.max(0, tokensPerSecond);
    return value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}

function sessionStatsGroups(state: ChatViewState): string[] {
    const stats = state.sessionStats;
    if (!stats || stats.steps <= 0) return [];
    const groups = [`${stats.turns} ${t("turns")} · ${stats.steps} ${t("steps")}`];
    const durations = [
        stats.llmMs > 0 ? `${t("LLM")} ${formatStatsDuration(stats.llmMs)}` : "",
        stats.toolMs > 0 ? `${t("Tool call")} ${formatStatsDuration(stats.toolMs)}` : "",
    ].filter(Boolean);
    if (durations.length > 0) groups.push(durations.join(" · "));
    const speeds = [
        stats.ttftSteps > 0 ? `${t("Average first token")} ${formatStatsDuration(stats.ttftMs / stats.ttftSteps)}` : "",
        stats.decodeMs > 0 ? `${formatStatsThroughput(stats.decodeTokens / (stats.decodeMs / 1_000))} tok/s` : "",
    ].filter(Boolean);
    if (speeds.length > 0) groups.push(speeds.join(" · "));
    return groups;
}

function ReasoningEffortControl({
    state,
    onDismiss,
}: ComposerProps & { onDismiss: () => void }): React.JSX.Element | null {
    const panelRef = useRef<HTMLDivElement>(null);
    const control = state.reasoningEffort;
    const options = control?.options ?? [];
    const currentIndex = control
        ? Math.max(0, options.findIndex((option) => option.id === control.current))
        : 0;
    const current = options[currentIndex] ?? options[0];
    const optionKey = options.map((option) => option.id).join("\u0000");
    const [draftIndex, setDraftIndex] = useState(currentIndex);
    const draftIndexRef = useRef(currentIndex);
    useEffect(() => {
        draftIndexRef.current = currentIndex;
        setDraftIndex(currentIndex);
    }, [currentIndex, optionKey, control?.current]);
    useEffect(() => {
        const onPointerDown = (event: PointerEvent): void => {
            if (event.target instanceof Node && !panelRef.current?.contains(event.target)) {
                onDismiss();
            }
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape") onDismiss();
        };
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [onDismiss]);
    if (!control || options.length === 0 || !current) return null;
    const draft = options[draftIndex] ?? current;
    const disabled = state.submitting || state.busy;
    const commit = (): void => {
        const option = options[draftIndexRef.current];
        if (option && option.id !== control.current) {
            postAction({ type: "selectReasoningEffort", effort: option.id });
        }
    };
    const fillPercent = options.length > 1 ? (draftIndex / (options.length - 1)) * 100 : 100;
    return (
        <div ref={panelRef} className="dsh-reasoning-control" aria-label={t("Set reasoning effort")}>
            <div className="dsh-reasoning-control-head">
                <span>{t("Reasoning effort")}</span>
                <span className="dsh-reasoning-control-actions">
                    <span className="dsh-reasoning-value">{draft.label}</span>
                    <button
                        type="button"
                        className="dsh-icon-button dsh-reasoning-close"
                        title={t("Close")}
                        onClick={onDismiss}
                    >
                        <CloseIcon />
                    </button>
                </span>
            </div>
            <div className="dsh-reasoning-slider-row">
                {draft.image ? (
                    <img
                        className="dsh-reasoning-effort-image"
                        src={draft.image}
                        alt={draft.label}
                    />
                ) : null}
                <div className="dsh-reasoning-slider-wrap">
                    <input
                        className="dsh-reasoning-slider"
                        type="range"
                        min={0}
                        max={Math.max(0, control.options.length - 1)}
                        step={1}
                        value={draftIndex}
                        disabled={disabled}
                        aria-label={t("Reasoning effort")}
                        style={{ "--dsh-slider-fill": `${fillPercent}%` } as React.CSSProperties}
                        onChange={(event) => {
                            const index = Number(event.target.value);
                            draftIndexRef.current = index;
                            setDraftIndex(index);
                        }}
                        onPointerUp={commit}
                        onKeyUp={(event) => {
                            if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
                                commit();
                            }
                        }}
                    />
                    <div className="dsh-reasoning-slider-dots" aria-hidden="true">
                        {options.map((option, index) => {
                            if (index === draftIndex) return null;
                            const left = options.length > 1 ? (index / (options.length - 1)) * 100 : 50;
                            return (
                                <button
                                    type="button"
                                    tabIndex={-1}
                                    className={index < draftIndex ? "filled" : ""}
                                    style={{ left: `${left}%` }}
                                    disabled={disabled}
                                    key={option.id}
                                    onClick={() => {
                                        draftIndexRef.current = index;
                                        setDraftIndex(index);
                                        if (option.id !== control.current) {
                                            postAction({ type: "selectReasoningEffort", effort: option.id });
                                        }
                                    }}
                                />
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
}

export function Composer({ state }: ComposerProps): React.JSX.Element {
    const [text, setText] = useState("");
    const [promptMode, setPromptMode] = useState<"queue" | "steer">("queue");
    const [slashIndex, setSlashIndex] = useState(0);
    const [effortVisible, setEffortVisible] = useState(false);
    const [attachmentMenuVisible, setAttachmentMenuVisible] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const attachmentMenuRef = useRef<HTMLDivElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const imageDrafts = useImageDrafts(state.imageLimits);

    // Legacy behavior: the queue/steer choice resets to queue once the session is idle.
    useEffect(() => {
        if (!state.busy) setPromptMode("queue");
    }, [state.busy]);
    useEffect(() => setEffortVisible(false), [state.sessionId]);
    useEffect(() => {
        if (!attachmentMenuVisible) return;
        const onPointerDown = (event: PointerEvent): void => {
            if (event.target instanceof Node && !attachmentMenuRef.current?.contains(event.target)) {
                setAttachmentMenuVisible(false);
            }
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape") setAttachmentMenuVisible(false);
        };
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [attachmentMenuVisible]);

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
        if (command.name === "/effort") {
            setEffortVisible(true);
        } else if (command.action) {
            postAction(command.action);
        }
        setText("");
        setSlashIndex(0);
        return true;
    }, []);

    const send = useCallback((): void => {
        if (state.submitting) return;
        const value = textareaRef.current?.value ?? text;
        if (!value.trim() && imageDrafts.images.length === 0) return;
        if (imageDrafts.images.length === 0 && executeSlashCommand(value.trim())) return;
        postAction({
            type: "sendPrompt",
            text: value,
            mode: state.busy ? promptMode : "queue",
            images: imageDrafts.images.map((image) => image.upload),
        });
        setText("");
        imageDrafts.clear();
    }, [executeSlashCommand, imageDrafts, state.busy, state.submitting, promptMode, text]);

    const slashQuery = text.match(/^\/(\S*)$/u)?.[1]?.toLowerCase();
    const slashMatches = slashQuery === undefined
        ? []
        : SLASH_COMMANDS.filter((command) => command.name.slice(1).startsWith(slashQuery));
    const slashSkillMatches = slashQuery === undefined
        ? []
        : state.skills.filter((skill) =>
              skill.name.toLowerCase().startsWith(slashQuery) &&
              !SLASH_COMMANDS.some((command) => command.name.slice(1) === skill.name.toLowerCase()),
          );
    const slashCandidateCount = slashMatches.length + slashSkillMatches.length;
    const skillMatch = text.match(/(?:^|\s)\$([^\s$]*)$/u);
    const skillQuery = skillMatch?.[1]?.toLowerCase();
    const skillMatches = skillQuery === undefined
        ? []
        : state.skills.filter((skill) => {
              const query = skillQuery.trim();
              return !query || skill.name.toLowerCase().includes(query) ||
                  skill.description.toLowerCase().includes(query) ||
                  skill.whenToUse?.toLowerCase().includes(query);
          });
    const chooseSlashCommand = useCallback((name: string): void => {
        executeSlashCommand(name);
        window.requestAnimationFrame(() => textareaRef.current?.focus());
    }, [executeSlashCommand]);
    const chooseSkill = useCallback((name: string): void => {
        const match = text.match(/(?:^|\s)\$([^\s$]*)$/u);
        if (match && match.index !== undefined) {
            const dollarOffset = match[0].lastIndexOf("$");
            const start = match.index + dollarOffset;
            setText(`${text.slice(0, start)}/${name} `);
        } else if (/^\/\S*$/u.test(text)) {
            setText(`/${name} `);
        } else {
            return;
        }
        setSlashIndex(0);
        window.requestAnimationFrame(() => textareaRef.current?.focus());
    }, [text]);

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
    const estimatedAttachmentTokens = Math.ceil(promptBytes / 4);
    const contextWindow = state.tokenUsage?.context?.contextWindow;
    const projectedTokens = state.tokenUsage?.context?.projectedTokens;
    const projectedWithAttachments = (projectedTokens ?? 0) + estimatedAttachmentTokens;
    const overContextWindow = contextWindow !== undefined && projectedTokens !== undefined && projectedWithAttachments > contextWindow;
    const sensitiveItems = promptItems.filter((item) => /(^|[/\\.])(env|env\..*|pem|key|p12|pfx|secret|credentials?)([/\\.]|$)/iu.test(item.path ?? item.label));
    const truncatedItems = promptItems.filter((item) => item.truncated);
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
            {promptItems.length ? (
                <div className="dsh-context-notices" role="status">
                    {overContextWindow ? (
                        <div className="dsh-context-warning">
                            {t("This send may exceed the model context window ({used} / {window} tokens). Remove a large attachment before sending.", {
                                used: projectedWithAttachments.toLocaleString(),
                                window: contextWindow!.toLocaleString(),
                            })}
                        </div>
                    ) : null}
                    {truncatedItems.length ? (
                        <div className="dsh-context-warning">
                            {t("{count} attachment(s) will be truncated before entering the prompt.", { count: truncatedItems.length })}
                        </div>
                    ) : null}
                    {sensitiveItems.length ? (
                        <div className="dsh-context-warning">
                            {t("Check {count} attachment(s): their path looks like it may contain secrets or credentials.", { count: sensitiveItems.length })}
                        </div>
                    ) : null}
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
            {effortVisible ? (
                <ReasoningEffortControl state={state} onDismiss={() => setEffortVisible(false)} />
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
            <ImageDraftRail
                images={imageDrafts.images}
                error={imageDrafts.error}
                onRemove={imageDrafts.remove}
            />
            <div
                className="dsh-composer-row"
                onDragOver={(event) => {
                    if (Array.from(event.dataTransfer.items).some((item) => item.kind === "file")) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "copy";
                    }
                }}
                onDrop={(event) => {
                    const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/"));
                    if (files.length === 0) return;
                    event.preventDefault();
                    void imageDrafts.addFiles(files);
                }}
            >
                <div className="dsh-menu-anchor dsh-attachment-anchor" ref={attachmentMenuRef}>
                    <button
                        type="button"
                        className="dsh-icon-button dsh-add-context"
                        title={t("Add attachment")}
                        aria-haspopup="menu"
                        aria-expanded={attachmentMenuVisible}
                        disabled={state.submitting}
                        onClick={() => setAttachmentMenuVisible((visible) => !visible)}
                    >
                        <PlusIcon />
                    </button>
                    {attachmentMenuVisible ? (
                        <div className="dsh-menu dsh-attachment-menu" role="menu">
                            <button
                                type="button"
                                className="dsh-menu-item"
                                role="menuitem"
                                onClick={() => {
                                    setAttachmentMenuVisible(false);
                                    postAction({ type: "openIdeContextPicker" });
                                }}
                            >
                                <PlusIcon />
                                {t("Add one-shot IDE context")}
                            </button>
                            <button
                                type="button"
                                className="dsh-menu-item"
                                role="menuitem"
                                onClick={() => {
                                    setAttachmentMenuVisible(false);
                                    imageInputRef.current?.click();
                                }}
                            >
                                <ImageIcon />
                                {t("Add images")}
                            </button>
                        </div>
                    ) : null}
                    <input
                        ref={imageInputRef}
                        className="dsh-image-input"
                        type="file"
                        accept={imageDrafts.accept}
                        multiple
                        tabIndex={-1}
                        onChange={(event) => {
                            const files = Array.from(event.target.files ?? []);
                            event.target.value = "";
                            void imageDrafts.addFiles(files);
                        }}
                    />
                </div>
                <textarea
                    ref={textareaRef}
                    className="dsh-prompt"
                    placeholder={t("Describe a task; use @ for files, $ for skills...")}
                    value={text}
                    disabled={state.submitting}
                    rows={3}
                    onChange={(event) => {
                        setText(event.target.value);
                        setSlashIndex(0);
                    }}
                    onPaste={(event) => {
                        const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
                        if (files.length === 0) return;
                        event.preventDefault();
                        void imageDrafts.addFiles(files);
                    }}
                    onKeyDown={(event) => {
                        if (skillMatches.length) {
                            if (event.key === "ArrowDown") {
                                event.preventDefault();
                                setSlashIndex((current) => (current + 1) % skillMatches.length);
                                return;
                            }
                            if (event.key === "ArrowUp") {
                                event.preventDefault();
                                setSlashIndex((current) => (current - 1 + skillMatches.length) % skillMatches.length);
                                return;
                            }
                            if (event.key === "Tab" || event.key === "Enter") {
                                event.preventDefault();
                                chooseSkill(skillMatches[slashIndex]?.name ?? skillMatches[0].name);
                                return;
                            }
                        } else if (slashCandidateCount) {
                            if (event.key === "ArrowDown") {
                                event.preventDefault();
                                setSlashIndex((current) => (current + 1) % slashCandidateCount);
                                return;
                            }
                            if (event.key === "ArrowUp") {
                                event.preventDefault();
                                setSlashIndex((current) => (current - 1 + slashCandidateCount) % slashCandidateCount);
                                return;
                            }
                            if (event.key === "Tab" || event.key === "Enter") {
                                event.preventDefault();
                                const command = slashMatches[slashIndex];
                                if (command) {
                                    chooseSlashCommand(command.name);
                                } else {
                                    const skill = slashSkillMatches[slashIndex - slashMatches.length];
                                    if (skill) chooseSkill(skill.name);
                                }
                                return;
                            }
                        }
                        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                            event.preventDefault();
                            send();
                        }
                    }}
                />
                {slashCandidateCount ? (
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
                        {slashSkillMatches.map((skill, offset) => {
                            const index = slashMatches.length + offset;
                            return (
                                <button
                                    type="button"
                                    role="option"
                                    aria-selected={index === slashIndex}
                                    className={index === slashIndex ? "active" : ""}
                                    key={`skill:${skill.name}`}
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={() => chooseSkill(skill.name)}
                                >
                                    <strong>/{skill.name}</strong>
                                    <span>{skill.whenToUse || skill.description}</span>
                                </button>
                            );
                        })}
                    </div>
                ) : null}
                {skillMatches.length ? (
                    <div className="dsh-slash-menu" role="listbox" aria-label="Skill candidates">
                        {skillMatches.map((skill, index) => (
                            <button
                                type="button"
                                role="option"
                                aria-selected={index === slashIndex}
                                className={index === slashIndex ? "active" : ""}
                                key={skill.name}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => chooseSkill(skill.name)}
                            >
                                <strong>${skill.name}</strong>
                                <span>{skill.whenToUse || skill.description}</span>
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
                    disabled={state.submitting || (!text.trim() && imageDrafts.images.length === 0)}
                    onClick={send}
                >
                    <SendIcon />
                    {sendLabel}
                </button>
            </div>
            {(() => {
                const groups = sessionStatsGroups(state);
                if (groups.length === 0) return null;
                return (
                    <div className="dsh-stats" aria-label={t("Session statistics")}>
                        <div className="dsh-stats-top">
                            {groups.slice(0, 2).map((group, index) => (
                                <React.Fragment key={group}>
                                    {index > 0 ? <span className="dsh-stats-separator" aria-hidden="true">|</span> : null}
                                    <span>{group}</span>
                                </React.Fragment>
                            ))}
                        </div>
                        {groups[2] ? <div className="dsh-stats-bottom">{groups[2]}</div> : null}
                    </div>
                );
            })()}
        </div>
    );
}
