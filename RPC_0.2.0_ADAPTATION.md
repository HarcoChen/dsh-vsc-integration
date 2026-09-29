# DSH `0.2.0-rc.1` Remote RPC 增量清单

审计目标：上游 tag [`dsh-v0.2.0-rc.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1)，commit `4878cdabd87d4041bdaff61d04c966883b9fd07a`（2026-09-28 发布）。

差异基线：`dsh-v0.1.7-rc.2`。本报告更新 RPC 清单；dsh-ide 当前实现和默认 Runtime 仍以 RC.2 为准，没有在本次变更中升级版本 pin。

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

因此，外接 `0.2.0-rc.1` Web Runtime 时，Schedule Dock 的 RPC 能力取决于该 Runtime 是否启用了 Schedule bundle。默认 Runtime pin 与 `src/remote/contracts.ts` 仍保持 `0.1.7-rc.2`，本清单不代表已完成 RC.1 Runtime 联调或版本升级。

## 源码依据

- [RC.1 release notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1)
- [Remote Client assembly](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.1/packages/api/remotes/src/client/index.ts)
- [Remote forwarded-event allowlist](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.1/packages/api/remotes/src/remote-events.ts)
- [Product Analytics Remote methods](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.1/packages/client/product-analytics/src/index.ts)
- [Product Analytics event DTOs](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.1/packages/client/product-analytics/src/events.ts)
- [Product Analytics composition and collection notes](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.1/packages/client/product-analytics/README.zh.md)
- [Optional Schedule bundle composition](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.1/packages/experimental/schedule-bundle/cordis.patch.yml)
- [Profile bundle defaults](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.1/packages/boot/app-boot/src/profile.ts)
