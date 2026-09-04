# TODO

更新时间：2026-08-26。

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

**尚未起头的大项**：4 处超长函数提取、Gateway 通道及其依赖的两个功能。
这些需要成块的时间，没有起头，不是做了一半。

**需要人工验证**：Trace 面板无测试覆盖，迁移后的行为我无法目视确认，
验证清单写在「重构 → 结构」该条目里。

## 契约基线（2026-08-26 复核）

上游 checkout 已更新至 `0.1.1-rc.2`，与 `dsh.runtimeVersion` 默认 pin 一致。以下数字是后续条目的证据基础，动手前先复核；上游迭代很快，过期的基线会让整张表失效。

- **Unary RPC**（`POST /api/<method>`，点号形式）：上游 52 条（`deepseek-harness/packages/host/apiproxy/src/fetch/handler.ts:90-143`），扩展消费 45 条（`src/harnessProtocol.ts:36-179`），无悬空引用。
- **Session projection**：上游注册 13 个，注册插件在 `bundle/base` 与 `bundle/web-app` 均已挂载，默认安装下都是活的；扩展消费 8 个（`goal`、`todos`、`tokenUsage`、`contextPressure`、`title`、`sessionStats`、`permissions`、`imageLimits`）。
  `GenericProjectionStore`（`src/sessionStore.ts:234-265`）按任意字符串 key 存储，**未消费的 projection 其实已经到达并缓存**，`src/tracePanel.ts:854` 已泛化渲染其原始值。因此接入新 projection 是纯呈现层工作，不动传输、不改运行时组合。
- **Typert Gateway**（`POST /api/<namespace>/<method>`，斜杠形式，与 unary 共用 `/api` 基址，见 `deepseek-harness/packages/api/gateway/src/index.ts:106-116`）：`goal.*` 与 `skill.*` 已有 unary 镜像并被消费；`commands`、`fileReference`、`sessionReference`、`pluginInventory`、`messageFeedback` 五个 namespace **无 unary 镜像，尚未接入**。同基址同动词，接入成本是 `src/harnessClient.ts` 的中等增量。

## P0：先行安全网

- [x] **Webview 纳入类型检查**。`tsconfig.json` 的 `include` 只有 `src`，`jsx` 选项未设置，tsc program 实际包含 40 个 `src/` 文件、**0 个 `webview/` 文件**；esbuild 只剥类型不校验。`webview/` 那 4.3k 行 React 既不过 `npm run check`，也不过 CI 门禁 `npm test`。
      做法：新增 `webview/tsconfig.json`（`jsx: react-jsx`、`allowSyntheticDefaultImports`、`lib` 含 DOM），`check` 脚本串联两个 project。
      **单独一个 commit，不夹带任何行为改动** —— 补上后大概率当场冒出一批既存类型错误，混在别的改动里就分不清是谁引入的。这一项是其余所有 Webview 改动的前置。

## P0：BUG修复

暂无

## P1：功能（按性价比排序，均已核对公开契约）

- [x] 任意消息「从这里 Fork / 回到这里」——我最推荐先做。 这几乎已经是白送的功能：你 DshRuntime.forkSession(sessionId, atSeq?) 已经支持 atSeq，但当前 ChatViewProvider.forkSession() 没传它，只能从最新位置 fork。 直接给每个 user/assistant turn hover 菜单加三个动作：Fork from here、Restore code to here、Fork + restore code。后两个还能复用你现有的 changeReviewStore.restore(sessionId, turn)。 这就基本得到 Claude Code 那套 checkpoint/rewind UX；Claude 当前 VS Code 扩展也确实把这三个语义拆成 fork、rewind code、fork+rewind。 工作量低，感知价值极高。
- [x] **IDE 内 Provider 配置**。`llm.models` 与 `llm.discoverModels` 是 52 条 unary 路由里未消费的两条。当前未配置 Provider 一律引导去 dsh Web UI（`0.5.3` 变更记录），这两条正是在 IDE 内枚举并配置所缺的能力。改动面 `src/chatView.ts` 的 `manageProviders`。
- [x] 把你 TODO 里“Terminal / PTY context 不可做”翻案。 这一条 TODO 已经过期了：当前稳定 VS Code API 已有 onDidStartTerminalShellExecution / onDidEndTerminalShellExecution，而且 TerminalShellExecution.read() 能流式读该次命令输出，还能拿 command line、cwd、exit code；这个 API 从 VS Code 1.93 就稳定了，而你最低版本已经是 ^1.106.0。 需要注意的是不能ย้อนหลัง读取 extension 启动前的 scrollback，只能从执行开始时监听，所以正确做法是维护一个每 Terminal 最近 N 条命令的 ring buffer。然后做：@terminal:last、@terminal:pytest、附件菜单「Recent terminal command」、非 0 exit code 后出现一个很轻的 Ask DSH 入口。这样用户刚跑完 npm test 爆了一屏错误，根本不用复制粘贴。这会是非常强的 IDE Integration 卖点。终端命令捕获已接入 IDE 上下文、引用补全和失败命令预填入口；仅保留内存中的扩展激活后命令，不读取或持久化既有 scrollback。

- [x] **Subagent 运行时长**。`subagentTiming`（上游 `deepseek-harness/packages/subagent/subagent/src/projection.ts:62`），wire 形状 `{settledMs, active?: {since, through}}`。`SubagentTreeNodeView` 目前只有二值 `activity: "running" | "inactive"`，没有任何时长，这是真正的新信息。
      **身份部分不做**：另一个单元注册的 key 是 `subagent`（不是 `subagentIdentity`，`projection.ts:169`），其 `label` / `mode` 已由 `subagent.list` 放在树节点上，重复。
- [x] **消息反馈**。上游 `messageFeedback.list/put/delete` 已有公开 `@Remote`（`deepseek-harness/packages/feedback/message-feedback/src/index.ts:189,205,271`），已接入 Gateway 通道并在已完成的 assistant 消息上提供赞/踩、备注、撤销及 CAS 冲突对账。反馈持久化在 Host sidecar，不写入 Session 日志、模型上下文或 telemetry。
- [ ] **`plan` 投影**。上游 `deepseek-harness/packages/plan/plan-mode/src/index.ts:245` 注册，插件在 base 与 web-app 双挂载。当前计划评审走 interaction 卡片，接 projection 可拿到结构化计划状态。
- [ ] **上下文用量与超限反馈补全**：发送前展示附件大小、截断与敏感文件风险，支持移除大项并说明最终进入 prompt 的内容。（基础部分已完成，缺 `contextBreakdown` 支撑的占用归因。）
- [ ] **扩展 `@` 引用类型**：在文件与 `@selection` 之外增加目录、diagnostics，并显示实际捕获范围
- [ ] **项目记忆入口**：优先复用 Harness 公开 Memory/Skill 能力；无公开协议时只提供打开明确文件的 IDE 操作，不自动把自建记忆拼入所有 prompt。
- [ ] S：Debug Context——让 DSH 真正“看见断点现场”。 现在你已经能附加 Diagnostics，但 Debugger 是明显的下一步。vscode.debug.activeStackItem 可以直接拿当前 thread/frame，API 还提供 onDidChangeActiveStackItem；当前 frame 有 frameId/threadId/session，再通过标准 DAP stackTrace → scopes → variables 就能拿调用栈和局部变量。 可以做 DSH: Explain Current Debug State，内容类似：当前 exception/线程、前 10 层 stack、当前 frame locals、当前源码附近几十行、workspace diagnostics。再往前一步，在 Debug Toolbar 加一个小鲸鱼按钮“问 DSH 为什么停在这里”。这比“Explain Selection”有意思太多，而且是 Claude/Codex 类 IDE integration 很自然应该做、但很多第三方插件没做好的地方。

## P1：上游暂无契约（本轮已在 `0.1.1-rc.2` 复核，保持搁置）

- [ ] **Hook 可观测性**：`deepseek-harness/packages/hooks` 下 `@Remote` 计数为 0，无公开查询契约。
- [ ] **Session 内容查询**：`deepseek-harness/packages/session-query` 下 `@Remote` 计数为 0；`session.search` 已消费，服务端全文检索无公开入口。
- [ ] **自动标题状态**：`deepseek-harness/packages/session/session-title` 下 `@Remote` 计数为 0；`title` projection 已消费，但生成状态与失败降级无公开契约。

## P1：Runtime 可靠性

- [ ] **跨平台 Runtime CI**：在 Windows、macOS、Linux 验证命令发现、启动、动态端口、健康检查、停止和进程树清理。
- [ ] **GUI 启动 PATH 发现**：覆盖 macOS Finder/Dock、Linux Desktop 和 Windows npm 全局 bin 路径缺失场景，日志中说明最终使用的可执行文件。
- [ ] **多根工作区 Runtime 归属**：根据活动编辑器选择 cwd，明确每个 session 对应的 workspace folder，切换时不误停其他窗口复用的 Runtime。
- [ ] **远程工作区支持评估**：验证 Remote SSH、WSL、Dev Container 下 Extension Host、Runtime 和文件系统是否位于同侧；需要时使用 VS Code 端口转发。
      此场景下 `host.pickDirectory` / `listDirectory` / `createDirectory` / `openPath` 四条未消费 RPC 是现成解法 —— 本地场景与 VS Code 原生 API 重复，仅远程场景值得接。
- [ ] **异常退出恢复**：检测扩展启动的 Runtime 意外退出，提供有限次数的退避重启，并避免接管或终止用户自行启动的实例。
- [ ] **rc2 兼容性回归**：验证 V4 Vision、Files API 图片复用、Windows PTY 与沙箱修复；不新增单元测试，使用现有检查与手动 smoke 流程。

## P1：重构

- [ ] **继续拆 `chatView.ts`**。已完成第一步：Workspace 与 Agent Preset 管理迁出（3169 → 2820 行）。剩余按性价比：三套目录缓存（model / skill / command 是同一套 Map 对 + 请求去重 + 失效重拉抄了三遍，可收成一个 `SessionCatalogCache<T>`，约 155 行 + 6 个字段）；`handleMessage` 的 205 行 switch 拆成按域分组的处理器表；Subagent 编排（约 285 行，`SubagentTreeStore` 已存在，预览/跟进/中断仍在视图里）。`postState` 的 193 行不建议动——它本质是把二十多个来源汇成一个快照，拆开只会变成到处找字段。
动手前先读两条硬约束，它们决定了哪些改法可行：

1. **`test/` 下 13 个 `node:test` 文件 `require("../dist/<module>.js")`**，钉住的是**编译产物的模块路径与具名导出**：`chatState`、`chatViewProtocol`、`deepseekBalance`、`harnessClient`、`harnessConnection`、`hostState`、`safeMarkdown`、`sessionCatalog`、`sessionFeatures`、`sessionStore`、`traceProjector`、`traceProtocol`。`npm test` 是发版门禁（`.github/workflows/release.yml`），移动或改名会在发版时才炸。且 `AGENTS.md` 禁止新增测试 —— 重构不能靠补测试买安全，必须构造上行为等价。
2. **30 个模块不 import vscode、10 个 import**，全部被测模块都在前者。`src/localize.ts:9` 的 `configureLocalization` 依赖注入是这套划分的支点（`src/extension.ts:19` 激活时注入 `vscode.l10n.t`）。收拢公共 helper 时落点必须留在 vscode-free 一侧，否则会把 vscode 依赖拖进被测模块，直接打断门禁。

那 54 个测试名本身是契约护栏（`only the public goal projection`、`read-only`、`never invents duration`、`fail closed`、`rejects forged session scope`），把「不伪造上游语义」钉成了可执行断言 —— 这也是禁止新增测试却保留这 13 个的原因。

### 结构

- [x] **`src/tracePanel.ts` 的 425 行内联 UI**（已完成，966 → 611 行）。样式 → `webview/src/trace/trace.css`（115 行），客户端脚本 → `webview/src/trace/main.ts`（407 行），均由 esbuild 构建到 `webview/dist/`，宿主用 `asWebviewUri` 以外部 `<link>` / `<script src>` 加载。`traceHtml` 425 → 90 行，其中已无 `<style>` 块、无内联脚本体。
      分四步落地，每步单独提交、单独验证：打通资源管线（CSS）→ 命名 wire 契约 → 契约移入 vscode-free 的 `traceProtocol` → 移植脚本。文案与 `sessionId` 改由 `<script type="application/json">` 数据块传递，本地化仍属宿主。
      **迁移中发现并修掉一个既存缺陷**：树缩进用 `style="padding-left"` 属性，而 `style-src` 不含（也不该含）`'unsafe-inline'`，属性被剥掉、缩进从来不生效。已改用 `.depth-0…8` 类，与同文件 timeline 条形图当初的修法一致。
      `escapeHtml` 在 JS 字符串里的第四份副本随之消失，全仓库现在只有 `fileLocations.ts` 一处定义。
      **仍需人工验证**：Trace 面板无测试覆盖，我无法目视确认。请在 VS Code 里打开一个会话的 Trace，检查筛选、翻页、行选中/折叠、timeline 点击、projection 选中、Summary/Raw 切换、文件路径跳转，以及树缩进现在是否真的可见。
- [ ] **`src/chatView.ts` God Object 继续拆**（3582 → 3103 行，已抽出 6 块）。
      已完成：Provider 管理 → `providerManagement.ts`（224 行，以 `ProviderManagementDeps` 注入依赖而非反向依赖 ChatViewProvider）；代码块动作 → `codeBlockActions.ts`（111 行，接缝按 `text` 而非 `renderId` 划，因为可复制文本的缓存与 markdown 渲染共享）；markdown 渲染与代码 payload → `markdownRenderCache.ts`（类，按 `GoalMutationGate` 先例）；设置值转换 → `chatViewPresentation.settingsMutationOps`；会话切换器行组装 → `sessionCatalog.presentSessionRows`（接缝划在 `catalog` 上，两处派生一起搬）；`mutateGoal` 内重复五次的 ref 确认收成一处。
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

### 去重

- [x] **`isRecord` 14 份副本**：`traceProtocol`、`chatState`、`sessionFeatures`、`sessionCatalog`、`tokenUsage`、`deepseekBalance`、`conversationNavigation`、`traceProjector`、`sessionStore`、`harnessClient`、`chatViewProtocol`、`changeReviewStore`、`hostState`，加 `chatViewPresentation` 里叫 `record` 的同一实现。
- [x] **`escapeHtml` 4 份**：`safeMarkdown.ts:62`、`fileLocations.ts:28`（逐字节相同）、`tracePanel.ts:60`、`tracePanel.ts:736`（JS 字符串内）。已收拢到 `fileLocations.ts`（vscode-free、未被钉住、本就拥有使用它的渲染函数）。`tracePanel.ts` 内 JS 模板字符串那份仍在——它是客户端代码、无法 import，随下面的内联 UI 迁移一并消失。
- [x] **`IMAGE_MEDIA_TYPES` 3 份**：`chatViewProtocol.ts:104`、`chatViewPresentation.ts:223`、`chatState.ts:109`。
- [x] **路径包含判定 2 份**：`changeReviewStore.ts:68` `inside()` 与 `workspaceNavigation.ts:7` `containsPath()`。已收拢到 `src/paths.ts`，并顺带修掉 `containsPath` 用 `startsWith("..")` 把 `..config` 之类合法目录误判为越界的假阴性。若要做按绝对路径反查 turn 的查询，复用它，不要加第三份 —— `GitContext.cwd` 已 `realpath` 归一（`changeReviewStore.ts:288`），新方法应显式复用该不变量。

### 一致性（非缺陷）

- [x] **协议校验严格度不统一**。`parseChatViewAction` 25 个 block 里 14 个用 `hasOnly` 白名单、6 个用 `hasAny` 黑名单、5 个（`removeContext`:309、`switchSession`:343、`answerApproval`:403、`answerQuestion`:408、`updateQueue`:414）无额外 key 守卫。
      **这不是逃逸路径** —— 这五处都重新构造只含已校验字段的新字面量，多余 key 到不了 Host。属一致性问题，值得统一，但不要当漏洞排期。`:157` 那句 "Strict trust boundary" 注释对这五处名不副实，一并修正。
- ~~**`onDidChange` 返回类型不一**~~ **不予统一**：核对后发现这个分界与 vscode-free 划分完全重合。`sessionStore:718`/`sessionCatalog:106` 返回 `() => void` 是因为它们不 import vscode——改成 `vscode.Disposable` 会打断 CI 门禁；`contextStore:124`/`dshRuntime:729` 本就 import vscode 且返回值直接进 disposables 数组。消费方已正确桥接（`chatView.ts:420-421` 包装、`tracePanel.ts:263-264` 直接调用）。已把这条隐含规则写进两处 doc comment。
- [x] **ARIA 声明强于实现**：`webview/src/components/Header.tsx:245` 与 `Composer.tsx:300` 声明 `role="menu"`/`menuitem`，但只支持 Tab 遍历与 Escape，无方向键与 roving tabindex；同仓库 `dock/ActivityDock.tsx:77-88` 的 tablist 做全了。建议摘掉 role 当普通按钮列表（Tab 遍历此时语义正确，零新增代码），而非为满足声明补一套无人要求的交互。

### 明确不动

- **`src/types.ts` 1024 行不拆**。107 个 interface + 22 个 type，**零运行时导出**（`grep -cE '^export (const|function|class|enum|let|var)'` 返回 0），所有 import 会被完全消除，拆它零收益；且 `ChatViewState`(:803) 横跨 wire 侧与 webview 侧，拆开会引入双向依赖。加分节注释即可。
- **`src/safeMarkdown.ts:124-220` 的双游标 file-location 交错不重构**，只加注释。正确性依赖两个索引在三处的推进不变式，是全套代码里最难验证的一段，且被钉住的 `renderSafeMarkdown` / `renderMarkdownMessage` 覆盖着。
- **`contextStore.ts`、`tokenUsage.ts`、`changeReviewStore.ts`、`sessionCatalog.ts` 大体健康**：长是因为领域本身复杂（git 沙箱、符号链接 TOCTOU 防护），非纠缠。`sessionCatalog.ts:177-284` `applyHostEnvelope` 可做一次定向提取，无需重写。
- **branded `Html` 类型**（把「每个插值点记得转义」交给编译器）收益真实但横穿整个渲染层并触及 5 个钉住导出，属独立工程，不塞进本轮。

## P2：产品呈现

- [ ] **Marketplace 截图与短 GIF**：展示流式回答、工具卡片、审批、计划评审、Activity Dock、Slash Commands 和 Trace 跳转。
- [ ] **兼容版本说明**：记录验证过的 DSH 版本范围和协议变化，遇到不兼容版本时给出可操作提示。
- [ ] **常见问题与故障排查**：覆盖找不到 dsh、API Key、空白 Webview、端口冲突、模型不可路由和远程工作区路径问题。
- [ ] **隐私与数据流说明**：明确编辑器上下文、prompt、凭据、日志和余额查询分别流向哪里，以及哪些数据会持久化。
- [ ] **Telemetry 与诊断关联**：对齐 Harness session telemetry/OTel 能力，提供可选开关、脱敏说明和按 session/turn 关联的诊断信息。

## 明确不做

上游或 VS Code 稳定 API 均无对应契约，避免从工具名或私有日志反推：

- ~~**MCP 工具来源**：展示 MCP server、工具来源、连接状态和错误。~~ 本轮复核 `deepseek-harness/packages/mcp` 无 `@Remote`、无 `mcp.*` unary 路由，仍无 server 列表或连接状态契约。
- ~~**Terminal / PTY context**：终端选区 `@` 引用、PTY 输出摘要和 persistent bash 状态。~~ 本轮复核无 `terminal.*` / `shell.*` unary 路由；VS Code 稳定 API 也不提供终端选区或既有 scrollback 读取。
- **workspace symbol `@` 候选**：公开协议未提供 workspace symbols 查询。

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
