<p align="center">
  <img src="resources/dsh.png" alt="DSH IDE" width="96">
</p>

# DeepSeek Harness for VS Code

**English** · [简体中文](README.zh-CN.md)

Bring DeepSeek Harness (DSH) into VS Code. Work with editor context, approve tool calls, review native diffs, and follow tasks through Trace and usage insights.

<p align="center">
  <img src="https://img.shields.io/badge/dsh_target-0.2.2--rc.1-2f6feb?style=flat-square" alt="dsh target 0.2.2-rc.1">
  <img src="https://img.shields.io/badge/Laya%20%2F%20Jev-built--in-8250df?style=flat-square" alt="Laya / Jev built-in">
  <img src="https://img.shields.io/badge/setup-zero--config-1a7f37?style=flat-square" alt="Zero-config setup">
</p>

<p align="center">
  <a href="https://open-vsx.org/extension/harcochen/dsh-vsc-integration"><img src="https://img.shields.io/open-vsx/dt/harcochen/dsh-vsc-integration?style=flat-square&label=Open%20VSX%20downloads" alt="Open VSX downloads"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=HarcoChen.dsh-vsc-integration"><img src="https://vsmarketplacebadges.dev/installs-short/HarcoChen.dsh-vsc-integration.svg?style=flat-square" alt="VS Code Marketplace installs"></a>
  <a href="https://github.com/HarcoChen/dsh-vsc-integration/stargazers"><img src="https://img.shields.io/github/stars/HarcoChen/dsh-vsc-integration?style=flat-square" alt="GitHub Stars"></a>
  <a href="https://github.com/HarcoChen/dsh-vsc-integration/blob/main/LICENSE"><img src="https://img.shields.io/github/license/HarcoChen/dsh-vsc-integration?style=flat-square" alt="License"></a>
</p>

[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=HarcoChen.dsh-vsc-integration) · [Open VSX](https://open-vsx.org/extension/harcochen/dsh-vsc-integration) · [Download VSIX](https://github.com/HarcoChen/dsh-vsc-integration/releases)

![DSH workflow demo](public/scene-intro.gif)

## Get started

Requires VS Code **1.106.0+**. The Runtime compatibility target is **dsh 0.2.2-rc.1**.

1. Install the extension from one of the links above. For a downloaded `.vsix`, run `Extensions: Install from VSIX...`.
2. Install and launch DeepSeek Desktop, which registers the `dsh` command. Open and trust your project folder, then run `DSH: Open Chat`. [Desktop download](https://www.deepseek.com/en/download/)
3. Run `DSH: Configure API Key` for DeepSeek credentials. For other providers, use `DSH: Open dsh Web UI in Browser`. Select or register a DSH Workspace and choose a model.
4. Send a task. Use `@` to attach context, respond to approval cards, and open tool diffs to review changes.

A DSH Workspace groups sessions in Harness and can be associated with a project path. Sessions on the same Runtime can also be continued in its Web UI.

## Features

- **Native review** with side-by-side tool diffs, proposed file changes before approval, and support for files outside Git.
- **Editor context** from files, selections, symbols, diagnostics, Git diffs and paused debugger state.
- **Persistent sessions** with independent editor tabs, conversation outlines, search, archive and Markdown/JSON/ZIP export.
- **Task visibility** through Trace, Activity, subagents, Todos, token usage and model cost estimates.
- **Runtime tools** for terminals, schedules, account management and plugin installation.
- **Worktree and PR review** through the optional official `@deepseek-ai/dsh-experimental-forge-bundle`.
- **Inline completion** and optional agent-driven debugging, with automatic completion and autonomous debugging off by default.

## Configuration

Search `dsh` in VS Code settings for all options. Commands are available under `DSH` in the Command Palette. The interface follows VS Code's English or Simplified Chinese display language.

Connect to an existing Runtime by setting `dsh.serverUrl` to its launch URL, including the token, or use `dsh.serverToken` separately. Remote hosts require HTTPS. Set `dsh.connectionMode` to `attach-only` to use existing processes. `DSH: Connect to Desktop` accepts a connection address from Desktop's `dsh-vscode-connect` plugin.

The bundled Laya / Jev integration provides loop detection, output shaping, completion checks, tool pruning and skill routing. Enable `dsh.jev.enabled` and the individual features you want, run `DSH: Configure Jev API Key`, then accept the Runtime restart. The key is encrypted in SecretStorage. Enabled features may send the samples they need to the configured endpoint. This integration applies to Runtimes launched by the extension.

For Laya, set `dsh.jev.baseUrl` to a compatible HTTPS System One endpoint and `dsh.jev.model` to its model name. Configure an API key, using a placeholder if the server accepts one.

## Troubleshooting

Run `DSH: Diagnose Environment`, then `DSH: Show dsh Runtime Logs`. Include the extension version, OS and redacted error details when reporting an issue. [Report an issue](https://github.com/HarcoChen/dsh-vsc-integration/issues)

Local Runtime configuration is backed up on launch and file changes, keeping the latest 10 snapshots per DSH Home/profile. Run `DSH: Open Configuration Backups` to retrieve files for manual recovery.

## Development

Use Node.js 22+ and initialize the bundled integration before building.

```bash
git submodule update --init --recursive
npm ci
npm run check
npm run package
```

`npm test` runs the release checks. Runtime compatibility and integration results are recorded in the maintenance report. Companion extensions can use the exported navigation and agent-status APIs. [Maintenance report](MAINTENANCE.md) · [Extension API](src/agentStatusPresentation.ts)

<details>
<summary>Release workflow</summary>

Record changes under `Unreleased` in `CHANGELOG.md`. Run `npm run release -- patch` for a patch release, then push the commit and tag with `git push origin HEAD --follow-tags`. Stable releases use even minor versions and previews use the next odd minor. Numeric previews receive the Marketplace pre-release marker. Versions with a SemVer pre-release suffix go to Open VSX and GitHub Releases.

Marketplace publishing uses GitHub OIDC and `vsce 4.1.0`. Before the first publish, create a Trusted Publishing policy under publisher `harcochen`, with owner `HarcoChen`, repository `dsh-vsc-integration`, workflow `release.yml`, and Environment empty. [Trusted Publishing setup](https://developer.microsoft.com/blog/trusted-publishing-visual-studio-marketplace/)

</details>

## Project

An independent community project. The runner sprite draws on `dsh-reasoning-effort`, and the conversation outline was inspired by `dsh-milestone`. [Sprite reference](https://github.com/HanaAyane/dsh-reasoning-effort)

[Changelog](CHANGELOG.md) · [JetBrains edition](https://github.com/HarcoChen/dsh-intellij-integration) · [MIT License](LICENSE)
