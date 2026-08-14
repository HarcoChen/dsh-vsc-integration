# DSH IDE

Please note that this README is maintained and translated by chatgpt models,it's better to refer to `README.zh-CN.md` for human-friendly descripitons.

Feel free to leave issues!

A native community VS Code extension for connecting to DeepSeek Harness.

**English** | [简体中文](README.zh-CN.md)

> **Note**: This is an independent community project. It is not an official DeepSeek project and is not maintained by DeepSeek.

> [!NOTE]
> **Highlights**
>
> - Slash-like command support
> - Context-aware assistance
> - Quick balance display
> - Built-in Trace support
> - A Cline-like chat experience with tool cards and collapsible reasoning

## Architecture

The chat interface is a React Webview backed by a typed, full-state bridge. The Extension Host is responsible for VS Code APIs, Runtime RPC, credentials, secure Markdown rendering and action validation.

## Installation

### From the Extension Marketplace

[🔗 Install from the Marketplace](https://marketplace.visualstudio.com/items?itemName=HarcoChen.dsh-vsc-integration)

### From GitHub Releases

Download the `.vsix` package from [GitHub Releases](https://github.com/HarcoChen/dsh-vsc-integration/releases), then run `Extensions: Install from VSIX...`.

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
3. Attach files, selections, diagnostics or unstaged Git diffs, or type `/` to open the local command menu.
4. Send a prompt and handle tool approvals, questions and plan reviews directly in the chat view.

If dsh reports a missing or invalid API key, click `Key` in the chat header or run `DSH: Configure API Key`. The key is passed to dsh's credential service, and an encrypted copy is stored in VS Code SecretStorage for the balance indicator. It is not written to prompts, extension state or logs.

## Configuration

```jsonc
{
  "dsh.command": "npx",
  "dsh.commandArgs": ["-y", "@deepseek-ai/dsh", "web"]
}
```

- `dsh.command` / `dsh.commandArgs`: command used to start `dsh web`.
- `dsh.serverUrl`: connect to an existing runtime instead of starting a new process.
- `dsh.serverPort`: local runtime port; `0` means auto-select.
- `dsh.maxContextBytes`: maximum UTF-8 byte size of the `<ide_context>` block.
- `dsh.apiKeyEnv`: credential reference used by `DSH: Configure API Key` (defaults to `DEEPSEEK_API_KEY`).
- `dsh.balanceRefreshIntervalMs`: DeepSeek balance refresh interval (defaults to 30 seconds).

The balance indicator calls DeepSeek's official `/user/balance` endpoint. Chat credentials remain managed by the dsh runtime; the encrypted SecretStorage copy is used only for this read-only balance request.

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
