# DSH 上游与竞品：下一阶段产品建议

核对日期：2026-10-09（Asia/Shanghai）。本项目基线：`0.10.3`，提交 `6b3509e`；Remote contract 为 `dsh-v0.2.0-rc.2@639ed015397290b3745d163aafe02ffee4aa3f84`。

**建议先做新版协议兼容、Runtime 终端和插件安装闭环；下一阶段主打 Worktree 隔离任务、跨会话待办入口和可验证的交付结果。** 当前功能基础已经较完整，收益最大的工作是让用户顺畅完成“开始任务 → 跟进执行 → 验证 → 审查 → 接受或恢复”。

这是调研与排序建议，未实施功能、升级默认 Runtime 或修改协议 pin。竞品依据官方文档及公开源码，未做产品实机横评；不能据此推断模型效果、稳定性、用户规模或性价比排名。文中的 Workspace 均指 DSH Workspace。

## 上游版本与必须先处理的变化

| 对象 | 已核对的状态 | 对本项目的意义 |
| --- | --- | --- |
| 本项目 | 默认目标与契约 pin 为 `0.2.0-rc.2` | 已完成 RC.2 的 Jobs、timed 问答、Team projection、插件开关与 Workspace 文件预览 |
| 本地上游 checkout | `c291e7961a`，2026-09-10；package version `0.1.5-rc.2` | 不能只看当前目录内容判断最新上游；RC.2 和 alpha 应使用 `git show <tag>:<path>` |
| 上游 alpha.1 | `dsh-v0.2.1-alpha.1@5badb15…`，10 月 3 日发布 | 新增实验性 Mods 兼容层、开发者工具 bundle、反向代理 public URL 等 |
| 上游 alpha.2 | `dsh-v0.2.1-alpha.2@d743267388641bc76f17c45ce8b4c231aed1d32c`，10 月 9 日发布 | 新增实验性 Git Worktrees、工作目录工具、共享 AGENTS 指令目录及 SSH helper 等 |

发布状态依据：[官方 Releases](https://github.com/deepseek-ai/deepseek-harness/releases)。alpha.2 是预发布版；“最新发布”不等于本项目已完成兼容验证。此次仅获取两个 alpha tag，没有切换 `deepseek-harness/` checkout。

重点源码差异如下，尚不构成全量 RPC 审计：

1. **投影查询出现迁移状态。** `session/projections` 从 `{ asOfSeq, values } | null` 变为 `kind: 'sequenced' | 'migration-required'` 联合类型。后一种只有缓存提示，没有可比较的事件序号；列表增加 `formatStatus`，fork 增加 `allowMigration`。本项目 `projectionBlock()` 可以读取有序结果，但无法读取缺少 `asOfSeq` 的迁移提示，`getAgentTeam()` 会把它当协议错误。需要分开处理“缓存展示”和“有序真值”，引导打开原会话完成迁移，不能凭空生成 seq。依据：[上游 SessionController](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.2/packages/api/session-controller/src/index.ts)、[wire types](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.2/packages/api/session-controller/src/types.ts)；本项目 [`sessionState.ts`](./src/remote/sessionState.ts)、[`dshRuntime.ts`](./src/dshRuntime.ts)。
2. **当前工作目录成为独立状态。** `workingDirectory` projection 和 `working-directory/change` 事件表示有效目录；Session header 仍标识原始项目，权限根与 Workspace 归属不随 `cd` 改写。已有终端保留自身进程目录。IDE 的新操作应使用当前有效目录，历史 Diff 和文件链接应使用执行时目录。本项目尚未显式消费该 projection，`ChangeReviewStore.observe()` 还会忽略同一 Session 的 cwd 变化。依据：[上游目录子系统](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.2/docs/subsystems/working-directory.zh.md)、[架构决策](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.2/.agents/notes/implemented/architecture/2026-09-13-session-working-directory.zh.md)；本项目 [`chatView.ts`](./src/chatView.ts)、[`changeReviewStore.ts`](./src/changeReviewStore.ts)。
3. **Worktree 是可选插件，创建不是现成 Remote RPC。** `create_worktree` 通过 Host 服务创建并进入 checkout；默认从本地 `HEAD` 开始，不 fetch，也不复制未提交或忽略文件；离开目录不会删除 checkout。已查看的 Worktree/工作目录包没有 `@Remote`。首版可以展示工具结果和目录状态，并提供可编辑的任务草稿；原生创建、列举、合并和清理按钮需要另行确认公开契约，不能假设 `worktree/create` 存在。依据：[Worktrees 子系统](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.2/docs/subsystems/worktrees.zh.md)、[工具实现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.2/packages/experimental/tool-worktree/src/index.ts)。
4. **升级要覆盖既有插件。** 发布说明移除了 `both` 工具模式，并调整子代理完成通知和 Team 消息投递。Jev 的 hooks、工具结果消费和 Team 校验需要随升级复核；不能只提高版本常量。依据：[alpha.2 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.2)。

## 已有能力：避免重复排期

- 原生工具 Diff、审批前预览、未保存文件守卫、编辑器/选区/Git/调试上下文。
- 会话恢复、置顶、归档恢复、搜索、大纲、消息处分叉，以及恢复代码/分叉并恢复入口。
- Jobs 输出、按游标重连和取消；Team 成员、任务、依赖及历史；限时问题与延迟回答。
- 插件清单、参数设置、插件启停、Bundle 选择；Workspace 文件只读浏览及变化刷新。
- Trace、用量与上下文归因、Schedule 管理、默认关闭的自主调试和 Laya/Jev 决策增强。

实现依据：[`README.zh-CN.md`](./README.zh-CN.md)、[`RC.2 适配报告`](./RPC_0.2.0_RC2_ADAPTATION.md)、[`TODO.md`](./TODO.md)及上述源码。已有入口不等于全部场景已验收；真实 VS Code、跨机器断网、账号与 Schedule 到期投递等仍有验证边界。

## 竞品比较：哪些做法值得转化为产品

以下是已确认的能力与可借鉴方向，不代表每个竞品的完整功能清单。

| 产品 | 公开资料确认的做法 | 我们的机会 |
| --- | --- | --- |
| DSH Sidebar（Lixxx1/dsh-vscode） | 插件发现/安装/删除、自主调试、原生 Diff、脏文件保护；源码还有 `sendProblem` 命令 | 自主调试和保护已具备；补插件安装闭环和 Problems 上下文，缩短首次使用路径。[README](https://github.com/Lixxx1/dsh-vscode/blob/main/README.md)、[manifest](https://github.com/Lixxx1/dsh-vscode/blob/main/package.json) |
| Cursor | Worktree 隔离执行、setup、审查和应用结果；浏览器读取截图、console 与网络信息。原生 Worktree UI 位于 Agents Window，IDE 使用相关 skills | 借鉴隔离任务的完整生命周期，以及前端任务的验证证据。[Worktrees](https://cursor.com/docs/configuration/worktrees)、[Browser](https://cursor.com/docs/agent/tools/browser) |
| Claude Code | 独立会话 Tab/窗口及状态提示、行范围引用、计划审查、checkpoint/rewind；checkpoint 不覆盖 Bash 改文件 | 补独立多会话视图与待处理入口，明确恢复覆盖范围。[VS Code](https://code.claude.com/docs/en/vs-code)、[Checkpointing](https://code.claude.com/docs/en/checkpointing) |
| Codex 桌面端 | Worktree、环境 setup、前后台 checkout handoff；定时任务可选择隔离目录 | 借鉴任务从执行到审查的组织方式；DSH 的 Schedule 消息投递不能直接等同于独立自动化运行。[Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)、[Scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app) |
| Cline | checkpoint 比较/恢复、Problems 引用、终端与浏览器操作、MCP Marketplace | 把上下文选择、扩展能力和恢复行为放在用户容易找到的位置。[IDE](https://cline.bot/ide)、[Checkpoints](https://docs.cline.bot/core-workflows/checkpoints) |
| OpenCode | IDE 快捷启动、独立终端会话、选区/文件行范围引用；工具支持实验性 LSP 查询 | 借鉴少步骤的上下文附加，优先用编辑器已有诊断与符号能力。[IDE](https://opencode.ai/docs/ide/)、[Tools](https://opencode.ai/docs/tools/) |

本项目的有利基础是对 DSH 原生状态的消费、可观测性、IDE Diff 与调试集成，以及 Laya/Jev 的证据检查。它们可以形成差异化；是否有效减少失败或费用，需要实际任务评估，不能仅凭功能存在下结论。

## 建议排期

工作量是相对判断，不是交付日期：小 = 单一上下文或展示改动；中 = 一个控制器及 UI 生命周期；大 = 多会话状态、持久化或 Git 协调。

| 顺序 | 建议 | 首版范围与完成条件 | 工作量 / 依赖 |
| --- | --- | --- | --- |
| P0 | alpha 兼容审计与目录语义 | 迁移提示可展示，打开原会话后重拉；原始项目/当前目录分开；目录切换后新操作正确，历史 Diff 不漂移；保持 RC.2 可用 | 中到大；先做新旧版本 smoke，再决定默认 pin |
| P1-A | Runtime 终端 | 用户能连接当前 Session 的 Host PTY、输入/resize、切会话后重连和恢复画面；明确终端与当前 Session 的目录差异 | 中；公开 `terminal/*` 已有，不依赖 Worktree |
| P1-B | 插件安装闭环 | 在现有清单上加 inspect、安装/取消/卸载、进度、失败原因与重启状态；先支持用户给出包 spec，社区搜索作为下一步 | 中；RC.2 已有官方管理器 Remote |
| P1-C | Problems 上下文 | `@diagnostics` 或“发送此问题”：用户选择当前文件/诊断，展示消息、位置、代码及大小；只附加选择的范围 | 小；VS Code diagnostics，无需新 DSH RPC |
| P1-D | 跨会话待处理入口 | 按 DSH Workspace 聚合运行中、待审批、待回答、完成/失败；点击跳转；先做会话中心，再考虑多个独立 Tab | 中；核对权限/问题流的可观察范围 |
| P2-A | Worktree 隔离任务 | 启用官方 bundle 后，展示创建结果、分支与有效目录，提供打开 checkout、审查和继续入口；后续再加 setup、合并与清理 | 大；依赖目录兼容及可用管理契约 |
| P2-B | 可持久化的恢复能力 | 复用现有按轮快照，明确重载后可用性；处理多轮恢复、用户并发修改、目录切换和容量管理 | 大；先冻结恢复语义 |
| P2-C | 交付证据卡 | 汇总修改文件、执行过的检查及结果、未验证项，点击定位对应工具记录；用户显式启用浏览器/调试验证 | 中；先使用已有 Trace/工具证据 |
| P3 | 远程执行产品化 | 先完成 Remote SSH/WSL/Container 和 DSH SSH provider 的执行侧矩阵；稳定后再做连接向导 | 大；SSH helper 发布不等于 IDE 已支持全部远程场景 |

### Runtime 终端：优先消除执行与接管之间的断点

现有 `@terminal` 捕获 VS Code 终端上下文，Jobs 展示后台输出；两者都不等于用户可交互的 Host PTY。公开终端控制器有 `environment`、`shells`、`list`、`create`、`retain`、`follow`、`write`、`resize`、`rename`、`close`，可评估用 VS Code Pseudoterminal 显示。

必须遵循 retain 与 attachment 的生命周期，区别重新附着和创建新终端。上游保留范围是 Host 生命周期，不能承诺 Runtime 重启后进程仍在；该控制器创建的是用户 shell，也不能当作 Agent 的沙箱工具通道。验证输入权、断线重连、退出、画面恢复及 Windows PTY。依据：[TerminalController](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.2/packages/api/terminal-controller/src/index.ts)。

### 插件安装：现有公开契约足够启动

RC.2 和 alpha.2 都有 `pluginManager/inspect|installBundle|waitForInstall|cancelInstall|removeBundle`，以及安装状态/日志事件；因此不用先重做一套 CLI/profile 管理。先提供输入包 spec 与官方可用 Bundle 的安装，再设计社区目录搜索。

UI 需要说明来源、版本兼容、构建脚本授权、保存/生效/需重启的区别，直接消费官方 `ChangeResult`，保留失败与取消结果。安装失败回滚不意味着下载文件或第三方脚本副作用全部消失。外部 Runtime 的安装也发生在 Host，不能在本机冒充完成。依据：[RC.2 PluginManager](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/boot/plugin-manager/src/index.ts)、[alpha.2 PluginManager](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.2/packages/boot/plugin-manager/src/index.ts)。

### 多任务：先解决“哪个任务需要我”

当前侧栏和编辑器 Tab 是同一 provider 的镜像，切换会话会同步改变两个视图；它们不等于两个独立会话。先复用 catalog 做运行中/待处理会话导航，再按 Session 分离 UI 选择状态，底层保持 Runtime store 唯一来源。

跨会话审批和问题是否能完整展示，取决于 Host 的流与 claim 语义；首版可只导航，动作仍进入目标 Session 执行。不能展示未经观察的“没有待办”，也不能用本地推测替代 Host 结算。依据：[`chatViewSurface.ts`](./src/chatViewSurface.ts)、[`chatView.ts`](./src/chatView.ts)，竞品参考见上表。

### 恢复：先把已有功能说清楚

现有消息菜单已提供 Fork、恢复代码、Fork + 恢复。代码恢复调用单轮 `ChangeReviewStore.restore()`，并非任意历史消息的整个文件系统快照；仓库树快照可能包含同时发生的用户改动。审查记录和临时 index 还依赖当前 Extension Host 生命周期。优先验证并明确这些边界，再决定多轮串行恢复或持久化快照方案。

必须继续保留恢复前后冲突检查；恢复成功而 fork 失败时要显示部分成功。不要直接把当前入口宣传成覆盖 shell、ignore 文件、未保存编辑与所有历史状态的完整 checkpoint。依据：[`chatView.ts`](./src/chatView.ts)、[`changeReviewStore.ts`](./src/changeReviewStore.ts)。

### 交付证据：把已有可观测性变成实际决策帮助

先做确定性的结果摘要：哪些文件改了，什么命令检查过、退出状态是什么，哪些结论尚无证据；工具记录可点击追溯。Laya/Jev doneGate 的结果可作为辅助信号，不能替代编译、现有检查或人工验收。

后续为前端任务提供可选浏览器验证：复用上游的 Playwright/Chrome DevTools MCP，而不是先自建浏览器执行器。把截图、console 错误和验证步骤归入同一交付卡，与原生 Diff、自主调试联动。这是对现有基础的产品建议，尚未核实所有 MCP 结果到 IDE 的呈现契约。

## 暂缓的方向

- **Ghost text / 全量向量索引：**涉及新的模型路由、延迟、取消与计费；优先把文件、选区、Problems、符号查询做好。
- **隐式 Memory 写入：**alpha.2 已有上游 AGENTS 指令发现；先显示来源与生效范围，避免另起重复注入体系。
- **把 Schedule 包装成云端任务执行：**现有接口支持定时消息与投递历史，运行环境、唤醒条件和产物生命周期仍需确认。
- **照搬官方 Desktop 外观设置、语音和遥测：**这些已有上游入口，IDE 集成的边际收益低于终端、插件、审查和验证。

## 建议的迭代与验收

1. **兼容迭代：**审计 RC.2 → alpha.2 的 Remote、事件、投影、目录与 Jev hooks；旧会话迁移、Team 历史、工作目录变化通过现有 Runtime smoke。完成前保持默认 pin。
2. **日常工作迭代：**Runtime 终端 + 插件安装 + Problems 引用；真实 VS Code 验证开始任务、接管终端、取消安装、断线恢复和诊断附加。顺带完成已有 RC.2 未验收路径。
3. **差异化迭代：**先做 Worktree 结果与目录展示、会话中心和交付证据卡；后续根据管理契约与使用反馈完善 setup、恢复和清理。

遵守仓库规则：不新增单元测试；实现阶段使用既有检查、集成 smoke 和人工场景。调研阶段不需要跑模型任务。

衡量这些建议是否有效，使用同一组真实任务记录：安装到首轮成功的步骤数、任务中断后的恢复成功率、发现待审批任务的耗时、可审查并恢复的改动比例，以及交付结论具备可追溯验证证据的比例。当前未采集这些数据，排序属于源码与产品工作流分析，尚不是用户研究结论。
