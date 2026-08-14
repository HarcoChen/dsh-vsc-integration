# 更新日志

本文档记录 DSH IDE 的重要版本变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.0] - 2026-08-14

- 新增紧凑的 Token 与上下文统计入口：使用环形进度展示估算占用，并在独立浮层中展示当前模型、reasoning effort、计费输入/输出、推理 Token 和缓存命中；数据来自 Harness 公开 usage/context projection，并明确区分计费值与估算值。
- 新增文件跳转：支持聊天回答、工具参数与结果、Trace 摘要及详情中的裸文件路径和 `path:line[:column]`，裸路径默认打开第 1 行；Extension Host 会校验工作区信任、真实文件、符号链接和工作区边界后再打开编辑器定位。
- 新增编辑器快捷任务：可从编辑器选区、当前文件或 Source Control 的 Git diff 右键入口预填“解释、修复、审查、生成文档”prompt；内容保持可编辑且不会自动提交，菜单会跟随 VS Code 语言显示中文或英文。
- 新增全界面国际化：扩展命令、设置说明、通知与选择器、聊天 Webview、Activity Dock、Token 面板和 Trace 均支持英文与简体中文，并跟随 VS Code 显示语言。
- 新增按 turn 汇总的变更审查面板：在 Git 工作区展示新增、修改、删除和重命名文件，并使用 VS Code 原生 diff 查看稳定快照；整轮恢复前会检测任务结束后的用户修改、路径占用和符号链接父路径，发生冲突时拒绝覆盖。
- 优化 Runtime 启动体验：`dsh.autoStart` 默认在扩展激活时启动或连接 DSH，“未启动”和“错误”状态可直接点击启动或重试；连接成功后会自动恢复工作区上次会话并加载完整历史。
- 新增 `@` 文件引用实时候选：根据输入内容查询工作区文件，排除 `.git` 和 `node_modules`，点击候选项即可插入引用。
- 增强发送前上下文反馈：附件显示字节大小和截断状态，并汇总本次实际进入 prompt 的上下文数量与大小。
- 更新 Marketplace 描述，突出流式任务、持久会话、Trace、变更审查和 Token/上下文可观测性。
- 增强 Runtime 发现：按配置路径、PATH、npm 全局目录和 `npx --no-install` 顺序查找 dsh，并记录最终来源。
- 修复 Windows 下启动 `.cmd`、`.ps1` 和 `npx.cmd` 可能触发 `EINVAL` 的问题。
- 增强 `@` 文件引用候选：支持路径模糊匹配，当前活动文件置顶，过滤常见构建和元数据目录。

## [未发布]

## [0.2.2] - 2026-08-14

本版本修复扩展图标缺失问题，并完善 DSH 的 IDE 品牌识别。

- 新增 Marketplace 扩展图标，解决扩展详情页不显示图标的问题。
- 更新 Activity Bar 图标：采用基于 DeepSeek Harness 鱼形标识的社区二次设计，并加入蓝色代码标记。
- 补充 DeepSeek Harness 图标来源与 MIT 许可说明。
- 完善 Slash Command，支持通过 `/mode` 切换 Harness 的四种 Agent Preset。
- 优化中英文 README、Marketplace 简介和自动发布流程。

## [0.2.1] - 2026-08-14

本版本重点重构了聊天界面，并补充模型选择和 Slash Command 支持。

- 使用 React 重构 Chat View，重新设计消息区、工具卡片、交互卡片、活动面板和输入区。
- 支持 Goal、队列、Subagent、Jobs 和权限状态的折叠展示。
- 新增模型选择功能。
- 新增 Slash Command 菜单，支持 `/ide`、`/new`、`/search`、`/model`、`/mode`、`/focus`、`/trace` 和 `/stop`；`/mode` 可动态选择 Harness Agent Preset。
- 更新中英文 README 和发布流程。

## [0.1.0-alpha]

- 首个社区预览版本，提供 `dsh web` Runtime 集成、侧栏聊天和 IDE 上下文附加。

[未发布]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.1.0-alpha...v0.2.1
[0.1.0-alpha]: https://github.com/HarcoChen/dsh-vsc-integration/releases/tag/v0.1.0-alpha
