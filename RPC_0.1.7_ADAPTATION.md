# DSH `0.1.7-rc.2` Remote RPC 适配审计

目标：`dsh-v0.1.7-rc.2@477b4f420553e8a52c2fbccc464d7561b239c443`。
比较基线：已适配的 `dsh-v0.1.7-rc.1@46a7f68b0922371ce7144b668b90e377d8e799f4`；
更早的 carrier 迁移基线是 `dsh-v0.1.5-rc.2@fb2c4b9e698e30edb738bca4cf0618587db7d203`。
审计以 `deepseek-harness/` 中的 tag 源码为准，没有切换嵌套 checkout。

## 结论

RC.2 没有继续改变 RC.1 引入的 Remote carrier：Connection multipart 二进制响应、Client
到 Host 的流上行帧和 Gateway 对应实现未变化。现有 carrier 适配继续有效。

RC.2 有业务 RPC 合约破坏性变更：5 个既有方法的参数签名改变；`agentPresets/list`
删除响应字段；`session/modelCatalog.routableProviders` 的含义收窄。新功能 RPC 和事件是
增量能力，不构成旧调用的 wire 不兼容。

## RC.1 → RC.2 破坏性与语义变化

| Remote surface | RC.2 变化 | dsh-ide 影响 |
| --- | --- | --- |
| `account/getProfile`、`getBalance`、`signOut` | 新增必填 `AccountClientMetadata` 参数 | `dsh.manageAccount` 为每次调用传入扩展版本、VS Code 语言与本地 UTC 偏移。 |
| `account/startSignIn` | 第一个参数由 `locale: string` 改为 `client: AccountClientMetadata` | 浏览器登录传入完整客户端元数据，并使用 Runtime loopback origin 作为回调来源。 |
| `workspace/initializeDefault` | 从 `(request, signal)` 改成 `(signal)`；移除客户端传目录名和标题的 DTO | 无 VS Code 文件夹且本地 Workspace/Session/archive 均为空时，显式新建 Session 会以无参数调用；首用目录由 Host 固定命名。 |
| `agentPresets/list` | roster 移除 `modeSelectionEnabled` | 本地接收类型仍把该字段设为可选；RC.2 缺省时保留 IDE 自己的选择器。是否要跟随上游统一的工作模式设置仍需产品决策。 |
| `session/modelCatalog` | `routableProviders` 现在只含至少有一个可用模型的 provider | wire 字段不变；现有 `routable` 派生读取该数组，语义与 RC.2 一致。空模型目录的 provider 会显示为不可路由。 |
| `session/selectModel` | 参数与返回结构不变；现在先校验模型可用性，并不等待默认模型持久化完成 | wire 兼容；调用方不能把 RPC 返回当作默认设置已落盘的确认。 |

RPC 方法签名差异集中在 Account 与 Workspace Controller。RC.2 的 `agentPresets/list`
DTO 删除和模型目录语义变化另列在表中，避免把类型兼容与行为兼容混为一谈。

## RC.2 新增 Remote 能力

- Account 新增 `getUnnotifiedBonuses`、`ackBonusNotified`、`hasRunningAccountTasks`、`watchExpiry`。
- Session 新增 `initializeDefaultModel`；模型目录还增加 provider 凭据/模型不可用的 Remote error code。
- 默认 Client Remote assembly 新挂载 Schedule namespace：`schedule/list`、`catalog`、`update`、`delete`、`history`。
- Workspace controller 新增 `unarchiveSession`、`pinSession`、`unpinSession`，`workspace/follow` baseline 与增量增加全量 `pinnedSessionIds`。
- 转发事件新增 `deepseek-account/session-expired`、`deepseek-account/model-sign-in-required`、
  `credentials/record-updated`、`schedule/changed`。本地 allowlist 已加入；账号事件刷新模型目录，
  Schedule 事件刷新当前会话的活动提醒列表及跨会话 catalog。
- Workspace files 的 `list` 扩展为跟随并校验 symlink/junction 目标，RPC 签名未变。

## 本地适配状态

- 目标 Runtime 版本、`src/remote/contracts.ts` wire-contract pin 和 README 已更新至 RC.2。
- multipart unary、双向 stream 与活动会话归档确认继续沿用 RC.1 实现。
- 事件 allowlist 已加入 RC.2 四个 emit 事件；credential record、账号过期和账号模型登录要求事件会刷新模型目录，Schedule 事件会刷新当前会话提醒和跨会话 catalog。
- Activity Dock 通过 `schedule/list` 读取当前会话的持久活动提醒，展示 RC.2 的 `daily/weekly/cron` 规则和标题；旧 Runtime 缺少该 endpoint 时回退到 Session Schedule 投影。RC.2 的 `schedule/history` 支持游标分页，`update` 用完整观察记录做 CAS，`delete` 会同时删除该任务的投递历史。
- Activity Dock 通过无参数 `schedule/catalog` 展示所有会话的活动与已结束提醒、原会话 ID 和最近投递；该视图只读，编辑/移除仍使用当前会话绑定的管理面板。
- 会话管理菜单接入 `workspace/pinSession|unpinSession|unarchiveSession` 与 `workspace/follow` pin 集；固定项在会话切换器及会话列表中前置。Archive/Pin RPC 响应只在对应流状态未更新时应用，避免旧完整快照覆盖较新的事件。
- 无 VS Code 文件夹时，显式新建 Session 会复用/选择现有 DSH Workspace；只有本地 Workspace、可见 Session 和 archived id 清单均为空时，才调用无参数 `workspace/initializeDefault` 使用 Host 固定 Documents 目录。之后可直接以该 Workspace 创建和使用 Session。
- Preset roster 对 `modeSelectionEnabled` 缺失保持兼容；RC.1 的显式 `false` 仍会被尊重。
- `session/modelCatalog` 继续按 `routableProviders` 派生路由状态，适配 RC.2 的非空模型目录语义。
- `dsh.manageAccount` 已接入 Account `getState/getProfile/getBalance/getUnnotifiedBonuses/ackBonusNotified/startSignIn/cancelSignIn/signOut/hasRunningAccountTasks/watch` 与 `watchExpiry`；提示显示后确认赠金，登录成功后尝试初始化默认模型，退出登录前向用户说明受影响的运行中账号任务。浏览器登录只使用可从浏览器访问的 localhost HTTP Runtime 来源。
- Schedule Activity Dock
  已接入当前会话 `list/history/update/delete` 与 `schedule/changed`。update UI 可修改名称、内容和
  timing rule（指定时间、固定间隔、每日、每周、Cron）；跨会话 `catalog` 以只读列表接入。提醒由上游
  `schedule_create` agent tool 创建，不是 Remote create endpoint。所有写请求按 RC.2 的 session
  绑定和完整 `expected` 记录发送。

## 验证边界与待办

- 遵守仓库规则，不新增或运行单元测试；可以运行 TypeScript 检查和 `git diff --check`。
- 未对真实 `0.1.7-rc.2` Runtime 做端到端联调。`scripts/verify-remote-runtime.mjs` 仍使用
  `0.1.5-rc.2` 与 V3 fixture，不覆盖 multipart、双向流、V4 存储或 RC.2 业务 RPC。
- TODO 中 Schedule、Account 与工作区首用初始化均已标记接入；仍未实现 Remote Workspace Files
  消费面，也未对真实 RC.2 Runtime 执行业务 RPC smoke。
