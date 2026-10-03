# DSH `0.2.0-rc.1` Remote RPC 适配审计

审计目标：上游预发布 tag [`dsh-v0.2.0-rc.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1)，commit `4878cdabd87d4041bdaff61d04c966883b9fd07a`（2026-09-28 发布）。复核日期：2026-10-02。

差异基线：`dsh-v0.1.7-rc.2`。默认 Runtime 与 Remote wire-contract pin 已切换至上述 RC.1。真实 RC.1 的标准 Web profile 与启用 Schedule bundle 的 profile 均已通过隔离 Remote 联调；CNB 独立 Runtime manifest 返回 HTTP 404，托管下载路径仍待补发归档。

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
- `tokenOptimization` 属于独立功能，不是 RC.1 兼容所需，故未一并升级。本轮 Remote 联调未启用 Jev，因此未提高插件协议报告的 `testedDshRuntime`。

源码参照：[Jev 子模块 pin](https://github.com/HarcoChen/dsh-jev-integration/tree/795907cbdf3347f97b27c473f4f6194f5877a74d)、[Jev Runtime 兼容声明](https://github.com/HarcoChen/dsh-jev-integration/blob/795907cbdf3347f97b27c473f4f6194f5877a74d/protocol/src/index.ts)。

## 适配范围与验证状态

- 默认 Runtime 下载及用户同意后的升级目标、Remote contract 注释、英文和中文设置说明均已指向 RC.1；最低兼容版本保持 `0.1.5-rc.1`。
- 桌面专用遥测不接入；Schedule bundle 缺失时保留面板并解释如何启用；Jev 子模块 pin 和最低版本保持不变。
- 2026-10-02，CNB 的 `v0.2.0-rc.1/manifest.json` 返回 HTTP 404；同源 `v0.1.7-rc.2/manifest.json` 返回 HTTP 200。扩展自身的 `CnbRuntimeProvider` 也复现 RC.1 的 404。官方 npm 包 `@deepseek-ai/dsh@0.2.0-rc.1` 可安装，自动 pnpm/npx 回退及显式 npm 启动器可用；无 Node/npm 环境的首启下载仍受阻。
- 发布前需补发 RC.1 独立 Runtime manifest 与五个平台归档，再通过 `verify-managed-runtime.mjs` 的远端检查及 `--full` 本机安装验证。此次没有下载、解压或运行 CNB 的 RC.1 归档。
- 仓库规则禁止新增单元测试；本轮只更新现有集成冒烟脚本并运行类型检查、编译与隔离联调。

## 真实 Runtime 联调

`scripts/verify-remote-runtime.mjs` 启动前检查 `dsh --version`，默认要求与 `RUNTIME_DEFAULT_VERSION` 一致。历史数据通过 `session/create` 和 `session/prompt` 生成，由 Runtime 写入当前存储格式，替代旧 V3 磁盘 fixture；模拟模型使用 DeepSeek 的 Messages SSE 协议。`--with-schedule-bundle` 只在临时 Web profile 中选择官方 Schedule bundle。

本轮使用临时 npm 安装的精确版本 `@deepseek-ai/dsh@0.2.0-rc.1`，不替换本机 `0.1.7-rc.2` CLI。两个 profile 均通过下列路径：

- 未认证请求被拒绝、启动 token 换 cookie、unary 与 mux `$events` 握手及 Workspace/Control baseline。
- DSH Workspace 与 Session 创建、八轮本地模型历史、`session/follow` 快照与 `session/page` 向旧记录分页回填、标题实时更新。
- 赞/踩分类、评价编辑、列表、CAS 冲突与删除。
- 断线后重建 baseline、流式回复中途重连恢复前缀、最终只提交一条助手消息。
- Goal 创建/暂停/恢复/清除及 activation 事件、命令附件参数、Subagent 缺失子会话错误。
- 标准 profile 的 `schedule/list|catalog` 返回 HTTP 404；启用 bundle 后二者返回空列表，`history|delete` 对不存在的任务返回 `schedule_not_found`。

执行记录（`/absolute/path/to/dsh` 代表上述临时安装中的启动器）：

```sh
npm run check
npm run compile
node scripts/verify-remote-runtime.mjs --launcher /absolute/path/to/dsh
node scripts/verify-remote-runtime.mjs --launcher /absolute/path/to/dsh --with-schedule-bundle
node scripts/verify-managed-runtime.mjs --version 0.2.0-rc.1
```

前四项通过；最后一项在 manifest 下载阶段因 HTTP 404 失败。额外用本机 RC.2 启动器验证了版本不匹配会在启动前被拒绝。联调使用临时 DSH_HOME、独立 DSH Workspace 和回环模型服务，不读取用户会话或外部模型凭据。

验证边界：未执行真实模型 API、DeepSeek 账号登录/钱包、Schedule 创建/编辑/到期投递、Jev 调用或 VS Code UI 人工联调；此脚本也未覆盖 multipart 字节载荷、mux 上行流、归档/固定/恢复及默认 Workspace 初始化。这些功能的 tag 差异结论来自源码审计。

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
