# DSH IDE

一个面向 Agent 工作流的 `dsh web` 社区版 VS Code 客户端，让任务执行、审查和上下文管理留在编辑器内完成。

[English](README.md) | **简体中文**

> **注意**：本项目为独立社区项目，并非 DeepSeek 官方项目，也未获得 DeepSeek 官方维护。

## 核心亮点

- **面向 Agent 的聊天体验**：React 驱动的右侧聊天视图，支持流式回答、reasoning 折叠、工具卡片、重试、取消、排队和转向。
- **Human-in-the-loop**：直接在 VS Code 内处理工具审批、结构化问题和 Markdown 计划评审，也可以带反馈继续规划。
- **IDE 上下文感知**：附加当前选区、文件、诊断信息和 Git diff；使用稳定的 `@file#Lx-y` 引用，避免无差别复制整个文件。
- **持久 Agent 工作流**：通过紧凑的活动面板查看 Goal、排队消息、Subagent 树和后台 Jobs。
- **完整会话工作流**：新建、切换、搜索、重命名、Fork 和归档会话，并以 Harness 状态为权威来源。
- **本地 Slash Commands**：在输入框键入 `/` 查看命令，可直接执行 `/ide`、`/new`、`/search`、`/model`、`/focus`、`/trace` 和 `/stop`。
- **Runtime 与安全边界**：支持启动、停止或连接 `dsh web`；严格 Webview CSP、消息校验、安全 Markdown 和 SecretStorage 将可信能力留在 Extension Host。
- **Trace 与可观察性**：从消息跳转到 Session Trace，查看运行状态和日志，并在状态栏监控 DeepSeek 余额。

## 功能架构

聊天界面使用 React Webview 和类型化全量状态桥。Extension Host 继续负责 VS Code API、Runtime RPC、凭据、安全 Markdown 和动作校验，在保持界面响应性的同时，不把可信操作下放到浏览器环境。

DSH IDE 只消费 `dsh` 公开的 Web RPC 和 projection。公开边界未提供的能力不会通过隐藏接口或 prompt 约定模拟。

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

## 文档

- [功能清单](docs/FEATURES.md)
- [Harness 集成边界](docs/HARNESS_INTEGRATIONS.md)
- [Trace 集成设计](docs/TRACE_INTEGRATION.md)
- [前端架构](docs/FRONTEND_ARCHITECTURE.md)

## 许可证

[MIT](LICENSE)
