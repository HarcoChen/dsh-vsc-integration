# DeepSeek Harness for VS Code

这是一个独立的 VS Code 扩展原型，为 [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness) 提供原生侧栏聊天和 IDE 上下文桥接。

## 当前能力

- 通过 `dsh web` 启动本地 DeepSeek Harness Web Runtime，也可以连接已有的 `dsh web` 地址。
- 使用 dsh 官方 Web RPC 创建会话、发送 prompt、读取已提交的 session history、取消当前任务。
- VS Code 侧栏聊天视图，保留当前扩展会话消息。
- 添加当前文件、编辑器选区、文件夹、当前文件诊断和 unstaged Git diff。
- 发送前将选中的 IDE 内容以 `<ide_context>` 区块附加到 prompt，并明确标记为不可信参考数据。
- 工作区级别保存最近一个 dsh session，扩展重新加载后尝试复用。
- 启动、停止、重启、日志、复制/预览 prompt context 等命令和编辑器/资源管理器右键入口。

## 使用

1. 安装并确保 `dsh` 命令可用。官方预览版也支持 `npx @deepseek-ai/dsh web`。
2. 在 VS Code 打开一个工作区。
3. 打开左侧 DSH 视图，第一次发送 prompt 时扩展会启动 `dsh web --port 0`。
4. 在设置中配置 dsh 的 API key、provider 和 model；这些设置由 dsh 管理，扩展不会保存或读取 API key。

如果 dsh 没有安装在 PATH 中，可以这样配置：

```json
{
    "dsh.command": "npx",
    "dsh.commandArgs": ["-y", "@deepseek-ai/dsh", "web"]
}
```

也可以运行 dsh 后设置：

```json
{
    "dsh.serverUrl": "http://127.0.0.1:3080"
}
```

## 开发

```bash
npm install
npm run check
npm run compile
```

使用 VS Code 的“运行扩展”配置启动 Extension Development Host。当前实现不依赖运行时 npm 包，扩展通过本地 HTTP RPC 与 dsh Web Runtime 通信。

## 设计边界

扩展没有把 dsh Web UI 嵌入 iframe，而是使用官方 Web API 做一个 VS Code 原生聊天面板。这让 IDE 上下文可以在发送前显式选择，也避免跨 Webview/浏览器上下文注入。流式事件接入和完整的 dsh 原生 Web UI 复用可以作为后续版本；当前版本轮询已提交的 `session.history`，所以只在 agent turn 结束后显示完整回答。

