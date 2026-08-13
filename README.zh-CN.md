# DSH IDE

一个将 `dsh web` 运行时带入编辑器的社区版 VS Code 扩展。

[English](README.md) | **简体中文**

> **注意**：本项目为独立社区项目，并非 DeepSeek 官方项目，也未获得 DeepSeek 官方维护。

## 功能特性

- 位于右侧 Secondary Sidebar 的侧栏聊天
- 显式附加 IDE 上下文（文件、选区、诊断信息、Git diff）
- Runtime 生命周期管理（启动 / 停止 / 重启 / 连接）
- 发送前预览和复制 prompt 上下文
- 工作区级会话复用
- VS Code 状态栏显示 DeepSeek 余额并自动刷新

## 安装

### 开发者

```bash
npm install
npm run check
npm run package
```

通过 `Extensions: Install from VSIX...` 安装生成的 `.vsix` 文件。

## 使用方式

1. 打开一个已信任的工作区。
2. 打开 DSH Chat（`Ctrl+Shift+Alt+D` / `Cmd+Shift+Alt+D`）。
3. 附加文件、选区、诊断信息或未暂存的 Git diff。
4. 发送你的 prompt。

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

## 文档

- [功能清单](docs/FEATURES.md)
- [Harness 集成边界](docs/HARNESS_INTEGRATIONS.md)
- [Trace 集成设计](docs/TRACE_INTEGRATION.md)

## 许可证

[MIT](LICENSE)
