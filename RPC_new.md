# DSH `0.1.2-rc.1` RPC 破坏性变更审计

## 结论

DSH `dsh-v0.1.2-rc.1` 不是在旧 RPC 上加一个 token，而是完成了一次 RPC/Remote 架构迁移。旧客户端即使解决了根路径鉴权，也不能直接调用这个 RC：HTTP 端点、参数封装、流式通道、事件相关、错误码和若干业务语义都不兼容。

本报告的规范比较范围是：

- 基线：`dsh-v0.1.1-rc.2`（`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`）
- 目标：`dsh-v0.1.2-rc.1`（`a66e4702047846cdaa10c66c9d3df3951f5ea70d`）
- 当前本地 `deepseek-harness` HEAD 是 `dsh-v0.1.3-alpha.1`（`d347e70390...`）。由于问题针对 `0.1.2-rc.1`，下文以 RC tag 为准；如果最终跟随 alpha/master，应再做一次该 tag 之后的增量审计。

### 影响等级

| 等级 | 变更 | 对 dsh-ide 的影响 |
| --- | --- | --- |
| P0 | 旧 `packages/host/apiproxy` 删除，改为 Typert Gateway/Remote | 现有 RPC 客户端无法仅靠改 URL 兼容 |
| P0 | `session.list` 改为 `session/list`；payload 从业务对象改为 `{args: ...}` | 旧请求会被路由或参数校验拒绝 |
| P0 | `/api/events.mux`、`/api/events.host` 改为 `/api/remote.mux` 多路复用 WebSocket | 现有 `server-request/rpcId` 流解析器不能工作 |
| P0 | `session.history`/`workspace.list` 等基线接口移除，改为 page/follow/control 流 | 启动、历史、实时状态需要重写 |
| P0 | 错误码由 kebab-case 全局表改为 namespaced `RemoteError` | 现有错误分支和 UI 提示映射失效 |
| P1 | preset、goal、command、subagent 等改为 Agent-scoped Remote | 旧的 `{sessionId: ...}` 请求不能照搬 |
| P1 | 业务返回值、游标、prompt 幂等字段变化 | 状态合并、重连和乐观消息需要重新适配 |
| P1 | 根路径 token/cookie 鉴权 | 这是独立的传输前置条件；当前 dsh-ide 已有对应修复，但不能替代 RPC 迁移 |

## 1. 架构变化证据

RC 删除了旧的 `packages/host/apiproxy`，其中包括旧的 `rpc-map.ts`、RPC schema、API contract 和 fetch carrier；同时新增：

- `packages/api/gateway`：端点声明、严格参数校验、Remote 错误和流式 Gateway；
- `packages/api/session-controller`、`settings-controller`、`workspace-controller`：新的业务 Remote owner；
- `packages/api/remotes`：客户端生成的 Remote namespace 挂载；
- `packages/client/connection`：统一 `/api` Connection、浏览器鉴权和 WebSocket stream carrier；
- `packages/typert/protocol`：`RemoteError`、`RemoteResult` 与生成式 Remote 协议。

这意味着兼容层不能继续维护一份旧的静态 `HarnessRpcMethodMap` 作为唯一协议源；至少需要一个旧协议 adapter 和一个 RC+ adapter，或者直接迁移到新 Remote client。

## 2. Unary RPC：外壳相似，实际协议已变

### 2.1 旧版请求

旧版 `packages/host/apiproxy/src/api/rpc.ts` 保留四类 envelope，业务请求直接放在 `payload`，端点使用点号命名：

```http
POST /api/session.list
Content-Type: application/json

{
  "type": "client-request",
  "rpcId": "r-1",
  "method": "session.list",
  "payload": { "cursor": "..." }
}
```

响应仍是：

```json
{
  "type": "server-response",
  "rpcId": "r-1",
  "result": { "ok": true, "value": { "items": [] } }
}
```

旧版错误码来自 `RpcErrorDetailsMap`，例如 `bad-request`、`session-not-found`、`model-unavailable`、`settings-conflict`、`internal`。

### 2.2 RC 请求

RC 保留 `client-request/server-response` 这个最外层 discriminant，但端点和 payload 规则已换成 Gateway/ Typert 规则：

```http
POST /api/session/list
Content-Type: application/json

{
  "type": "client-request",
  "rpcId": "r-1",
  "method": "session/list",
  "payload": { "args": { "cursor": "..." } }
}
```

关键约束来自 `packages/api/gateway/src/index.ts`：

1. endpoint 必须恰好是两个非空 segment，即 `<namespace>/<method>`；`session.list` 不再是合法的 Remote endpoint。
2. `payload` 必须恰好只有一个普通对象字段 `args`；把旧业务对象直接放进 `payload` 会得到 `gateway/arguments-invalid` 或 bad request。
3. `args` 必须与生成 descriptor 精确匹配；缺字段和多余字段都会拒绝，不能再依赖旧 handler 忽略未知字段。
4. URL 中的 endpoint 必须和 envelope 的 `method` 完全相同。
5. HTTP 仍然要求 POST + JSON；不满足时由 Connection 在业务 dispatch 之前返回 404/415/400。

响应 envelope 的形状仍近似旧版，但错误现在是 `ConnectionRpcFailure`/`RemoteError` 风格，典型 code 为 `gateway/internal`、`gateway/bad-request` 或领域 namespaced code。不能按旧 kebab-case 全局 union 做 exhaustive switch。

## 3. 流式 RPC 和事件通道已重做

### 3.1 旧版

旧版在 `packages/client/connection/src/api-path.ts` 暴露两个 WebSocket 路径：

- `/api/events.mux`
- `/api/events.host`

`websocket-downlink.ts` 把每个下行 frame 包成：

```json
{
  "type": "server-request",
  "rpcId": "event-1",
  "method": "session/event",
  "payload": { "type": "...", "seq": 1 }
}
```

客户端只消费下行，不发送逻辑 stream open/cancel；实时事件和请求-响应事件都依赖 `server-request` + `rpcId`。

### 3.2 RC

RC 只有一个物理流路径：

```text
/api/remote.mux
```

一个 WebSocket 承载多个逻辑 Remote stream。客户端发送：

```json
{ "type": "open", "streamId": "s-1", "endpoint": "session/follow", "payload": { "args": { "address": { "kind": "session", "sessionId": "..." } } } }
{ "type": "cancel", "streamId": "s-1" }
```

主机发送：

```json
{ "type": "item", "streamId": "s-1", "value": { "type": "snapshot", "cursor": 42, "records": [] } }
{ "type": "error", "streamId": "s-1", "error": { "code": "session/not-found", "message": "...", "details": {} } }
{ "type": "end", "streamId": "s-1" }
```

该协议由 `packages/api/gateway/src/stream-protocol.ts` 定义，严格校验字段集合。流错误不再是 `server-request`，也不再用 `rpcId` 做流相关；相关性由 `streamId` 管理。

### 3.3 Gateway 内部 Remote events

事件转发是 Gateway 的特殊 Remote stream：

- endpoint：`$events`；
- event-result unary endpoint：`$events/result`；
- ready 帧分配 `clientId` 并携带 Host 信息（`home`）；
- 通知为 `{type: "emit", event, args}`；
- Agent-scoped waterfall 为 `{type: "waterfall", event, eventId, agentId, request}`；
- 客户端取消用 `{type: "cancel", eventId}`；
- 结果必须通过 `POST /api/$events/result`，payload 为 `{args:{clientId,eventId,outcome}}`，outcome 是 `next`、`result` 或 `rejected`。

因此旧的 `harnessConnection.mux()`/`host()`、`/api/respond`、`server-request` parser 和 `rpcId` response map 都不能直接复用。

## 4. 端点和命名空间映射

下表列出旧 `rpc-map.ts` 与 RC 源码的对应关系。除非标为“仍保留”，都属于协议迁移，不是简单别名。

| 旧端点 | RC 端点/处理方式 | 备注 |
| --- | --- | --- |
| `session.list` | `session/list` | payload 变为 `{args:{cursor?}}` |
| `session.search` | `session/search` | 同上，descriptor 严格校验 |
| `session.create` | `session/create` | 结果仍有 `sessionId`，但由 Remote descriptor 定义 |
| `session.history` | `session/page` + `session/follow` | history 被拆成分页 unary 和可重连 stream |
| `session.models` | `session/modelCatalog` | 新返回 provider 分组、默认模型和失败列表 |
| `session.selectModel` | `session/selectModel` | 业务请求仍含 `sessionId`，走新 args wrapper |
| `session.rename` | `session/rename` | 新结果含 `{title, seq}` |
| `session.fork` | `session/fork` | 新结果 `{sessionId}` |
| `session.prompt` | `session/prompt` | 必须有 client-minted `requestId`、`mode`、`content`，成功值为 `{accepted:true}` |
| `session.attachment` | `session/attachment` | 新 args wrapper和错误码 |
| `session.updateQueue` | `session/updateQueue` | `QueueAction` 由新类型定义 |
| `session.cancel` | `session/cancel` | 只确认取消已被接纳 |
| `subagent.list` | `subagents/list` | namespace 变复数，参数是 `parentSessionId` |
| `subagent.history` | 无同名 endpoint | 子代理历史通过 `session/page`/`session/follow` 的 `SessionAddress` 访问 |
| `subagent.prompt` | `subagents/prompt` | 请求带 parent/child、requestId、content、时区等 |
| `subagent.interrupt` | `subagents/interruptByParent` | 新增 parent 归属和 `mode:'continuable'` 校验 |
| `host.describe` | 无同名 endpoint | Host facts 改由 connection/Remote `$host` 和 ready generation 提供 |
| `host.pickDirectory` | `directoryPicker/pick` | capability-gated namespace |
| `host.listDirectory` | `directoryPicker/list` | capability-gated namespace |
| `host.createDirectory` | `directoryPicker/createDirectory` | 参数由 descriptor 精确约束 |
| `host.openPath` | `session/canOpenWorkspacePath` + `session/openWorkspacePath` | 新语义要求 Session-aware path；settings 另有 preset/document opener |
| `workspace.list` | `workspace/follow` | 不再有 list unary；首帧是完整 baseline，后续是 ordered increment |
| `workspace.create` | `workspace/create` | 结果为 `{workspace, created}` |
| `workspace.rename` | `workspace/rename` | 结果返回完整 workspace projection |
| `workspace.delete` | `workspace/delete` | 返回 `{deleted:true}` |
| `workspace.insertBefore` | `workspace/insertBefore` | 返回完整 workspace order |
| `workspace.insertSessionBefore` | `workspace/insertSessionBefore` | 返回更新后的 workspace |
| `workspace.archiveSession` | `workspace/archiveSession` | 返回完整 archived set |
| `skill.list` | `skills/list` | namespace 变复数；按 Session composition 返回 |
| `agentPreset.list` | `agentPresets/list` | namespace 变复数；结果包含 roster/authorable |
| `agentPreset.select` | `agentPresets/select` | Agent-scoped，不能只传旧 `sessionId` |
| `agentPreset.read` | `agentPresets/read` | `readDocument` 导出为 `read` |
| `agentPreset.copy` | `agentPresets/copy` | 参数为 `from/id/name?` |
| `agentPreset.openDocument` | `settings/openAgentPresetDirectory` | 移到 settings namespace，且只允许可写 preset |
| `agentPreset.remove` | `agentPresets/deletePreset` | method 名改变 |
| `goal.create` | `goals/create` | Agent-scoped；request 是 objective/max rounds，不是旧 session payload |
| `goal.edit` | `goals/edit` | Agent + revision ref + patch |
| `goal.pause` | `goals/pause` | Agent + revision ref |
| `goal.resume` | `goals/resume` | Agent + revision ref |
| `goal.complete` | `goals/complete` | Agent + revision ref |
| `goal.clear` | `goals/clear` | Agent + revision ref |
| `settings.describe` | `settings/describe` | redacted namespace views |
| `settings.openDocument` | `settings/openSettingsDocument` | method 名改变 |
| `settings.update` | `settings/update` | 从单 request object 改为生成的 positional/named args |
| `settings.replace` | `settings/replace` | 同上 |
| `settings.mutate` | `settings/mutate` | 同上 |
| `credentials.describe` | `credentials/describe` | 新 args descriptor；secret 仍不会返回 |
| `credentials.set` | `credentials/set` | 新 args descriptor |
| `credentials.unset` | `credentials/unset` | 新 args descriptor |
| `llm.providers` | `llm/listProviders` | method 名改变 |
| `llm.models` | `llm/listConfigurableProviders` | 不再是旧 `models` 名称 |
| `llm.discoverModels` | `llm/discoverModels` | endpoint slash 化，参数分解为 `settingsNs/request/signal` |

## 5. RC 新增的 Remote surface

`packages/api/remotes/src/client/index.ts` 明确挂载以下客户端 namespace，旧 `rpc-map.ts` 没有这些完整 surface：

- `commands`：`commands/list`、`commands/execute`；方法按 Agent 作用域解析；
- `messageFeedback`：`messageFeedback/list`、`put`、`delete`；
- `pluginInventory`：插件库存；
- `sessionReferenceResolver`：会话引用候选；
- `fileReferences`：文件引用候选；
- `dynamic`：Cordis host runner 动态能力；
- `skills`、`directoryPicker` 等独立 capability namespace；
- `agentPresets`、`subagents`、`goals`、`session`、`workspace`、`settings`、`credentials`、`llm` 的生成式 Remote artifacts。

客户端不能只维护旧的 50 多个方法名；是否 mount 某 namespace 本身也成为组合结果的一部分，未挂载的方法是 assembly fault，不再等价于旧的 `method-not-found` 业务错误。

## 6. 领域 payload 和语义变化

### 6.1 Session 地址、历史和实时状态

RC 在 `packages/api/session-controller/src/types.ts` 引入 `SessionAddress`：

```ts
{ kind: 'session', sessionId }
{ kind: 'subagent', parentSessionId, childSessionId, mode: 'one-shot' | 'continuable' }
```

历史读取改为：

- `session/page`：传 `address`、`throughSeq`、可选 `beforeSeq`、`maxMessages`，返回 message-aligned page；
- `session/follow`：首帧是带 `header/cursor/records/hasMore/projections` 的 snapshot，之后是 gap-free `event` 帧；
- `session/control`：首帧 baseline，之后是 queue/jobs/projection replacement frame。

这不等价于旧的 `session.history` + `/api/events.mux`。旧客户端的 `sessionStore.ts`/`sessionCatalog.ts` 需要从“收到 server-request 后按 rpcId 拼状态”改成“以 snapshot/cursor 为基线、按 generation 重连”。

### 6.2 Prompt 幂等和消息内容

`SessionPromptRequest` 现在至少要求：

```ts
{
  requestId: SessionRequestId,       // 客户端生成，用于持久化/重试对账
  sessionId: SessionId,
  mode: 'queue' | 'steer',
  content: PromptContentPart[],
  clientTimeZone?: string
}
```

旧客户端若只传文本、`command` 或依赖服务端生成 rpc id，会丢失新 RC 的幂等、steer 和时区语义。

### 6.3 Agent-scoped 方法

`goals/*`、`commands/*`、`agentPresets/select` 等方法的源码签名直接接收 `Agent`。Typert 会把该参数编译为 lookup/context wire 参数，并在 Host 侧验证它属于正确 scope。旧版传 `{sessionId: ...}` 的做法既不满足 descriptor，也绕过了新的 live-Agent/隔离语义。

### 6.4 Workspace baseline

`workspace/follow` 的首帧为完整 baseline：workspace items、归档 session 集合；后续增量包括 upsert/remove/order/archived。不能用一次 `workspace/list` 后再拼旧 host frames 代替，因为重连时必须重新接收完整 generation baseline。

## 7. 错误模型变化

旧版：

```ts
{ ok: false, error: { code: 'session-not-found', message, details } }
```

RC：

```ts
{ ok: false, error: RemoteError }
// RemoteError: { isDSHRemoteError: true, code, message, details }
```

`packages/typert/protocol/src/remote-error.ts` 定义了跨 realm 可识别的 `RemoteError`；业务代码按 `error.code` 判别，不应再用 `instanceof` 或旧的全局 union。错误码由 namespace 扩展，例如：

- Gateway：`gateway/arguments-invalid`、`gateway/method-unavailable`、`gateway/result-invalid`、`gateway/internal`；
- Session：`session/not-found`、`session/model-unavailable`、`session/conflict`、`session/agent-busy`、`session/queue-item-not-found`；
- Workspace：`workspace/not-found`、`workspace/invalid-path`、`workspace/name-conflict`、`workspace/move-invalid`；
- Settings/Credential：`settings/rejected`、`settings/conflict`、`credential/rejected`；
- Preset/Subagent/LLM：`agent-preset/not-found`、`agent-preset/locked`、`subagent/not-found`、`subagent/unauthorized`、`llm/model-discovery-rejected`。

需要特别注意：Gateway 的参数/descriptor 错误发生在业务 handler 之前；它们不是旧业务错误表中的 `bad-request` 一个分支可以完整替代的。

## 8. 对当前 dsh-ide 的直接影响

当前扩展仍然可见的旧协议假设：

- `src/harnessProtocol.ts`：静态 `HarnessRpcMethodMap` 使用 `session.history`、`workspace.list`、`agentPreset.*`、`goal.*`、`llm.providers/models` 等点号端点；
- `src/harnessClient.ts`：请求 URL 是 `/api/${method}`，payload 直接传业务对象；stream 固定读取 `/api/events.mux` 和 `/api/events.host`，并要求 `server-request`；
- `src/harnessConnection.ts`：分离 `mux()`/`host()`，以旧 frame type 和 `rpcId` 做分发；
- `src/types.ts`：`DshMuxFrame`/`DshHostFrame` 保留旧 host/session frame 与 rpcId correlation；
- `src/sessionStore.ts`、`src/sessionCatalog.ts`：按旧 session event、host session frame 和旧 list/history 返回值更新状态。

因此兼容工作至少要分成以下 P0/P1：

1. **P0 transport**：新增 `/api/<namespace>/<method>` + `{args:{...}}` 请求器；接入 `/api/remote.mux` 的 `open/cancel/item/error/end` 多路复用；实现 generation/reconnect/cancel。
2. **P0 protocol/types**：重写 endpoint map 和参数/返回类型，不能在旧 `HarnessRpcMethodMap` 上做字符串替换。
3. **P0 session/workspace state**：实现 `session/page`、`session/follow`、`session/control`、`workspace/follow` 的 baseline/cursor/增量合并。
4. **P0 errors**：建立 `RemoteError` code 到 UI/业务动作的映射，并保留未知 namespaced code 的兜底。
5. **P1 feature remotes**：按生成 descriptor 迁移 settings、credentials、preset、goal、subagent、LLM、commands、feedback 等调用方。

根路径 token/cookie 修复只解决 `requestRejection` 前置鉴权，不能使上述旧 endpoint 和 stream 恢复可用。

## 9. 兼容策略建议

如果产品只支持默认打包的最新 DSH，可以直接把 RC+协议作为唯一实现，并在启动时做一次 Remote capability/握手失败诊断。若必须兼容旧 DSH，建议：

```text
旧版 DSH  -> LegacyApiProxyAdapter
0.1.2-rc.1+ -> TypertRemoteAdapter
```

不要只按 token 是否存在判断版本，也不要用“先请求旧端点、401 后再猜新协议”作为长期方案：401 可能代表鉴权，404/400 可能代表 endpoint/descriptor，三者不能混为版本信号。兼容分支应以明确的 DSH 版本/协议能力信息为准；在无法读取版本时，至少把“新旧 endpoint + stream handshake”封装成一次可缓存的 capability probe，并把结果绑定到该 DSH 进程/连接 generation。

不过，若 dsh-ide 默认永远拉取最新 DSH，版本检测不是运行时必需项；必须做的是完整实现 RC+ adapter，并在诊断信息中报告发现的 DSH 版本和协议代次。

## 10. 源码索引

目标 tag `dsh-v0.1.2-rc.1`：

- `packages/api/gateway/src/index.ts`：endpoint claims、`remoteRequest`、exact argument validation；
- `packages/api/gateway/src/stream-protocol.ts`：`/api/remote.mux`、logical stream、`$events` wire frames；
- `packages/api/gateway/src/client/stream-client.ts`：单 WebSocket、多 logical stream、open/cancel/reconnect；
- `packages/client/connection/src/rpc.ts`：新的 Connection RPC envelope、result/failure 与 `/api` channel API；
- `packages/client/connection/src/rpc-host.ts`：HTTP endpoint 解析、POST/JSON、method/path 一致性和鉴权前置；
- `packages/api/session-controller/src/index.ts`、`src/types.ts`：Session Remote methods、page/follow/control、prompt/address types；
- `packages/api/workspace-controller/src/index.ts`、`src/types.ts`：Workspace methods 与 follow baseline/increments；
- `packages/api/workspace-controller/src/directory-picker.ts`：`directoryPicker` namespace；
- `packages/api/remotes/src/client/index.ts`：客户端实际挂载的 Remote namespaces；
- `packages/typert/protocol/src/remote-error.ts`、`src/types.ts`：RemoteError/RemoteResult/error code 扩展点；
- `packages/preset/agent-presets/src/index.ts`：`agentPresets` method exports；
- `packages/goal/goal/src/index.ts`：Agent-scoped `goals` methods；
- `packages/subagent/subagent/src/index.ts`：`subagents/list|prompt|interruptByParent`；
- `packages/llm/llm/src/index.ts`：`listProviders|listConfigurableProviders|discoverModels`；
- `packages/api/settings-controller/src/index.ts`、`src/credentials.ts`：settings/credentials Remote surface；
- 基线 `dsh-v0.1.1-rc.2:packages/host/apiproxy/src/api/rpc-map.ts`、`rpc.ts`：旧 endpoint map 和四象限 RPC envelope。

本文件是源代码审计和迁移清单，不包含实现修改；后续实现应以 RC tag 的 generated Remote descriptor 和上述类型定义为准。
