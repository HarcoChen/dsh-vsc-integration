# DSH VS Code 插件维护记录

调查日期为 2026-11-11。比较范围为同类 DSH VS Code 插件。功能描述依据各项目 README 和能力矩阵，验证状态沿用来源中的限制。

## 同类插件对比

| 项目 | 调查时的提交 | 主要能力 | 本仓库覆盖与差距 |
| --- | --- | --- | --- |
| DSH Sidebar | `f9449c5`，11 月 6 日 | 原生聊天、调试器、逐轮活动、模型与权限、Diff 和安全恢复、Tools/Skills/MCP 管理 | 已有对应核心入口及自动调试、逐次工具 Diff、Trace、Jev。本次补充新版任务和插件包更新。 |
| JaboDSH | `05d73dc`，11 月 11 日 | Markdown/JSON/ZIP 导出、历史输入召回、完成提示、独立会话编辑器标签、会话排序与布局偏好、费用估算 | 本次补齐 Markdown/JSON 导出、完整会话复制、历史输入召回和可选完成通知。当前编辑器聊天镜像共享会话，独立会话标签及含附件 ZIP 归档仍有差距。 |
| DSH Coding Agent | `2f3187c`，11 月 11 日 | 桌面连接配对、会话与 DSH Workspace 导航、上下文、审批、原生审阅、侧栏及编辑器聊天 | 已有主要聊天工作流和本地 Runtime 发现。本次补充会话导出和输入工作流，专用桌面 connect 插件的 Windows 配对协议仍待接入。 |
| Fengze233 DSH for VS Code | `b1243ba`，11 月 8 日 | 嵌入官方 Web UI、鉴权代理、CLI/Desktop 发现、原生文件与剪贴板桥接、远程环境支持 | 本仓库采用原生聊天和 Remote API，已有进程管理、鉴权、发现、文件链接及图片附件。嵌入 Web UI 可跟随上游页面功能，原生界面需要逐项适配。非视觉模型的图片路径回退仍有差距。 |
| GT112 DSH Sidebar | `9d3b29a`，8 月 16 日 | 行内补全、诊断及文件附件、Trace、逐轮变更、检查点、插件中心、能力热刷新 | 已有多数 Agent 工作流和动态目录。行内 ghost-text 补全待实现，该来源的版本和安装方式较旧。 |

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
| 会话导出与复制 | 聊天菜单和命令面板导出 Markdown/JSON，记住格式。被动 follow 固定切点后分页读取完整历史。Markdown 显示图片引用和工具日志，JSON 包含完整记录。完整复制写入剪贴板。 | RC.1 真实分页及两种文本格式检查通过。取消、权限或连接变化时终止。二进制附件打包待实现。 |
| 引用与历史提示词 | 消息底部可引用整条消息或其中选中文本。空输入框按 ↑ 召回已发提示词，↑/↓ 切换并恢复原草稿，手动编辑结束召回。 | 浏览器预览验证 ↑ 召回及 ↓ 恢复。引用由主机核对消息和选区。 |
| 完成通知 | 可选设置 `dsh.completionNotification` 在 VS Code 失焦且观察到成功完成时通知，提供打开会话入口。 | 默认关闭，通知受 VS Code 与系统设置影响。 |
| 子代理目录 | 0.2.2 读取目录、身份和计时 projection，展示名称和 external 项。多层目录显式展开并保留错误重试。Team 与子代理面板可同时访问。 | RC.1 实际验证 Team 子成员目录、历史和 follow-up。RC.2 的名称、external 及 `interruptByUser` 按源码适配，待真实版本验证。 |
| 冷会话激活 | 所有者显式打开普通聊天时请求激活。历史导出、子代理预览及共享只读连接使用被动读取。 | RC.1 的 follow、权限及历史链路通过，冷会话迁移待旧数据现场验收。 |
| Runtime 终端 | 选择 Host 发现的 Shell、重命名及恢复画面。RC.2 实时刷新目录，显示 Agent/用户来源和控制权，用户输入携带接管标记。 | RC.1 真实 Shell 发现、重命名、PTY 输入、resize、重连、画面及关闭通过。RC.2 roster 和接管待真实版本验证。 |
| 插件包更新 | 选择兼容新版本，Git 包可指定完整提交来源和准确版本。使用官方 `updateBundle`，显示更新日志与回滚结果，取消绑定 request ID。 | RC.1 安装、卸载、取消及回滚的既有链路通过。实际更新及失败恢复需用两个可用版本的插件做人工验收。 |
| 状态协议与继续生成 | 批量 projection 按事件应用，inbox 驱动队列，兼容旧格式。可选 projection 提供空输入框继续生成，绑定失败序号和请求 ID。 | 状态和队列通过 RC.1 联调。继续生成仅在 Runtime 提供有效状态时显示，真实 RC.2 端到端待验证。 |

本次还处理附件读取期间发送、输入法选词与补全菜单按键冲突、快捷键提示不一致问题。

## 上游契约与剩余功能

基础契约 pin 和默认升级目标为 `dsh-v0.2.1-rc.2`，本轮增加 `0.2.2-rc.1` 兼容分支。源码检查使用本地 `deepseek-harness/` 标签对象。

- `dsh-v0.2.2-rc.1` 对应 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。
- `dsh-v0.2.2-rc.2` 对应 `ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`。
- Schedule 使用 `packages/schedule/schedule/src/types.ts` 和 `index.ts`。
- 子代理使用 `packages/subagent/subagent/src/projection-types.ts`、`control-types.ts` 和 `index.ts`。
- 终端使用 `packages/api/terminal-controller/src/types.ts`、`index.ts` 和 `terminal.ts`。
- 插件更新使用 `packages/boot/plugin-manager/src/types.ts` 和 `index.ts`。
- 继续生成使用 `packages/api/session-controller/src/continuation.ts` 和 `commands.ts`。

Worktree/PR 原生评审、审阅进度与分支更新，独立会话编辑器标签、二进制附件 ZIP 归档、桌面 connect 专用配对和行内补全仍待实现。已有本地 Diff、消息分叉与代码恢复、会话镜像和 Runtime 连接。模型重试参数通过现有 schema 驱动的 Runtime 设置编辑。

上游发布说明见 [RC.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1) 和 [RC.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.2)。调查时 npm 镜像及官方 registry 均未提供 `@deepseek-ai/dsh@0.2.2-rc.2`，GitHub RC.2 release assets 为空。实际联调使用已安装 RC.1。

## 验证

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
```

完整扩展冒烟通过，使用隔离的临时 DSH 配置、DSH Workspace 和 41 次本机模拟模型请求，覆盖鉴权、完整历史导出、Host 任务、设置、账号通知、共享权限、PTY、插件安装取消、目录变更、Diff、评价、重连、流式输出、Goal、Jobs、限时问题和 Team。

浏览器预览验证任务面板和历史提示词召回。完整 VS Code 原生向导、各平台桌面配对及 RC.2 专有接口需对应环境验收。
