# DSH IDE

原生连接 DeepSeek Harness 的社区版 VS Code Extension。

[English](README.md) | **简体中文**

> **注意**：本项目为独立社区项目，并非 DeepSeek 官方项目，也未获得 DeepSeek 官方维护。

> [!NOTE]
> **亮点**
>
> - Slash-like Command 支持
> - 上下文感知支持
> - 余额快捷显示
> - Trace 功能内建支持
> - Cline-like 的聊天体验：工具卡片、Reasoning 折叠

## 功能架构

聊天界面使用 React Webview 和类型化全量状态桥。Extension Host 负责 VS Code API、Runtime RPC、凭据、安全 Markdown 和动作校验。

## 安装

### 从Extension Market

[🔗安装链接](https://marketplace.visualstudio.com/items?itemName=HarcoChen.dsh-vsc-integration)

### 从Github Release

从 [GitHub Releases](https://github.com/HarcoChen/dsh-vsc-integration/releases) 下载 `.vsix`，然后运行 `Extensions: Install from VSIX...`。

### 从源码构建

```bash
npm install
npm run check
npm run package
```

通过 `Extensions: Install from VSIX...` 安装生成的 `.vsix` 文件。

## 使用方式

1. 打开一个已信任的工作区。
2. 打开 DSH Chat（`Ctrl+Shift+Alt+D` / `Cmd+Shift+Alt+D`）。
3. 附加文件、选区、诊断信息或未暂存的 Git diff，也可以输入 `/` 打开本地命令菜单。
4. 发送 prompt，并直接在聊天视图内处理工具审批、问题和计划评审。

如果 dsh 报告 API Key 缺失或无效，点击聊天头部的 `Key`，或运行 `DSH: Configure API Key`。密钥会交给 dsh 的凭据服务，并以 VS Code SecretStorage 加密保存一份给余额指示器使用；不会写入 prompt、扩展状态或日志。

## 配置

```jsonc
{
  "dsh.command": "npx",
  "dsh.commandArgs": ["-y", "@deepseek-ai/dsh", "web"]
}
```

- `dsh.command` / `dsh.commandArgs`：用于启动 `dsh web` 的命令。
- `dsh.serverUrl`：连接已有 runtime，而不是启动新进程。
- `dsh.serverPort`：本地 runtime 端口；`0` 表示自动选择。
- `dsh.maxContextBytes`：`<ide_context>` 区块的最大 UTF-8 字节数。
- `dsh.apiKeyEnv`：`DSH: Configure API Key` 使用的凭据引用名，默认为 `DEEPSEEK_API_KEY`。
- `dsh.balanceRefreshIntervalMs`：DeepSeek 余额刷新间隔，默认为 30 秒。

余额指示器调用 DeepSeek 官方 `/user/balance` 接口。聊天凭据仍由 dsh runtime 管理；SecretStorage 中的加密副本仅用于只读余额查询。

## 开发

```bash
npm install
npm run check      # TypeScript 检查
npm run compile    # 构建到 dist/
npm run package    # 编译 + vsce 打包
```

在 VS Code 中按 `F5` 启动 Extension Development Host。

## 更多信息

- [更新日志](CHANGELOG.md)
- [产品 TODO](TODO.md)
- [第三方资产说明](THIRD_PARTY_NOTICES.md)

## 许可证

[MIT](LICENSE)
