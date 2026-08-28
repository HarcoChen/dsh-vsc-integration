# Deepseek-Harness VSCode Integration Community Edition

<p align="center">
  <img src="resources/dsh.png" alt="DSH" width="128">
</p>

<p align="center">
  <a href="https://open-vsx.org/extension/harcochen/dsh-vsc-integration"><img src="https://img.shields.io/open-vsx/dt/harcochen/dsh-vsc-integration?style=flat-square&label=Open%20VSX%20downloads" alt="Open VSX downloads"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=HarcoChen.dsh-vsc-integration"><img src="https://vsmarketplacebadges.dev/installs-short/HarcoChen.dsh-vsc-integration.svg?style=flat-square" alt="VS Code Marketplace installs"></a>
  <a href="https://open-vsx.org/extension/harcochen/dsh-vsc-integration"><img src="https://img.shields.io/open-vsx/v/harcochen/dsh-vsc-integration?style=flat-square&label=Open%20VSX" alt="Open VSX version"></a>
  <a href="https://github.com/HarcoChen/dsh-vsc-integration/blob/main/LICENSE"><img src="https://img.shields.io/github/license/HarcoChen/dsh-vsc-integration?style=flat-square" alt="License"></a>
</p>

**Please note that this README is maintained and translated by chatgpt models,it's better to refer to `README.zh-CN.md` for human-friendly descripitons.**

Feel free to leave issues!

A full-featured community VS Code Extension for DeepSeek Harness, supporting four-mode switching, in-editor Trace viewing, and automatic Runtime download for npm-free environments.

**English** | [简体中文](README.zh-CN.md)

> [!WARNING]
> This project is an independent community project. It is not an official DeepSeek project and is not maintained by DeepSeek.
> For any information, help or feature suggestions, feel free to leave an issue!

> [!NOTE]
>
> - Quickly view your API Key balance
> - Built-in Trace support
> - Automatically download Runtime (distributed via CNB) when DSH is not present
> - i18n support

More comprehensive features: session state, IDE context, Runtime activity, approvals, Trace and file changes are all integrated into the extension.
Easier to use: there is no need to understand npm at all!

## Feature Architecture

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

## Detailed Description

If dsh reports a missing or invalid API Key, click `Key` in the chat header or run `DSH: Configure API Key`. The key is passed to dsh's credential service, and an encrypted copy is stored in VS Code SecretStorage for the balance indicator. It is never written to prompts, extension state or logs.

`DSH: Manage Providers` from the chat menu or Command Palette lets you inspect whether a Provider is enabled, its configuration and credential source, set or remove API Keys, and open the official Harness configuration file for advanced editing. `DSH: Manage Agent Presets` lists system and user Presets, reports broken compositions, opens a read-only composition snapshot, and lets you copy, edit, delete or make a Preset the default through Harness-owned operations. DSH Workspaces are discovered from their directories; `DSH: Manage Workspaces` can rename or remove groups and reorder Workspaces or their Sessions. Removing a group never deletes its directory or Session logs.

Multiple VS Code windows preferentially share one local Harness Runtime. A Runtime started by the extension publishes its random loopback port through a process lock; later windows validate it with `host.describe` before connecting, preventing competing writers from touching the same Session storage.

## Development

```bash
npm install
npm run check      # TypeScript check
npm run compile    # Build to dist/
npm run package    # Compile + vsce package
```

VS Code is recommended.

## More Information

- [Changelog](CHANGELOG.md)
- [Product TODO](TODO.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Acknowledgments

Thanks to [dsh-reasoning-effort](https://github.com/HanaAyane/dsh-reasoning-effort) for the chibi runner sprite reference and asset used by the reasoning-effort control. The conversation outline also takes inspiration from the `dsh-milestone` project; its Hub-style milestone idea led to the native VS Code TreeView implementation here.

## License

[MIT](LICENSE)
