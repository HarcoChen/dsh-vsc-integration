# DSH VS Code 插件维护记录

调查日期为 2026-11-11。比较范围为同类 DSH VS Code 插件。功能描述依据各项目 README 和能力矩阵，验证状态沿用来源中的限制。

## 同类插件对比

| 项目 | 调查时的提交 | 主要能力 | 本仓库覆盖与差距 |
| --- | --- | --- | --- |
| DSH Sidebar | `f9449c5`，11 月 6 日 | 原生聊天、调试器、逐轮活动、模型与权限、Diff 和安全恢复、Tools/Skills/MCP 管理 | 已有对应核心入口及自动调试、逐次工具 Diff、Trace、Jev。本次补充新版任务和插件包更新。 |
| JaboDSH | `05d73dc`，11 月 11 日 | Markdown/JSON/ZIP 导出、历史输入召回、完成提示、独立会话编辑器标签、会话排序与布局偏好、费用估算 | 已接入三种导出、独立会话标签与文字草稿恢复、完整复制、历史输入召回和完成通知。 |
| DSH Coding Agent | `2f3187c`，11 月 11 日 | 桌面连接配对、会话与 DSH Workspace 导航、上下文、审批、原生审阅、侧栏及编辑器聊天 | 已有主要聊天工作流和本地 Runtime 发现，接入了桌面 connect 地址、Windows 本机发现及加密配对协议。 |
| Fengze233 DSH for VS Code | `b1243ba`，11 月 8 日 | 嵌入官方 Web UI、鉴权代理、CLI/Desktop 发现、原生文件与剪贴板桥接、远程环境支持 | 本仓库采用原生聊天和 Remote API，已有进程管理、鉴权、发现、文件链接及图片附件。本次接入模型明确拒绝图片输入时的文件附件回退。 |
| GT112 DSH Sidebar | `9d3b29a`，8 月 16 日 | 行内补全、诊断及文件附件、Trace、逐轮变更、检查点、插件中心、能力热刷新 | 已有多数 Agent 工作流和动态目录，新增独立 minimal 会话驱动的行内 ghost-text 补全。该来源的版本和安装方式较旧。 |

对应来源按调查时提交固定，便于后续复核。

- [DSH Sidebar README](https://github.com/omdsh-dev/dsh-vscode/blob/f9449c5bd6ed50674859dfabe1ea5f5f87f047a7/README.md)
- [JaboDSH README](https://github.com/Jabofish/deepseek-harness-vscode/blob/05d73dcac3cf8c67e22c0844ea1a59b166207e9b/README.md)、[能力矩阵](https://github.com/Jabofish/deepseek-harness-vscode/blob/05d73dcac3cf8c67e22c0844ea1a59b166207e9b/docs/capability-matrix.en.md)
- [DSH Coding Agent README](https://github.com/mcdottok/vscode-dsh/blob/2f3187ce19a14f667afd29e2845e25967535824b/README.md)、[能力矩阵](https://github.com/mcdottok/vscode-dsh/blob/2f3187ce19a14f667afd29e2845e25967535824b/docs/capability-matrix.md)
- [Fengze233 README](https://github.com/Fengze233/dsh-vscode/blob/b1243baf6cda8de7f8a229e3c08a4f5a7e0fbc86/README.md)
- [GT112 README](https://github.com/112GT/deepseek-harness-vscode/blob/9d3b29af499445c035ecf3350c7514e25b8deda0/README.md)

`tingfeng347/dsh-vscode-workbench` 在 Harness 内提供编辑器工作台，属于相邻形态。其 Git、Monaco 和文件预览能力可作为参考。该项目的安装方式及功能见 [README](https://github.com/tingfeng347/dsh-vscode-workbench)。

## 本次实现

| 功能 | 用户入口和行为 | 验证范围 |
| --- | --- | --- |
| Host 级定时任务 | Schedule 面板分页及跨页筛选活动/非活动任务。创建支持延迟、日期、间隔、每日、每周、Cron 和 RRULE。目标可用已有会话、首次新建并复用或每次新建会话，新建会话使用当前 DSH Workspace 的目录。管理提供编辑、暂停/恢复、立即执行、删除和投递历史，编辑及删除携带版本冲突保护。 | RC.1 实际验证分页、目标、创建、编辑冲突、暂停/恢复、执行、历史和删除。浏览器预览检查面板。各规则的原生输入向导待人工交互验收。 |
| 会话导出与复制 | 聊天菜单和命令面板导出 Markdown/JSON/ZIP，记住格式。文本导出固定切点后分页读取。ZIP 使用上游原生流，收集持久日志、二进制附件及可选后代会话。 | RC.1 真实分页及 ZIP 解压后逐字节附件校验通过。取消、权限或连接变化时终止文本导出。 |
| 引用与历史提示词 | 消息底部可引用整条消息或其中选中文本。空输入框按 ↑ 召回已发提示词，↑/↓ 切换并恢复原草稿，手动编辑结束召回。 | 浏览器预览验证 ↑ 召回及 ↓ 恢复。引用由主机核对消息和选区。 |
| 完成通知 | 可选设置 `dsh.completionNotification` 在 VS Code 失焦且观察到成功完成时通知，提供打开会话入口。 | 默认关闭，通知受 VS Code 与系统设置影响。 |
| 子代理目录 | 0.2.2 读取目录、身份和计时 projection，展示名称和 external 项。多层目录显式展开并保留错误重试。Team 与子代理面板可同时访问。 | RC.1 实际验证 Team 子成员目录、历史和 follow-up。RC.2 的名称、external 及 `interruptByUser` 按源码适配，待真实版本验证。 |
| 冷会话激活 | 所有者显式打开普通聊天时请求激活。历史导出、子代理预览及共享只读连接使用被动读取。 | RC.1 的 follow、权限及历史链路通过，冷会话迁移待旧数据现场验收。 |
| Runtime 终端 | 选择 Host 发现的 Shell、重命名及恢复画面。RC.2 实时刷新目录，显示 Agent/用户来源和控制权，用户输入携带接管标记。 | RC.1 真实 Shell 发现、重命名、PTY 输入、resize、重连、画面及关闭通过。RC.2 roster 和接管待真实版本验证。 |
| 插件包更新 | 选择兼容新版本，Git 包可指定完整提交来源和准确版本。使用官方 `updateBundle`，显示更新日志与回滚结果，取消绑定 request ID。 | RC.1 安装、卸载、取消及回滚的既有链路通过。实际更新及失败恢复需用两个可用版本的插件做人工验收。 |
| 状态协议与继续生成 | 批量 projection 按事件应用，inbox 驱动队列，兼容旧格式。可选 projection 提供空输入框继续生成，绑定失败序号和请求 ID。 | 状态和队列通过 RC.1 联调。继续生成仅在 Runtime 提供有效状态时显示，真实 RC.2 端到端待验证。 |

本次还处理附件读取期间发送、输入法选词与补全菜单按键冲突、快捷键提示不一致问题。

## 后续补齐

| 功能 | 已实现范围 | 验证 |
| --- | --- | --- |
| Worktree/PR 原生评审 | 使用官方 `forgePanel`。本地改动按暂存、未暂存、未提交、分支比较，RC.2 可选基础分支和单提交，按接口/实现/测试筛选。只读内容提供器展示原生并排 Diff，校验 hunk 与当前文本。已审阅摘要持久保存。 | RC.1 真实仓库验证 modified/added Diff、原文重建、初次任务前创建 Worktree。 |
| PR 协作与进度 | 跟踪 PR、读取差异和检查。RC.2 接入评审讨论、服务端 viewed 标记、行评论、完整评审和 head 校验后的分支更新，写入前展示确认内容。 | 按 RC.1/RC.2 源码版本分别构造请求。真实托管平台写入尚未实测。 |
| 独立会话标签 | 每个编辑器标签持有独立控制器、会话、上下文与草稿。相同会话复用已有标签。各视图共享 Runtime 和原生文件预览服务，命令和大纲跟随当前聊天。保存标签身份与文字草稿供恢复。 | 普通隔离 VS Code 窗口中通过双标签、重复打开、关闭不影响 Runtime，以及退出并重启后的会话恢复。 |
| 桌面 connect | 连接地址存 SecretStorage。Windows 使用当前账户 DPAPI 解密发现记录，通过 HMAC、nonce 和 AES-GCM 配对刷新地址。复制地址方式可用于其他平台和本地转发。桌面连接不另起 Harness。 | 配对客户端与真实 socket 验证正常密文、MAC 和篡改拒绝。本机为 macOS，Windows DPAPI 真机流程待验收。协议依据 [dsh-vscode-connect](https://github.com/mcdottok/dsh-vscode-connect)。 |
| 行内补全 | 手动命令及可选自动触发，自动模式默认关闭。只传当前文件的有限前后文到独立 minimal 会话，使用指定或当前聊天模型，取消旧请求、检查文档版本，结束后归档补全会话。 | 原生 VS Code 中通过真实模拟模型请求，返回 InlineCompletionItem，已取消请求返回空结果。 |
| 非视觉图片回退 | 仅对 `MODEL_DOES_NOT_SUPPORT_IMAGES` 的明确拒绝改为文件附件，沿用同一 request ID，受 `dsh.imageFileFallback` 控制。 | 使用 text-only 模型和实际文件上传验证。 |

## 上游契约与验证范围

基础契约 pin 和默认升级目标更新为已经过完整联调的 `dsh-v0.2.2-rc.1`，较旧 Runtime 保留版本兼容分支。源码检查使用本地 `deepseek-harness/` 标签对象。

- `dsh-v0.2.2-rc.1` 对应 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。
- `dsh-v0.2.2-rc.2` 对应 `ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`。
- Schedule 使用 `packages/schedule/schedule/src/types.ts` 和 `index.ts`。
- 子代理使用 `packages/subagent/subagent/src/projection-types.ts`、`control-types.ts` 和 `index.ts`。
- 终端使用 `packages/api/terminal-controller/src/types.ts`、`index.ts` 和 `terminal.ts`。
- 插件更新使用 `packages/boot/plugin-manager/src/types.ts` 和 `index.ts`。
- 继续生成使用 `packages/api/session-controller/src/continuation.ts` 和 `commands.ts`。

上述功能均已提供入口。真实 PR 写入、Windows 账户加密发现，以及 RC.2 专有服务仍需在对应平台和版本验收。模型重试参数通过现有 schema 驱动的 Runtime 设置编辑。

上游发布说明见 [RC.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1) 和 [RC.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.2)。调查时 npm 镜像及官方 registry 均未提供 `@deepseek-ai/dsh@0.2.2-rc.2`，GitHub RC.2 release assets 为空。实际联调使用已安装 RC.1。

## 验证

仓库评审依赖可选的 `@deepseek-ai/dsh-experimental-forge-bundle`。未启用时，Runtime 会返回 `gateway/invocation-unavailable`。扩展提供“管理 Runtime 插件”入口，可选择该组合包的“启用组合包”项；若宿主提示需要重启，请重启所属 Runtime 后再打开评审。缺少包时使用安装入口。权限拒绝和其他评审接口错误保留原始错误，不作为依赖缺失处理。

隔离 RC.1 集成检查已复现该缺失错误，验证网关错误的 endpoint 匹配，并确认通过 `setBundleEnabled` 启用官方可选组合包后，评审状态流恢复；检查结束后恢复为禁用状态。

`--no-open` 是 Web 应用的合法参数。若 Web 配置同时选入 `@deepseek-ai/dsh-headless`，另一个命令行解析器会拒绝它；Headless 组合包还会覆盖权限、凭据和沙箱设置，不能通过删除启动参数解决。扩展禁止在 Web Runtime 中选入或安装此组合包，并在启动前诊断已有混用配置。Headless 任务应放在独立配置中运行。

使用隔离的 RC.1 配置复现了完全相同的 `unknown option '--no-open'`。启动检查确认冲突在创建子进程前被拒绝且不改写配置，原生 VS Code 检查确认 Headless 的只读说明、拒绝启用以及原配置保持不变。正常会话、行内补全及重启恢复通过。

### 产品缺口复查（2026-11-12）

- 社区插件搜索使用 `pluginMarket/listIndexes|search|readEntryDetail|setIndexes`，可添加来源、翻页和选择兼容版本，安装/更新沿用市场返回的 registry 和精确 spec。需要启用官方 `@deepseek-ai/dsh-experimental-plugin-market-bundle`。
- 会话中心可按需要处理、运行、置顶及 DSH Workspace 筛选，保存排序与分组偏好。归档通知提供撤销入口。
- 费用面板使用当前自定义费率，按每次请求实际路由计价，不把旧模型 Token 转给当前模型。币种分别汇总，未匹配请求单独计数，不含非 Token 费用。
- 聊天字号、密度和专注模式可持久保存。`dsh.connectionMode=attach-only` 仅发现并附加已有实例。
- 模板管理可显式创建/编辑 IDE 项目的 `.dsh/prompts` 文档。附件菜单提供 IDE 文件/符号搜索以及 `AGENTS.md`、`.dsh/rules`、`.agents/rules` 的显式一次性规则附件。
- 附件读取预留数量与字节预算，完成时合并最新状态，清空或切换会话后丢弃过期批次。

实际 RC.1 检查覆盖本机市场分页结果、兼容性和精确 registry/spec，自定义费率的请求计数与金额，以及会话目录排序。原生 VS Code 检查增加了基于 TextDocument 的一次性代码上下文捕获。

遵循仓库规则，运行既有 50 项单元测试，扩展已有真实 Runtime 集成脚本。

```sh
npm run check
npm run compile
node --test test/*.test.js
npm run verify:package
node scripts/verify-file-drafts.mjs
node scripts/verify-remote-runtime.mjs \
  --launcher /opt/homebrew/bin/dsh --expect-version 0.2.2-rc.1 \
  --feature-controls --workflow-controls --with-jev --with-team-bundle --timed-questions
node scripts/verify-native-ide.mjs --launcher /opt/homebrew/bin/dsh
```

完整扩展冒烟通过，使用隔离的临时 DSH 配置、DSH Workspace 和本机模拟模型请求，覆盖鉴权、完整历史导出、ZIP 附件、Forge/Worktree、Host 任务、设置、账号通知、共享权限、PTY、插件安装取消、目录变更、Diff、评价、重连、流式输出、Goal、Jobs、限时问题和 Team。增加 `--with-forge` 可启用本地仓库与 Worktree 场景。

原生检查创建临时开发窗口并禁用该窗口的真实模型配置，执行双标签、补全与重启恢复。检查结束后退出测试窗口并清理临时数据，`--keep` 可保留日志。extension test 模式使用内存存储，恢复检查使用普通开发窗口。
