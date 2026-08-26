/**
 * Error-to-text formatting shared by the host modules.
 *
 * Kept free of `vscode` imports so it stays usable from the modules `test/`
 * loads directly from `dist/`.
 */

/** The message of an Error, or the stringified value for a non-Error throw. */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
