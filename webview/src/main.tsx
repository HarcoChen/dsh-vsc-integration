import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/tokens.css";
import "./styles/app.css";

const mount = document.getElementById("root");
if (mount) {
    createRoot(mount).render(<App />);
}
