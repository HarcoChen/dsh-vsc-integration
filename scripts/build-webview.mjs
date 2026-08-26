import { build } from "esbuild";

const production = process.env.NODE_ENV === "production";
const shared = {
    bundle: true,
    platform: "browser",
    target: ["es2022"],
    minify: production,
    sourcemap: production ? false : "linked",
};

// The chat view: React, mounted into the sidebar webview.
await build({
    ...shared,
    entryPoints: ["webview/src/main.tsx"],
    format: "iife",
    outfile: "webview/dist/main.js",
    loader: { ".css": "css" },
});

// The Trace panel stylesheet. Its markup and client script still live in
// src/tracePanel.ts; only the styles have moved out so far.
await build({
    ...shared,
    entryPoints: ["webview/src/trace/trace.css"],
    outfile: "webview/dist/trace.css",
});
