import React from "react";

/**
 * File-type glyph shown on a pending attachment card.
 *
 * Ported from the Harness web composer so one file looks the same in the
 * editor panel and in the browser surface: a page silhouette with a folded
 * corner, and a type mark drawn on it. Types the product does not classify
 * fall back to the plain page, exactly as the reference does.
 */

/** Page silhouette: the card body every glyph is drawn on. */
const PAGE =
    "M8.48924 28H19.5108C21.6479 28 22.7165 28 23.5594 27.6509C24.6833 27.1853 25.5762 26.2924 " +
    "26.0417 25.1685C26.3909 24.3256 26.3909 23.257 26.3909 21.1199V8.79443C26.3909 8.32877 " +
    "26.3909 8.09593 26.3471 7.87507C26.2887 7.58058 26.173 7.30042 26.0067 7.05048C25.882 " +
    "6.86303 25.7177 6.69799 25.3893 6.36792L20.0611 1.01354C19.7304 0.681235 19.5651 0.515081 " +
    "19.3769 0.38885C19.126 0.220541 18.8443 0.103463 18.5481 0.0443412C18.3259 0 18.0915 0 " +
    "17.6226 0H8.48924C6.35209 0 5.28351 0 4.4406 0.349145C3.31672 0.814671 2.4238 1.70759 " +
    "1.95828 2.83147C1.60913 3.67438 1.60913 4.74296 1.60913 6.88011V21.1199C1.60913 23.257 " +
    "1.60913 24.3256 1.95828 25.1685C2.4238 26.2924 3.31672 27.1853 4.4406 27.6509C5.28351 28 " +
    "6.35209 28 8.48924 28Z";

/** The folded corner, drawn lighter than the page. */
const FOLD =
    "M26.3909 7.37445L19.0525 0V3.77445C19.0525 4.89271 19.0525 5.45184 19.2352 5.89289C19.4788 " +
    "6.48096 19.946 6.94818 20.5341 7.19176C20.9751 7.37445 21.5342 7.37445 22.6525 " +
    "7.37445H26.3909Z";

const MARK = "translate(14 16) scale(1.12) translate(-14 -16)";
const MARK_WIDE = "translate(14 16) scale(1.22) translate(-14 -16)";

type FileKind =
    | "code"
    | "excel"
    | "html"
    | "image"
    | "markdown"
    | "pdf"
    | "ppt"
    | "video"
    | "word"
    | "zip"
    | "other";

/** Extension to kind, matching the Harness classifier's vocabulary. */
const BY_EXTENSION: Readonly<Record<string, FileKind>> = {
    scss: "code", sass: "code", less: "code", vue: "code", svelte: "code", astro: "code",
    bat: "code", cmd: "code", csv: "code", tsv: "code",
    html: "html", htm: "html",
    png: "image", jpg: "image", jpeg: "image", gif: "image", svg: "image", webp: "image",
    avif: "image", bmp: "image", ico: "image", tif: "image", tiff: "image", heic: "image", heif: "image",
    md: "markdown", mdx: "markdown", markdown: "markdown",
    pdf: "pdf",
    ppt: "ppt", pptx: "ppt", key: "ppt",
    mp4: "video", mov: "video", m4v: "video", webm: "video", mkv: "video", avi: "video",
    mpg: "video", mpeg: "video",
    doc: "word", docx: "word", rtf: "word", odt: "word", pages: "word",
    xls: "excel", xlsx: "excel", xlsm: "excel", numbers: "excel",
    zip: "zip", "7z": "zip", rar: "zip", gz: "zip", tar: "zip",
};

/** Whole-name matches, checked before the extension table. */
const BY_NAME: Readonly<Record<string, FileKind>> = {
    changelog: "markdown",
    contributing: "markdown",
    readme: "markdown",
};

/** Kind for one display name; `other` when the product does not classify it. */
export function fileKind(name: string): FileKind {
    const leaf = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1).toLowerCase();
    const byName = BY_NAME[leaf];
    if (byName !== undefined) return byName;
    const dot = leaf.lastIndexOf(".");
    const extension = dot < 0 ? "" : leaf.slice(dot + 1);
    return BY_EXTENSION[extension] ?? "other";
}

function mark(kind: FileKind): React.JSX.Element | null {
    switch (kind) {
        case "code":
            return (
                <>
                    <path d="M8.61 16.3601L11.76 18.3901V20.1401L7 17.0601V15.6601L11.76 12.5801V14.3301L8.61 16.3601Z" fill="currentColor" />
                    <path d="M16.1918 14.3301V12.5801L20.9518 15.6601V17.0601L16.1918 20.1401V18.3901L19.3418 16.3601L16.1918 14.3301Z" fill="currentColor" />
                </>
            );
        case "markdown":
            return (
                <path d="M8.7588 19.5V14.6H9.8998L11.9298 17.932H11.3278L13.3018 14.6H14.4428L14.4568 19.5H13.1828L13.1688 16.539H13.3858L11.9088 19.017H11.2928L9.7738 16.539H10.0398V19.5H8.7588ZM15.4375 19.5V14.6H17.7545C18.2958 14.6 18.7718 14.7003 19.1825 14.901C19.5932 15.1017 19.9128 15.384 20.1415 15.748C20.3748 16.112 20.4915 16.546 20.4915 17.05C20.4915 17.5493 20.3748 17.9833 20.1415 18.352C19.9128 18.716 19.5932 18.9983 19.1825 19.199C18.7718 19.3997 18.2958 19.5 17.7545 19.5H15.4375ZM16.8235 18.394H17.6985C17.9785 18.394 18.2212 18.3427 18.4265 18.24C18.6365 18.1327 18.7998 17.9787 18.9165 17.778C19.0332 17.5727 19.0915 17.33 19.0915 17.05C19.0915 16.7653 19.0332 16.5227 18.9165 16.322C18.7998 16.1213 18.6365 15.9697 18.4265 15.867C18.2212 15.7597 17.9785 15.706 17.6985 15.706H16.8235V18.394Z" fill="currentColor" />
            );
        case "image":
            return (
                <>
                    <path d="M10.4212 15.9204C10.5756 15.6558 10.9579 15.6558 11.1123 15.9204L13.6493 20.2696C13.8048 20.5362 13.6125 20.8711 13.3037 20.8711H8.22974C7.92102 20.8711 7.72868 20.5362 7.88423 20.2696L10.4212 15.9204Z" fill="currentColor" />
                    <path d="M15.4981 13.186C15.6505 12.9117 16.0451 12.9117 16.1975 13.186L20.1368 20.2769C20.2849 20.5435 20.0922 20.8711 19.7872 20.8711H11.9084C11.6034 20.8711 11.4107 20.5435 11.5588 20.2769L15.4981 13.186Z" fill="currentColor" />
                    <path d="M11.8603 11.3997C11.8603 12.286 11.1418 13.0045 10.2555 13.0045C9.36924 13.0045 8.65076 12.286 8.65076 11.3997C8.65076 10.5134 9.36924 9.79492 10.2555 9.79492C11.1418 9.79492 11.8603 10.5134 11.8603 11.3997Z" fill="currentColor" />
                </>
            );
        case "zip":
            return (
                <>
                    <path d="M13.2 9.5h1.6v1.4h-1.6zM13.2 11.6h1.6v1.4h-1.6zM13.2 13.7h1.6v1.4h-1.6zM13.2 15.8h1.6v1.4h-1.6z" fill="currentColor" />
                    <path d="M12.3 17.2h3.4a1.2 1.2 0 0 1 1.2 1.2v1.3a1.2 1.2 0 0 1-1.2 1.2h-3.4a1.2 1.2 0 0 1-1.2-1.2v-1.3a1.2 1.2 0 0 1 1.2-1.2Z" fill="currentColor" />
                </>
            );
        case "pdf":
            return (
                <path d="M6.80616 19.5V14.6H9.04616C9.49416 14.6 9.87916 14.6723 10.2012 14.817C10.5278 14.9617 10.7798 15.1717 10.9572 15.447C11.1345 15.7177 11.2232 16.0397 11.2232 16.413C11.2232 16.7817 11.1345 17.1013 10.9572 17.372C10.7798 17.6427 10.5278 17.8527 10.2012 18.002C9.87916 18.1467 9.49416 18.219 9.04616 18.219H7.57616L8.19216 17.617V19.5H6.80616ZM8.19216 17.764L7.57616 17.127H8.96216C9.2515 17.127 9.46616 17.064 9.60616 16.938C9.75083 16.812 9.82316 16.637 9.82316 16.413C9.82316 16.1843 9.75083 16.007 9.60616 15.881C9.46616 15.755 9.2515 15.692 8.96216 15.692H7.57616L8.19216 15.055V17.764Z" fill="currentColor" />
            );
        case "word":
            return (
                <path d="M8.2 19.4L6.6 14.6H7.98L9.1 18.36H8.72L9.9 14.6H11.06L12.2 18.36H11.84L13 14.6H14.34L12.72 19.4H11.44L10.36 15.95H10.6L9.48 19.4H8.2Z" fill="currentColor" />
            );
        case "excel":
            return (
                <path d="M10.2932 20.5L13.3532 16.25L13.3432 17.66L10.4032 13.5H12.6332L14.5132 16.21L13.5632 16.22L15.4132 13.5H17.5532L14.6132 17.58V16.18L17.7132 20.5H15.4332L13.5232 17.65H14.4332L12.5532 20.5H10.2932Z" fill="currentColor" />
            );
        case "ppt":
            return (
                <path d="M7.2 19.4V14.6H9.44C9.89 14.6 10.28 14.67 10.6 14.82C10.93 14.96 11.18 15.17 11.36 15.45C11.54 15.72 11.62 16.04 11.62 16.41C11.62 16.78 11.54 17.1 11.36 17.37C11.18 17.64 10.93 17.85 10.6 18C10.28 18.15 9.89 18.22 9.44 18.22H7.97L8.58 17.62V19.4H7.2ZM8.58 17.76L7.97 17.13H9.36C9.65 17.13 9.86 17.07 10 16.94C10.15 16.81 10.22 16.64 10.22 16.41C10.22 16.18 10.15 16.01 10 15.88C9.86 15.75 9.65 15.69 9.36 15.69H7.97L8.58 15.05V17.76ZM12.4 19.4V14.6H14.72C15.26 14.6 15.74 14.7 16.15 14.9C16.56 15.1 16.88 15.38 17.11 15.75C17.34 16.11 17.46 16.55 17.46 17.05C17.46 17.55 17.34 17.98 17.11 18.35C16.88 18.72 16.56 19 16.15 19.2C15.74 19.4 15.26 19.5 14.72 19.5H12.4ZM13.78 18.39H14.66C14.94 18.39 15.18 18.34 15.39 18.24C15.6 18.13 15.76 17.98 15.88 17.78C16 17.57 16.05 17.33 16.05 17.05C16.05 16.77 16 16.52 15.88 16.32C15.76 16.12 15.6 15.97 15.39 15.87C15.18 15.76 14.94 15.71 14.66 15.71H13.78V18.39Z" fill="currentColor" />
            );
        case "video":
            return (
                <path d="M11.6 14.6 17.2 17.5 11.6 20.4V14.6Z" fill="currentColor" />
            );
        case "html":
            return (
                <path d="M13.9994 9.68298C17.212 9.68298 19.8167 12.2872 19.8168 15.4997C19.8168 18.7123 17.2121 21.3171 13.9994 21.3171C10.7869 21.3169 8.18274 18.7122 8.18274 15.4997C8.1829 12.2873 10.787 9.68315 13.9994 9.68298ZM12.42 18.95C12.62 19.5 12.83 19.8 14 19.8C15.17 19.8 15.38 19.5 15.58 18.95C15.78 18.4 15.9 17.3 15.9 16.02H12.1C12.1 17.3 12.22 18.4 12.42 18.95ZM9.26 16.02C9.47 17.92 10.79 19.49 12.56 20.05C12.42 19.8 12.3 19.52 12.19 19.21C11.89 18.35 11.69 17.24 11.64 16.02H9.26Z" fill="currentColor" />
            );
        default:
            return null;
    }
}

/** The page mark is inset for narrow glyphs and widened for wide ones. */
const WIDE: ReadonlySet<FileKind> = new Set(["excel", "markdown", "pdf", "ppt", "word"]);

export function FileTypeIcon({
    name,
    size = 28,
}: {
    name: string;
    size?: number;
}): React.JSX.Element {
    const kind = fileKind(name);
    const body = mark(kind);
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 28 28"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
        >
            <path d={PAGE} fill="currentColor" />
            <path d={FOLD} fill="var(--vscode-editor-background)" fillOpacity="0.7" />
            {body === null ? null : (
                <g
                    className="dsh-file-type-mark"
                    transform={WIDE.has(kind) ? MARK_WIDE : MARK}
                >
                    {body}
                </g>
            )}
        </svg>
    );
}
