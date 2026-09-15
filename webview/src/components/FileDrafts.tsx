import React, { useCallback, useRef, useState } from "react";
import type { DshFileDraft } from "../../../src/types";
import { t } from "../i18n";
import { CloseIcon } from "./icons";
import { FileTypeIcon } from "./FileTypeIcon";
import { toBase64 } from "./ImageDrafts";

const MAX_FILES_PER_MESSAGE = 20;

export interface DraftFile extends DshFileDraft {
    id: string;
    bytes: number;
}

/** Keep images on the existing preview and normalization path. */
export function splitImageFiles(files: readonly File[]): { images: File[]; others: File[] } {
    const images: File[] = [];
    const others: File[] = [];
    for (const file of files) {
        if (file.type.startsWith("image/")) images.push(file);
        else others.push(file);
    }
    return { images, others };
}

/** Extension of a display name, without the dot; empty when there is none. */
export function fileExtension(name: string): string {
    const leaf = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
    const dot = leaf.lastIndexOf(".");
    return dot <= 0 ? "" : leaf.slice(dot + 1);
}

/** Match the Harness UI's binary units and precision. */
export function fileSizeText(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    const kilobytes = bytes / 1024;
    if (kilobytes < 1024) return `${kilobytes < 10 ? kilobytes.toFixed(1) : Math.round(kilobytes)}KB`;
    const megabytes = kilobytes / 1024;
    if (megabytes < 1024) return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)}MB`;
    const gigabytes = megabytes / 1024;
    return `${gigabytes < 10 ? gigabytes.toFixed(1) : Math.round(gigabytes)}GB`;
}

/** Metadata line under a file name: extension first, then size when known. */
function fileMeta(name: string, bytes: number): string {
    const extension = fileExtension(name).toUpperCase().slice(0, 8);
    return [extension, fileSizeText(bytes)].filter((part) => part !== "").join(" ");
}

/** Read bytes at attachment time; the clipboard File may expire before send. */
export function useFileDrafts(): {
    files: readonly DraftFile[];
    error?: string;
    addFiles: (files: readonly File[]) => Promise<void>;
    remove: (id: string) => void;
    clear: () => void;
} {
    const [files, setFiles] = useState<DraftFile[]>([]);
    const [error, setError] = useState<string>();
    // Read at add time so a batch is rejected as a whole rather than in part.
    const pending = useRef<DraftFile[]>([]);

    const addFiles = useCallback(async (incoming: readonly File[]): Promise<void> => {
        setError(undefined);
        if (incoming.length === 0) return;
        const existing = pending.current;
        if (existing.length + incoming.length > MAX_FILES_PER_MESSAGE) {
            setError(t("A message can contain at most {count} files.", { count: MAX_FILES_PER_MESSAGE }));
            return;
        }
        const additions: DraftFile[] = [];
        for (const file of incoming) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            additions.push({
                id: crypto.randomUUID(),
                name: file.name || t("file"),
                bytes: bytes.byteLength,
                data: toBase64(bytes),
            });
        }
        pending.current = [...existing, ...additions];
        setFiles(pending.current);
    }, []);

    const remove = useCallback((id: string): void => {
        pending.current = pending.current.filter((item) => item.id !== id);
        setFiles(pending.current);
    }, []);

    const clear = useCallback((): void => {
        pending.current = [];
        setFiles([]);
        setError(undefined);
    }, []);

    return { files, error, addFiles, remove, clear };
}

export function FileDraftRail({
    files,
    error,
    onRemove,
}: {
    files: readonly DraftFile[];
    error?: string;
    onRemove: (id: string) => void;
}): React.JSX.Element | null {
    if (files.length === 0 && !error) return null;
    return (
        <div className="dsh-file-drafts">
            {files.length ? (
                <div className="dsh-file-draft-rail" aria-label={t("Pending files")}>
                    {files.map((file) => (
                        <div className="dsh-file-card" title={file.name} key={file.id}>
                            <span className="dsh-file-card-icon" aria-hidden="true">
                                <FileTypeIcon name={file.name} />
                            </span>
                            <span className="dsh-file-card-body">
                                <span className="dsh-file-card-name">{file.name}</span>
                                <span className="dsh-file-card-meta">{fileMeta(file.name, file.bytes)}</span>
                            </span>
                            <button
                                type="button"
                                className="dsh-file-card-remove"
                                title={t("Remove file")}
                                aria-label={t("Remove file")}
                                onClick={() => onRemove(file.id)}
                            >
                                <CloseIcon />
                            </button>
                        </div>
                    ))}
                </div>
            ) : null}
            {error ? <div className="dsh-card-error">{error}</div> : null}
        </div>
    );
}
