# 首批 DSH 工作流功能与验收

日期：2026-10-10。分支：`codex/dsh-workflow-features`。默认 Runtime 和完整 Remote contract pin 保持 `0.2.0-rc.2`；此轮单独验证 alpha.2 的投影、迁移、工作目录、终端与插件路径。

## 已实现

| 入口 | 行为 | 边界 |
| --- | --- | --- |
| `DSH: 打开 Runtime 终端` / 聊天菜单 | 创建或附着 Host 用户 PTY、串行输入和 resize、控制权判断、屏幕恢复、关闭清理及失败重试 | 切换会话保留终端；Host 重启不恢复进程；已有终端保留自身目录；外部 Runtime 仍由其所有者管理 |
| `DSH: 安装或卸载 Runtime 插件` / Settings | 官方 inspect/install/cancel/wait/remove，来源和版本确认、构建脚本批准、进度与日志、应用或需重启结果 | 包路径位于 Host；社区目录搜索未实现；`waitForInstall` 只查询仍在进行的安装，不能保证完成后还能取回结果 |
| `DSH: 附加当前文件的问题` / 附件菜单 / `@` 候选 | 用户选择诊断后附加一次，包含位置、严重性、来源和诊断代码 | 手写 `@diagnostics` 附加当前文件诊断；不自动读取其他文件；沿用附件大小与截断限制 |
| `DSH: 打开会话中心` / 聊天菜单 | 实时显示 DSH Workspace 归属，优先排列已观察到的审批、问题、错误和运行中会话 | 只展示已有 catalog 的观察结果；独立多会话 Tab 待实现 |
| 当前目录与历史文件导航 | 显示有效目录，新操作与历史操作分别按自己的目录解析；同名文件的 Diff 历史按绝对路径区分 | 原始项目和权限根不变；一轮中切目录时关闭整轮恢复，保留逐次工具 Diff；缓存提示不用于决定操作目录 |
| 旧格式 Session | 缓存投影与有序投影分开，保留 Host `formatStatus`，新版 fork 可拒绝隐式迁移 | 由 Host 完成迁移；客户端不从历史快照推断迁移已完成，也不生成缓存 seq |

真实 Runtime 联调还发现旧 Diff 读取路径依赖 Client presentation，而公开 Remote 事件保留的是工具参数与结果 metadata。现已按官方 `write`/`edit` 契约读取拟议改动和实际 hunks；新文件使用成功结果的 canonical path 与原始写入内容。已执行的编辑缺少实际 metadata 时不把拟议片段当作执行结果。

## 验证结果

- `npm run check`、`npm run compile`、既有 50 项测试通过；未创建或添加单元测试。
- `node scripts/verify-review-stream.mjs`：既有历史/流式切片回归通过。
- `node scripts/verify-package.mjs`：Jev 必需文件与 VSIX 清单检查通过。
- 真实 `0.2.0-rc.2 --workflow-controls`：终端创建、保留、输入、resize、重附着、画面恢复与关闭通过；本地插件检查/安装/卸载、安装中的取消、配置回滚与等待者结算通过。
- 真实 `0.2.1-alpha.2 --workflow-controls --migration-home ...`：上述路径通过；从 `0.1.5-rc.2` 通过公开 RPC 生成的真实旧会话能先显示无序迁移提示，再迁移为有序投影。工作目录切换保留原始项目身份；两个目录中的 `same.txt` 分别写入成功，目录回放与 Diff hunk 历史互不混用。
- 真实 RC.2 `--with-team-bundle --timed-questions --feature-controls`：插件开关、Jobs 游标重连/取消、前台/延迟问答、Team 投影/成员历史/跟进回归通过。
- 编译后的 Webview 在 360 px 与 1100 px 下通过新增菜单、Settings 安装入口、Problems 选择意图、草稿保留和历史文件链接动作检查；无页面异常或横向页面溢出。该检查使用临时浏览器和模拟 VS Code bridge，不代表真实 Extension Host 已完成人工验收。

Runtime smoke 使用独立 `DSH_HOME`、临时 DSH Workspace、回环模拟模型和临时插件；不读取用户会话、账号或模型凭据，不发真实模型请求。alpha.2 默认 Web 已包含 Schedule，RC.2 默认 Web 不包含；脚本按版本核对此差异。alpha.2 偶有 PTY 清理拒绝，Host 保留终端身份，重试关闭通过；UI 显示失败并保留重试入口。

## 复现命令

使用安装在临时目录中的精确版本，不替换本机 CLI：

```sh
npm run check
npm run compile
node --test test/*.test.js
node scripts/verify-review-stream.mjs
node scripts/verify-package.mjs
node scripts/verify-remote-runtime.mjs --launcher /absolute/path/to/rc2/dsh --workflow-controls
node scripts/verify-remote-runtime.mjs --launcher /absolute/path/to/rc2/dsh --with-team-bundle --timed-questions --feature-controls
node scripts/verify-remote-runtime.mjs --launcher /absolute/path/to/legacy/dsh --expect-version 0.1.5-rc.2 --seed-only --keep
node scripts/verify-remote-runtime.mjs --launcher /absolute/path/to/alpha2/dsh --expect-version 0.2.1-alpha.2 --workflow-controls --migration-home /isolated/legacy/smoke/home
```

`--migration-home` 必须指向 smoke 自己生成且带 `.dsh-ide-smoke-fixture` 标记的目录。fixture 复制后运行迁移，原 fixture 保留。`--seed-only` 用于旧 provider 的 Chat Completions 模拟接口；正常 RC.2/alpha.2 使用 Messages 模拟接口。

## Review 场景与后续

在真实 VS Code 中验证：当前会话打开用户终端，输入/粘贴和调整面板，切会话后继续使用，断线后重新附着，关闭后不留下进程；在另一客户端抢占控制后应进入只读，再通过重新附着取得控制。检查安装取消、构建脚本批准、需要重启的结果和外部 Runtime 的重启提示。确认 Problems 附件内容、移除和发送后消费；打开会话中心时触发另一会话的审批并检查实时排序。

Windows PTY、远端 Host、第三方插件与实际构建脚本批准尚需人工验收。此轮未完成全量 alpha.2 Remote/Jev hooks 审计，未升级默认版本；Worktree 创建/setup/审查/清理、持久化恢复和交付证据卡见 [TODO](./TODO.md)。
