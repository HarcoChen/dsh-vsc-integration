# DSH `0.2.0-rc.1` Remote RPC 增量清单

审计目标：上游 tag [`dsh-v0.2.0-rc.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1)，commit `4878cdabd87d4041bdaff61d04c966883b9fd07a`（2026-09-28 发布）。截至本次适配，上游 0.2.0 系列仍只有预发布候选，没有正式 `v0.2.0` tag。

差异基线：`dsh-v0.1.7-rc.2`。默认 Runtime 与 Remote wire-contract pin 已切换至上述 RC.1。此次依据固定 tag 做了源码适配；没有运行测试，也没有连接真实 RC.1 Runtime 联调。

## 新增 Remote namespace

RC.1 在 `packages/api/remotes/src/client/index.ts` 中新增并挂载 `productAnalytics` contribution，提供 3 个 Remote 方法：

| Endpoint | 传输 | 签名 | 说明 |
| --- | --- | --- | --- |
| `productAnalytics/enabled` | unary | `(): boolean` | 读取 Host 当前的采集策略。 |
| `productAnalytics/watchPolicy` | stream | `(signal: AbortSignal): AsyncIterable<boolean>` | 初次发送当前策略，配置变化时继续发送；signal 由 Remote stream 提供，用于订阅生命周期，不是序列化的业务参数。 |
| `productAnalytics/report` | unary | `(event: ProductEvent): Promise<void>` | 接收带时间戳和类型化属性的桌面产品事件；返回只表示本地接收路径结束，不确认遥测已送达。 |

`ProductEvent.eventName` 的 21 种取值为：`desktop_app_launch`、`auth_page_view`、`auth_page_click`、`api_key_save_click`、`onboarding_page_view`、`onboarding_page_click`、`onboarding_popup_view`、`onboarding_popup_click`、`desktop_upgrade_click`、`desktop_upgrade_download_result`、`desktop_upgrade_install_restart_click`、`send_button_click`、`model_switch`、`thinking_level_switch`、`context_compression`、`branch_session_click`、`sidebar_menu_click`、`plugin_toggle`、`plugin_add_button_click`、`plugin_install_click`、`install_plugin_result`。每类事件有独立的 `attributes` 类型，`timestamp` 为毫秒时间戳。

这是桌面端遥测接口。上游配置通过 volatile `enabled` 字段控制采集；普通 Web composition 不挂载该服务，也不会提交这些事件。dsh-ide 连接的是 `dsh web` Runtime，因此不调用、不转发这组 RPC。事件类型不包含提示词、模型回复、API Key 或账户令牌；Host 可在字段存在时补充设备与账户标识。`report` 没有数据仓库交付确认。

## 既有接口和可用性

- 两个 tag 间没有发现既有 `@Remote` endpoint 签名或 Remote event allowlist 变化；本次新增的 Remote 声明均属于 `productAnalytics`。
- `schedule/list|history|update|delete|catalog` 的签名没有变化，但 RC.1 把 Schedule composition 移入可选包 `@deepseek-ai/dsh-experimental-schedule-bundle`。标准 Web profile 不包含 `time-context`、`schedule`、`ui-schedule` 这三项；安装并启用可选包后才提供对应服务。`schedule_create` 仍是 Agent tool，不是 Remote create endpoint。
- Session client API 的 `fork` 增加 `onCreated` callback；它不是 `@Remote` endpoint，不属于 wire RPC 清单。

因此，外接 `0.2.0-rc.1` Web Runtime 时，Schedule Dock 的 RPC 能力取决于该 Runtime 是否启用了 Schedule bundle。dsh-ide 仍兼容 Schedule endpoint 缺失的 Runtime；Activity Dock 会保留 Schedule 标签，并显示启用官方 bundle 的说明。

## 插件与 Git 子模块

- `.gitmodules` 中登记的唯一 Git 子模块是 `vendor/dsh-jev-integration`，当前固定在 `795907cbdf3347f97b27c473f4f6194f5877a74d`，子模块工作区干净。该提交满足适配所需；没有推进子模块指针。
- Jev 协议的最低 Runtime 版本仍为 `0.1.5-rc.1`。它使用的 `agent/turn-stopping`、`session/event`、`session/disposed`、`system-prompt/assemble`、工具执行钩子和 `tokenMeter`/`toolResultPruner` 服务在 RC.1 源码中仍存在，未发现需要调整的插件接口。
- 本地 `dsh-jev-integration` `origin/main` 比子模块 pin 前进两个提交，其中新增的 opt-in `tokenOptimization` 是另一项功能，不是 RC.1 兼容所需，故未一并升级。没有真实 Runtime 联调，因此未提高插件协议报告的 `testedDshRuntime`。

源码参照：[Jev 子模块 pin](https://github.com/HarcoChen/dsh-jev-integration/tree/795907cbdf3347f97b27c473f4f6194f5877a74d)、[Jev Runtime 兼容声明](https://github.com/HarcoChen/dsh-jev-integration/blob/795907cbdf3347f97b27c473f4f6194f5877a74d/protocol/src/index.ts)。

## 适配范围与验证状态

- 默认 Runtime 下载及用户同意后的升级目标、Remote contract 注释、英文和中文设置说明均已指向 RC.1；最低兼容版本保持 `0.1.5-rc.1`。
- 桌面专用遥测不接入；Schedule bundle 缺失时保留面板并解释如何启用；Jev 子模块 pin 和最低版本保持不变。
- 独立托管归档由 `dsh-runtimes` CNB 流水线发布；本环境无法解析 `cnb.cool`，因此未能核实 `v0.2.0-rc.1/manifest.json` 是否已发布。
- 尚未对真实 `0.2.0-rc.1` Runtime 执行联调。仓库规则禁止新增单元测试；本次未运行测试。

## 源码依据

- [RC.1 release notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1)
- [Remote Client assembly](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.1/packages/api/remotes/src/client/index.ts)
- [Remote forwarded-event allowlist](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.1/packages/api/remotes/src/remote-events.ts)
- [Product Analytics Remote methods](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.1/packages/client/product-analytics/src/index.ts)
- [Product Analytics event DTOs](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.1/packages/client/product-analytics/src/events.ts)
- [Product Analytics composition and collection notes](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.1/packages/client/product-analytics/README.zh.md)
- [Optional Schedule bundle composition](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.1/packages/experimental/schedule-bundle/cordis.patch.yml)
- [Profile bundle defaults](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.1/packages/boot/app-boot/src/profile.ts)
- [Optional Schedule bundle in the Plugins page](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.1/packages/bundle/web-app/README.zh.md)
