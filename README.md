# DSH IDE

A community VS Code client for the `dsh web` runtime, built for agent workflows that should stay inside the editor.

**English** | [简体中文](README.zh-CN.md)

> **Note**: This is an independent community project and is not officially affiliated with or maintained by DeepSeek. DSH IDE only acts as a VS Code client for a `dsh-compatible` Web Runtime.

## Highlights

- **Agent-native chat**: streaming responses, reasoning folds, tool cards, retry, cancel, queue and steer modes in a React-powered Secondary Sidebar.
- **Human-in-the-loop controls**: answer approvals and structured questions, review Markdown plans, and continue planning with feedback without leaving VS Code.
- **IDE-aware context**: attach the current selection, files, diagnostics and Git diff; insert stable `@file#Lx-y` references without copying entire files into the prompt.
- **Persistent agent workflows**: inspect Goals, queued messages, Subagent trees and background Jobs from a compact activity dock.
- **Session workflow**: create, switch, search, rename, fork and archive sessions while preserving authoritative Harness state.
- **Local slash commands**: type `/` for command discovery and run `/ide`, `/new`, `/search`, `/model`, `/focus`, `/trace` or `/stop` directly from the composer.
- **Runtime and security boundaries**: start, stop or attach to `dsh web`; strict Webview CSP, validated messages, sanitized Markdown and SecretStorage-backed credentials keep host capabilities outside the UI sandbox.
- **Trace and observability**: jump from a message to its session trace, inspect runtime state, open logs, and monitor DeepSeek balance from the status bar.

## Features

The chat view is a React Webview backed by a typed, full-state bridge. The Extension Host remains responsible for VS Code APIs, runtime RPC, credentials, Markdown sanitization and action validation. This keeps the interface responsive without moving trusted operations into browser code.

DSH IDE consumes the public `dsh` Web RPC and projection surface. Features that are not exposed by that public boundary are not emulated with hidden endpoints or prompt conventions.

## Installation

```bash
npm install
npm run check
npm run package
```

Install the generated `.vsix` via `Extensions: Install from VSIX...`.

## Usage

1. Open a trusted workspace.
2. Open DSH Chat (`Ctrl+Shift+Alt+D` / `Cmd+Shift+Alt+D`).
3. Attach a file, selection, diagnostics or unstaged Git diff, or type `/` to open the local command menu.
4. Send a prompt and handle tool approvals, questions and plan reviews directly in the chat view.

If dsh reports a missing or invalid API key, click `Key` in the chat header or run `DSH: Configure API Key`. The value is sent to dsh's credential service and an encrypted copy is kept in VS Code SecretStorage for the balance indicator; it is not written to prompts, extension state, or logs.

## Configuration

```jsonc
{
  "dsh.command": "npx",
  "dsh.commandArgs": ["-y", "@deepseek-ai/dsh", "web"]
}
```

- `dsh.command` / `dsh.commandArgs`: command used to start `dsh web`.
- `dsh.serverUrl`: connect to an existing runtime instead of spawning one.
- `dsh.serverPort`: port for local runtime; `0` means auto-select.
- `dsh.maxContextBytes`: max UTF-8 bytes of the `<ide_context>` block.
- `dsh.apiKeyEnv`: credential reference used by `DSH: Configure API Key` (defaults to `DEEPSEEK_API_KEY`).
- `dsh.balanceRefreshIntervalMs`: DeepSeek balance refresh interval (default: 30 seconds).

The balance indicator calls DeepSeek's official `/user/balance` endpoint. The runtime remains the source of truth for chat credentials; the encrypted SecretStorage copy is used only for this read-only balance request.

## Development

```bash
npm install
npm run check      # TypeScript check
npm run compile    # Build to dist/
npm run package    # Compile + vsce package
```

Press `F5` in VS Code to launch the Extension Development Host.

## Documentation

- [Feature checklist](docs/FEATURES.md)
- [Harness integration boundaries](docs/HARNESS_INTEGRATIONS.md)
- [Trace integration design](docs/TRACE_INTEGRATION.md)
- [Frontend architecture](docs/FRONTEND_ARCHITECTURE.md)

## License

[MIT](LICENSE)
