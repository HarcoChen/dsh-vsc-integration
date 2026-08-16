# Deepseek-Harness VSCode Integration Community Edition

<p align="center">
  <img src="resources/dsh.png" alt="DSH" width="128">
</p>

面向 DeepSeek Harness 社区版 VS Code Extension，支持四种模式切换、Trace Vscode内查看等特色功能

[English](README.md) | **简体中文**

> **注意**：本项目为独立社区项目，并非 DeepSeek 官方项目，也未获得 DeepSeek 官方维护。

> [!NOTE] 亮点
>
> - 快速查看Key余额
> - 流式传输、队列、Steer、审批和计划评审支持
> - 输入 `@` 实时搜索工作区文件，并插入明确的文件引用
> - 输入 `$` 或 `/` 搜索 Harness Skills，并使用官方 `/skill-name` 语法调用
> - 按 DSH Workspace 分组、恢复和管理 Session，可在不同 VS Code 文件夹间继续已有对话
> - 在插件内查看 Provider 与 API Key 状态，并管理 Harness 凭据和自定义 Provider
> - 浏览 Agent Preset、查看 composition、复制用户版本并设置默认 Preset
> - Git Diff集成，长prompt自动转文件发送
> - 支持选择、粘贴或拖放 PNG、JPEG、WebP、GIF 图片，并回看 Session 历史图片
> - 在内建 Trace 中查看工具调用、结果和 Reasoning
> - 支持文件路径与行号跳转
> - 实时查看 Harness 当前任务清单的待处理、进行中和已完成状态
> - 查看当前模型、Reasoning effort、计费 Token、缓存用量和估算上下文压力
> - i18n支持

功能更全面：会话状态、IDE 上下文、Runtime 活动、审批、Trace、文件变更均集成在插件内。

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
3. 输入 `@` 搜索并引用工作区文件，输入 `$` 选择 Skill，附加选区、诊断信息、未暂存的 Git diff 或图片，也可以输入 `/` 打开命令与 Skill 菜单。图片还可直接粘贴或拖放到输入区。
4. 发送 prompt，并直接在聊天视图内处理工具审批、问题和计划评审。

资源管理器右键菜单提供 `DSH：询问此资源`，会将所选文件或目录及其工作区根目录预填到聊天，不会自动发送。执行 `DSH：诊断环境` 可在 DSH 输出通道中生成脱敏的 Runtime 与命令发现报告。

如果 dsh 报告 API Key 缺失或无效，点击聊天头部的 `Key`，或运行 `DSH: Configure API Key`。密钥会交给 dsh 的凭据服务，并以 VS Code SecretStorage 加密保存一份给余额指示器使用；不会写入 prompt、扩展状态或日志。

聊天菜单和命令面板中的 `DSH: Manage Providers` 可查看 Provider 是否启用、配置及其凭据来源，设置或移除 API Key，并打开 Harness 官方配置文件进行高级编辑。`DSH: Manage Agent Presets` 可列出 system/user Preset、显示损坏原因、打开只读 composition 快照，并通过 Harness 提供的操作复制、编辑、删除或设为默认 Preset。DSH Workspace 会根据目录自动发现；`DSH: Manage Workspaces` 支持重命名和移除分组，并调整 Workspace 与组内 Session 的显示顺序。移除分组不会删除目录或 Session 日志。

多个 VS Code 窗口会优先复用同一个本地 Harness Runtime。扩展启动的 Runtime 使用进程锁公布其随机 loopback 端口，后续窗口经 `host.describe` 验证后连接，避免多个写进程竞争同一 Session 存储。

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
