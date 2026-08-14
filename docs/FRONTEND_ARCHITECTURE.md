# DSH IDE 前端架构与 Harness UI 复用

更新时间：2026-08-14（Chat View 已整体迁移到 React Webview）。

## 决策

DSH IDE 采用“原生 VS Code 外壳 + 薄 Webview adapter”的路线。Chat View 已整体迁移到 `webview/` 下的 React 18 应用，Extension Host 只保留协议校验、业务逻辑和 safe Markdown 预渲染。

- 不再把业务 UI 拼接在 Extension Host 的 HTML 字符串中；`src/chatView.ts` 的 `getHtml()` 只是加载 `webview/dist/main.js` / `main.css` 的静态 shell（nonce CSP + `#root`）。
- 不 iframe Harness Web UI，也不复制一套完整 Harness 前端。
- 优先复用 `deepseek-harness/packages/client` 中浏览器可用的协议类型、纯投影、presenter 和 UI 组件。
- 只自行实现 VS Code 特有能力，如编辑器 context、原生 diff、命令、状态栏、SecretStorage 和 URI 导航。

Chat View 的 React 迁移以功能等价为前提完成：旧 vanilla 模板中的全部交互（会话操作、Goal/队列/子代理/Jobs/权限 dock、审批/计划评审/问答、上下文 chips、insertText 光标插入）在新 UI 中逐一保留，协议（`ChatViewState` / `ChatViewAction`）未变。

## 竞品路线

Claude Code VS Code 使用专用图形客户端：CLI/runtime 持有 agent 语义，独立 Webview 前端负责 IDE 体验。OpenCode 官方 VS Code 扩展保持轻量，把丰富交互留在 TUI 或 Server/Web 客户端。

DSH IDE 需要比终端桥接更原生的体验，但 Harness 已提供模块化 client runtime 和 UI packages，因此不应从零复制 Claude Code 式的整套前端。

## 分层

```text
VS Code Extension Host
  runtime process / HTTP RPC / WebSocket / SecretStorage / editor API
  safe Markdown 预渲染 / action 校验与分发
                         |
        {type:"state", protocol:1, state} 全量推送
        {type:"insertText", text} 光标插入
                         |
React Webview (webview/src)
  bridge.ts: ready 握手 / state 订阅 / vscode.setState 持久化 / postAction
  components/: Header · MessageList · Interactions · ActivityDock · Composer
  styles/: tokens.css（--vscode-* 令牌映射）+ app.css（dsh- 前缀）
```

### Extension Host

负责只有 VS Code 扩展进程能够安全完成的工作：

- 启停或连接 `dsh web`，维护 HTTP RPC、WebSocket 和重连基线。
- 访问 workspace、editor、diagnostics、Git、terminal 和原生 diff。
- 保存 credential 与敏感配置；只向 Webview 发送展示所需的最小数据。
- 用 safeMarkdown 把消息文本预渲染为固定词汇的 HTML，Webview 只做 `dangerouslySetInnerHTML`。
- 校验 Webview action（`parseChatViewAction`，严格键白名单），并把它映射到公开 Harness RPC。

### React Webview

负责布局、交互和局部 UI 状态。构建产物（esbuild IIFE bundle）随 VSIX 发布，通过 nonce CSP 加载；`webview/dist` 进入 VSIX，`webview/src` 被 `.vscodeignore` 排除。

信息架构（自上而下）：

1. **Header**：状态点 + turn 状态、会话切换下拉、新建/搜索图标按钮，其余会话操作（重命名/Fork/归档/Trace）与运行时控制（启停/日志/浏览器/API Key/Focus 模式）收纳进 ⋯ 溢出菜单。
2. **消息区**（绝对主体）：用户气泡、tool card（运行中/失败态）、reasoning 折叠、流式/待发送/失败重试态、per-message trace 按钮；copy-code 与外链点击走事件委托回传 host。
3. **Interactions**（按需出现，固定在 composer 上方）：approval / plan-review（含 planHtml 与反馈输入）/ question 三类卡片。
4. **Activity Dock**：可折叠 tab 条（Goal / 队列 / 子代理 / Jobs / 权限，badge 计数），替代旧的五个常驻 dock；面板承载旧 dock 的全部操作。
5. **Composer**：上下文 chips（选区开关 + 一次性附件）、自动增高 textarea、Ctrl/Cmd+Enter、发送/停止、busy 时的排队/转向 segmented。

## 复用规则

按以下顺序选择实现：

1. 直接复用 Harness browser-safe 的类型、纯函数和 presenter。
2. 复用 Harness React 组件，并通过 adapter 补齐 runtime、slot 和 locale props。
3. 当组件与 Harness Web 外壳强耦合时，抽取或包装最小 domain 组件。
4. 只有 VS Code 特有界面或当前无法解耦的薄骨架才在本仓库实现。

优先评估这些包：

| 领域 | Harness 来源 | DSH IDE 策略 |
| --- | --- | --- |
| Conversation | `client/ui-conversation`、`client/runtime` | 复用消息、composer 和 session facade |
| Tool | `client/ui-tool`、tool presentation | 复用 host view 对应卡片，VS Code 补路径跳转 |
| Question/Plan | `client/ui-user-questions` | 复用普通问题与 `PlanReviewPanel` |
| Permission | `client/ui-permission-presets` | 复用 projection 展示；写入口仍受公开 RPC 范围约束 |
| Goal/Subagent/Workspace | 对应 `client/ui-*` 包 | 通过 adapter 逐项接入 |
| Trace | `client/ui-trajectory` | 复用视觉与交互，保留现有 event projector |

禁止直接依赖 Harness host 内部实现、未公开 endpoint、进程内 Cordis service 或不进入 VSIX 的源码路径。复用代码必须由 Webview bundler 打包，并锁定到仓库内 `deepseek-harness` 的兼容版本。

## 演进顺序

1. [x] 建立可选的 `webview/` React 入口、bundler 和版本化 Host/Webview bridge。
2. [x] Chat View 整体迁移到 React：单一挂载点、协议不变、旧 vanilla 模板删除，不存在两套运行时 UI。
3. 优先完成任务快照、原生 diff、文件/诊断跳转、多 session tab 和输入安全等 VS Code 特有 P0。
4. Harness 已有复杂 UI 时，先评估 browser-safe package；逐区域用 Harness 组件替换 `webview/src/components` 中的自实现。
5. 模型、Skills、Settings、附件等领域能力严格走公开 adapter；无法安全复用时提供“在 Harness Web UI 打开”，不复制领域语义。

每个阶段必须保持现有功能可用并独立提交。测试集中在 adapter 契约、核心投影和关键用户流程，不为低概率分支扩张防御性测试。

## 完成标准

- Webview 可独立构建并随 VSIX 打包，不依赖开发机路径。
- Extension Host 与 Webview 的领域逻辑保持薄层，新增复杂 UI 不复制 Harness 已有语义。
- 使用 React 的区域必须实际复用 Harness 组件或解决明确的 VS Code 交互问题，不能只做框架迁移。
- HTTP RPC/WebSocket、安全和 credential 边界仍由 Extension Host 控制。
- Reload、theme、缩放和中英文 locale 下核心聊天流程可用。
