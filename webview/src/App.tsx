import React from "react";
import { useHostState } from "./bridge";
import { Header } from "./components/Header";
import { MessageList } from "./components/MessageList";
import { Interactions } from "./components/Interactions";
import { ActivityDock } from "./components/dock/ActivityDock";
import { Composer } from "./components/Composer";
import { TokenUsageBar } from "./components/TokenUsageBar";
import { TodoPanel } from "./components/TodoPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { StatusBanner } from "./components/StatusBanner";

export function App(): React.JSX.Element {
    const state = useHostState();
    return (
        <div className={`dsh-shell${state.focusMode ? " dsh-focus-mode" : ""}`}>
            <Header state={state} />
            <StatusBanner state={state} />
            {!state.focusMode && state.settings ? <SettingsPanel settings={state.settings} /> : null}
            <MessageList
                messages={state.messages}
                submitting={state.submitting}
                agentStatusLabel={state.agentStatusLabel}
            />
            {!state.focusMode ? <Interactions interactions={state.interactions} /> : null}
            {!state.focusMode ? <ActivityDock state={state} /> : null}
            {!state.focusMode ? <TodoPanel todos={state.todos ?? []} /> : null}
            {!state.focusMode ? <TokenUsageBar usage={state.tokenUsage} /> : null}
            <Composer state={state} />
        </div>
    );
}
