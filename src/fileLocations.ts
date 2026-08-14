export const MAX_FILE_LOCATION_PATH_CHARACTERS = 4_096;
export const MAX_FILE_LOCATION_INDEX = 99_999_999;

export interface FileLocation {
    path: string;
    line: number;
    column?: number;
}

export interface FileLocationMatch extends FileLocation {
    start: number;
    end: number;
    text: string;
}

const LOCATION_TOKEN = /[^\s<>"'`()[\]{}*,;]+:[1-9]\d{0,7}(?::[1-9]\d{0,7})?(?!\d|:\d)/gu;
const SPECIAL_BASENAME = /^(?:readme|license|makefile|dockerfile|todo|agents)(?:\.[a-z0-9_-]+)?$/iu;

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/gu, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;",
    })[character] ?? character);
}

function pathLike(value: string): boolean {
    if (
        !value ||
        value.length > MAX_FILE_LOCATION_PATH_CHARACTERS ||
        value.includes("\0") ||
        value.includes("://")
    ) return false;
    const basename = value.split(/[\\/]/u).at(-1) ?? "";
    return value.includes("/") ||
        value.includes("\\") ||
        basename.includes(".") ||
        SPECIAL_BASENAME.test(basename);
}

export function parseFileLocation(value: unknown): FileLocation | undefined {
    if (typeof value !== "string") return undefined;
    const withColumn = /^(.*):([1-9]\d{0,7}):([1-9]\d{0,7})$/u.exec(value);
    const withoutColumn = withColumn
        ? undefined
        : /^(.*):([1-9]\d{0,7})$/u.exec(value);
    const match = withColumn ?? withoutColumn;
    if (!match || !pathLike(match[1] as string)) return undefined;
    const line = Number(match[2]);
    const column = withColumn ? Number(match[3]) : undefined;
    if (
        !Number.isSafeInteger(line) ||
        line <= 0 ||
        line > MAX_FILE_LOCATION_INDEX ||
        (column !== undefined &&
            (!Number.isSafeInteger(column) || column <= 0 || column > MAX_FILE_LOCATION_INDEX))
    ) return undefined;
    return {
        path: match[1] as string,
        line,
        ...(column === undefined ? {} : { column }),
    };
}

export function findFileLocations(text: string): FileLocationMatch[] {
    const matches: FileLocationMatch[] = [];
    for (const token of text.matchAll(LOCATION_TOKEN)) {
        const location = parseFileLocation(token[0]);
        const start = token.index;
        if (!location || start === undefined) continue;
        matches.push({
            ...location,
            start,
            end: start + token[0].length,
            text: token[0],
        });
    }
    return matches;
}

export function renderFileLocationAnchor(
    match: FileLocationMatch,
    code = false,
): string {
    const text = escapeHtml(match.text);
    const label = code ? `<code>${text}</code>` : text;
    return `<a class="file-location-link" role="link" tabindex="0" data-file-path="${escapeHtml(match.path)}" data-file-line="${match.line}"${match.column === undefined ? "" : ` data-file-column="${match.column}"`}>${label}</a>`;
}

/** Fixed-vocabulary path link rendering for host-owned plain text. */
export function renderFileLocationsHtml(text: string): string {
    const matches = findFileLocations(text);
    if (matches.length === 0) return escapeHtml(text);
    let cursor = 0;
    let output = "";
    for (const match of matches) {
        output += escapeHtml(text.slice(cursor, match.start));
        output += renderFileLocationAnchor(match);
        cursor = match.end;
    }
    return output + escapeHtml(text.slice(cursor));
}
