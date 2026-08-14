# DSH IDE

A native community VS Code client for DeepSeek Harness, designed to keep chat, approvals, plan review and agent workflows inside the editor.

**English** | [简体中文](README.zh-CN.md)

> **Note**: This is an independent community project and is not officially affiliated with or maintained by DeepSeek. DSH IDE only acts as a VS Code client for a `dsh-compatible` Web Runtime.

> [!IMPORTANT]
> DSH IDE does not iframe the `dsh web` interface or rebuild conversation history around one-off headless processes. It speaks the public Harness Web RPC and WebSocket protocols directly, preserving real sessions and authoritative projections behind a VS Code-native React interface.

## Why DSH IDE

- **Native agent chat**: streaming responses, reasoning folds, tool cards, retry, cancel, queue and steer controls without iframe layout constraints.
- **Recoverable human-in-the-loop controls**: answer approvals and structured questions or review Markdown plans directly in VS Code, including after reconnecting.
- **IDE-aware context**: attach the current selection, files, diagnostics and Git diff; insert stable `@file#Lx-y` references without copying entire files into the prompt.
- **Harness-native workflows**: inspect Goals, queued prompts, Subagent trees, background Jobs and permission state from a compact activity dock.
- **Persistent sessions and observability**: create, search, switch, rename, fork and archive sessions; jump from messages into Trace and inspect runtime logs.
- **Local slash commands**: type `/` for command discovery and run `/ide`, `/new`, `/search`, `/model`, `/mode`, `/focus`, `/trace` or `/stop` directly from the composer.
- **Clear security boundary**: strict Webview CSP, validated actions, sanitized Markdown and SecretStorage-backed credentials keep trusted operations in the Extension Host.

## How It Differs

| Capability | DSH IDE | Embedded Web UI | Headless task panel |
| --- | --- | --- | --- |
| Interface | React UI designed for the VS Code sidebar | Full website inside an iframe | Custom chat panel |
| Conversation state | Native persistent Harness sessions | Native persistent Harness sessions | Commonly reconstructs history in prompts |
| Live state | WebSocket mux and full projections | Managed inside the embedded website | Commonly stdout or tailed event logs |
| Approvals and questions | Native, recoverable VS Code interactions | Handled inside the embedded website | Usually unavailable in headless mode |
| Goal/Subagent/Jobs | Dedicated activity dock | Harness web interface | Usually lacks native projections |
| IDE context | Selection, files, diagnostics, Git diff and line references | Requires a separate editor bridge | Commonly appended to task text |

## Features

The chat view is a React Webview backed by a typed, full-state bridge. The Extension Host remains responsible for VS Code APIs, runtime RPC, credentials, Markdown sanitization and action validation. This keeps the interface responsive without moving trusted operations into browser code.

DSH IDE consumes the public `dsh` Web RPC and projection surface. Features that are not exposed by that public boundary are not emulated with hidden endpoints or prompt conventions.

## Installation

Download the `.vsix` from [GitHub Releases](https://github.com/HarcoChen/dsh-vsc-integration/releases), then run `Extensions: Install from VSIX...`.

### Build from source

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

## More Information

- [Changelog](CHANGELOG.md)
- [Product TODO](TODO.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## License

[MIT](LICENSE)
