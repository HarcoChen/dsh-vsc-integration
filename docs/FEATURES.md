# DSH IDE 对标功能清单

更新时间：2026-08-14。

本文以 Claude Code for VS Code、OpenCode VS Code 扩展和 DeepSeek Harness Web/API 为基准，列出 DSH IDE 需要实现的功能。勾选只表示本仓库已经提供并验证对应的 VS Code 体验；Harness runtime 自身具备某项能力，不代表本扩展已经实现其 UI。

标记说明：

- **Harness 直连**：Harness 已有 Web RPC、SSE frame 或 session projection。
- **IDE 自建**：主要使用 VS Code API 在扩展侧完成。
- **对标差距**：竞品具备但 Harness 当前 Web RPC 未开放；仅记录差距，不进入本扩展开发路线。
- **P0**：安全、可观察、可恢复的 agent 闭环；**P1**：成熟日常体验；**P2**：生态、远程和团队能力。

## 对标结论

Claude Code 是完整的图形 IDE 客户端，覆盖流式对话、权限模式、计划评审、原生 diff、多会话、checkpoint、`@` 引用、上下文用量、插件和 MCP 管理。OpenCode 官方 VS Code 扩展刻意保持轻量，核心是分屏终端、会话快捷键、自动共享选区/当前标签页和带行号的文件引用；它的 session、permission、diff、fork、MCP 等丰富能力主要存在于 OpenCode Server API，不能视为扩展已经提供同等图形 UI。

DeepSeek Harness 已提供完整 GUI 所需的大部分后端基础：事件溯源 session、SSE mux、审批、用户问题、plan、permission preset、模型、队列、附件、workspace、skill、goal、subagent、job、token/context projection 和 compaction。DSH IDE 当前的主要差距是没有消费这些能力，而不是缺少聊天输入框。

Harness 自身还有一组不能按普通聊天插件处理的运行时语义，包括 surface replacement、通用 projection、持久 Goal、可续跑 Subagent 和后台 Job。当前实现严格限定于已有 RPC、SSE frame 和 projection，完整范围见 [基于现有 RPC 的 Harness 特色集成清单](HARNESS_INTEGRATIONS.md)。

## 能力矩阵

| 能力 | DSH IDE 当前 | Claude Code VS Code | OpenCode VS Code | Harness 可用基础 |
| --- | --- | --- | --- | --- |
| 默认位置 | 右侧 Secondary Sidebar | 可放侧栏或编辑器 | 分屏终端 | 客户端无关 |
| Runtime 启动 | 探测 `dsh`，缺失时回退 `npx` | 扩展内置 CLI | 要求 CLI；CLI 可安装扩展 | `npx @deepseek-ai/dsh web` |
| 当前文件/选区 | 自动感知选区、`@` 行号引用 | 自动感知、行号引用 | 自动共享 | `session.prompt` |
| `@` 文件/目录引用 | 无 | 模糊搜索、目录、行范围 | 文件及行范围 | 需 IDE 构建 |
| 流式消息/工具过程 | 无，轮询 history | 有 | TUI 内有 | SSE mux + `session/event` |
| 审批/用户问题 | 无 | 有 | TUI/Server 支持 | answerable frame + `/api/respond` |
| 计划模式/评审 | 无 | Markdown 计划、批注、批准 | agent/TUI 能力 | `plan` projection + `plan-review` |
| 文件变更 diff | 无 | 原生 diff、接受/拒绝/反馈 | Server 有 session diff | IDE 可做；Harness 无公开 diff RPC |
| Session 列表/搜索 | 只保存最近 ID | 搜索、恢复、重命名、删除 | TUI 会话入口 | `session.list/search/rename` |
| 多会话并行 | 无 | 多 tab/窗口及状态提示 | 新终端会话 | session/host stream |
| Fork/checkpoint | 无 | fork、代码 rewind | Server 有 fork/revert | `session.fork` 可做；代码 rewind 属于对标差距 |
| 模型/推理强度 | 无 | 可切换 | TUI 可切换 | `session.models/selectModel` |
| 命令/Skills | 仅本地 `/ide`；Skills 无 UI | `/` 菜单和 skills | TUI 命令 | `skill.list`；runtime command 属于对标差距 |
| MCP/插件 | 无 | MCP 与插件管理 UI | Server 有 MCP API | 对标差距，不在当前范围 |
| Token/context | 无 | 用量、自动/手动 compact | TUI 管理 | token/context projections + compaction |
| 子 agent/job/todo | 无 | tool activity、todo、subagent | Server 有 todo/agent | `subagent.*`、jobs、goal projection |
| 终端输出上下文 | 无 | `@terminal:name` | 原生终端形态 | IDE 自建 |
| 图片附件 | 无 | 有 | message parts 支持 | `session.attachment` + `imageLimits` |

## 当前基线

- [x] Chat 默认位于右侧 Secondary Sidebar。
- [x] 启动或连接 `dsh web`；启动前检查命令，默认 `dsh` 缺失时尝试 `npx -y @deepseek-ai/dsh`。
- [x] 调用 `session.create`、`session.prompt`、`session.history` 和 `session.cancel`。
- [x] 自动感知并可关闭当前选区；diagnostics 和 unstaged Git diff 作为本轮一次性附件。
- [x] `@文件#Lx-y` 编辑器引用与 `@selection` 显式选区引用。
- [x] 本地 `/ide` 打开 IDE context；其他文本统一通过现有 `session.prompt` 发送。
- [x] Composer 中显示瞬时选区与本轮附件，并可逐项关闭或移除。
- [x] 工作区级保存最近的 session ID。
- [x] 工作区信任、远程 URL 提示、日志、请求超时、TypeScript 检查和 VSIX 打包。

## P0：可用的 agent 闭环

### P0-1 协议客户端与事件状态

- [ ] **Host 基线信息**（Harness 直连）：调用 `host.describe`，记录 runtime 版本、cwd、默认 provider/model、attached session 数和 `canOpenPath`；不把它误当成完整 capability manifest。
- [ ] **SSE mux 客户端**（Harness 直连）：消费 session mux 和 host stream；处理 event、subscribed、queue、jobs、projection、host status/error 等 frame。
- [ ] **断线恢复**（Harness 直连）：重连后重新拉取 history 尾页与 projections，以 seq/watermark 去重，恢复待审批、问题、队列和运行状态。
- [ ] **统一状态仓库**（IDE 自建）：以 session ID 隔离消息、工具、queue、job、projection 和交互请求，避免多会话串线。
- [ ] **协议容错**（IDE 自建）：未知 frame 降级为诊断记录；区分 runtime、transport、provider 和 agent 错误。

验收：运行中的会话断网后重连不重复消息；刷新后审批、问题、队列和状态与 Harness Web UI 一致。

### P0-2 流式聊天与工具可观察性

- [ ] **增量 assistant 输出**（Harness 直连）：按事件 seq 合并 `assistant/chunk`，安全渲染 Markdown，支持代码块复制。
- [ ] **reasoning 展开/折叠**（Harness 直连）：默认折叠，不把 reasoning 混入最终回答。
- [ ] **工具调用卡片**（Harness 直连）：显示工具名、参数摘要、状态、结果、耗时和错误；优先使用 host presentation view。
- [ ] **轮次状态**（Harness 直连）：显示 queued/running/waiting/completed/cancelled/failed；隐藏标签页完成或待审批时显示 badge。
- [ ] **取消、重试、queue/steer**（Harness 直连）：失败后安全重试；运行时消息明确选择排队或 steer。
- [ ] **Focus view**（IDE 自建）：可折叠 tool、result 和 reasoning，保留最终回答、todo/goal 与待处理交互。

### P0-3 审批、问题与权限

- [ ] **审批卡片**（Harness 直连）：展示 tool、call、reason 和 session；支持 Allow once / Reject，用原 rpcId POST `/api/respond`。
- [ ] **结构化问题**（Harness 直连）：支持单选、多选、自由文本、批量问题和取消；未知 intent 使用通用渲染。
- [ ] **计划评审**（Harness 直连）：识别 `plan-review`，用 Markdown 展示，允许批准或带反馈继续规划。
- [ ] **权限状态**（Harness 直连）：只读展示 `permissions` projection；当前 RPC 没有直接 mutation 方法，因此不提供切换控件。
- [ ] **fail-closed**（IDE 自建）：断线、过期、重复应答或解析失败都不视为授权，显示 resolved/cancelled/unavailable。
- [ ] **风险说明**（IDE 自建）：删除、覆盖、shell、网络、工作区外访问使用不同样式，并显示 cwd 和目标。

验收：审批和 agent 问题均可在 VS Code 内完成；刷新可恢复未决请求；重复点击不会产生第二次授权。

### P0-4 Session 工作流

- [ ] **Session 列表**（Harness 直连）：展示标题、cwd、更新时间、running、blank、parent 和 preset。
- [ ] **搜索与历史分页**（Harness 直连）：跨 session 搜索，history 上翻加载并保留滚动锚点。
- [ ] **新建、切换、重命名、归档**（Harness 直连）：复用同工作区 blank session，由 host stream 收敛 UI。
- [ ] **多会话并行**（IDE 自建）：每个 session 可作为 editor tab 打开；状态、草稿、context 和事件彼此隔离。
- [ ] **关闭与恢复**（IDE 自建）：恢复最近关闭的 tab；持久化草稿但不持久化敏感附件内容。
- [ ] **Fork 对话**（Harness 直连）：从已完成 turn 的 seq 调用 `session.fork`，显示 parent/child。

### P0-5 文件变更审查与恢复

- [ ] **任务前快照**（IDE 自建）：记录 Git HEAD、tracked/untracked 状态和目标文件摘要；多根工作区分别记录。
- [ ] **变更集合**（IDE 自建）：按 turn 展示新增、修改、删除和 rename，不把任务前用户改动归给 agent。
- [ ] **VS Code 原生 diff**（IDE 自建）：逐文件打开左右对比，支持路径/行号跳转。
- [ ] **接受/拒绝/反馈**（IDE 自建 + Harness 审批）：未执行写操作走审批；已落盘变化可逐文件保留、恢复或继续修改。
- **对标差距：Checkpoint/code rewind**。当前 Harness RPC 仅支持 `session.fork`，本扩展不实现 runtime checkpoint/revert。
- [ ] **冲突保护**（IDE 自建）：恢复前检测用户或其他任务的后续修改；冲突时只展示 diff，不覆盖。

验收：有既存未提交改动时仍能准确区分本 turn 变化；拒绝或 rewind 不丢失用户后续编辑。

### P0-6 Context 与编辑器交互

- [x] **自动选区感知**（IDE 自建）：composer footer 显示当前文件/选区行数，发送时重新取快照且可关闭。
- [ ] **`@` 模糊引用**（IDE 自建）：搜索文件、目录、workspace symbol，支持 `@path#Lx-y`。
- [ ] **Context chips**（IDE 自建）：展示来源、范围、字节/token 估算和截断状态，可移除和定位。
- [ ] **路径与诊断链接**（IDE 自建）：消息内工作区路径、行号、diagnostic 可点击打开。
- [ ] **输入体验**（IDE 自建）：Shift+Enter、可配置发送键、草稿、IME、粘贴大文本提示。
- [ ] **敏感信息拦截**（IDE 自建）：识别密钥、私钥、`.env` 和超大内容，阻止或要求明确确认。

### P0-7 工程质量

- [ ] **Fake Harness server**：覆盖 RPC、SSE 重连、乱序/重复 frame、迟到应答、分页和旧字段。
- [ ] **VS Code integration tests**：覆盖命令、快捷键、session tab、context、diff、trust 和 multi-root。
- [ ] **Webview 安全**：严格 CSP、nonce、消息 schema、Markdown sanitize、command URI 白名单。
- [ ] **诊断包**：默认只导出脱敏版本、配置、状态和协议错误，不包含 prompt、文件、credential 或图片。
- [ ] **性能预算**：长 session 虚拟列表；增量合并不全量重渲染；大型 diff/附件有硬上限。

## P1：成熟开发体验

完整的 Trace 交互方案见 [DSH Session Trace 的 VS Code 集成设计](TRACE_INTEGRATION.md)。Trace MVP 与流式聊天共享事件基础设施，建议在 P0 SSE 状态仓库后立即交付。

### P1-1 Plan、模型和 agent 控制

- [ ] **Plan 状态**（Harness 直连）：读取 `plan` projection，显示 active/pending；当前 RPC 没有直接切换方法，因此不提供模式开关。
- [ ] **计划文档批注**（IDE 自建）：把 plan 打开为 Markdown 文档，收集 inline comment 后作为一次反馈返回。
- [ ] **模型与 reasoning effort**（Harness 直连）：调用 `session.models/selectModel`，展示 routable、provider 分组、失败原因和当前选择。
- [ ] **Agent preset**（Harness 直连）：列出、读取、选择 preset；新建 session 时明确使用哪个 preset。
- [ ] **Goal/Todo**（Harness 直连）：展示 goal projection 和 todo，接入 create/edit/pause/resume/complete/clear。
- [ ] **Subagent 树**（Harness 直连）：展示 parent/child、provider、状态和历史；支持 follow-up 与 interrupt。
- [ ] **Background jobs**（Harness 直连）：只读展示 `session/jobs` 完整快照、owner、kind 和状态；当前 RPC 没有 stop/readOutput 方法。

### P1-2 Skills、配置与凭据
- [ ] **Skills 浏览器**（Harness 直连）：使用 `skill.list` 展示名称、说明、可调用性和来源；插入调用而非静默注入全文。
- [ ] **配置编辑器**（Harness 直连）：基于 `settings.describe/update` 渲染 schema 表单，保留打开原始配置文件入口。
- [ ] **Credential UI**（Harness 直连）：使用 `credentials.describe/set/unset`；值不回显、不进入 webview state 或日志。

MCP 和 Harness 插件管理属于对标差距，当前 Web RPC map 未公开对应方法，不进入实现范围。

### P1-3 Context、附件和用量

- [ ] **图片附件**（Harness 直连）：遵循 `imageLimits`，客户端先校验数量、类型和大小，再走 `session.attachment`。
- [ ] **Problems/测试上下文**（IDE 自建）：附加失败测试、Problems、Task 输出，保留来源与截断提示。
- [ ] **终端输出引用**（IDE 自建）：按 terminal 和明确范围附加，默认脱敏环境变量与控制字符。
- [ ] **Token/context 指示器**（Harness 直连）：消费 `tokenUsage`、`contextPressure`、`contextBreakdown`，标明估算或实测。
- [ ] **Compact 可观察性**（Harness 直连）：展示已到达事件和 projection 中的运行状态、压缩范围和失败原因；不提供手动触发按钮。
- [ ] **使用量归因**（Harness 直连）：只展示现有 projection 明确提供的 token、context 和 cache 字段，不推算缺失成本。

### P1-4 IDE 工作流

- [ ] **焦点快捷键**：提供编辑器/聊天切换、新会话、插入引用和重新打开已关闭会话。
- [ ] **编辑器标题和状态栏入口**：无文件时仍可打开；显示 disconnected/running/attention/error。
- [ ] **代码操作**：Explain、Fix、Test、Refactor、Document、Review 作为 context/code action，统一走可预览 prompt。
- [ ] **Terminal 模式**：在 VS Code Terminal 打开同一 runtime/session，说明 GUI 与 CLI 的历史共享边界。
- [ ] **URI handler**：支持预填 prompt 和打开指定 session；外部来源不得自动提交。
- [ ] **Onboarding/Doctor**：检查 VS Code、workspace trust、Node/dsh、runtime、provider/model 和 API 兼容性。

## P2：生态、远程和团队

- [ ] **多根/远程工作区**：支持 multi-root、SSH、Dev Container、WSL；cwd、URI scheme 和权限始终可见。
- [ ] **Workspace 管理**（Harness 直连）：接入 `workspace.list/create/rename/delete/order/archiveSession`，区分 IDE 与 Harness workspace。
- [ ] **浏览器调试联动**：明确授权后附加页面、console、network 或截图，不静默共享浏览器登录态。
- [ ] **远程 runtime 安全**：HTTPS、认证、host allowlist、证书错误、断线恢复和数据外发确认。
- [ ] **Worktree 隔离**：为并行长任务创建 Git worktree，展示分支/目录、合并入口和安全回收流程。
- [ ] **分享与导出**：导出脱敏 Markdown/JSON；分享链接必须支持范围预览、撤销和有效期。
- [ ] **团队策略**：管理员默认 permission、允许的工具/命令、插件来源、审计和 workspace policy。
- [ ] **公开扩展接口**：允许其他 VS Code 扩展贡献可审查 context，评估 Chat Participant、Language Model API 和 MCP 边界。
- [ ] **可访问性和国际化**：键盘全流程、屏幕阅读器、对比度、缩放、中英文和 reduced motion。
- [ ] **Marketplace 发布**：隐私声明、数据流、CHANGELOG、签名、兼容策略和崩溃恢复说明。

## Harness 现有协议依赖清单

可以直接接入的现有能力：

- `session.list/search/create/history/models/selectModel/rename/fork/prompt/attachment/updateQueue/cancel`
- `subagent.list/history/prompt/interrupt`
- `workspace.*`、`agentPreset.*`、`goal.*`、`skill.list`
- `settings.*`、`credentials.*`、`llm.providers/models/discoverModels`
- session/host SSE streams、`/api/respond`
- projections：`plan`、`permissions`、`goal`、`tokenUsage`、`contextPressure`、`contextBreakdown` 等已装载单元

当前 Web RPC map 未暴露的能力一律视为非目标，不通过硬编码内部命令、普通 prompt 或推测 endpoint 实现。具体排除项见 [基于现有 RPC 的 Harness 特色集成清单](HARNESS_INTEGRATIONS.md#当前明确不做)。

## 建议交付顺序

```text
能力握手 + SSE 状态仓库
          ↓
流式消息 / 工具卡片 / 审批 / 问题
          ↓
Session 列表、恢复、多 tab、queue/steer
          ↓
文件快照、原生 diff、session fork
          ↓
@ 引用、Plan、模型、Goal、Subagent、Token
          ↓
Skills / Presets / Workspaces / Settings / Trace
```

前四阶段完成后，DSH IDE 才具备可与成熟 agent IDE 比较的核心闭环。模型选择、插件市场等功能不应早于事件恢复、审批和文件安全审查。

## 对标来源

- [Claude Code for VS Code](https://code.claude.com/docs/en/vs-code)
- [OpenCode IDE integration](https://opencode.ai/docs/ide/)
- [OpenCode Server API](https://opencode.ai/docs/server/)
- [DeepSeek Harness Web UI Guide](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart)
- [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness)
- [Harness Web RPC method map](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/apiproxy/src/api/rpc-map.ts)
- [Harness SSE event contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/apiproxy/src/api/events.ts)
- [Harness subsystem reference](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/)
