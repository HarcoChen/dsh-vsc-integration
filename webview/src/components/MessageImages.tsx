import React, { useEffect, useRef, useState } from "react";
import type { ChatImageView } from "../../../src/types";
import { postAction } from "../bridge";
import { t } from "../i18n";
import { CloseIcon } from "./icons";

export function MessageImages({ images }: { images: readonly ChatImageView[] }): React.JSX.Element | null {
    const galleryRef = useRef<HTMLDivElement>(null);
    const lightboxCloseRef = useRef<HTMLButtonElement>(null);
    const lightboxRestoreRef = useRef<HTMLElement | null>(null);
    const [preview, setPreview] = useState<ChatImageView>();
    const pendingIds = images
        .filter((image) => !image.src && image.loadState === "idle" && image.attachmentId)
        .map((image) => image.attachmentId as string)
        .join("\u0000");
    useEffect(() => {
        if (!pendingIds) return;
        const load = (): void => {
            for (const attachmentId of pendingIds.split("\u0000")) {
                postAction({ type: "loadImage", attachmentId });
            }
        };
        const target = galleryRef.current;
        if (!target || typeof IntersectionObserver === "undefined") {
            load();
            return;
        }
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                observer.disconnect();
                load();
            }
        }, { rootMargin: "120px" });
        observer.observe(target);
        return () => observer.disconnect();
    }, [pendingIds]);
    useEffect(() => {
        if (!preview?.src) return;
        // Move focus into the dialog on open and restore it on close.
        lightboxRestoreRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        lightboxCloseRef.current?.focus();
        return () => lightboxRestoreRef.current?.focus();
    }, [preview?.src]);
    if (images.length === 0) return null;
    return (
        <>
            <div ref={galleryRef} className="dsh-message-images" aria-label={t("Images")}>
                {images.map((image, index) => {
                    const label = image.name || t("Image {index}", { index: index + 1 });
                    return image.src ? (
                        <button
                            type="button"
                            className="dsh-message-image"
                            title={t("Open original image")}
                            onClick={() => setPreview(image)}
                            key={image.attachmentId ?? `${image.mediaType}:${index}`}
                        >
                            <img src={image.src} alt={label} />
                        </button>
                    ) : (
                        <button
                            type="button"
                            className={`dsh-message-image dsh-image-placeholder ${image.loadState ?? "idle"}`}
                            title={image.error || t("Load image")}
                            disabled={image.loadState === "loading" || !image.attachmentId}
                            onClick={() => {
                                if (image.attachmentId) {
                                    postAction({ type: "loadImage", attachmentId: image.attachmentId });
                                }
                            }}
                            key={image.attachmentId ?? `${image.mediaType}:${index}`}
                        >
                            <span>{image.loadState === "loading" ? t("Loading image...") : image.loadState === "error" ? t("Retry image") : t("Image")}</span>
                            <small>{label}</small>
                        </button>
                    );
                })}
            </div>
            {preview?.src ? (
                <div
                    className="dsh-image-lightbox"
                    role="dialog"
                    aria-modal="true"
                    aria-label={t("Original image preview")}
                    onClick={() => setPreview(undefined)}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") {
                            event.preventDefault();
                            setPreview(undefined);
                        } else if (event.key === "Tab") {
                            event.preventDefault();
                            lightboxCloseRef.current?.focus();
                        }
                    }}
                >
                    <button
                        type="button"
                        ref={lightboxCloseRef}
                        className="dsh-icon-button dsh-image-lightbox-close"
                        title={t("Close")}
                        onClick={() => setPreview(undefined)}
                    >
                        <CloseIcon />
                    </button>
                    <img
                        src={preview.src}
                        alt={preview.name || t("Image")}
                        onClick={(event) => event.stopPropagation()}
                    />
                </div>
            ) : null}
        </>
    );
}
