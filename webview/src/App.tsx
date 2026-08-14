import React from "react";
import { useHostState } from "./bridge";
import { Header } from "./components/Header";
import { MessageList } from "./components/MessageList";
import { Interactions } from "./components/Interactions";
import { ActivityDock } from "./components/ActivityDock";
import { Composer } from "./components/Composer";

export function App(): React.JSX.Element {
    const state = useHostState();
    return (
        <div className="dsh-shell">
            <Header state={state} />
            <MessageList messages={state.messages} submitting={state.submitting} />
            <Interactions interactions={state.interactions} />
            <ActivityDock state={state} />
            <Composer state={state} />
        </div>
    );
}
