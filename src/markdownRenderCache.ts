import { randomUUID } from "node:crypto";
import { isCopyableCode, renderMarkdownMessage } from "./safeMarkdown";
import { t } from "./localize";
import { ChatMessage } from "./types";

/**
 * Bound on retained render entries. Reached only in very long sessions; the
 * oldest entry is evicted along with the code payloads it owns, so the copyable
 * text cannot outlive the render it came from.
 */
const MAX_ENTRIES = 2_000;

interface RenderEntry {
    source: string;
    reasoningSource?: string;
    html: string;
    renderId: string;
    codeBlocks: ReadonlyMap<string, string>;
    reasoningHtml?: string;
    reasoningRenderId?: string;
}

/**
 * Caches rendered Markdown per message and owns the copyable code payloads the
 * webview later refers to by render id.
 *
 * Keeping both maps here is what makes the pairing safe: a render id is only ever
 * published together with its payload, and evicting or replacing an entry drops
 * the payload in the same step. A code-block action arriving for a discarded
 * render therefore fails closed rather than reading a stale payload.
 */
export class MarkdownRenderCache {
    private readonly entries = new Map<string, RenderEntry>();
    private readonly codeByRenderId = new Map<string, ReadonlyMap<string, string>>();

    /**
     * Renders each message, reusing the cached HTML when neither the text nor the
     * reasoning text changed.
     *
     * @param messages - the messages to render, already image-hydrated.
     * @param scope - distinguishes caches for the same message id across surfaces.
     * @returns the messages with rendered HTML and render ids attached.
     */
    public render(messages: readonly ChatMessage[], scope: string): ChatMessage[] {
        return messages.map((message) => {
            const key = `${scope}:${message.role}:${message.id}`;
            const reasoningSource = message.role === "assistant" && message.reasoning
                ? message.reasoning
                : undefined;
            const cached = this.entries.get(key);
            if (cached?.source === message.text && cached.reasoningSource === reasoningSource) {
                return {
                    ...message,
                    renderedHtml: cached.html,
                    renderId: cached.renderId,
                    ...(cached.reasoningHtml === undefined
                        ? {}
                        : { renderedReasoningHtml: cached.reasoningHtml }),
                    ...(cached.reasoningRenderId === undefined
                        ? {}
                        : { reasoningRenderId: cached.reasoningRenderId }),
                };
            }
            return this.renderFresh(key, message, reasoningSource, cached);
        });
    }

    /**
     * The copyable text of one code block.
     *
     * @param renderId - the render that published the block.
     * @param codeBlockId - the block within that render.
     * @returns the text.
     * @throws when the render was discarded or the block exceeds the copy limit.
     */
    public codeBlockText(renderId: string, codeBlockId: string): string {
        const text = this.codeByRenderId.get(renderId)?.get(codeBlockId);
        if (text === undefined || !isCopyableCode(text)) {
            throw new Error(t("The code block does not exist or exceeds the copy size limit."));
        }
        return text;
    }

    private renderFresh(
        key: string,
        message: ChatMessage,
        reasoningSource: string | undefined,
        cached: RenderEntry | undefined,
    ): ChatMessage {
        const rendered = renderMarkdownMessage(message.text);
        const renderedReasoning = reasoningSource === undefined
            ? undefined
            : renderMarkdownMessage(reasoningSource);
        if (!cached && this.entries.size >= MAX_ENTRIES) {
            const oldest = this.entries.keys().next().value as string | undefined;
            if (oldest !== undefined) {
                const evicted = this.entries.get(oldest);
                if (evicted) this.discard(evicted);
                this.entries.delete(oldest);
            }
        }
        if (cached) this.discard(cached);
        const renderId = randomUUID().replace(/-/gu, "");
        const codeBlocks = new Map(rendered.codeBlocks.map((block) => [block.id, block.text]));
        const reasoningRenderId = renderedReasoning === undefined
            ? undefined
            : randomUUID().replace(/-/gu, "");
        const reasoningCodeBlocks = renderedReasoning === undefined
            ? undefined
            : new Map(renderedReasoning.codeBlocks.map((block) => [block.id, block.text]));
        this.entries.set(key, {
            source: message.text,
            ...(reasoningSource === undefined ? {} : { reasoningSource }),
            html: rendered.html,
            renderId,
            codeBlocks,
            ...(renderedReasoning === undefined ? {} : { reasoningHtml: renderedReasoning.html }),
            ...(reasoningRenderId === undefined ? {} : { reasoningRenderId }),
        });
        this.codeByRenderId.set(renderId, codeBlocks);
        if (reasoningRenderId && reasoningCodeBlocks) {
            this.codeByRenderId.set(reasoningRenderId, reasoningCodeBlocks);
        }
        return {
            ...message,
            renderedHtml: rendered.html,
            renderId,
            ...(renderedReasoning === undefined
                ? {}
                : { renderedReasoningHtml: renderedReasoning.html }),
            ...(reasoningRenderId === undefined ? {} : { reasoningRenderId }),
        };
    }

    private discard(cached: Pick<RenderEntry, "renderId" | "reasoningRenderId">): void {
        this.codeByRenderId.delete(cached.renderId);
        if (cached.reasoningRenderId) {
            this.codeByRenderId.delete(cached.reasoningRenderId);
        }
    }
}
