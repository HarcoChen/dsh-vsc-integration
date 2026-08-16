# 更新日志

本文档记录 DSH IDE 的重要版本变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.5.0] - 2026-08-16

- 新增深色模式适配，聊天、活动面板、Trace 和 Token 使用界面颜色与 VS Code 主题保持一致。
- 新增从 CNB 安装完整 Runtime 与 Standalone 镜像的能力，并增强下载进度和 HTTP 请求结束处理。
- 新增 LSP 集成、Web Search 卡片和 TODO 卡片展示，补充更多 Harness 任务状态反馈。
- 新增 Preset 管理，支持创建和选择自定义 Agent Preset；`/preset` 可作为 `/mode` 别名使用，并显示当前 Preset。
- 优化 Slash Command 在空工作区中的处理，支持 `/compact`，并修复 `/model` 在新对话中误创建空 Session 的问题。
- 新增 effort 滑块和图片附件入口，改善发送前的任务参数配置。
- 优化 Workspace 管理及 Runtime 发布流程，Marketplace 发布改用 PAT 校验。

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

## [0.3.2] - 2026-08-14

- 新增资源管理器入口：文件和目录右键可将目标路径与 workspace root 预填到 DSH Chat，不会自动发送或读取文件内容。
- 新增 `DSH: Diagnose Environment`：输出脱敏的 VS Code、Node、平台、工作区信任、命令发现、npm 全局目录、Runtime 健康状态和 API Key 引用诊断。
- 修复 Windows 下 npm 全局前缀查询无法通过 `.cmd` 启动器执行的问题，并保留 `.cmd`/`.ps1` Runtime 启动兼容性。

## [0.4.1] - 2026-08-16

- 新增 Provider 管理：可查看 Provider 启用、配置及凭据状态，设置或移除 API Key，并从命令面板或聊天菜单打开 Harness 官方配置文件进行新增和高级编辑。
- 支持安全删除纯用户层自定义 Provider；删除操作按 Harness 设置 revision 执行，并且仅清理由该 Provider 约定名称独占管理的凭据，避免误删共享 Key。
- 新增 `$` Skill 候选，并在 `/` 候选中同时展示 Harness Skill；选择后插入官方 `/skill-name` 调用语法。
- 修复新对话草稿态无法使用 `/mode`，以及尚未发送 prompt 时错误创建空 Session 的问题。
- 优化新对话的 Workspace 归属：可在当前 VS Code 文件夹尚无 Session 时直接建立本 Workspace 对话，也可继承当前所选 DSH Workspace 创建新对话。
- 修复第二个 VS Code 窗口无法复用随机端口 Runtime 的问题：启动者会把经过限制的 loopback URL 写入进程锁，后续窗口通过 `host.describe` 验证后连接已有 Harness，避免再次启动写进程。

## [0.4.0] - 2026-08-15

- 新增 Workspace 注册与 Session 归属：创建会话前自动注册当前工作区，避免新会话全部落入未分组状态。
- 新增按 VS Code 文件夹自动发现并恢复已有 DSH Session；打开曾在 Web 中建立过工作区的文件夹时可继续使用原会话和历史记录。
- 优化 Webview 会话选择器：按 Workspace 分组展示会话，并为历史或未关联工作区的会话提供“未分组会话”兜底分组。
- 扩展 Harness Workspace RPC 集成，支持读取工作区列表及按工作区筛选会话，为跨 Web 与 VS Code 的工作区复用提供基础。
- 增强 Trace Timeline：按可见事件的实际时间范围绘制时间轴，保留空闲间隔并改善 CSP 下的时间条定位。
- 修复跨 DSH Workspace 切换 Session 后发送消息会因 VS Code 当前目录不同而误建新会话的问题。
- 修复多窗口或多进程启动 Runtime 时的竞争：优先复用已存在的 Harness，并通过插件锁避免重复启动写入同一会话存储。
- 修复默认端口被占用时无法启动的问题：按 Harness 默认端口 `3080` 探测，未配置端口时交由操作系统分配空闲端口，并校验 `host.describe` 后才复用服务。

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

[0.4.1]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.4.0...v0.4.1
[0.5.0]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.4.1...v0.5.0
[0.4.0]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.3.0...v0.3.2
[0.3.0]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.1.0-alpha...v0.2.1
[0.1.0-alpha]: https://github.com/HarcoChen/dsh-vsc-integration/releases/tag/v0.1.0-alpha
