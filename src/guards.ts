/**
 * Structural guards shared by the wire-parsing and projection layers.
 *
 * This module must stay free of `vscode` imports: most of its consumers are the
 * modules `test/` exercises directly against `dist/`, and pulling the editor API
 * in here would make them unloadable under `node --test`.
 */

/** Narrows to a plain object, excluding arrays and null. */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
