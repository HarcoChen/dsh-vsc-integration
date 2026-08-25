import {
    escapeHtml,
    findFileLocations,
    renderFileLocationAnchor,
} from "./fileLocations";
import { t } from "./localize";

export const MAX_EXTERNAL_URL_CHARACTERS = 4_096;
export const MAX_COPIED_CODE_BYTES = 65_536;

const MAX_INLINE_DEPTH = 16;
const MAX_BLOCK_DEPTH = 8;
const MARKDOWN_PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/u;
const UNSAFE_URL_CHARACTER = /[\u0000-\u0020\u007f<>"'`\\]/u;
const encoder = new TextEncoder();

export interface RenderedCodeBlock {
    id: string;
    text: string;
}

export interface RenderedMarkdown {
    html: string;
    codeBlocks: RenderedCodeBlock[];
}

export function utf8ByteLength(value: string): number {
    return encoder.encode(value).byteLength;
}

export function isCopyableCode(value: unknown): value is string {
    return typeof value === "string" && utf8ByteLength(value) <= MAX_COPIED_CODE_BYTES;
}

/** Canonicalize only explicit HTTP(S) URLs that are safe to carry through an HTML attribute. */
export function parseSafeHttpUrl(value: unknown): string | undefined {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > MAX_EXTERNAL_URL_CHARACTERS ||
        !/^https?:\/\//iu.test(value) ||
        UNSAFE_URL_CHARACTER.test(value)
    ) {
        return undefined;
    }
    try {
        const parsed = new URL(value);
        if (
            (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
            !parsed.hostname ||
            parsed.username ||
            parsed.password ||
            parsed.href.length > MAX_EXTERNAL_URL_CHARACTERS
        ) {
            return undefined;
        }
        return parsed.href;
    } catch {
        return undefined;
    }
}

function countRun(value: string, index: number, character: string): number {
    let cursor = index;
    while (value[cursor] === character) cursor += 1;
    return cursor - index;
}

function wordCharacter(value: string | undefined): boolean {
    return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

/**
 * CommonMark forbids intraword emphasis for `_` so that identifiers such as
 * `snake_case_name` survive verbatim, while `*` may open inside a word. This
 * checks the simplified flanking condition the scanner needs: an `_` run may
 * only open when the character before it is not a word character, and may only
 * close when the character after it is not one.
 */
function emphasisRunAllowed(
    source: string,
    character: string,
    openStart: number,
    closeEnd: number,
): boolean {
    if (character !== "_") return true;
    return !wordCharacter(source[openStart - 1]) && !wordCharacter(source[closeEnd]);
}

function closingRun(value: string, start: number, character: string, length: number): number {
    let cursor = start;
    while (cursor < value.length) {
        const next = value.indexOf(character, cursor);
        if (next < 0) return -1;
        const run = countRun(value, next, character);
        if (run === length) return next;
        cursor = next + run;
    }
    return -1;
}

function closingBracket(value: string, start: number): number {
    let depth = 0;
    for (let index = start; index < value.length; index += 1) {
        if (value[index] === "\\") {
            index += 1;
        } else if (value[index] === "[") {
            depth += 1;
        } else if (value[index] === "]") {
            if (depth === 0) return index;
            depth -= 1;
        }
    }
    return -1;
}

function closingParenthesis(value: string, start: number): number {
    let depth = 0;
    for (let index = start; index < value.length; index += 1) {
        if (value[index] === "\\") {
            index += 1;
        } else if (value[index] === "(") {
            depth += 1;
        } else if (value[index] === ")") {
            if (depth === 0) return index;
            depth -= 1;
        }
    }
    return -1;
}

function renderInline(source: string, depth = 0): string {
    if (depth >= MAX_INLINE_DEPTH) return escapeHtml(source);
    const fileLocations = findFileLocations(source);
    let fileLocationIndex = 0;
    let output = "";
    let index = 0;
    while (index < source.length) {
        while (
            fileLocationIndex < fileLocations.length &&
            (fileLocations[fileLocationIndex]?.end ?? 0) <= index
        ) fileLocationIndex += 1;
        const fileLocation = fileLocations[fileLocationIndex];
        if (fileLocation?.start === index) {
            output += renderFileLocationAnchor(fileLocation);
            index = fileLocation.end;
            fileLocationIndex += 1;
            continue;
        }
        const character = source[index];
        if (
            character === "\\" &&
            index + 1 < source.length &&
            MARKDOWN_PUNCTUATION.test(source[index + 1] as string)
        ) {
            output += escapeHtml(source[index + 1] as string);
            index += 2;
            continue;
        }
        if (character === "`") {
            const length = countRun(source, index, "`");
            const closing = closingRun(source, index + length, "`", length);
            if (closing >= 0) {
                let code = source.slice(index + length, closing).replace(/\r?\n/gu, " ");
                if (code.startsWith(" ") && code.endsWith(" ") && code.trim()) {
                    code = code.slice(1, -1);
                }
                const codeLocation = findFileLocations(code);
                output += codeLocation.length === 1 &&
                    codeLocation[0]?.start === 0 &&
                    codeLocation[0].end === code.length
                    ? renderFileLocationAnchor(codeLocation[0], true)
                    : `<code>${escapeHtml(code)}</code>`;
                index = closing + length;
                continue;
            }
        }
        if (character === "[") {
            const labelEnd = closingBracket(source, index + 1);
            if (labelEnd >= 0 && source[labelEnd + 1] === "(") {
                const targetEnd = closingParenthesis(source, labelEnd + 2);
                if (targetEnd >= 0) {
                    const label = renderInline(source.slice(index + 1, labelEnd), depth + 1);
                    let target = source.slice(labelEnd + 2, targetEnd).trim();
                    if (target.startsWith("<") && target.endsWith(">")) {
                        target = target.slice(1, -1);
                    }
                    const url = parseSafeHttpUrl(target);
                    output += url
                        ? `<a class="markdown-link" role="link" tabindex="0" data-external-url="${escapeHtml(url)}">${label}</a>`
                        : label;
                    index = targetEnd + 1;
                    continue;
                }
            }
        }
        if (character === "*" || character === "_") {
            const run = Math.min(countRun(source, index, character), 2);
            const closing = closingRun(source, index + run, character, run);
            if (closing > index + run && emphasisRunAllowed(source, character, index, closing + run)) {
                const inner = renderInline(source.slice(index + run, closing), depth + 1);
                const tag = run === 2 ? "strong" : "em";
                output += `<${tag}>${inner}</${tag}>`;
                index = closing + run;
                continue;
            }
        }
        let end = index + 1;
        while (
            end < source.length &&
            end < (fileLocation?.start ?? source.length) &&
            !"\\`[*_".includes(source[end] as string)
        ) end += 1;
        output += escapeHtml(source.slice(index, end));
        index = end;
    }
    return output;
}

interface Fence {
    character: "`" | "~";
    length: number;
    language?: string;
}

function fenceAt(line: string): Fence | undefined {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (!match) return undefined;
    const marker = match[1] as string;
    const info = (match[2] as string).trim();
    if (marker[0] === "`" && info.includes("`")) return undefined;
    const candidate = info.split(/\s+/u)[0];
    return {
        character: marker[0] as "`" | "~",
        length: marker.length,
        ...(candidate && /^[\p{L}\p{N}_+.#-]{1,40}$/u.test(candidate)
            ? { language: candidate }
            : {}),
    };
}

function closesFence(line: string, fence: Fence): boolean {
    const match = /^ {0,3}(`+|~+)\s*$/u.exec(line);
    return Boolean(
        match &&
        (match[1] as string)[0] === fence.character &&
        (match[1] as string).length >= fence.length,
    );
}

function unorderedItem(line: string): string | undefined {
    const match = /^ {0,3}[-+*]\s+(.+)$/u.exec(line);
    return match?.[1];
}

function orderedItem(line: string): string | undefined {
    const match = /^ {0,3}\d{1,9}[.)]\s+(.+)$/u.exec(line);
    return match?.[1];
}

function blockquoteItem(line: string): string | undefined {
    const match = /^ {0,3}> ?(.*)$/u.exec(line);
    return match?.[1];
}

function tableCells(line: string): string[] | undefined {
    const trimmed = line.trim();
    if (!trimmed.includes("|")) return undefined;
    const source = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
    const withoutTrailingPipe = source.endsWith("|") ? source.slice(0, -1) : source;
    const cells: string[] = [];
    let cell = "";
    for (let index = 0; index < withoutTrailingPipe.length; index += 1) {
        const character = withoutTrailingPipe[index];
        if (character === "\\" && withoutTrailingPipe[index + 1] === "|") {
            cell += "\\|";
            index += 1;
        } else if (character === "|") {
            cells.push(cell.trim());
            cell = "";
        } else {
            cell += character;
        }
    }
    cells.push(cell.trim());
    return cells.length > 1 ? cells : undefined;
}

type TableAlignment = "left" | "center" | "right";

function tableAlignment(cell: string): TableAlignment | undefined {
    const value = cell.trim();
    if (!/^:?-{3,}:?$/u.test(value)) return undefined;
    return value.startsWith(":")
        ? value.endsWith(":") ? "center" : "left"
        : value.endsWith(":") ? "right" : "left";
}

function tableStart(lines: readonly string[], index: number): boolean {
    const header = tableCells(lines[index] as string);
    const separator = index + 1 < lines.length ? tableCells(lines[index + 1] as string) : undefined;
    return header !== undefined && separator !== undefined &&
        header.length === separator.length && separator.every((cell) => tableAlignment(cell) !== undefined);
}

function tableBlock(
    lines: readonly string[],
    index: number,
): { html: string; nextIndex: number } | undefined {
    if (!tableStart(lines, index)) return undefined;
    const header = tableCells(lines[index] as string) as string[];
    const separator = tableCells(lines[index + 1] as string) as string[];
    const alignments = separator.map((cell) => tableAlignment(cell) as TableAlignment);
    const rows: string[][] = [];
    let nextIndex = index + 2;
    while (nextIndex < lines.length) {
        const row = tableCells(lines[nextIndex] as string);
        if (row === undefined || !(lines[nextIndex] as string).trim()) break;
        rows.push(row);
        nextIndex += 1;
    }
    const cell = (tag: "th" | "td", value: string, column: number): string =>
        `<${tag} class="markdown-table-cell-${alignments[column]}">${renderInline(value)}</${tag}>`;
    const headerHtml = header.map((value, column) => cell("th", value, column)).join("");
    const bodyHtml = rows.map((row) => {
        const values = alignments.map((_alignment, column) => row[column] ?? "");
        return `<tr>${values.map((value, column) => cell("td", value, column)).join("")}</tr>`;
    }).join("");
    return {
        html: `<div class="markdown-table-wrap"><table><thead><tr>${headerHtml}</tr></thead>${bodyHtml ? `<tbody>${bodyHtml}</tbody>` : ""}</table></div>`,
        nextIndex,
    };
}

function heading(line: string): { level: number; content: string } | undefined {
    const match = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    return match ? { level: (match[1] as string).length, content: match[2] as string } : undefined;
}

function startsBlock(line: string): boolean {
    return Boolean(
        fenceAt(line) ||
        heading(line) ||
        unorderedItem(line) !== undefined ||
        orderedItem(line) !== undefined ||
        blockquoteItem(line) !== undefined,
    );
}

function codeBlock(
    code: string,
    language: string | undefined,
    codeBlocks: RenderedCodeBlock[],
): string {
    const canCopy = isCopyableCode(code);
    const label = language ? escapeHtml(language) : "Code";
    const id = canCopy ? `code-${codeBlocks.length}` : undefined;
    if (id) codeBlocks.push({ id, text: code });
    if (!id) {
        return `<div class="markdown-code-block"><div class="markdown-code-head"><span>${label}</span><button type="button" class="markdown-code-action markdown-code-copy" disabled title="${escapeHtml(t("Code block exceeds the copy limit"))}">${escapeHtml(t("Too large"))}</button></div><pre><code>${escapeHtml(code)}</code></pre></div>`;
    }
    const languageAttribute = language ? ` data-code-language="${escapeHtml(language)}"` : "";
    const action = (type: "copyCode" | "insertCode" | "openCode" | "applyCode", text: string): string =>
        `<button type="button" class="markdown-code-action${type === "copyCode" ? " markdown-code-copy" : ""}" data-code-action="${type}" data-code-block-id="${id}"${type === "copyCode" ? ` data-copy-code-id="${id}"` : ""}${languageAttribute}>${escapeHtml(text)}</button>`;
    return `<div class="markdown-code-block"><div class="markdown-code-head"><span>${label}</span><div class="markdown-code-actions">${action("copyCode", t("Copy"))}${action("insertCode", t("Insert"))}${action("openCode", t("Open"))}${action("applyCode", t("Apply"))}</div></div><pre><code>${escapeHtml(code)}</code></pre></div>`;
}

function renderBlocks(source: string, codeBlocks: RenderedCodeBlock[], depth = 0): string {
    if (depth >= MAX_BLOCK_DEPTH) return `<p>${escapeHtml(source)}</p>`;
    const lines = source.split("\n");
    const blocks: string[] = [];
    let index = 0;
    while (index < lines.length) {
        const line = lines[index] as string;
        if (!line.trim()) {
            index += 1;
            continue;
        }
        const fence = fenceAt(line);
        if (fence) {
            index += 1;
            const code: string[] = [];
            while (index < lines.length && !closesFence(lines[index] as string, fence)) {
                code.push(lines[index] as string);
                index += 1;
            }
            if (index < lines.length) index += 1;
            blocks.push(codeBlock(code.join("\n"), fence.language, codeBlocks));
            continue;
        }
        const table = tableBlock(lines, index);
        if (table) {
            blocks.push(table.html);
            index = table.nextIndex;
            continue;
        }
        const title = heading(line);
        if (title) {
            blocks.push(`<h${title.level}>${renderInline(title.content)}</h${title.level}>`);
            index += 1;
            continue;
        }
        const quote = blockquoteItem(line);
        if (quote !== undefined) {
            const quoted = [quote];
            index += 1;
            while (index < lines.length) {
                const next = blockquoteItem(lines[index] as string);
                if (next === undefined) break;
                quoted.push(next);
                index += 1;
            }
            blocks.push(`<blockquote>${renderBlocks(quoted.join("\n"), codeBlocks, depth + 1)}</blockquote>`);
            continue;
        }
        const unordered = unorderedItem(line);
        if (unordered !== undefined) {
            const items = [unordered];
            index += 1;
            while (index < lines.length) {
                const next = unorderedItem(lines[index] as string);
                if (next === undefined) break;
                items.push(next);
                index += 1;
            }
            blocks.push(`<ul>${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`);
            continue;
        }
        const ordered = orderedItem(line);
        if (ordered !== undefined) {
            const items = [ordered];
            index += 1;
            while (index < lines.length) {
                const next = orderedItem(lines[index] as string);
                if (next === undefined) break;
                items.push(next);
                index += 1;
            }
            blocks.push(`<ol>${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ol>`);
            continue;
        }
        const paragraph = [line];
        index += 1;
        while (
            index < lines.length &&
            (lines[index] as string).trim() &&
            !startsBlock(lines[index] as string) &&
            !tableStart(lines, index)
        ) {
            paragraph.push(lines[index] as string);
            index += 1;
        }
        blocks.push(`<p>${renderInline(paragraph.join("\n"))}</p>`);
    }
    return blocks.join("");
}

/** Render the supported Markdown subset with a fixed tag/attribute vocabulary. Raw HTML is text. */
export function renderSafeMarkdown(markdown: string): string {
    return renderMarkdownMessage(markdown).html;
}

/** Render together with host-only code payloads; code text is never embedded in an action. */
export function renderMarkdownMessage(markdown: string): RenderedMarkdown {
    const codeBlocks: RenderedCodeBlock[] = [];
    return {
        html: renderBlocks(markdown.replace(/\r\n?/gu, "\n"), codeBlocks),
        codeBlocks,
    };
}
