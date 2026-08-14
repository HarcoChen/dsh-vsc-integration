# 基于现有 RPC 的 Harness 特色集成清单

更新时间：2026-08-14。

本文严格以 DeepSeek Harness 当前公开的 Web RPC、WebSocket frame 和 session projection 为边界。不为 Harness 内部 subsystem 猜测接口，也不把尚未暴露的能力列入扩展开发路线。

客户端 UI 的复用与 VS Code 边界见 [DSH IDE 前端架构与 Harness UI 复用](FRONTEND_ARCHITECTURE.md)。协议范围由本文约束，展示层优先采用仓库内 Harness client packages。

## 可依赖的公开边界

- Unary RPC：`session.*`、`subagent.*`、`host.*`、`workspace.*`、`skill.list`、`agentPreset.*`、`goal.*`、`settings.*`、`credentials.*`、`llm.*`。
- Session mux：`session/event`、`session/subscribed`、approval/question requested/resolved、`session/queue`、`session/jobs`、`session/projection`、`stream/error`。
- Host stream：session added/removed/status、agent error、workspace changed/removed/order/archive，以及 allowlist 内的 remote event。
- Answerable frame：使用原始 `rpcId` 调用 `/api/respond`。

`host.describe` 当前只返回 version、cwd、默认 provider/model、attached session 数和 `canOpenPath`，不应把它描述成完整 capability manifest。具体能力以方法是否可调用、projection key 是否存在及 stream frame 为准。

## Harness 特色能力及对应 UI

| 现有能力 | Harness 特殊语义 | VS Code 集成形态 | 使用的公开协议 | 优先级 |
| --- | --- | --- | --- | --- |
| 事件溯源会话 | session 不是消息数组；原始事件带单调 seq，可见 surface 可能 append/replace，并保留 `sourceEventSeqs` | Event Store + Surface Projector；聊天可回溯到 Trace 原始事件 | `session.history`、`session/event`、`session/subscribed` | P0 基础 |
| 通用 projection | host 直接提供日志派生状态的完整当前值；插件可增加未知 key | 每 session 的 generic projection store，higher-seq-wins；已知 key 插入专用组件 | history 的 projections block、`session/projection` | P0 基础 |
| 可恢复交互 | pending approval/question 在 mux 重连时重放，回答必须复用其 `rpcId` | 原位审批卡、结构化问题卡；resolved 后不可重复提交 | requested/resolved frames、`/api/respond` | P0 |
| 权威 Queue | queue/steering/context 是完整瞬时快照，不是持久聊天消息 | Queue Dock：编辑、删除、steer；收到新快照后收敛本地 optimistic state | `session/queue`、`session.updateQueue` | P0 |
| Session 生命周期 | cold session 与 attached/running 不同；blank、parent、origin、cwd、preset 都是独立字段 | Session 列表、多 tab、running/blank 标记、parent 导航、断线恢复 | `session.list/search/create/history/rename/fork/cancel` + host stream | P0 |
| Tool presentation | host 可随 event 附带非持久 `ToolEventView`，缺失时客户端必须通用降级 | 专用工具卡优先使用 view；否则安全 JSON renderer | history entry / `session/event.view` | P0 |
| Goal | Goal 有完整生命周期，并有专门 mutation RPC | 顶部 Goal HUD：创建、编辑、暂停、恢复、完成、清除 | `goal.*` + `goal` projection | P1 招牌 |
| 可续跑 Subagent | 子 agent 有独立 history、provider/session 关系，可继续 prompt 或 interrupt | Agent Tree：状态、历史、打开子会话、follow-up、interrupt | `subagent.list/history/prompt/interrupt` | P1 招牌 |
| Background Job 快照 | jobs 是 process-local 完整快照；空数组也是有意义的状态迁移 | 只读 Runtime Activity Center：owner、kind、状态、完成/失败提示 | `session/jobs` | P1 招牌 |
| Workspace registry | Harness workspace 是持久注册表，不等同于当前 VS Code multi-root workspace | Workspace Picker：创建、重命名、排序、归档 session；明确 cwd 映射 | `workspace.*` + workspace host frames | P1 |
| Agent Preset | preset 是 agent 组合，不只是模型别名 | 新会话/标题栏 preset selector；读取、复制、打开定义、移除 | `agentPreset.*` | P1 |
| Skills | Harness 返回 runtime 实际发现的 skill，而不是客户端扫描文件 | Skills Browser：名称、描述、来源和可调用性；不自行拼接 skill 内容 | `skill.list` | P1 |
| 模型与推理强度 | session model catalog 包含 routable、provider 分组、reasoning effort 和局部失败 | Model Picker：当前 route、effort、不可路由和 provider failure | `session.models/selectModel`、`llm.providers/models/discoverModels` | P1 |
| 图片附件 | host 负责把浏览器提交的图片转成持久 reference，限制由 projection 告知 | 图片预览、数量/大小预检、上传失败恢复 | `session.attachment`、`session.prompt`、`imageLimits` projection | P1 |
| Settings/Credentials | settings 是 schema 驱动；credential 只能 describe/set/unset，值不可回读 | 设置表单和秘密输入框；credential 永不进入日志或 webview 持久状态 | `settings.*`、`credentials.*` | P1 |
| Host 文件选择 | 路径由 host 返回绝对值，客户端不自行 join；native/browse 部署能力可能不同 | 远程友好的目录浏览器，面包屑、新建目录、可选 openPath | `host.pickDirectory/listDirectory/createDirectory/openPath` | P1 |
| Trace | event seq、tool view、turn/step/tool 事件天然适合完整轨迹视图 | 独立 Trace Editor，并与聊天、session、tool card 双向定位 | history + mux event | P1 招牌 |

## 五个最有辨识度的入口

1. **Trace Editor**：利用完整 event log，而不是从渲染后的聊天反推执行过程。
2. **Goal HUD**：直接接 `goal.*` 和 projection，让长任务状态常驻可见。
3. **Agent Tree**：直接接 `subagent.*`，支持查看、继续和 interrupt。
4. **Runtime Activity Center**：消费 `session/jobs`、queue、approval 和 question 快照；Job 暂时只读。
5. **Context/Projection Inspector**：统一展示 token、pressure、breakdown、plan、permissions 等已出现的 projection，也能诊断未知 key。

## 客户端实现约束

1. **三层状态分离**：原始 event log、可见 conversation surface、projection store 分开保存。
2. **higher-seq-wins**：history tail 提供 projection baseline，live projection 只在 seq 更高时覆盖。
3. **重连必须重新基线化**：重新打开 mux，并重新拉取 history；当前 v1 的 `since` 参数被忽略。
4. **完整快照直接替换**：queue 和 jobs frame 不是增量 patch，收到后替换该 session 的对应集合。
5. **Tool view 不能持久依赖**：它是 host 在传输时计算的展示建议，缺失时仍须正确渲染事件。
6. **cold 不等于 idle**：session list 的 `running: false` 可能只是 session 未 attach，不能推断历史任务失败或完成。
7. **Job 只做协议允许的动作**：当前只有快照 frame，不提供公开 stop/read RPC，因此 UI 不放不可实现的按钮。
8. **未知 projection 不丢弃**：保存 key、value、seq，并在诊断视图展示；只有已知 schema 才做业务控件。
9. **凭据值不回显**：只允许 set/unset，不进入 store、webview state、日志或诊断包。
10. **不伪造 capability**：`host.describe` 不是方法清单；可选 host 方法失败时做明确降级。
11. **不重复建设 Web UI**：browser-safe 的 Harness client 逻辑和组件优先复用；Extension Host 只保留 bridge 与 VS Code 特有能力。

## 当前明确不做

以下能力即使 Harness 内部存在，只要当前 Web RPC map 没有公开控制面，就不进入本扩展实现清单：

- command catalog/execute 与 runtime slash command 管理；`/ide` 仅是本地 UI 快捷入口；
- schedule/reminder 管理；
- MCP 和 Harness plugin 管理；
- feedback 提交；
- spill artifact 专用读取；
- Harness PTY attach/read/stop；
- Harness LSP、Code Runtime、Workflow 的专用控制面；
- job stop/readOutput；
- permission preset、plan mode、manual compaction 的直接 mutation 控件；
- checkpoint/revert 和 runtime-owned file diff。

这些内容可以在 Trace 中以已经到达的普通 session event 展示，但不据此构造新的操作入口。

## 实施顺序

```text
RPC client + Event Store + Surface Fold + Projection Store
                           ↓
Streaming Chat + Approval/Question + Queue + Session lifecycle
                           ↓
React Webview + Harness client adapter + UI migration
                           ↓
Goal HUD + Agent Tree + Read-only Job Center
                           ↓
Models + Presets + Skills + Workspaces + Attachments
                           ↓
Trace Editor + Projection Inspector + Settings/Credentials
```

## 参考

- [Web RPC method map](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/apiproxy/src/api/rpc-map.ts)
- [Event stream contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/apiproxy/src/api/events.ts)
- [Session API](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/apiproxy/src/api/sessions.ts)
- [Host API](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/apiproxy/src/api/host.ts)
- [Trace 集成设计](TRACE_INTEGRATION.md)
