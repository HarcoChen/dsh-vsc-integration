import { build } from "esbuild";

await build({
    entryPoints: ["webview/src/main.tsx"],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["es2022"],
    outfile: "webview/dist/main.js",
    minify: process.env.NODE_ENV === "production",
    sourcemap: process.env.NODE_ENV === "production" ? false : "linked",
    loader: { ".css": "css" },
});
