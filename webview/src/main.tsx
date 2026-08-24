import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/markdown.css";
import "./styles/dock.css";
import "./styles/usage.css";

const mount = document.getElementById("root");
if (mount) {
    createRoot(mount).render(<App />);
}
