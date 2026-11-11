# 插件维护调查（2026-11-11）

## 结论与本次改动

默认 Runtime 目标仍为 `0.2.1-rc.2`。上游最新预发布为
[`dsh-v0.2.2-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.2)，
源码 tag 对应 `ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`。
本次补充特定接口的兼容处理，不代表完成新版 Runtime 的全部适配。

- 修复新版 `session/control` 的批量 projection 帧导致异常：整批验证并应用，兼容旧版单个 `key/value` 帧。
- 从 `inbox` projection 恢复排队、插话和上下文消息，保留旧队列控制帧作为兼容路径。
- 修复控制流在目录基线读取结束前失败时，Promise 拒绝未及时处理的问题。
- 接入可选的“继续生成”：Runtime 提供 `conversationContinuation` 时，空草稿的发送按钮可直接继续临时失败的生成。
  操作绑定会话与失败序号；运行中、提交中、已有排队输入、待处理交互或只读权限时不可提交。
  使用空 `session/prompt`，不重发原任务或附件；响应丢失后复用 request ID，接收成功后屏蔽同一失败的再次提交。
- 附件读取完成前禁止发送，读取失败提供可见提示；输入法组合期间不让补全菜单处理按键；快捷键提示与 Enter 发送、Shift+Enter 换行的实际行为一致。

## 竞品与现有能力

以下区分近期发布与已有功能；优先级是结合本仓库现状的判断。

| 产品与依据 | 已核实的能力 | 本插件现状与建议 |
| --- | --- | --- |
| [VS Code 1.146，2026-11-11](https://code.visualstudio.com/updates/v1_146) | 实验性会话 Inbox、模型对比、独立聊天窗口、Agents 窗口扩展 | 已有跨 DSH Workspace 的会话中心、审批/问题/错误优先排序及编辑器聊天镜像。下一步优先做持久可见的待处理会话列表、筛选和未读状态；模型对比需单独设计运行与费用语义。 |
| [Cursor 更新日志，2026-11-06 / 11-05](https://cursor.com/changelog) | Agent 实时语音对话；构建带数据库、认证和托管的可分享应用 | 属于语音服务和云端交付能力，投入与依赖较大。暂排在 Runtime 兼容、历史与审阅工作流之后。 |
| [Cline Checkpoints 文档](https://docs.cline.bot/core-workflows/checkpoints) | Shadow Git 保存工具步骤快照，可比较与恢复文件、会话或两者 | 已有逐次工具 Diff、按消息分叉与恢复代码、按轮次审查。后续应明确命令副作用的覆盖范围、恢复冲突与未保存文件处理，再考虑完整快照。此项是功能对照，不是声称 Cline 最近新增。 |

已刷新仓库配置的三个社区 fork 远端。调查时 `1w1w11w1/main` 没有相对本仓库
`origin/main` 的独有提交；其文件粘贴附件分支是历史开发分支，本插件已具备对应入口，不直接重复合并。

## 上游新增与接入差距

发布依据：[0.2.2-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1)、
[0.2.2-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.2)。
接口判断来自本地 `deepseek-harness/` 中对应 tag 的源码（通过 `git show` 读取，保留原 checkout）。

| 上游能力或变化 | 接入状态 / 后续工作 |
| --- | --- |
| 每次事件一次性发布 projection changes；队列使用持久 inbox | 本次补齐批量帧、原子应用和队列显示，保留旧格式。 |
| 临时模型失败后继续生成 | 本次按可选 projection 接入，不猜测错误是否可重试，不对旧 Runtime 发送空消息。 |
| Host 级 Schedule，分页列表、任务目标、暂停/结束状态 | **尚未适配。** `schedule/list` 已由会话数组变成 `{items, shown, total, limit, offset}`；任务状态和目标也已变化。升级前需要同步列表、编辑、删除与历史面板，不能只解包 `items`。目前新版任务请使用官方 Web UI。 |
| `session/follow` 可选择后台激活；默认被动读取 | 需分别验证聊天打开、历史预览、冷会话迁移与共享权限。不要给所有预览请求无条件增加 `activate: true`。 |
| 具名、多层 SubAgent 与会话级 AgentTeam | 现有子代理树和 Team 面板需核对名称、逐层读取、重试及工具开关；本次没有声明完整支持新层级协议。 |
| Worktree、PR 审阅、已审阅进度与分支更新 | 本插件已有本地 Diff / Git 上下文，尚无完整的上游 Worktree / PR 工作流；后续优先于语音与云托管。这里的 Workspace 始终指 DSH Workspace。 |
| 完整历史复制为 Markdown、聊天选区引用 | 现有复制限单条消息；适合下次维护补齐，导出应覆盖分页历史，并明确附件和工具输出的表示。 |
| Agent 终端可见与输入接管、插件包更新、模型重试策略 | 已有用户 Runtime 终端、插件安装/卸载与设置入口；仍需核对新版 Agent 终端 roster、接管语义和插件更新 RPC。 |

源码核对入口（均为 `dsh-v0.2.2-rc.2`）：

- `packages/api/session-controller/src/control.ts`、`types.ts`：`changes: [{key, val}]` 与事件序号。
- `packages/core/agent-loop/src/inbox.ts`：`next-turn` / `next-step` 的持久投影。
- `packages/api/session-controller/src/continuation.ts`、`commands.ts`：可继续失败集合、空 prompt 的 Host admission 与去重。
- `packages/client/ui-conversation/src/client/input/hub.ts`：原生客户端的失败序号和输入状态检查。
- `packages/api/session-controller/src/web/controller.ts`：被动 follow 与显式激活。
- `packages/schedule/schedule/src/types.ts`、`index.ts`：Host 级任务与分页列表。

## 验证与升级门槛

本次不新增或修改单元测试。执行类型检查、编译、现有 50 项回归、现有附件检查及 VSIX 文件清单检查。

本机可用 CLI 为 `0.2.2-rc.1`：完整集成冒烟首先复现了 projection 帧异常；修复后，
已通过八轮历史生成、分页、设置 schema、账号通知与共享权限检查，随后停在旧 Schedule 数组断言。
这一失败与上游接口变化一致，不能当作完整冒烟通过。另运行 `--seed-only` 的会话协议检查。

`0.2.2-rc.2` 的继续生成契约已按源码接入，尚需真实 RC.2 的临时错误与空 prompt 端到端验证。
提升默认目标前，应在隔离配置中补齐 Schedule、冷会话激活、子代理/Team、终端与 Jev 的真实 Runtime 冒烟。
