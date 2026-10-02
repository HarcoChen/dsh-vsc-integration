# DSH `0.2.0-rc.2` 适配报告

审计目标是上游 tag [`dsh-v0.2.0-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2)，commit `639ed015397290b3745d163aafe02ffee4aa3f84`。差异基线为 `dsh-v0.2.0-rc.1`。

RC.2 对 dsh-ide 有实际影响的变化集中在异步用户问题：`@deepseek-ai/dsh-user-questions` 现在挂载 Remote contribution，新增 `userQuestions/answer` unary 和 `userQuestions/attachWait` stream。Timed `ask_user_question` 在前台等待结束后会继续 Agent，同时通过 `userQuestions` Session projection 保留可回答的问题；延迟回答会作为新的 `user-question-reply` 用户消息进入 Session。

IDE 已完成以下适配：

- Runtime 默认版本和 Remote contract pin 更新到 RC.2；最低兼容版本仍为 `0.1.5-rc.1`。
- `userQuestions/answer` 接入 `DshRuntime`，并对 unknown call 返回值做严格校验。
- Session store 校验并消费 `userQuestions` projection；`continued` 问题会重新显示为普通问题卡，提交时走 RC.2 Remote answer，而不是已结束的 waterfall event。
- 原有 waterfall 问题请求保留 `wait.callId`，因此 timed 请求在超时后能和 projection 中的调用关联。
- Remote 事件 allowlist 保留 RC.2 新增的 `credentials/reference-updated` 与 `llm/adapters-updated`，模型目录刷新行为继续复用现有缓存失效逻辑。
- Schedule 的投递 framing 由 Runtime 负责，IDE 不重写模型消息；Schedule RPC 的可选 bundle 行为保持兼容。
- Agent Teams 通过 `pluginInventory/list` 检查 Host service，再通过公开 `session/projections` 读取 Lead Session 的 `agentTeam`。复核 RC.2 `src/index.ts` 与 `client/mount.ts` 后确认：团队服务没有 `@Remote`，Web UI 已改为只读 projection；启用 bundle 也不会提供旧 `agentTeams/view|createTask|updateTask`。这些旧 wrapper 已清理，成员与任务 UI 仍待集成。
- `permissionPresets/catalog` 接入权限面板；RC.2 的 `permissions` projection 只提供 `currentValue` 时，IDE 用独立 catalog 合并可选项，并兼容旧 Runtime 将 options 放在 projection 中的格式。
- Plugin Manager 的只读 `listBundles` 与 `listPlugins` 已接入 Settings 插件清单，展示 Bundle 的安装、选择、版本、插件 patch 行和只读状态；安装、启停和删除仍留在 Harness Web UI。
- RC.2 的 preset composition inventory 没有 `trust` 字段，校验器现在允许缺省；仍校验旧 Runtime 显式给出的 `system|user`，避免拒绝整份插件清单。
- `workspaceFiles/list|stat|read|readBytes|changes` 使用统一的类型化 client。根目录请求使用 `.`，read 与 readBytes 缺省时分别发送必需的 `{}` range/options。新增命令和 `/ide` 浏览入口，以 Session id 获取 Host 目录和只读编辑器预览；预览保持原文本和结尾换行，限制 UTF-8/1 MiB，拒绝读取期间版本变化。changes 流刷新预览，关闭释放监听；重连重新读取，同一预览不会切换到另一 Runtime endpoint。
- 权限目录缓存已完成及缺失结果，避免每次 `postState` 都发 RPC；停止 Runtime 会清理缓存，重连或 catalog-changed 重新拉取。当前值为 `custom` 时仍展示，不把它作为切换目标。

上游 Desktop 命令管理、模型选择器搜索、Sidebar 本地应用打开和 PowerShell 修复属于 Harness Web/Desktop 自身能力，dsh-ide 不复制这些 UI。定时消息改为明确的用户定时消息也由 Runtime 记录和呈现，IDE 通过公开 Session history 原样读取。

验证使用临时安装的精确 npm 包 `@deepseek-ai/dsh@0.2.0-rc.2`，没有替换本机 CLI。执行结果：

```sh
npm run check
npm run compile
node scripts/verify-remote-runtime.mjs --launcher /absolute/path/to/dsh
node scripts/verify-remote-runtime.mjs --launcher /absolute/path/to/dsh --with-schedule-bundle
node scripts/verify-remote-runtime.mjs --launcher /absolute/path/to/dsh --timed-questions
node scripts/verify-remote-runtime.mjs --launcher /absolute/path/to/dsh --with-team-bundle
node scripts/verify-managed-runtime.mjs --version 0.2.0-rc.2
```

此前标准 Web、Schedule bundle 与 timed-question smoke 均通过，CNB manifest 与五个平台资产检查通过（9/9）。本轮重新运行标准 Web 和 Team bundle smoke；下段记录新增覆盖，历史账号与 Schedule 的验证边界保持不变。

联调使用临时 DSH_HOME、独立 Workspace 和回环 Messages 模拟模型，不读取用户会话或外部模型凭据；没有执行真实模型 API、账号登录、Schedule 到期投递或 VS Code UI 人工验收。`userQuestions/attachWait` 已由上游契约审计，但当前 IDE 使用固定问题卡，不依赖浏览器倒计时 claim，因此未将它接入 UI。

源码参照：[RC.2 release notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2)、[user-questions Remote service](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/interaction/user-questions/src/index.ts)、[user-question projection](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/interaction/user-questions/src/projection.ts)、[RC.1 report](./RPC_0.2.0_ADAPTATION.md)。

补充依据：[Workspace Files 方法与参数](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/api/workspace-files/src/index.ts)、[Team UI 读取 projection](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/experimental/client-ui-agent-team/src/client/mount.ts)、[插件清单类型](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/host/plugin-inventory/src/types.ts)。

本轮补充的 smoke 直接复用 `WorkspaceFilesClient` 和预览读取函数，验证缺省参数、分页、multipart bytes、ready 后真实 change、更新后的完整文本、二进制/超大预览拒绝和 not-found；可选 Team bundle 验证 active service、Lead projection 与旧 RPC 的 404。没有新增单元测试。编辑器 UI、远端跨机器部署和手动刷新仍需人工验收。

剩余产品集成按优先级见 [TODO](./TODO.md)：Jobs 输出/取消、timed 问答完整生命周期、Team 投影面板、插件变更操作、Runtime Terminal。`fileUploads/upload` 与现有官方裸字节上传功能等价；Desktop telemetry 与执行不可信 Client half 不纳入 IDE 计划。
