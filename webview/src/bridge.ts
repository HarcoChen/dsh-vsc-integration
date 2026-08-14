import { useEffect, useState } from "react";
import type { ChatViewState } from "../../src/types";
import type { ChatViewAction } from "../../src/chatViewProtocol";
import { DEFAULT_STATE } from "./state";

export const WEBVIEW_PROTOCOL_VERSION = 1 as const;

export interface VsCodeApi {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}

declare global {
    interface Window {
        acquireVsCodeApi?: () => VsCodeApi;
    }
}

/** Standalone dev page (webview/index.html) has no VS Code host; keep the UI alive with a no-op bridge. */
function createDevApi(): VsCodeApi {
    let saved: unknown;
    return {
        postMessage(message: unknown): void {
            console.log("[dsh-dev] postMessage", message);
        },
        getState(): unknown {
            return saved;
        },
        setState(state: unknown): void {
            saved = state;
        },
    };
}

let api: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi {
    if (!api) {
        api = typeof window.acquireVsCodeApi === "function"
            ? window.acquireVsCodeApi()
            : createDevApi();
    }
    return api;
}

/**
 * Post a webview action to the host.
 *
 * Do NOT attach a `protocol` field: parseChatViewAction validates openExternalLink,
 * copyCode and retryPrompt with hasOnly(...), so any extra key gets the message rejected.
 */
export function postAction(action: ChatViewAction): void {
    getVsCodeApi().postMessage(action);
}

interface HostStateMessage {
    type: "state";
    protocol: typeof WEBVIEW_PROTOCOL_VERSION;
    state: ChatViewState;
}

function isHostStateMessage(value: unknown): value is HostStateMessage {
    if (!value || typeof value !== "object") return false;
    const message = value as Record<string, unknown>;
    return (
        message.type === "state" &&
        message.protocol === WEBVIEW_PROTOCOL_VERSION &&
        typeof message.state === "object" &&
        message.state !== null
    );
}

function isInsertTextMessage(value: unknown): value is { type: "insertText"; text: string } {
    if (!value || typeof value !== "object") return false;
    const message = value as Record<string, unknown>;
    return message.type === "insertText" && typeof message.text === "string";
}

function isSetTextMessage(value: unknown): value is { type: "setText"; text: string } {
    if (!value || typeof value !== "object") return false;
    const message = value as Record<string, unknown>;
    return message.type === "setText" && typeof message.text === "string";
}

function isChatViewState(value: unknown): value is ChatViewState {
    if (!value || typeof value !== "object") return false;
    const state = value as Partial<ChatViewState>;
    return Array.isArray(state.messages) && Array.isArray(state.sessions);
}

export type InsertTextHandler = (text: string) => void;
export type SetTextHandler = (text: string) => void;

let insertTextHandler: InsertTextHandler | undefined;
let setTextHandler: SetTextHandler | undefined;

/** Called by the composer to own host-initiated cursor insertions. */
export function registerInsertTextHandler(handler: InsertTextHandler | undefined): void {
    insertTextHandler = handler;
}

/** Called by the composer to own host-initiated draft replacements. */
export function registerSetTextHandler(handler: SetTextHandler | undefined): void {
    setTextHandler = handler;
}

/**
 * Single source of truth for host state: restores the last pushed state via
 * vscode.getState, subscribes to full-state pushes, persists every update via
 * vscode.setState, and performs the ready handshake once mounted.
 */
export function useHostState(): ChatViewState {
    const [state, setState] = useState<ChatViewState>(() => {
        const saved = getVsCodeApi().getState();
        return isChatViewState(saved) ? { ...DEFAULT_STATE, ...saved } : DEFAULT_STATE;
    });

    useEffect(() => {
        const vscode = getVsCodeApi();
        const onMessage = (event: MessageEvent): void => {
            const data: unknown = event.data;
            if (isHostStateMessage(data)) {
                setState(data.state);
                vscode.setState(data.state);
                return;
            }
            if (isInsertTextMessage(data)) {
                insertTextHandler?.(data.text);
                return;
            }
            if (isSetTextMessage(data)) {
                setTextHandler?.(data.text);
            }
        };
        window.addEventListener("message", onMessage);
        postAction({ type: "ready" });
        return () => window.removeEventListener("message", onMessage);
    }, []);

    return state;
}
