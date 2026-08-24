import React, { useEffect, useRef, useState } from "react";
import { postAction } from "../bridge";
import { t } from "../i18n";
import type { ReasoningEffortState } from "../state";
import { CloseIcon } from "./icons";

/** Escapes a URL for safe embedding inside a CSS url("...") value. */
function cssImageUrl(url: string): string {
    return url.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function ReasoningEffortControl({
    control,
    submitting,
    busy,
    onDismiss,
}: {
    control: ReasoningEffortState["reasoningEffort"];
    submitting: ReasoningEffortState["submitting"];
    busy: ReasoningEffortState["busy"];
    onDismiss: () => void;
}): React.JSX.Element | null {
    const panelRef = useRef<HTMLDivElement>(null);
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
    const disabled = submitting || busy;
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
                    {draft.image ? (
                        <span
                            className="dsh-reasoning-knob"
                            style={{
                                left: `${fillPercent}%`,
                                backgroundImage: `url("${cssImageUrl(draft.image)}")`,
                            }}
                            aria-hidden="true"
                        />
                    ) : null}
                </div>
            </div>
        </div>
    );
}
