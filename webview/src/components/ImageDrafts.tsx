import React, { useCallback, useEffect, useRef, useState } from "react";
import type { DshImageLimitsView, DshImageMediaType, DshImageUpload } from "../../../src/types";
import { t } from "../i18n";
import { CloseIcon } from "./icons";

const DEFAULT_LIMITS: DshImageLimitsView = {
    maxImageBytes: 5 * 1024 * 1024,
    maxImagesPerMessage: 20,
    maxMessageImageBytes: 100 * 1024 * 1024,
    mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
};

export interface DraftImage {
    id: string;
    upload: DshImageUpload;
    bytes: number;
    src: string;
}

export function toBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}

function mediaType(value: string): DshImageMediaType | undefined {
    return value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif"
        ? value
        : undefined;
}

export function useImageDrafts(limitsValue?: DshImageLimitsView): {
    images: readonly DraftImage[];
    error?: string;
    accept: string;
    addFiles: (files: readonly File[]) => Promise<void>;
    addUploads: (uploads: readonly DshImageUpload[]) => void;
    remove: (id: string) => void;
    clear: () => void;
} {
    const limits = limitsValue ?? DEFAULT_LIMITS;
    const latestLimits = useRef(limits);
    React.useLayoutEffect(() => { latestLimits.current = limits; }, [limits]);
    const current = useRef<DraftImage[]>([]);
    const generation = useRef(0);
    const reserved = useRef({ count: 0, bytes: 0 });
    const [images, setImages] = useState<DraftImage[]>([]);
    const [error, setError] = useState<string>();
    useEffect(
        () => () => {
            generation.current += 1;
        },
        []
    );

    const validate = (
        incoming: readonly { bytes: number; type: string; name?: string }[],
        pending = reserved.current
    ): boolean => {
        const limits = latestLimits.current;
        if (current.current.length + pending.count + incoming.length > limits.maxImagesPerMessage) {
            setError(t("A message can contain at most {count} images.", { count: limits.maxImagesPerMessage }));
            return false;
        }
        let total = current.current.reduce((sum, image) => sum + image.bytes, pending.bytes);
        for (const image of incoming) {
            const type = mediaType(image.type);
            if (!type || !limits.mediaTypes.includes(type)) {
                setError(t("Only PNG, JPEG, WebP, and GIF images are supported."));
                return false;
            }
            if (image.bytes > limits.maxImageBytes) {
                setError(
                    t("Image {name} exceeds the {size} byte limit.", {
                        name: image.name || t("image"),
                        size: limits.maxImageBytes.toLocaleString(),
                    })
                );
                return false;
            }
            total += image.bytes;
        }
        if (total > limits.maxMessageImageBytes) {
            setError(
                t("Attached images exceed the {size} byte total limit.", {
                    size: limits.maxMessageImageBytes.toLocaleString(),
                })
            );
            return false;
        }
        return true;
    };

    const addFiles = useCallback(async (files: readonly File[]): Promise<void> => {
        if (!files.length) return;
        setError(undefined);
        const metadata = files.map((file) => ({ bytes: file.size, type: file.type, name: file.name }));
        if (!validate(metadata)) return;
        const currentGeneration = generation.current;
        const bytes = files.reduce((sum, file) => sum + file.size, 0);
        reserved.current = { count: reserved.current.count + files.length, bytes: reserved.current.bytes + bytes };
        try {
            const additions: DraftImage[] = [];
            for (const file of files) {
                const data = toBase64(new Uint8Array(await file.arrayBuffer()));
                if (generation.current !== currentGeneration) return;
                const type = mediaType(file.type)!;
                additions.push({
                    id: crypto.randomUUID(),
                    upload: { mediaType: type, data, ...(file.name ? { name: file.name } : {}) },
                    bytes: file.size,
                    src: `data:${type};base64,${data}`,
                });
            }
            const otherReservations = {
                count: reserved.current.count - files.length,
                bytes: reserved.current.bytes - bytes,
            };
            if (!validate(metadata, otherReservations)) return;
            current.current = [...current.current, ...additions];
            setImages(current.current);
        } finally {
            if (generation.current === currentGeneration)
                reserved.current = {
                    count: reserved.current.count - files.length,
                    bytes: reserved.current.bytes - bytes,
                };
        }
    }, []);
    const addUploads = useCallback((uploads: readonly DshImageUpload[]): void => {
        if (!uploads.length) return;
        setError(undefined);
        const metadata = uploads.map((upload) => ({
            bytes:
                Math.floor((upload.data.length * 3) / 4) -
                (upload.data.endsWith("==") ? 2 : upload.data.endsWith("=") ? 1 : 0),
            type: upload.mediaType,
            name: upload.name,
        }));
        if (!validate(metadata)) return;
        const additions = uploads.map((upload, index) => ({
            id: crypto.randomUUID(),
            upload,
            bytes: metadata[index].bytes,
            src: `data:${upload.mediaType};base64,${upload.data}`,
        }));
        current.current = [...current.current, ...additions];
        setImages(current.current);
    }, []);
    return {
        images,
        error,
        accept: limits.mediaTypes.join(","),
        addFiles,
        addUploads,
        remove: (id) => {
            current.current = current.current.filter((image) => image.id !== id);
            setImages(current.current);
        },
        clear: () => {
            generation.current += 1;
            reserved.current = { count: 0, bytes: 0 };
            current.current = [];
            setImages([]);
            setError(undefined);
        },
    };
}

export function ImageDraftRail({
    images,
    error,
    onRemove,
}: {
    images: readonly DraftImage[];
    error?: string;
    onRemove: (id: string) => void;
}): React.JSX.Element | null {
    if (images.length === 0 && !error) return null;
    return (
        <div className="dsh-image-drafts">
            {images.length ? (
                <div className="dsh-image-draft-rail" aria-label={t("Pending images")}>
                    {images.map((image) => (
                        <div className="dsh-image-draft" key={image.id}>
                            <img src={image.src} alt={image.upload.name || t("Image")} />
                            <button
                                type="button"
                                className="dsh-icon-button"
                                title={t("Remove image")}
                                onClick={() => onRemove(image.id)}
                            >
                                <CloseIcon />
                            </button>
                            <span>{image.upload.name || t("Image")}</span>
                        </div>
                    ))}
                </div>
            ) : null}
            {error ? <div className="dsh-card-error">{error}</div> : null}
            {images.length ? (
                <div className="dsh-image-data-notice">
                    {t("Images are uploaded to Harness when this message is sent.")}
                </div>
            ) : null}
        </div>
    );
}
