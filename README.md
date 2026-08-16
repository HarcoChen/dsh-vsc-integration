# Deepseek-Harness VSCode Integration Community Edition

<p align="center">
  <img src="resources/dsh.png" alt="DSH" width="128">
</p>

Please note that this README is maintained and translated by chatgpt models,it's better to refer to `README.zh-CN.md` for human-friendly descripitons.

Feel free to leave issues!

A full-featured community VS Code extension for connecting to DeepSeek Harness and completing the Agent workflow without leaving the editor.

**English** | [简体中文](README.zh-CN.md)

> **Note**: This is an independent community project. It is not an official DeepSeek project and is not maintained by DeepSeek.

> [!NOTE]
> **Highlights**
>
> - Stream tasks in persistent Harness sessions, with queueing, steering, approvals and plan reviews
> - Type `@` to search workspace files in real time and insert an explicit file reference
> - Type `$` or `/` to discover Harness Skills and invoke them with the official `/skill-name` syntax
> - Group and resume sessions by DSH Workspace, including conversations created from other VS Code folders or the Web UI
> - Inspect Provider and API Key status and manage Harness credentials and custom Providers
> - Browse Agent Presets, inspect their composition, copy user variants, and choose the default Preset
> - Attach selections, diagnostics and Git diffs with byte-size and truncation feedback before sending
> - Attach PNG, JPEG, WebP or GIF images by picker, paste or drag and drop, and reopen images from session history
> - Inspect tool calls, results and reasoning in a built-in Trace, with clickable file and line locations
> - Review per-turn file changes with native VS Code diffs before restoring anything
> - Follow the current Harness todo plan with live pending, active and completed states
> - Monitor the active model, reasoning effort, billed tokens, cache usage and estimated context pressure

The extension is designed as a complete working surface rather than a thin chat wrapper: session state, IDE context, runtime activity, approvals, traces and file changes stay connected throughout a task.

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
3. Type `@` to search and reference workspace files, type `$` to select a Skill, attach selections, diagnostics, unstaged Git diffs or images, or type `/` to open the command and Skill menu. Images can also be pasted or dropped into the composer.
4. Send a prompt and handle tool approvals, questions and plan reviews directly in the chat view.

The Explorer context menu includes `DSH: Ask About This Resource`, which pre-fills the selected file or directory and its workspace root without sending automatically. Use `DSH: Diagnose Environment` to write a redacted runtime and command-discovery report to the DSH output channel.

If dsh reports a missing or invalid API key, click `Key` in the chat header or run `DSH: Configure API Key`. The key is passed to dsh's credential service, and an encrypted copy is stored in VS Code SecretStorage for the balance indicator. It is not written to prompts, extension state or logs.

Use `DSH: Manage Providers` from the chat menu or Command Palette to inspect Provider activation, configuration and credential source, set or remove API Keys, and open the official Harness configuration document for advanced edits. `DSH: Manage Agent Presets` lists system and user Presets, reports broken compositions, opens a read-only composition snapshot, and lets you copy, edit, delete or make a Preset the default through Harness-owned operations. DSH Workspaces are discovered from their directories; `DSH: Manage Workspaces` can rename or remove groups and reorder Workspaces or their Sessions. Removing a group never deletes its directory or Session logs.

Multiple VS Code windows preferentially share one local Harness Runtime. A Runtime started by the extension publishes its random loopback port through a process lock; later windows validate it with `host.describe` before connecting, preventing competing writers from touching the same Session storage.

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
