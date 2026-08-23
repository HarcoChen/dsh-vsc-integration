import React from "react";
import type {
    ChatLspLocationView,
    ChatLspResultView,
    ChatWebResultView,
    ChatWebSourceView,
} from "../../../src/types";
import { t } from "../i18n";

function WebLink({
    location,
    label,
    className,
}: {
    location: Pick<ChatWebSourceView, "url" | "href">;
    label: string;
    className: string;
}): React.JSX.Element {
    return location.href ? (
        <button
            type="button"
            className={className}
            data-external-url={location.href}
            title={location.url}
        >
            {label}
        </button>
    ) : <span className={`${className} dsh-web-link-disabled`}>{label}</span>;
}

export function WebToolResult({ web }: { web: ChatWebResultView }): React.JSX.Element {
    if (web.kind === "fetch") {
        return (
            <div className="dsh-web-result dsh-web-fetch">
                <WebLink location={web} label={web.url} className="dsh-web-fetch-url" />
                <div className="dsh-web-meta">
                    {web.domain ? <span>{web.domain}</span> : null}
                    <span className={web.statusCode >= 400 ? "dsh-web-status-error" : ""}>
                        HTTP {web.statusCode}
                    </span>
                    {web.truncated ? <span>{t("Content truncated")}</span> : null}
                </div>
            </div>
        );
    }
    const empty = !web.answer && web.sources.length === 0;
    return (
        <div className="dsh-web-result dsh-web-search">
            {web.answer ? <div className="dsh-web-answer">{web.answer}</div> : null}
            {empty ? <div className="dsh-web-empty">{t("No results found")}</div> : (
                <ol className="dsh-web-sources">
                    {web.sources.map((source, index) => (
                        <li key={`${source.url}:${index}`}>
                            <WebLink
                                location={source}
                                label={source.title || source.domain || source.url}
                                className="dsh-web-source-link"
                            />
                            {source.snippet ? <div className="dsh-web-snippet">{source.snippet}</div> : null}
                            {source.domain || source.publishedAt ? (
                                <div className="dsh-web-meta">
                                    {source.domain ? <span>{source.domain}</span> : null}
                                    {source.publishedAt ? <span>{source.publishedAt}</span> : null}
                                </div>
                            ) : null}
                        </li>
                    ))}
                </ol>
            )}
            {web.truncated ? <div className="dsh-web-truncated">{t("Source list truncated")}</div> : null}
        </div>
    );
}

function LspLocationLink({ location }: { location: ChatLspLocationView }): React.JSX.Element {
    return location.path && location.line ? (
        <button
            type="button"
            className="dsh-lsp-location"
            data-file-path={location.path}
            data-file-line={location.line}
            {...(location.character === undefined
                ? {}
                : { "data-file-column": location.character })}
        >
            {location.label}
        </button>
    ) : <span>{location.label}</span>;
}

function lspOperationLabel(operation: ChatLspResultView["operation"]): string {
    switch (operation) {
        case "goToDefinition": return t("Definition");
        case "findReferences": return t("References");
        case "goToImplementation": return t("Implementations");
        case "hover": return "Hover";
    }
}

export function LspToolResult({ lsp }: { lsp: ChatLspResultView }): React.JSX.Element {
    return (
        <div className="dsh-lsp-result">
            <div className="dsh-lsp-head">
                <strong>{lspOperationLabel(lsp.operation)}</strong>
                <span>{t("Query")}: <LspLocationLink location={lsp.query} /></span>
            </div>
            {lsp.empty ? <div className="dsh-lsp-empty">{t("No LSP results")}</div> : null}
            {lsp.kind === "locations" && lsp.locations.length ? (
                <ol className="dsh-lsp-locations">
                    {lsp.locations.map((location, index) => (
                        <li key={`${location.label}:${index}`}>
                            <LspLocationLink location={location} />
                        </li>
                    ))}
                </ol>
            ) : null}
            {lsp.kind === "hover" && lsp.content ? (
                <pre className="dsh-lsp-hover">{lsp.content}</pre>
            ) : null}
            {lsp.kind === "locations" && lsp.notices.length ? (
                <div className="dsh-lsp-notices">
                    {lsp.notices.map((notice, index) => <div key={`${notice}:${index}`}>{notice}</div>)}
                </div>
            ) : null}
            {lsp.truncated ? <div className="dsh-lsp-truncated">{t("LSP result truncated")}</div> : null}
        </div>
    );
}
