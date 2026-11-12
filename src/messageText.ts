import type { ChatMessage } from "./types";

/** Human-readable prompt text, including a skill-only invocation. */
export function messageText(message: Pick<ChatMessage, "text" | "skillInvocation">): string {
    return message.skillInvocation ? `/${message.skillInvocation}${message.text ? ` ${message.text}` : ""}` : message.text;
}
