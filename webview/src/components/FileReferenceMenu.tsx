import React from "react";
import type { DshReferenceCandidate } from "../../../src/types";

export function FileReferenceMenu({
    candidates,
    onSelect,
}: {
    candidates: DshReferenceCandidate[];
    onSelect: (candidate: DshReferenceCandidate) => void;
}): React.JSX.Element {
    return (
        <div className="dsh-file-reference-menu" role="listbox">
            {candidates.map((candidate) => (
                <button type="button" role="option" aria-selected={false} key={`${candidate.kind}:${candidate.insertText}`} onMouseDown={(event) => event.preventDefault()} onClick={() => onSelect(candidate)}>
                    <span className="dsh-reference-label">@{candidate.label}</span>
                    {candidate.description ? <small>{candidate.description}</small> : null}
                </button>
            ))}
        </div>
    );
}
