# DSH `0.1.7-rc.1` Remote RPC 适配审计

目标：`dsh-v0.1.7-rc.1@46a7f68b0922371ce7144b668b90e377d8e799f4`。
比较基线：`dsh-v0.1.5-rc.2@fb2c4b9e698e30edb738bca4cf0618587db7d203`。
上游源码位于 `deepseek-harness/`；本报告以 tag 源码为准。源码树可检索到 125 个
`@Remote` 声明，实际可调用 endpoint 取决于 Runtime 的 profile/composition。

## 已适配的 wire 变化

| 上游变化 | dsh-ide 处理 |
| --- | --- |
| unary RPC 成功结果含字节时，Connection 返回 `multipart/form-data`；`metadata` 内有原响应 envelope 与 `attachments[{path, codec: "bytes", part}]`，独立 `bytes-N` 字段承载二进制 | `RemoteUnaryClient` 按表单还原 byte path 上的 `null` 占位为 `Uint8Array`；检查 rpcId、codec、part、路径、重复字段和多余字段。纯 JSON 与错误响应仍沿用原 envelope parser。 |
| Remote stream 除 `open/cancel` 外支持 Client 上行 `item` 和半关闭 `end` | `RemoteStreamMuxClient.open(..., uplink?)` 逐项校验 JSON-safe 值并发送上行帧；关闭、异常或取消时结束迭代器。Gateway 默认每流最多缓冲 262,144 字节。 |
| Host 转发事件新增 4 个 emit：permission preset catalog、plugin manager changed/install log/install state | 加入 `src/remote/events.ts` allowlist，继续走既有连接事件路由。IDE 尚无这些事件的专用呈现消费者。 |
| 归档活动中的 Session 可返回 `workspace/session-active` 和 activity 详情；`stopActivity: true` 可请求停止其活动并归档 | `DshRuntime.archiveSession` 仅在显式第二次确认后发送 `stopActivity: true`；普通归档请求不停止工作。 |

## Endpoint 与 DTO 差异

- **Agent Preset**：由 `dsh-agent-preset-registry` 提供 `agentPresets/list|read|select`。List 返回 `presets` 与 `modeSelectionEnabled`；行和 read DTO 不再提供 `trust`、`authorable`、`hasDocument`。上游不再公开 `agentPresets/copy`、`agentPresets/deletePreset`、`settings/canOpenAgentPresetDirectory`、`settings/openAgentPresetDirectory`。IDE 保留只读 composition 查看和 default 选择；default 写入仍调用 `settings/update`，新 namespace/字段是 `agent-preset-registry` / `selectedDefault`。设置描述也会识别仍受支持的旧 Runtime `agent-presets` / `default` 字段。
- **Workspace files**：当前是 `read`、`readBytes`、`stat`、`list`、`changes` 五个 Remote 方法；`readAll`、`readRelated` 已移除，`changes` 现在需要 path。当前 IDE 无消费者，留在远程 Workspace 文件能力候选。
- **Workspace archive**：另有 `initializeDefault`、`unarchiveSession`、`pinSession`、`unpinSession`；Workspace snapshot 含 `pinnedSessionIds`，follow 可给出 `type: "pinned"`。IDE 目前只归档，固定/恢复导航列入 TODO。
- **Session DTO**：新增 `agentAvailable`、projection hint kind `cached|sequenced`、page/follow 的 `turnWindow` 等元数据。现有列表和历史读取路径按公开 Remote DTO 工作，没有添加对可选字段的必需依赖。
- **Session log**：上游磁盘记录进入 V4。IDE 通过 `session/page`、`session/follow` 消费 Runtime 暴露的记录，不直接解析 Session 文件或迁移格式。
- **新增 namespace**：默认 Remote assembly 纳入 `jobs`、`terminal`、`pluginManager`、`pluginRegistryProbe`、`permissionPresets`、`officeToPdf`、`account` 等能力；是否存在仍由实例 composition 决定。本扩展暂未接入这些新增表面。

## 相关实现位置

- 协议与 multipart：`src/remote/contracts.ts`、`src/remote/unaryClient.ts`
- mux 上行与连接 facade：`src/remote/muxClient.ts`、`src/remote/connection.ts`
- forwarded event allowlist：`src/remote/events.ts`
- archive 和 preset facade/UI：`src/dshRuntime.ts`、`src/chatView.ts`、`src/agentPresetActions.ts`、`src/types.ts`
- 当前功能候选及 smoke 限制：`TODO.md` 的 2026-09-24 本轮进展

## 验证边界

本次未新增单元测试，遵守仓库规则。类型检查和 diff 检查作为提交前验证；未对真实
`0.1.7-rc.1` Runtime 运行联调。`scripts/verify-remote-runtime.mjs` 当前固定使用
`0.1.5-rc.2` 与 V3 磁盘 fixture，不覆盖 multipart、双向流或 V4 存储；不把该脚本结果
作为本次协议变更的验证证据。未来为新 Runtime 增加集成冒烟时，应使用隔离 DSH_HOME，且不请求外部模型。
