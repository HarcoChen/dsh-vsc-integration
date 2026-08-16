# TODO

更新时间：2026-08-14。


## P0：日常使用闭环

- [x] **Token 与上下文用量条**：展示当前模型、reasoning effort、输入/输出 token、推理 token、缓存命中和上下文占用；数据必须来自公开 usage/context projection，并明确区分估算值与计费值。
- [x] **文件路径与行号跳转**：识别回答、工具结果和 Trace 中的裸文件路径及 `path:line[:column]`，经 Extension Host 校验工作区边界后打开编辑器定位。
- [x] **编辑器快捷任务**：为当前文件、选区和 Git diff 提供“解释、修复、审查、生成文档”等右键入口；操作只预填并展示 prompt，不静默提交。
- [x] **变更审查面板**：按 turn 汇总新增、修改、删除和重命名文件，使用 VS Code 原生 diff 展示；恢复前检测任务之后的用户修改，避免覆盖。
- [x] **上下文用量与超限反馈**：在发送前展示附件大小、截断和敏感文件风险，支持移除大项并说明最终进入 prompt 的内容。

## P1：IDE 集成与效率

- [x] **全界面 i18n**：扩展清单、Extension Host、聊天 Webview 与 Trace 使用英文源文案和简体中文语言包；协议标识、模型名、文件路径和用户内容保持原样。
- [x] **VS Code Chat Participant**：支持通过 `@dsh` 在内置 Chat 中发起任务，并复用同一 Harness session/context 边界。
- [x] **资源管理器入口**：文件和目录右键“使用 DSH 提问”，保留明确的目标路径与工作区根。
- [x] **代码块操作**：复制、插入光标、打开新编辑器、应用到目标文件；写文件前显示 diff 并要求确认。
- [x] **外部 Approval 接管**：接收 Runtime 的 `approval/requested`，在 VS Code 展示工具/原因并只允许一次性批准或拒绝；响应绑定 session、rpcId 和 approvalId，不提供持久权限提升 RPC。
- [x] **Skills 浏览与选择**：接入公开 `skill.list`，通过 `$` 和 `/` 候选展示当前 Session 的 Skills，并使用官方 `/skill-name` 语法；不直接扫描或解释私有 Runtime 目录。
- [x] **Provider、模型与 reasoning effort 状态**：展示当前路由与 reasoning effort，统一 `/model`、`/mode` 选择，并提供 Provider 与凭据管理入口。
- [x] **Workspace 管理**：支持重命名和移除 DSH Workspace 分组，并调整 Workspace 与组内 Session 的显示顺序；不删除目录或 Session 日志。
- [ ] **项目记忆入口**：优先复用 Harness 公开 Memory/Skill 能力；若没有公开协议，只提供打开明确文件的 IDE 操作，不自动把自建记忆拼入所有 prompt。
- [x] **文件 `@` 引用候选**：扫描工作区文件、排除常见目录、按路径片段匹配，并优先展示当前活动文件。
- [ ] **扩展 `@` 引用类型**：在已有文件候选和 `@selection` 基础上增加目录、workspace symbol、diagnostics、终端选区，并显示实际捕获范围。
- [x] **手动压缩上下文**：通过公开 `/compact` command 触发会话压缩，并确保命令不会混入 IDE context；后续补充专门的 compaction 状态和摘要展示。
- [ ] **消息反馈**：接入 `feedback/record`，支持对消息点赞、点踩和文字反馈，并明确反馈是否写入 session 日志。
- [ ] **Todo 状态卡**：接入 `todo/write` projection/event，展示待办、进行中和完成状态，并处理历史回放与失效状态。
- [ ] **图片附件**：使用官方 image content block 发送和回放图片，限制 MIME、大小和工作区外数据流。
- [ ] **Web Search / Fetch 展示**：接入公开 web tool 结果，提供来源、域名、链接安全校验和失败状态；不从私有日志推断搜索结果。
- [ ] **MCP 工具来源**：展示 MCP server、工具来源、连接状态和错误；审批时明确区分 MCP 工具与内置工具。
- [ ] **LSP 能力**：接入公开 LSP tool，支持诊断之外的符号、定义、引用和 hover 结果，并复用工作区边界校验。
- [ ] **Terminal / PTY context**：支持终端选区 `@` 引用、PTY 输出摘要和 persistent bash 状态；避免把完整终端历史静默注入 prompt。
- [ ] **Hook 可观测性**：展示 Claude Code/Codex hook 的触发、结果和失败状态，并在 Trace 中关联对应 turn。
- [ ] **Session 内容查询**：使用公开 session query/index，标题匹配后支持服务端全文搜索，索引不可用时明确回退本地匹配。
- [ ] **自动标题状态**：展示首 prompt/LLM 标题生成状态、失败降级和最终标题来源。

## P1：Runtime 可靠性

- [ ] **跨平台 Runtime CI**：在 Windows、macOS、Linux 验证命令发现、启动、动态端口、健康检查、停止和进程树清理。
- [ ] **GUI 启动 PATH 发现**：覆盖 macOS Finder/Dock、Linux Desktop 和 Windows npm 全局 bin 路径缺失场景，日志中说明最终使用的可执行文件。
- [ ] **多根工作区 Runtime 归属**：根据活动编辑器选择 cwd，明确每个 session 对应的 workspace folder，切换时不误停其他窗口复用的 Runtime。
- [ ] **远程工作区支持评估**：验证 Remote SSH、WSL、Dev Container 下 Extension Host、Runtime 和文件系统是否位于同侧；需要时使用 VS Code 端口转发。
- [ ] **异常退出恢复**：检测扩展启动的 Runtime 意外退出，提供有限次数的退避重启，并避免接管或终止用户自行启动的实例。

## P2：产品呈现

- [ ] **Marketplace 截图与短 GIF**：展示流式回答、工具卡片、审批、计划评审、Activity Dock、Slash Commands 和 Trace 跳转。
- [x] **环境检查命令**：一次性诊断 VS Code 版本、工作区信任、Node/dsh 路径、Runtime 版本、端口、API Key 引用和公开 RPC 可用性；输出必须脱敏。
- [ ] **兼容版本说明**：记录验证过的 DSH 版本范围和协议变化，遇到不兼容版本时给出可操作提示。
- [ ] **常见问题与故障排查**：覆盖找不到 dsh、API Key、空白 Webview、端口冲突、模型不可路由和远程工作区路径问题。
- [ ] **隐私与数据流说明**：明确编辑器上下文、prompt、凭据、日志和余额查询分别流向哪里，以及哪些数据会持久化。
- [ ] **Telemetry 与诊断关联**：对齐 Harness session telemetry/OTel 能力，提供可选开关、脱敏说明和按 session/turn 关联的诊断信息。

## 明确不照搬

- 不通过 iframe 嵌入完整 Harness Web UI 作为主聊天体验。
- 不为每条消息启动全新的 headless 会话并重新拼接历史。
- 不通过 tail 私有 JSONL 日志代替公开 WebSocket/projection 协议。
- 不在公开 RPC 缺失时伪造 `/compact`、权限切换、插件管理或 Memory 语义。
- 不在没有 diff、工作区边界校验和用户确认时自动把代码块写入文件。
