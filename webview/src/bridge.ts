import { useEffect, useState } from "react";
import type { ChatViewState, DshImageUpload } from "../../src/types";
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

function isAddImageDraftMessage(value: unknown): value is { type: "addImageDraft"; image: DshImageUpload } {
    if (!value || typeof value !== "object") return false;
    const message = value as Record<string, unknown>;
    if (message.type !== "addImageDraft" || !message.image || typeof message.image !== "object") return false;
    const image = message.image as Record<string, unknown>;
    return image.mediaType === "image/png" && typeof image.data === "string" && image.data.length > 0 &&
        (image.name === undefined || typeof image.name === "string");
}

function isRevealMessage(value: unknown): value is { type: "revealMessage"; seq: number } {
    if (!value || typeof value !== "object") return false;
    const message = value as Record<string, unknown>;
    return message.type === "revealMessage" && typeof message.seq === "number" && Number.isSafeInteger(message.seq);
}

function isChatViewState(value: unknown): value is ChatViewState {
    if (!value || typeof value !== "object") return false;
    const state = value as Partial<ChatViewState>;
    return Array.isArray(state.messages) && Array.isArray(state.sessions);
}

export type InsertTextHandler = (text: string) => void;
export type SetTextHandler = (text: string) => void;
export type AddImageDraftHandler = (image: DshImageUpload) => void;
export type RevealMessageHandler = (seq: number) => void;

const insertTextSubscribers = new Set<InsertTextHandler>();
const setTextSubscribers = new Set<SetTextHandler>();
const addImageDraftSubscribers = new Set<AddImageDraftHandler>();
const revealMessageSubscribers = new Set<RevealMessageHandler>();
const pendingImageDrafts: DshImageUpload[] = [];
const pendingRevealMessages: number[] = [];

function subscribe<T>(subscribers: Set<T>, handler: T): () => void {
    subscribers.add(handler);
    return () => {
        subscribers.delete(handler);
    };
}

function notify<T>(subscribers: Set<T>, dispatch: (handler: T) => void): void {
    for (const handler of [...subscribers]) dispatch(handler);
}

/** Subscribe to host-initiated cursor insertions; returns an idempotent unsubscribe function. */
export function subscribeInsertText(handler: InsertTextHandler): () => void {
    return subscribe(insertTextSubscribers, handler);
}

/** Subscribe to host-initiated draft replacements; returns an idempotent unsubscribe function. */
export function subscribeSetText(handler: SetTextHandler): () => void {
    return subscribe(setTextSubscribers, handler);
}

/** Subscribe to screenshots captured by the extension host. */
export function subscribeAddImageDraft(handler: AddImageDraftHandler): () => void {
    const unsubscribe = subscribe(addImageDraftSubscribers, handler);
    for (const image of pendingImageDrafts.splice(0)) handler(image);
    return unsubscribe;
}

/** Subscribe to message reveal requests so MessageList owns the DOM scroll operation. */
export function subscribeRevealMessage(handler: RevealMessageHandler): () => void {
    const unsubscribe = subscribe(revealMessageSubscribers, handler);
    for (const seq of pendingRevealMessages.splice(0)) handler(seq);
    return unsubscribe;
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
                notify(insertTextSubscribers, (handler) => handler(data.text));
                return;
            }
            if (isSetTextMessage(data)) {
                notify(setTextSubscribers, (handler) => handler(data.text));
                return;
            }
            if (isAddImageDraftMessage(data)) {
                if (addImageDraftSubscribers.size > 0) {
                    notify(addImageDraftSubscribers, (handler) => handler(data.image));
                } else {
                    pendingImageDrafts.push(data.image);
                }
                return;
            }
            if (isRevealMessage(data)) {
                if (revealMessageSubscribers.size > 0) {
                    notify(revealMessageSubscribers, (handler) => handler(data.seq));
                } else {
                    pendingRevealMessages.push(data.seq);
                }
            }
        };
        window.addEventListener("message", onMessage);
        postAction({ type: "ready" });
        return () => window.removeEventListener("message", onMessage);
    }, []);

    return state;
}
