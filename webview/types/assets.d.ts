/**
 * Style sheets are side-effect imports resolved by the esbuild CSS loader
 * (see scripts/build-webview.mjs); they contribute no values to the module graph.
 */
declare module "*.css";
