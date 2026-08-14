# TODO

更新时间：2026-08-14。


## P0：日常使用闭环

- [x] **Token 与上下文用量条**：展示当前模型、reasoning effort、输入/输出 token、推理 token、缓存命中和上下文占用；数据必须来自公开 usage/context projection，并明确区分估算值与计费值。
- [x] **文件路径与行号跳转**：识别回答、工具结果和 Trace 中的 `path:line[:column]`，经 Extension Host 校验工作区边界后打开编辑器定位。
- [ ] **编辑器快捷任务**：为当前文件、选区和 Git diff 提供“解释、修复、审查、生成文档”等右键入口；操作只预填并展示 prompt，不静默提交。
- [ ] **变更审查面板**：按 turn 汇总新增、修改、删除和重命名文件，使用 VS Code 原生 diff 展示；恢复前检测任务之后的用户修改，避免覆盖。
- [ ] **上下文用量与超限反馈**：在发送前展示附件大小、截断和敏感文件风险，支持移除大项并说明最终进入 prompt 的内容。

## P1：IDE 集成与效率

- [ ] **VS Code Chat Participant**：支持通过 `@dsh` 在内置 Chat 中发起任务，并复用同一 Harness session/context 边界。
- [ ] **资源管理器入口**：文件和目录右键“使用 DSH 提问”，保留明确的目标路径与工作区根。
- [ ] **代码块操作**：复制、插入光标、打开新编辑器、应用到目标文件；写文件前显示 diff 并要求确认。
- [ ] **Skills 浏览与选择**：接入公开 `skill.list` 等能力，在 Composer 中展示本轮启用的 Skills；不直接扫描或解释私有 Runtime 目录。
- [ ] **Provider、模型与 reasoning effort 状态**：在 Composer 附近展示当前路由，并统一 `/model`、`/mode` 与未来 provider/effort 选择体验。
- [ ] **项目记忆入口**：优先复用 Harness 公开 Memory/Skill 能力；若没有公开协议，只提供打开明确文件的 IDE 操作，不自动把自建记忆拼入所有 prompt。
- [ ] **目录与符号引用**：扩展 `@` picker，支持目录、workspace symbol、diagnostics 和终端选区，并显示实际捕获范围。

## P1：Runtime 可靠性

- [ ] **跨平台 Runtime CI**：在 Windows、macOS、Linux 验证命令发现、启动、动态端口、健康检查、停止和进程树清理。
- [ ] **GUI 启动 PATH 发现**：覆盖 macOS Finder/Dock、Linux Desktop 和 Windows npm 全局 bin 路径缺失场景，日志中说明最终使用的可执行文件。
- [ ] **多根工作区 Runtime 归属**：根据活动编辑器选择 cwd，明确每个 session 对应的 workspace folder，切换时不误停其他窗口复用的 Runtime。
- [ ] **远程工作区支持评估**：验证 Remote SSH、WSL、Dev Container 下 Extension Host、Runtime 和文件系统是否位于同侧；需要时使用 VS Code 端口转发。
- [ ] **异常退出恢复**：检测扩展启动的 Runtime 意外退出，提供有限次数的退避重启，并避免接管或终止用户自行启动的实例。

## P2：产品呈现

- [ ] **Marketplace 截图与短 GIF**：展示流式回答、工具卡片、审批、计划评审、Activity Dock、Slash Commands 和 Trace 跳转。
- [ ] **环境检查命令**：一次性诊断 VS Code 版本、工作区信任、Node/dsh 路径、Runtime 版本、端口、API Key 引用和公开 RPC 可用性；输出必须脱敏。
- [ ] **兼容版本说明**：记录验证过的 DSH 版本范围和协议变化，遇到不兼容版本时给出可操作提示。
- [ ] **常见问题与故障排查**：覆盖找不到 dsh、API Key、空白 Webview、端口冲突、模型不可路由和远程工作区路径问题。
- [ ] **隐私与数据流说明**：明确编辑器上下文、prompt、凭据、日志和余额查询分别流向哪里，以及哪些数据会持久化。

## 明确不照搬

- 不通过 iframe 嵌入完整 Harness Web UI 作为主聊天体验。
- 不为每条消息启动全新的 headless 会话并重新拼接历史。
- 不通过 tail 私有 JSONL 日志代替公开 WebSocket/projection 协议。
- 不在公开 RPC 缺失时伪造 `/compact`、权限切换、插件管理或 Memory 语义。
- 不在没有 diff、工作区边界校验和用户确认时自动把代码块写入文件。
