# DSH IDE 前端架构与 Harness UI 复用

更新时间：2026-08-14。

## 决策

DSH IDE 采用“原生 VS Code 外壳 + 独立 React Webview + Harness client adapter”的路线。

- 不继续把复杂业务 UI 拼接在 Extension Host 的 HTML 字符串中。
- 不 iframe Harness Web UI，也不复制一套完整 Harness 前端。
- 优先复用 `deepseek-harness/packages/client` 中浏览器可用的协议类型、纯投影、presenter 和 UI 组件。
- 只自行实现 VS Code 特有能力，如编辑器 context、原生 diff、命令、状态栏、SecretStorage 和 URI 导航。

现有 Vanilla Webview 在迁移期间继续工作，按功能逐步替换，不做一次性重写。React Webview 基础完成前，不再向 `src/chatView.ts` 的内联 HTML 增加新的复杂业务面板。

## 竞品路线

Claude Code VS Code 使用专用图形客户端：CLI/runtime 持有 agent 语义，独立 Webview 前端负责 IDE 体验。OpenCode 官方 VS Code 扩展保持轻量，把丰富交互留在 TUI 或 Server/Web 客户端。

DSH IDE 需要比终端桥接更原生的体验，但 Harness 已提供模块化 client runtime 和 UI packages，因此不应从零复制 Claude Code 式的整套前端。

## 分层

```text
VS Code Extension Host
  runtime process / HTTP RPC / WebSocket / SecretStorage / editor API
                         |
                  typed message bridge
                         |
Harness Client Adapter in Webview
  session facade / projections / answerable waits / locale / slots
                         |
React Webview
  reused Harness UI + VS Code-specific components
```

### Extension Host

负责只有 VS Code 扩展进程能够安全完成的工作：

- 启停或连接 `dsh web`，维护 HTTP RPC、WebSocket 和重连基线。
- 访问 workspace、editor、diagnostics、Git、terminal 和原生 diff。
- 保存 credential 与敏感配置；只向 Webview 发送展示所需的最小数据。
- 校验 Webview action，并把它映射到公开 Harness RPC。

### Harness Client Adapter

把当前 Extension Host 状态桥接为 Harness client UI 需要的窄接口：

- session snapshot、conversation surface 和 generic projections。
- approval/question 的 pending wait 与原 `rpcId` response。
- queue、jobs、goal、subagent、model 等 domain facade。
- VS Code locale、theme、路径打开和剪贴板能力。

Adapter 不新增 Harness 没有公开的能力，也不通过普通 prompt 模拟 RPC。

### React Webview

负责布局、交互和局部 UI 状态。构建产物随 VSIX 发布，通过 nonce CSP 加载；源码不在 Extension Host 中以模板字符串维护。

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

## 迁移顺序

1. 建立 `webview/` React 入口、bundler、开发模式、生产资源 URI 和 CSP。
2. 定义 Extension Host 与 Webview 的版本化消息协议，以及 Harness client adapter 最小接口。
3. 迁移 Chat shell、conversation、tool、question/plan 和 permission；旧 UI 按区域删除。
4. 迁移 Goal、Subagent、Job、Trace，再继续模型、Skills、Settings 等新功能。
5. 删除 `chatView.ts` 中已迁移的 HTML/CSS/浏览器脚本，仅保留 provider、桥接和 VS Code action。

每个阶段必须保持现有功能可用并独立提交。测试集中在 adapter 契约、核心投影和关键用户流程，不为低概率分支扩张防御性测试。

## 完成标准

- Webview 可独立构建并随 VSIX 打包，不依赖开发机路径。
- Extension Host 不再包含大段业务 HTML、CSS 或浏览器脚本。
- 已迁移领域优先使用 Harness client 组件或纯逻辑；自行实现处有明确的 VS Code 特有理由。
- HTTP RPC/WebSocket、安全和 credential 边界仍由 Extension Host 控制。
- Reload、theme、缩放和中英文 locale 下核心聊天流程可用。
