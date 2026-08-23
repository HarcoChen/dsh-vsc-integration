import React, { useCallback, useState } from "react";
import type {
    DshImageLimitsView,
    DshImageMediaType,
    DshImageUpload,
} from "../../../src/types";
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

function toBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}

function mediaType(value: string): DshImageMediaType | undefined {
    return value === "image/png" || value === "image/jpeg" ||
        value === "image/webp" || value === "image/gif"
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
    const [images, setImages] = useState<DraftImage[]>([]);
    const [error, setError] = useState<string>();
    const addFiles = useCallback(async (files: readonly File[]): Promise<void> => {
        setError(undefined);
        const remainingCount = limits.maxImagesPerMessage - images.length;
        if (files.length > remainingCount) {
            setError(t("A message can contain at most {count} images.", {
                count: limits.maxImagesPerMessage,
            }));
            return;
        }
        const existingBytes = images.reduce((sum, image) => sum + image.bytes, 0);
        const additions: DraftImage[] = [];
        let addedBytes = 0;
        for (const file of files) {
            const type = mediaType(file.type);
            if (!type || !limits.mediaTypes.includes(type)) {
                setError(t("Only PNG, JPEG, WebP, and GIF images are supported."));
                return;
            }
            if (file.size > limits.maxImageBytes) {
                setError(t("Image {name} exceeds the {size} byte limit.", {
                    name: file.name || t("image"),
                    size: limits.maxImageBytes.toLocaleString(),
                }));
                return;
            }
            addedBytes += file.size;
            if (existingBytes + addedBytes > limits.maxMessageImageBytes) {
                setError(t("Attached images exceed the {size} byte total limit.", {
                    size: limits.maxMessageImageBytes.toLocaleString(),
                }));
                return;
            }
            const data = toBase64(new Uint8Array(await file.arrayBuffer()));
            additions.push({
                id: crypto.randomUUID(),
                upload: {
                    mediaType: type,
                    data,
                    ...(file.name ? { name: file.name } : {}),
                },
                bytes: file.size,
                src: `data:${type};base64,${data}`,
            });
        }
        setImages((current) => [...current, ...additions]);
    }, [images, limits.maxImageBytes, limits.maxImagesPerMessage, limits.maxMessageImageBytes, limits.mediaTypes]);
    const addUploads = useCallback((uploads: readonly DshImageUpload[]): void => {
        setError(undefined);
        const existingBytes = images.reduce((sum, image) => sum + image.bytes, 0);
        const additions: DraftImage[] = [];
        let addedBytes = 0;
        if (images.length + uploads.length > limits.maxImagesPerMessage) {
            setError(t("A message can contain at most {count} images.", { count: limits.maxImagesPerMessage }));
            return;
        }
        for (const upload of uploads) {
            if (!limits.mediaTypes.includes(upload.mediaType)) {
                setError(t("Only PNG, JPEG, WebP, and GIF images are supported."));
                return;
            }
            const bytes = Math.floor(upload.data.length * 3 / 4);
            if (bytes > limits.maxImageBytes) {
                setError(t("Image {name} exceeds the {size} byte limit.", {
                    name: upload.name || t("image"),
                    size: limits.maxImageBytes.toLocaleString(),
                }));
                return;
            }
            addedBytes += bytes;
            if (existingBytes + addedBytes > limits.maxMessageImageBytes) {
                setError(t("Attached images exceed the {size} byte total limit.", {
                    size: limits.maxMessageImageBytes.toLocaleString(),
                }));
                return;
            }
            additions.push({
                id: crypto.randomUUID(),
                upload,
                bytes,
                src: `data:${upload.mediaType};base64,${upload.data}`,
            });
        }
        setImages((current) => [...current, ...additions]);
    }, [images, limits.maxImageBytes, limits.maxImagesPerMessage, limits.maxMessageImageBytes, limits.mediaTypes]);
    return {
        images,
        error,
        accept: limits.mediaTypes.join(","),
        addFiles,
        addUploads,
        remove: (id) => setImages((current) => current.filter((image) => image.id !== id)),
        clear: () => {
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
