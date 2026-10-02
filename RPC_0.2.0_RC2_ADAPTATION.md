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
- Agent Teams wrapper 增加 composition probe：通过 `pluginInventory/list` 检查 `agent-team` Host row 是否 active。标准 Web profile 不挂载 `agentTeams/*`，因此不会再把 404 当成普通业务失败；完整 Team roster/task-board UI 仍属于实验性 profile，尚未在 IDE 展示。
- `permissionPresets/catalog` 接入权限面板；RC.2 的 `permissions` projection 只提供 `currentValue` 时，IDE 用独立 catalog 合并可选项，并兼容旧 Runtime 将 options 放在 projection 中的格式。
- Plugin Manager 的只读 `listBundles` 已接入 Settings 插件清单，展示 Bundle 的安装、选择、版本和只读状态；安装、启停和删除仍留在 Harness Web UI。

上游 Desktop 命令管理、模型选择器搜索、Sidebar 本地应用打开和 PowerShell 修复属于 Harness Web/Desktop 自身能力，dsh-ide 不复制这些 UI。定时消息改为明确的用户定时消息也由 Runtime 记录和呈现，IDE 通过公开 Session history 原样读取。

验证使用临时安装的精确 npm 包 `@deepseek-ai/dsh@0.2.0-rc.2`，没有替换本机 CLI。执行结果：

```sh
npm run check
npm run compile
node scripts/verify-remote-runtime.mjs --launcher /absolute/path/to/dsh
node scripts/verify-remote-runtime.mjs --launcher /absolute/path/to/dsh --with-schedule-bundle
node scripts/verify-remote-runtime.mjs --launcher /absolute/path/to/dsh --timed-questions
node scripts/verify-managed-runtime.mjs --version 0.2.0-rc.2
```

四类 Remote smoke 均通过：鉴权与 mux、Workspace/Session、V4 history 分页、评价、重连、流式输出、Goal、命令、Schedule 可用性，以及 timed `ask_user_question` 超时后 projection 保留和 late `userQuestions/answer` 结算。CNB RC.2 manifest 与五个平台资产检查通过（9/9）。

联调使用临时 DSH_HOME、独立 Workspace 和回环 Messages 模拟模型，不读取用户会话或外部模型凭据；没有执行真实模型 API、账号登录、Schedule 到期投递或 VS Code UI 人工验收。`userQuestions/attachWait` 已由上游契约审计，但当前 IDE 使用固定问题卡，不依赖浏览器倒计时 claim，因此未将它接入 UI。

源码参照：[RC.2 release notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2)、[user-questions Remote service](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/interaction/user-questions/src/index.ts)、[user-question projection](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/interaction/user-questions/src/projection.ts)、[RC.1 report](./RPC_0.2.0_ADAPTATION.md)。
