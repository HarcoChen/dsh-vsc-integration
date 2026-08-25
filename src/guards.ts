/**
 * Structural guards shared by the wire-parsing and projection layers.
 *
 * This module must stay free of `vscode` imports: most of its consumers are the
 * modules `test/` exercises directly against `dist/`, and pulling the editor API
 * in here would make them unloadable under `node --test`.
 */

import type { DshImageMediaType } from "./types";

/** Narrows to a plain object, excluding arrays and null. */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const IMAGE_MEDIA_TYPES = new Set<string>([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
]);

/**
 * The image media types the chat protocol accepts, as a guard rather than a bare
 * set: every call site pairs the membership test with a `typeof === "string"`
 * check, and narrowing here removes the casts those sites would otherwise need.
 */
export function isImageMediaType(value: unknown): value is DshImageMediaType {
    return typeof value === "string" && IMAGE_MEDIA_TYPES.has(value);
}
