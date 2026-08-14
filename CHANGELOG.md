# 更新日志

本文档记录 DSH IDE 的重要版本变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

[未发布]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/HarcoChen/dsh-vsc-integration/compare/v0.1.0-alpha...v0.2.1
[0.1.0-alpha]: https://github.com/HarcoChen/dsh-vsc-integration/releases/tag/v0.1.0-alpha
