# TODO

更新时间：2026-09-18（按 `dsh-v0.1.5-rc.2` 重做 RPC 全量 endpoint 差集，修正两处过期结论）。
下方「本轮进展」各节是历史记录，保留当时的版本判断。

## 本轮进展（2026-09-06）

`0.1.2-rc.1` RC Remote 实现完成，部分验收待完成（`RPC_ADAPTATION_PLAN.md` 第 1–7 步）：
`src/remote/` 九模块 carrier 落地，旧 ApiProxy 协议（`harnessClient`/
`harnessState`/`harnessConnection`/`harnessProtocol`）及其测试删除；类型迁移
仅动 `types.ts` 与四个导入点，store 的 envelope reducer 保留为护栏测试入口。
对真实 `0.1.2-rc.1` runtime 跑了 32 项自动化 smoke（鉴权、unary/流握手、
baseline、workspace 生命周期、能力端点、错误路径）全绿；**UI 级流式、审批/
提问交互、断线恢复仍是未覆盖的人工冒烟项**（无模型 provider 的环境发不出
prompt）。第 8 步的版本发布用 `npm run release` 执行，CHANGELOG
[Unreleased] 已备好。

本次增量消费 `pluginInventory/list`：Runtime 对 Loader 条目和 Agent preset
组合做严格快照校验，设置面板提供全局/会话分组、生命周期相位、搜索和手动刷新；
仍保持只读，不凭空添加插件管理动作。随后接入 dynamic Cordis Host 面板：
inventory、停止、移除和拒绝待批准请求，Client half 继续交给 Harness Web UI。
文件位置跳转在本地边界检查失败且 Host 宣布 `canOpenPath` 时回落到
`session/openWorkspacePath`，为远程工作区保留公开协议路径。

本轮进一步核对了多根语义：DSH 的 Session/DirectoryPicker 契约均是单 `cwd`，
因此 VS Code multi-root 不作为一个 DSH Session 支持；同时为扩展启动的 Runtime
补上了异常退出后的 1s/5s/15s 有界退避恢复，外部 Runtime 仍只复用、不接管。
另复核了一轮能力边界：敏感内容自动识别仍不做，远程工作区仍只做测试，
插件安装等能力继续受公开契约和 Host 安全边界约束。

下方「契约基线」已按 `dsh-v0.1.2-rc.1` 与当前实现更新；`RPC_new.md` 与
`RPC_ADAPTATION_PLAN.md` 仍保留为迁移审计和版本升级门禁。下次升级先按其 §14
做 tag diff，再调整 runtime pin。

同日重构增量：chatView 三套目录缓存（model / skill / command）的手抄并发骨架
收拢为 vscode-free 的 `src/sessionCatalogCache.ts`（value map、请求去重、失效代际、
重拉排队各留一处实现），`npm run check` 与 `npm test`（50 项）验证通过；
`handleMessage` 拆分与 Subagent 编排仍是重构余项。
Subagent 编排随后也已迁出：树刷新/历史预览/跟进/中断与 6 个私有字段整体移入
`src/subagentController.ts`（425 行），按 `ProviderManagementDeps` 先例注入
`runtime` + `currentRootSession()` + `onChange()` 三个依赖，ChatViewProvider 仅在
构造器订阅、handleMessage 五个 case、postState/loadImage 读取、dispose 处接线；
迁出代码经机械替换归一后与原实现逐行等价（仅类内方法顺序不同）。messageFeedback
的状态与 CAS 骨架（4 字段 + 接口 + 2 个模块级 helper + 12 个方法）同法迁入
`src/messageFeedbackController.ts`（395 行；后续已将 `messageFeedbackView`/
`decorateMessageFeedback` 接回 Webview）。chatView.ts 3975 → 3175 行；重构余项：
`handleMessage` switch 拆处理器表（结构收益为主，行数基本持平），以及
settings/动态插件域（约 250 行）与 `updateFileReferenceCandidates`（约 200 行，
vscode 依赖较重）两个可选迁出。

## 本轮进展（2026-08-26）

整条完成 14 项，撤回 4 项（核对后判定无收益或不应统一，理由写在各条目上），
另有若干改动落在仍未完成条目的内部（主要是 `chatView` 续拆）。共 38 个 commit，
每个都经 `npm run check` 与 `npm test`（54 个测试）验证通过。

新增的两处基础设施值得注意：`webview/tsconfig.json` 让前端首次进入类型检查，
`npm test` 前置 `check:webview` 使 CI 门禁真正覆盖前端；`scripts/sync-locales.mjs`
让两个 zh-hans 文件从 zh-cn 派生，消除副本漂移。

那道新门禁在本轮当场拦下了两个我自己引入的错误（JSX 注释放进三元槽位、
i18n 重复 key），否则都会作为运行时坏包发出——这是它最直接的价值证明。

`chatView` 已从 3582 降到 3103 行，抽出 6 块（详见「重构 → 结构」条目，
其中记录了后续照用的抽取标准与三组未通过该标准的原因）。新增六个小模块：
`guards`、`paths`、`errors`、`providerManagement`、`codeBlockActions`、
`markdownRenderCache`。

`tracePanel` 的 425 行内联 UI 已迁完（966 → 611 行），仓库中不再有未经类型检查
的 UI 代码——这是本轮两处基础设施改动（webview typecheck、资源管线）合起来的结果。

**当时尚未起头的大项（历史记录）**：4 处超长函数提取、Gateway 通道及其依赖的两个功能。
这些需要成块的时间；随后 RC Remote 迁移已在 2026-09-06 完成，剩余是验收与功能消费。

**需要人工验证**：Trace 面板无测试覆盖，迁移后的行为我无法目视确认，
验证清单写在「重构 → 结构」该条目里。

## 契约基线（当前快照：2026-09-18，契约目标 `dsh-v0.1.5-rc.2`）

默认下载 pin 是 `0.1.5-rc.1`（`package.json` 的 `dsh.runtimeVersion` 默认值），
`src/remote/contracts.ts` 的契约 pin 是 tag `dsh-v0.1.5-rc.2`、commit
`fb2c4b9e698e30edb738bca4cf0618587db7d203`（本地 `deepseek-harness/` HEAD
`c291e7961a` 即该版本同步进 master 的位置）。RC Remote 的 endpoint 和
projection 集合由当前 Loader composition 决定，不再用旧版固定总数判断兼容性。
`dsh-v0.1.5-rc.2` 全量为 87 个 `@Remote` endpoint / 20 个 namespace（唯一注册机制是
`packages/typert/protocol/src/index.ts` 的 `@Remote` 装饰器，树内没有生成的 endpoint
清单），`src/remote/` 消费其中 68 个；未消费的 19 个逐条列在下方的
「`0.1.5-rc.2` 未消费 endpoint」一节。

- **RC Remote unary**：统一走 `POST /api/<namespace>/<method>`，请求为
  `payload: {args: ...}`，由 `src/remote/unaryClient.ts` 严格校验 envelope、
  endpoint、rpcId、响应和 namespaced error。`DshRuntime` 当前消费 session、
  workspace、subagents、goals、agentPresets、pluginInventory、dynamicCordisRunner、skills、commands、settings、
  credentials、llm、directoryPicker、fileReferences、
  sessionReferenceResolver 与 messageFeedback 等已挂载能力；`agentTeams/view|createTask|updateTask`
  已在 `src/dshRuntime.ts` 留有 wrapper 但零调用方，属未激活的内部准备（见下方附注）。生产代码不再
  依赖旧点号 endpoint map。
- **RC Remote streams**：`/api/remote.mux` 由 `RemoteMuxClient` 承载 `$events`、
  `workspace/follow`、`session/control` 和按需 `session/follow`；
  `RemoteStateCoordinator` 以 generation baseline、cursor 和高 seq projection
  合并重连状态。旧的双 WebSocket、`server-request`、`/api/respond` 已移除。
  `0.1.5-rc.2` 的第 4 个流 `workspaceFiles/changes` 未消费。
- **Session projection**：projection cell 以任意字符串 key + seq 进入
  `GenericProjectionStore`，未消费的 key 仍会到达并缓存。当前 UI 消费
  `goal`、`todos`、`tokenUsage`、`contextPressure`、`contextBreakdown`、
  `title`、`sessionStats`、`permissions`、`imageLimits`、`plan`、
  `subagentTiming`、`modelSelection`、`turnOutline` 与 `schedule`；其中
  `modelSelection` 已按 projection 变化实时更新模型/推理强度状态，`turnOutline`
  已驱动对话导航，`schedule` 已接入 Activity Dock 只读面板。
  Session 元数据只携带单个可选 `cwd`；这不是 VS Code multi-root 的多路径绑定。
- **Typert Gateway capability**：`commands/list|execute`、
  `fileReferences/list`、`sessionReferenceResolver/candidates` 已由 UI/Runtime
  消费；文件与会话引用在 404/旧 Runtime 时回退本地候选。`messageFeedback` 已接入
  会话级缓存、CAS 变更和消息行点赞/点踩/备注入口，旧 Runtime 静默降级；`pluginInventory/list`
  已接入设置面板只读清单；动态插件 inventory/stop/remove/decline 已接入
  Activity Dock（源码不在 Extension Host 执行）。所有 RC1 调用均经 `src/remote/`，不要再按已删除的
  `src/harnessClient.ts`、`src/harnessProtocol.ts` 估算接入成本。

## P0：BUG修复

暂无

## P1：功能（按性价比排序，均已核对公开契约）

- [x] **消息反馈 UI/评测闭环**。上游 `messageFeedback.list/put/delete` 已有公开 `@Remote`（`deepseek-harness/packages/feedback/message-feedback/src/index.ts:189,205,271`）；当前已接入会话级刷新、CAS 变更、点赞/点踩、备注编辑、会话切换和旧 Runtime 降级。反馈不写入模型上下文或 telemetry；统计、导出和会话级 `sessionFeedback/record` 仍按下方候选项另行评估。
- [ ] **上下文用量与超限反馈补全**：发送前展示附件大小、截断与最终进入 prompt 的内容，支持移除大项。（基础用量与 `contextBreakdown` 占用归因已完成；不自动识别或分类秘密、个人信息等敏感内容，除非另有隐私策略和明确同意。）
- [ ] **扩展 `@` 引用类型**：当前已有文件、目录、`@selection`、`@terminal`，以及 Runtime 侧 `fileReferences/list`、`sessionReferenceResolver/candidates` 候选；仍需 diagnostics、实际捕获范围展示，并补齐远程工作区实机验证。
- [ ] **项目规则（Prompt 模板已交付，见下）**：提供本地规则 Markdown 的只读发现和显式选择，作为可见上下文附件；没有公开 Memory 协议时不自动注入或生成隐式记忆。

### 新 RPC 解锁的功能候选（2026-09-06 按 `dsh-v0.1.2-rc.1` 首次复核；2026-09-18 按 `dsh-v0.1.5-rc.2` 全量 endpoint 差集复评）

适配完成后（上一节），RC Remote 的消费面盘点（2026-09-18 按 `dsh-v0.1.5-rc.2` 复核）：
19 个下行事件（`packages/api/remotes/src/remote-events.ts` 的
`API_REMOTE_FORWARDED_EVENTS`，17 个 emit + 2 个 waterfall）已全部进入
`src/remote/events.ts` 的 allowlist，其中 17 个已消费（catalog 6 个 + approval/question
waterfall 2 个 + chatView 失效刷新 4 个 + dynamic 插件刷新 4 个 +
`goal/activation-changed`，未消费的 2 个 `cordis/inspect-*` 见下）；已注册 session
projection 已消费 14 个 key（goal、todos、tokenUsage、contextPressure、
contextBreakdown、title、sessionStats、permissions、imageLimits、plan、
subagentTiming、modelSelection、turnOutline、schedule）；且
`GenericProjectionStore` 本就缓存全部 projection —— 以下多数条目是**纯呈现层
工作**，不动传输。`pluginInventory/list` 已由 Runtime 严格校验并在设置面板
按全局 Loader 与 Agent preset 组合分组展示；剩余候选按性价比排序：

- [x] **动态插件面板（`dynamic`，进阶，Host 侧）**：已消费
      `dynamicCordisRunner/inventory`、`stopFromPanel`、`undefineFromPanel` 与
      `resolveRequestRun`（拒绝待批准请求），并在 Activity Dock 展示按会话归属的只读状态、
      package/Host half/Client half、等待服务和失败诊断。6 个 `cordis/*` 下行事件会触发
      重新读取；`cordis/request-run` 显示待批准提示并可跳转 dsh Web UI。扩展不执行不可信的
      `getClientCode`，也不在 Extension Host 内模拟 Client half；浏览器侧运行与批准仍由
      Harness Web UI 负责。
- [ ] **远程工作区支持评估（暂只做测试）**（激活上方 P1「Runtime 可靠性」的搁置项）：`dshRuntime` 已有
      `directoryPicker/*`、`session/canOpenWorkspacePath|openWorkspacePath` wrapper；
      `fileReferences/list` 已接入 Composer，缺失时回退本地候选。Runtime 侧文件浏览/打开的协议解法基本就位，
      但 picker 尚未接入远程工作区专用 UI；剩验证 Remote SSH/WSL/Dev Container 下 Extension Host
      与 Runtime 同侧性的实机评估。
- [ ] **`workspaceFiles/*` 消费（7 个 endpoint，含 `changes` 流）**：`0.1.5-rc.1` 起上游已在
      `packages/api/remotes/src/client/index.ts` 挂载 `workspaceFilesRemote`，扩展零调用
      （`deepseek-harness/packages/api/workspace-files/src/index.ts:231-364`）。本地工作区由
      VS Code 原生 FS 覆盖，因此这是**远程工作区专用**能力：文本分页读、字节窗口读、
      `readRelated`、`stat`、`list` 与 `changes` 变更流，也是「Files API 图片复用」的落点。
      接入前先解上方「远程工作区支持评估」的同侧性判定；注意 7 个方法的首参在 wire 上名为
      `workspaceFileScopeId`（`src/index.ts:202` 的 lookup 显式改写，全库唯一），不要按 `scope` 抄。
- [ ] **`sessionFeedback/record`（整会话反馈入口）**：上游 `dsh-v0.1.3-alpha.2` 起公开，
      `0.1.5-rc.1` 已挂载（`packages/feedback/command-feedback/src/index.ts:101`），是 Web 反馈
      对话框与 `/feedback` 命令背后的分类 + 备注上报，与 `messageFeedback`（逐条消息评分）不是同一
      契约。扩展当前只有 `messageFeedback`，会话级反馈无 IDE 入口。上游不写 Session 日志、不触发模型
      工作，接入不触碰 prompt；与「消息反馈 UI/评测闭环」项共用评价口径决策。
- [ ] **`settings/canOpenAgentPresetDirectory` 能力探测**：`src/dshRuntime.ts` 直接调
      `settings/openAgentPresetDirectory`，未先探测。上游该目录打开受 optional `agentPresets`
      服务与 `Config.nativeOpen` 双重门控（`settings-controller/src/index.ts:232-240`、`:89`），
      无能力时抛 `agent-preset/not-found`。现状是报错而非隐藏菜单项，与 `session/canOpenWorkspacePath`
      先探测再回落的既有做法不一致；改用探测可对齐。
- [ ] **`cordis/inspect-query` / `-resolved` 呈现**：`src/remote/events.ts:29-30` 已在 allowlist
      内（帧不会触发协议错误），但除该文件外零消费者，配套的
      `dynamicCordisRunner/resolveInspectQuery`、`syncInspectManifest` 亦未接入，即 `cordis_inspect`
      工具在 IDE 侧无呈现。属动态插件面板的剩余一半，需先定 IDE 是否承担 Web UI 的 inspect 面板角色。

附注（证据与边界）：

- **【2026-09-18 修正】** 原记「`fileUploads` remote 是 `0.1.3-alpha.1` 新增，rc.1 挂载清单里没有」。
  该判断只对 `0.1.2-rc.1` 成立，对 `0.1.5-rc.1` 是错的：`git show
  dsh-v0.1.5-rc.1:packages/api/remotes/src/client/index.ts` 的挂载清单同时包含
  `fileUploadsRemote`、`workspaceFilesRemote` 与 `sessionFeedbackRemote`。
  `fileUploads/upload` 至今零调用，但**不构成图片上传的功能缺口**：扩展走
  `/api/session/uploadFileBinary`（`src/dshRuntime.ts:1934`），那正是同一上游服务自己的权威
  裸字节路由（`packages/client/file-upload/src/protocol.ts:2`），`fileUploads/upload` 只是
  JSON 编码的备用入口。跟随 alpha 前按 `RPC_ADAPTATION_PLAN.md` §14 做 tag 增量审计的门禁维持不变。
- hooks、session-query、session-title、mcp 在 rc.1 的 `@Remote` 计数仍为 0，
  「上游暂无契约」三项维持搁置；`session/search` 本身已是公开 remote（本次 smoke 验证过），
  但部署可禁用索引（返回 `gateway/internal: session search is disabled`），调用方需保留该降级。
  `packages/mcp`、`schedule`、`jobs`、`webhook`、`workflow`、`hooks`、`lsp`、`e2b`、`sandbox`、
  `identity`、`skill`、`acp`、`todo`、`plan`、`storage` 在 `0.1.5-rc.2` 的 `@Remote` 计数仍为 0：
  `jobs` 以 `SessionJob` 类型挂在 `session/*` 返回值上，`skill` 只以 `skills/list`
  （由 api-session-controller 持有）出现，均无独立 namespace。
- **【2026-09-18 修正】** `agentTeams/*` 不只是「属 experimental，未列入候选」：上游
  `agentTeams` **不在** `api-remotes` 的挂载清单里，唯一挂载点是
  `packages/experimental/client-ui-agent-team/src/client/mount.ts:88`，只在
  `agent-team-profile` / `agent-team-web-profile` 补丁下可达。默认托管 Runtime 上调用会直接端点失败，
  而版本本身并不蕴含该服务已安装（`RPC_0.1.5_ADAPTATION.md` 已记）。`src/dshRuntime.ts:2219-2237`
  的三个 wrapper 因此零调用、无 UI、无命令，是纯粹的准备代码；激活前需先确认目标 profile 挂载，
  否则考虑收缩为该判定之后再接线。

### `0.1.5-rc.2` 未消费 endpoint（19 / 87，2026-09-18 差集）

按 `@Remote` 装饰器逐条对出，非按文档推断。判定分三类。

**真缺口（上游已挂载，扩展零调用）**：

| endpoint | 上游位置 | 备注 |
| --- | --- | --- |
| `workspaceFiles/read\|readBytes\|readAll\|readRelated\|stat\|list` | `packages/api/workspace-files/src/index.ts:231-336` | 远程工作区文件预览 |
| `workspaceFiles/changes`（流） | 同上 `:364` | 4 个 Remote 流中唯一未消费 |
| `sessionFeedback/record` | `packages/feedback/command-feedback/src/index.ts:101` | 会话级反馈入口 |
| `settings/canOpenAgentPresetDirectory` | `packages/api/settings-controller/src/index.ts:130` | 探测未用，见上方候选项 |
| `fileUploads/upload` | `packages/client/file-upload/src/index.ts:105` | 已由裸字节路由等价覆盖，仅 JSON 入口缺失 |

**有意不做（有决策依据，不记为欠账）**：

| endpoint | 依据 |
| --- | --- |
| `settings/replace` | 本文件「明确不做」一节：整文档覆盖是退步，设置卡片走 revision 保护的 `settings.mutate` |
| `dynamicCordisRunner/getClientCode\|runHostHalf\|settleUserRun\|invoke\|reportRenderFailure\|reportClientGuardFailure` | 上方「动态插件面板」项：扩展不在 Extension Host 执行不可信 Client half，浏览器侧运行归 Harness Web UI |
| `dynamicCordisRunner/syncInspectManifest\|resolveInspectQuery` | 与上方 `cordis/inspect-*` 呈现项同源，待角色判定 |

**已接线、零调用方**：`agentTeams/view|createTask|updateTask`（见上一条附注）。

差集另含两条反向结论：扩展调用的 endpoint 名全部能在 `0.1.5-rc.2` 找到对应声明，无幻影或已删方法
残留；两个易错参数名都已做对 —— `session/list` 用字面 `_request`（`session-controller/src/index.ts:223`），
19 个事件名与 `remote-events.ts:16-35` 逐一对齐，两个 waterfall 经 `$events/result` 应答。

### 竞品差距（2026-09-18 对照 `Lixxx1/dsh-vscode`，DSH Sidebar v0.0.5）

按整仓源码逐文件核对，非按 README 判断。基线：该扩展消费约 24 / 87 个 `@Remote`
（无 `goals`、`subagents`、`workspace` CRUD、`directoryPicker`、`messageFeedback`、
`fileReferences`、`sessionReferenceResolver`、`llm` 三方法、`dynamicCordisRunner`），
无托管 Runtime 下载（README 第一步即 `npm install -g @deepseek-ai/dsh`）、
`package.json` 无 `l10n` 字段、仅上 Marketplace、贡献面 14 命令 / 6 设置。
因此在协议覆盖、Runtime 供给、分发与本地化、Trace 与大纲呈现上我方领先，
以下 4 项是**差距的全集**，且**没有一项需要新增 RPC**：

- [x] **工具写入的脏文件守卫（先做，安全类且对方当卖点）**。竞品用
      `src/tool-write-guard.ts` + `src/dirty-file-guard.ts`：从事件流按工具名
      （`write|edit|str_replace_editor|apply_patch`）识别写意图，解析目标路径，
      与未保存编辑器比对后拦截。我方当前只在**自己的**代码块应用路径查
      `isDirty`（`src/codeBlockActions.ts:99,128`），Runtime 侧工具写入无守卫。
      接入点唯一：`src/chatView.ts:2495` `answerApproval` 在
      `respondRemoteEvent` 之前判定；目标路径复用审批卡片既有的
      `presentApprovalCall(session, interaction.callId)` 与
      `src/toolDiffStore.ts:133-141`（`applyProposedHunks` 处已同时持有 `path` 与拟写内容），
      不必新起一套路径推断。语义要求：命中时**不得静默放行也不得静默拒绝**，
      要把「哪个文件有未保存改动」呈现出来并保留用户显式继续的出口。
      竞品按工具名后缀猜是启发式，我方已有 `callDiffState`/`storedDiffView` 的
      结构化依据，不要降级成名字匹配。
      实现：`ChatViewProvider.answerApproval` 在 `claimInteraction` **之前**用
      `presentApprovalCall(...).diffPaths` 与 `vscode.workspace.textDocuments` 的
      `isDirty` 求交（路径按 `sessionCwd ?? workspaceRoot()` 解析，与
      `src/toolDiffStore.ts` 同一口径），命中即抛错并列出文件名，卡片因此留在
      `pending` 可重试；未命中才 claim → `respondRemoteEvent`。未做按工具名推断的
      回落，终端审批不在守卫内（README/CHANGELOG 已注明该边界）。**未在真实 VS Code
      窗口跑过**，仅过 `npm run check` 与既有 50 项测试。
- [x] **编辑器 Tab 聊天入口**（把下方 P2「编辑器 Tab 聊天入口评估」转正）。
      竞品有 `deepseekHarness.openInEditor`，与右侧栏并存。P2 原条目约束维持：
      先验证 Session deep-link 与状态复用，**不维护第二套聊天状态**——
      现有 `ChatViewProvider` 的 `postState` 是唯一快照来源，编辑器槽位只能做同一
      provider 的第二视图，不能另起 store。
      实现：先抽出 `src/chatViewSurface.ts`（一个 surface = 一个 webview + 它自己的
      `ready` + `reveal`/`setBadge`/`resolveResource`），`ChatViewProvider` 改为持有
      `surfaces: Set` 与 `activeSurface`；`postState` 一次算状态、逐个 surface 投递，
      入站消息仍全部汇入同一 `handleMessage`，**没有第二份会话状态**。
      `asWebviewUri` 与 webview 一一对应，因此 shared state 里只放 `resources/` 下的
      文件名，投递前由 `withSurfaceResources` 按 surface 改写 effort 滑块 URI。
      入口为 `dsh.openInEditor`（命令面板 + 侧栏 `view/title` 图标）→
      `createWebviewPanel("dsh.chatViewEditor", …, retainContextWhenHidden: true)`，
      只复用一个标签页。未注册 `WebviewPanelSerializer`，故窗口重载后该标签页不恢复。
      **未在真实 VS Code 窗口跑过**。
- [x] **自主调试（把下方 P2「调试器控制安全 spike」升级为 P1 并定方案）**。
      竞品确实做出来了：本地起 StreamableHTTP **MCP server**
      （`src/debug-mcp-server.ts`，Bearer token + `timingSafeEqual` + 256 KB 请求上限），
      暴露 `start`（按 `.vscode/launch.json` 拉起）/ `breakpoint` / `control`（单步）/
      `context`（栈帧与局部变量）4 个工具（`src/debug-tools.ts`），再写一个
      `debug-<uuid>.cordis.yml` **patch 注入托管启动**
      （`src/debug-runtime-contribution.ts:56-58`，token 走 `DSH_VSCODE_DEBUG_TOKEN`），
      并按版本门控（`src/debug-runtime-patch.ts:12-24`）。设置默认关闭。
      **关键收益：这条通道绕开了「MCP 无公开 `@Remote`」的死结**（MCP 是 DSH 的公开
      扩展点，走启动期 composition 而非 RPC），所以上方「明确不做」里的 MCP 条目
      不构成阻塞理由。我方待解差异：托管启动链路比竞品多一层
      （`src/runtimeProcess.ts`、`src/managedRuntime/`、锁文件与升级流），
      patch 注入点需先确认可不与 `web --no-open` 默认参数和 auto 模式的
      package-manager 前缀剥离冲突；patch 生命周期要与统一停止流程对齐，
      不能留孤儿 `cordis.yml`。
      实现分两层：
      - Host 侧：`src/debugMcpServer.ts`（手写无状态 JSON 的 StreamableHTTP 端点，
        避免为 MCP SDK 引入约 90 个包——本扩展运行时依赖仍只有 `ws`）、
        `src/debugToolHandlers.ts`（`debug_start`/`debug_breakpoint`/`debug_control`/
        `debug_context`）、`src/debugContext.ts` 扩出生命周期事件
        （`onDidLifecycleChange`）与按 `session/thread/frame` 定位的快照采集，
        原 `contextStore` 调用点行为不变。
      - 启动侧：`src/debugLaunch.ts` 的 `DebugLaunchOverlay` 在**本窗口自启**且
        `isWebProfileArgs(args)` 时创建，patch 走 `insertWebLauncherPatch`（与
        compaction 同一函数：`--patch` 插在 web app 参数之前、已有 `--patch` 对之后，
        两片可叠加。auto 模式改写包名前缀发生在同一 `launchAttempt` 的更早处，
        因此不与之争序；`web --no-open` 是 app 参数，launcher flag 不会落在它后面）；
        token 不落盘，经
        `DSH_IDE_DEBUG_TOKEN` 由 patch 里的 `!!js` 在 Runtime 进程内插值。
        文件名为 `debug-<pid>-<ownerId>.patch.yml`，写入 `recoveryLedger.directory`；
        `--patch` 覆盖层是**补丁列表**（`applyEntryPatches`：带 `id` 的裸条目是按 id 覆盖
        已有行，目标缺失只 warn 后跳过），所以插件行必须包在 `- insert:` 里，
        `!!js` 表达式也要用引号包住反引号模板（YAML 普通标量不能以反引号开头），
        否则解析直接抛错、Runtime 起不来。
        释放路径覆盖统一停止（`stopResources`）、启动失败、以及 `launchAttempt`
        里 peer 最后时刻应答三种情形；另按 pid 存活清扫崩溃残留的孤儿文件。
        因为 per-launch 文件名进入 `buildComposition` 的 hash，别的窗口不会 adopt
        带调试端点的 Runtime。设置 `dsh.autonomousDebugging` 默认 `false`，
        运行中变更时提示重启。
      已验证：`npm run check`、既有 50 项测试、以及仓库外三个探针——用真实
      `@modelcontextprotocol/sdk` 客户端打通 initialize/tools list/call 并跑完
      401/405/404/403(Host 伪造)/400(batch)/413/202/无状态重连/幂等 stop；
      用假 `vscode` 模块驱动四个工具，覆盖 redaction、寄存器 scope 过滤、
      `wait` 事件、断点 `verified` 状态与 launch 配置校验的错误文案；
      第三个探针用 harness 同款的 `JSON_SCHEMA + !!js` 方言解析生成的 patch，
      校验 `insert` 结构、模板求值出 `Bearer <token>`、token 不在文件里、
      死 pid 孤儿被清扫而活 pid 与 `compaction.patch.yml` 不动、dispose 幂等删文件。
      **未验证：没有在真实 VS Code 窗口里让 `dsh-mcp-client` 加载该 patch 并让
      Agent 真的调用一次工具**——`serverName` 正则/`!!js` 方言/`insert` 语义均按
      `deepseek-harness` 源码（`vendor/include`、`packages/boot/app-boot`、
      `packages/mcp/mcp-client`）与本地 SDK 客户端推断，首次真机联调要盯
      `[dsh:debug]` 输出与 `failOnStartupError` 是否把错误吞掉。
- [ ] **插件中心（把下方 P2「Plugin Center 安全 spike」转正）**。竞品用
      `src/plugin-manager.ts`：`spawn` 官方 `dsh` CLI + 直接读 DSH_HOME profile
      （`plugin-profile.ts` 的 `readInstalledPlugins`/`resolveDshHome`）+
      社区 registry（`COMMUNITY_REGISTRY_URL`，5 MB 上限）+ `settings/mutate` 配参数 +
      变更后 `restartAfterRuntimeChange`。**这条不违反「不在公开 RPC 缺失时伪造插件管理
      语义」**：契约面是官方 CLI 与 profile 文件，不是 RPC，与我方 P2 原设想一致。
      要求按原条目执行：来源/兼容性/权限告知、显式确认、重启与回滚；
      只在 Host 侧调用，不在 Webview 执行第三方代码。我方已有只读
      `pluginInventory/list` 面板可作为起点。

## P1：上游暂无契约（`0.1.5-rc.2` 复核维持搁置）

`packages/hooks`、`packages/session-query`、`packages/session/session-title` 三处在
`c291e7961a`（`0.1.5-rc.2` 同步进 master 的位置）的 `@Remote` 计数仍为 0，无新增公开契约。

- [ ] **Hook 可观测性**：`deepseek-harness/packages/hooks` 下 `@Remote` 计数为 0（`0.1.1-rc.2`、`0.1.2-rc.1` 两轮复核一致），无公开查询契约。
- [ ] **Session 内容查询**：`deepseek-harness/packages/session-query` 下 `@Remote` 计数为 0；`session.search` 已消费（rc.1 起为公开 remote，但部署可禁用索引），服务端全文检索管理面无公开入口。
- [ ] **自动标题状态**：`deepseek-harness/packages/session/session-title` 下 `@Remote` 计数为 0；`title` projection 已消费，但生成状态与失败降级无公开契约。

## P1：待评估候选

以下候选优先复用现有 RC Remote 和 VS Code 稳定 API，不把未公开的实现
当成 DSH 契约：

- [ ] **`@diagnostics`**：附加用户主动选择的诊断项与范围，不默认把全工作区诊断送入 prompt。
- [x] **Prompt 模板**：发现 `.dsh/prompts` 下的本地 Markdown，只做可见预填，发送前由用户确认。
      实现：`src/promptTemplates.ts` 只读发现（`.dsh/prompts/**/*.md`，限 100 个文件/4 层深/32 KiB，frontmatter `title` 或首个 `#` 标题作展示名，路径经 `..`/绝对路径校验）；入口为 Composer `/template` slash 命令与命令面板 `DSH: Insert Prompt Template`；选中后整篇成为输入框草稿（`setComposerText`），发送仍由用户手动完成。不做：自动注入、隐式记忆、规则文件作为上下文附件（后者见上方 P1 条目）。
- [ ] **Runtime 连接模式与生命周期可见性**：补 `attach-only`/`auto` 等状态表达，不改变外部 Runtime 只复用、不接管的规则。
- [ ] **轻量代码库搜索**：先复用 VS Code 文件/符号能力，用户选中结果后再附加；向量索引暂不默认开启。

## P1：Runtime 可靠性

- [ ] **跨平台 Runtime CI**：在 Windows、macOS、Linux 验证命令发现、启动、动态端口、健康检查、停止和进程树清理。
- [ ] **GUI 启动 PATH 发现**：覆盖 macOS Finder/Dock、Linux Desktop 和 Windows npm 全局 bin 路径缺失场景，日志中说明最终使用的可执行文件。
- [x] **多根工作区 Runtime 归属（契约边界已核对）**：DSH 的一个 Session 只有一个 `cwd`，DirectoryPicker 也只暴露一条 ancestry chain；因此不把 VS Code multi-root workspace 映射成一个 DSH Session。多个根目录应分别建立 DSH Workspace/Session，IDE 当前沿用第一个 VS Code workspace folder，并在文档中明确这一限制（上游证据：`deepseek-harness/packages/host/directory-picker/README.md`、`packages/api/session-controller/src/types.ts`）。
- [ ] **远程工作区矩阵验收（仅测试）**：验证 Remote SSH、WSL、Dev Container 下 Extension Host、Runtime 和文件系统是否位于同侧；需要时使用 VS Code 端口转发，不把测试结果包装成已支持功能。
      文件位置点击现已在本地边界检查失败时回落到 `session/openWorkspacePath`；剩余
      `directoryPicker/pick` / `directoryPicker/list` / `directoryPicker/createDirectory` 三条目录选择 RPC
      尚未接入专用 picker。需在 Remote SSH/WSL/Dev Container 实机确认 Extension Host、
      Runtime 与文件系统同侧性后，再决定是否增加远程目录浏览 UI（本地场景与 VS Code 原生 API 重复）。
- [x] **异常退出恢复**：已检测扩展启动的 Runtime 意外退出，并按 1s/5s/15s 提供最多三次退避重启；手动生命周期操作会取消恢复，外部 Runtime 只复用、不接管。跨平台/真实进程树仍归入下方验收项。
- [ ] **rc2 兼容性回归**：验证 V4 Vision、Files API 图片复用、Windows PTY 与沙箱修复；不新增单元测试，使用现有检查与手动 smoke 流程。

## P1：重构

- [ ] **继续拆 `chatView.ts`**。已完成第一步：Workspace 与 Agent Preset 管理迁出（3169 → 2820 行）；目录缓存已收拢为 `sessionCatalogCache.ts`（见「结构」）；Subagent 编排已迁出为 `subagentController.ts`（见「结构」）。剩余按性价比：`handleMessage` 的 205 行 switch 拆成按域分组的处理器表。`postState` 的 193 行不建议动——它本质是把二十多个来源汇成一个快照，拆开只会变成到处找字段。
动手前先读两条硬约束，它们决定了哪些改法可行：

1. **`test/` 下 13 个 `node:test` 文件 `require("../dist/<module>.js")`**，钉住的是**编译产物的模块路径与具名导出**：`chatState`、`chatViewProtocol`、`deepseekBalance`、`harnessClient`、`harnessConnection`、`hostState`、`safeMarkdown`、`sessionCatalog`、`sessionFeatures`、`sessionStore`、`traceProjector`、`traceProtocol`。`npm test` 是发版门禁（`.github/workflows/release.yml`），移动或改名会在发版时才炸。且 `AGENTS.md` 禁止新增测试 —— 重构不能靠补测试买安全，必须构造上行为等价。
2. **30 个模块不 import vscode、10 个 import**，全部被测模块都在前者。`src/localize.ts:9` 的 `configureLocalization` 依赖注入是这套划分的支点（`src/extension.ts:19` 激活时注入 `vscode.l10n.t`）。收拢公共 helper 时落点必须留在 vscode-free 一侧，否则会把 vscode 依赖拖进被测模块，直接打断门禁。

那 54 个测试名本身是契约护栏（`only the public goal projection`、`read-only`、`never invents duration`、`fail closed`、`rejects forged session scope`），把「不伪造上游语义」钉成了可执行断言 —— 这也是禁止新增测试却保留这 13 个的原因。

### 结构

- [ ] **`src/chatView.ts` God Object 继续拆**（3582 → 3103 行，已抽出 6 块；目录缓存与 Subagent 迁出后 3535 行；脏文件守卫 + 编辑器 Tab 入口后 3606 行）。
      已完成：Provider 管理 → `providerManagement.ts`（224 行，以 `ProviderManagementDeps` 注入依赖而非反向依赖 ChatViewProvider）；代码块动作 → `codeBlockActions.ts`（111 行，接缝按 `text` 而非 `renderId` 划，因为可复制文本的缓存与 markdown 渲染共享）；markdown 渲染与代码 payload → `markdownRenderCache.ts`（类，按 `GoalMutationGate` 先例）；设置值转换 → `chatViewPresentation.settingsMutationOps`；会话切换器行组装 → `sessionCatalog.presentSessionRows`（接缝划在 `catalog` 上，两处派生一起搬）；`mutateGoal` 内重复五次的 ref 确认收成一处；三套目录缓存的并发骨架（value map + 请求去重 + 失效代际 + 重拉排队）→ `sessionCatalogCache.ts`（89 行，`pull` 承载 then/catch/finally 编排，apply/absent/fail 由调用方注入；skill 组原先缺 generations/refreshPending 字段，因无 invalidate 调用点，收拢后代际护栏零值恒真，行为不变）；**webview surface → `chatViewSurface.ts`（124 行）** —— 一个 surface = 一个 webview + 它自己的 `ready` + `reveal`/`setBadge`/`resolveResource`，provider 改持 `surfaces: Set` 与 `activeSurface`，`postState` 一次算状态、逐 surface 投递，入站消息仍汇入同一 `handleMessage`。这是「须连状态一起搬」的首个实例：搬走 `view`/`webviewReady`/`viewMessageDisposable` 三字段及其 22 个读写点；`pendingComposerUpdate`/`pendingComposerImages` 有意留在 provider，因为「视图未起时排队的草稿不丢」是既有语义，单槽 + 有 booted surface 才消费即可保持。副产一条硬约束：**`asWebviewUri` 与 webview 一一对应**，shared state 只能带 `resources/` 下的文件名，投递前由 `withSurfaceResources` 逐 surface 改写（此前 `reasoningEffortImage`/`defaultEffortKnobImage` 直接读 `this.view`，两个 webview 会互相拿到错的 URI Authority）。
      **抽取标准（本轮验证有效，后续照用）**：候选必须不持有状态、不调 `postState`。按此标准复核的结果 —— Workspace 组的 `pendingNewSessionWorkspace*` 有 16 个读写点散在 `sendPrompt`/`postState`/`newSession`；Preset 组的 `agentPresetCatalog` 7 个点里只有 2 个在块内，`agentPresetDocuments` 更在构造函数里注册为 `TextDocumentContentProvider`；Subagent 组自己拥有 5 个字段，本质是 store+controller。这三组直接抽出只是把耦合从文件内搬到文件间，**须连状态一起搬**才有意义，属更大的设计改动。
      剩余易做项：`chooseWorkspaceAction`(42 行) 与 `chooseAgentPresetAction`(46 行) 完全不碰 `this`，但它们是上述两个域的「动作菜单」那一半，宜与各自域一同搬迁，不要先按机制凑进一个桶。
- [ ] **`src/sessionFeatures.ts:414-421` 反向依赖**。顶层 feature 模块内 `new HarnessSessionStore()` + `rebaseline()` + `projectChatMessages()`，使其同时依赖下面两层，也让 `test/sessionFeatures.test.js` 顺带钉住了 `projectChatMessages` 的输出形状。该模块另含五个互不相关的 feature（plan review、goal、subagent、history、jobs），10 个钉住导出全在此处 —— 拆分需同步改测试，先评估收益。

### 超长函数（内部线性，拆解属纯提取，风险低）

- [ ] `src/chatState.ts:646-835` `projectChatMessages` 190 行 / 7 职责，嵌套深度 6（:695-712），且函数内有字符级重复的 8 行（:651-658 ≡ :825-832）。
- [ ] `src/chatViewProtocol.ts:158-434` `parseChatViewAction` 277 行 / 25 个 case，14 份手工同步的 key 数组与联合类型（:9-75）无编译期关联；最差块 :251-289 校验一次后重复分派四次。
- [ ] `src/sessionStore.ts` `applyMuxEnvelope` 160 行 / 11 分支。九处诊断文案已收拢为 `malformedFrame()`。
      **骨架的其余部分不可提取**（已实测，不必再试）：把 validate 留在 `case` 里、state/mutate/publish 移进 `applyToSession(sessionId, mutate)` 回调后，TS 的属性收窄不穿透闭包 —— `frame.lastSeq` 在回调内退回 `unknown`（TS2345）。那需要九个调用点各加一次类型断言，在 wire 校验路径上用断言换去重不值得。要真正去重得先给每个 frame 类型建具名解析函数（`parseSubscribedFrame(frame): {lastSeq} | undefined` 之类），让收窄由返回类型承载 —— 那是比本条更大的改动。
- [ ] `src/traceProjector.ts:745-929` `projectSessionTrace` 185 行 / 8 职责，含深度 5 的 fallthrough 发射循环。（`genericRow` 的两个死形参与随之失效的 `turnStarts` 索引已删除。）
- [ ] `src/tracePanel.ts` `publish()` 约 120 行 / 7 职责，几何计算与面板消息发送混在一起。（其 payload 现已有 `TracePanelState` 契约，拆解时可直接按字段分组。）

### 一致性（非缺陷）

- ~~**`onDidChange` 返回类型不一**~~ **不予统一**：核对后发现这个分界与 vscode-free 划分完全重合。`sessionStore:718`/`sessionCatalog:106` 返回 `() => void` 是因为它们不 import vscode——改成 `vscode.Disposable` 会打断 CI 门禁；`contextStore:124`/`dshRuntime:729` 本就 import vscode 且返回值直接进 disposables 数组。消费方已正确桥接（`chatView.ts:420-421` 包装、`tracePanel.ts:263-264` 直接调用）。已把这条隐含规则写进两处 doc comment。

### 明确不动

- **`src/types.ts` 1024 行不拆**。107 个 interface + 22 个 type，**零运行时导出**（`grep -cE '^export (const|function|class|enum|let|var)'` 返回 0），所有 import 会被完全消除，拆它零收益；且 `ChatViewState`(:803) 横跨 wire 侧与 webview 侧，拆开会引入双向依赖。加分节注释即可。
- **`src/safeMarkdown.ts:124-220` 的双游标 file-location 交错不重构**，只加注释。正确性依赖两个索引在三处的推进不变式，是全套代码里最难验证的一段，且被钉住的 `renderSafeMarkdown` / `renderMarkdownMessage` 覆盖着。
- **`contextStore.ts`、`tokenUsage.ts`、`changeReviewStore.ts`、`sessionCatalog.ts` 大体健康**：长是因为领域本身复杂（git 沙箱、符号链接 TOCTOU 防护），非纠缠。`sessionCatalog.ts:177-284` `applyHostEnvelope` 可做一次定向提取，无需重写。
- **branded `Html` 类型**（把「每个插值点记得转义」交给编译器）收益真实但横穿整个渲染层并触及 5 个钉住导出，属独立工程，不塞进本轮。

## P2：产品呈现

- [ ] **原生 Chat Session provider 评估**：以 proposed API 做隔离 spike，与现有 `@dsh` Chat Participant/Webview 保持单一 Session 来源。
- [x] **编辑器 Tab 聊天入口评估**：参考其他 DSH 扩展的多入口形态，先验证 Session deep-link 和状态复用，避免维护第二套聊天状态。
  **（2026-09-18 升级 P1 并已实现，见「竞品差距」）**
- [ ] **Plugin Center 安全 spike**：只在 Host 侧调用官方 `dsh plugin`，加入来源/兼容性/权限告知、显式确认、重启和回滚；不在 Webview 执行第三方代码。
  **（2026-09-18 升级 P1，见「竞品差距」）**
- [x] **调试器控制安全 spike**：在现有暂停态上下文之上评估启动、断点、单步和变量读取；每个动作需白名单、确认、取消和超时。
  **（2026-09-18 升级 P1 并已实现，见「竞品差距」）**
- [ ] **Session 导入/导出评估**：等待 DSH 导出格式稳定后再做显式文件选择，不复制第二套 Session 数据库。
- [ ] **Inline completion / Ghost text 评估**：需要独立的模型路由、节流、取消、隐私和计费语义，暂不由 RC1 直接解锁。
- [ ] **本地检查点设计**：先定义未跟踪文件、未保存编辑、并发修改、清理和存储上限，再评估 shadow snapshot；现有原生 diff 不等于完整回滚。
- [ ] **Marketplace 截图与短 GIF**：展示流式回答、工具卡片、审批、计划评审、Activity Dock、Slash Commands 和 Trace 跳转。
- [ ] **兼容版本说明**：记录验证过的 DSH 版本范围和协议变化，遇到不兼容版本时给出可操作提示。
- [ ] **常见问题与故障排查**：覆盖找不到 dsh、API Key、空白 Webview、端口冲突、模型不可路由和远程工作区路径问题。
- [ ] **隐私与数据流说明**：明确编辑器上下文、prompt、凭据、日志和余额查询分别流向哪里，以及哪些数据会持久化。
- [ ] **Telemetry 与诊断关联**：对齐 Harness session telemetry/OTel 能力，提供可选开关、脱敏说明和按 session/turn 关联的诊断信息。

## 明确不做

上游或 VS Code 稳定 API 均无对应契约，避免从工具名或私有日志反推：

- ~~**MCP 工具来源**：展示 MCP server、工具来源、连接状态和错误。~~ 本轮复核 `deepseek-harness/packages/mcp` 无 `@Remote`、无 `mcp.*` unary 路由，仍无 server 列表或连接状态契约。注意本条只禁「展示 MCP 状态」，不禁止把 MCP 作为 DSH 公开扩展点向外挂载（见上方「竞品差距 → 自主调试」）。
- ~~**Terminal / PTY context**：终端选区 `@` 引用、PTY 输出摘要和 persistent bash 状态。~~ 本轮复核无 `terminal.*` / `shell.*` unary 路由；VS Code 稳定 API 也不提供终端选区或既有 scrollback 读取。
- **workspace symbol `@` 候选**：公开协议未提供 workspace symbols 查询。
- **VS Code multi-root Session**：DSH Workspace 可以有多个独立 Workspace，Session 也可分散在这些 Workspace 中；但公开 Session/DirectoryPicker 契约没有一个 Session 绑定多个根目录的表示。不要为此自建多根协议或误报“已支持”。

## 明确不照搬

- 不通过 iframe 嵌入完整 Harness Web UI 作为主聊天体验。
- 不为每条消息启动全新 headless 会话并重新拼接历史。
- 不通过 tail 私有 JSONL 日志代替公开 WebSocket/projection 协议。
- 不在公开 RPC 缺失时伪造 `/compact`、权限切换、插件管理或 Memory 语义。
- 不在没有 diff、工作区边界校验和用户确认时自动把代码块写入文件。
- 不使用 `settings.replace` 做整文档覆盖：设置卡片走 revision 保护的 `settings.mutate`，整文档替换是退步。

## 已完成

保留作为记录，不再逐条展开。

### rc2 对齐

托管 Runtime 默认 pin 升至 `0.1.1-rc.2`（五平台资产，安装时校验 manifest 版本一致）；问题卡片折叠与草稿保留；Job Panel 展示对齐（单任务停止仍等公开控制 RPC）；会话 `@` 引用；嵌套图片递归提取；通用插件设置卡片（`settings.describe/mutate` + revision 冲突保护）；Markdown 表格。

### 日常使用闭环

Token 与上下文用量条；文件路径与行号跳转；编辑器快捷任务（只预填不静默提交）；变更审查面板（原生 diff，恢复前检测后续修改）。

### IDE 集成与效率

全界面 i18n；VS Code Chat Participant（`@dsh`）；资源管理器入口；代码块操作（写文件前 diff 并确认）；外部 Approval 接管（一次性批准/拒绝，绑定 session + rpcId + approvalId）；Skills 浏览与选择；Provider、模型与 reasoning effort 状态；Agent Preset 管理；Workspace 管理（不删目录或日志）；文件 `@` 引用候选；手动压缩上下文（公开 `/compact`）；Todo 状态卡；图片附件；Web Search / Fetch 展示；LSP 能力；对话大纲 TreeView 与导航 API；macOS AppShot；峰谷定价展示。

### 环境与发布

环境检查命令（输出脱敏）；`npm run release` 统一发版；Open VSX 发布步骤；pnpm 启动与 npx 回退、备用 registry 重试。
