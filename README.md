# DSH IDE

A community VS Code extension that brings `dsh web` runtime into your editor.

**English** | [简体中文](README.zh-CN.md)

> **Note**: This is an independent community project and is not officially affiliated with or maintained by DeepSeek. DSH IDE only acts as a VS Code client for a `dsh-compatible` Web Runtime.

## Features

- Sidebar chat in the Secondary Sidebar
- Explicit IDE context attachment (file, selection, diagnostics, Git diff)
- Runtime lifecycle management (start / stop / restart / connect)
- Preview and copy prompt context before sending
- Workspace-scoped session reuse
- DeepSeek balance in the VS Code status bar, with automatic refresh

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
3. Attach file, selection, diagnostics or unstaged Git diff.
4. Send your prompt.

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

## License

[MIT](LICENSE)
