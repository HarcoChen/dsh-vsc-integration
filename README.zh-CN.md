# Deepseek-Harness VSCode Integration Community Edition

<p align="center">
  <img src="resources/dsh.png" alt="DSH" width="128">
</p>

面向 DeepSeek Harness 社区版 VS Code Extension，支持四种模式切换、Trace Vscode内查看、无npm环境自动下载runtime等特色功能

[English](README.md) | **简体中文**

> [!WARNING]
> 本项目为独立社区项目，并非 DeepSeek 官方项目，也未获得 DeepSeek 官方维护。
> 需要任何信息或帮助、功能建议，欢迎留下issues！


> [!NOTE]
>
> - 快速查看Key余额
> - 内建Trace支持
> - DSH不存在时，自动下载（通过CNB分发Runtime）
> - 全面l10n支持

功能更全面：会话状态、IDE 上下文、Runtime 活动、审批、Trace、文件变更均集成在插件内。

使用更方便：完全不了解npm也没关系！
## 功能架构

聊天界面使用 React Webview 和类型化全量状态桥。Extension Host 负责 VS Code API、Runtime RPC、凭据、安全 Markdown 和动作校验。

## 安装

### 从Extension Market

[🔗安装链接](https://marketplace.visualstudio.com/items?itemName=HarcoChen.dsh-vsc-integration)

### 从Github Release

从 [GitHub Releases](https://github.com/HarcoChen/dsh-vsc-integration/releases) 下载 `.vsix`，然后运行 `Extensions: Install from VSIX...`。

### 从源码构建

```bash
npm install
npm run check
npm run package
```

通过 `Extensions: Install from VSIX...` 安装生成的 `.vsix` 文件。

## 详细说明

如果 dsh 报告 API Key 缺失或无效，点击聊天头部的 `Key`，或运行 `DSH: Configure API Key`。密钥会交给 dsh 的凭据服务，并以 VS Code SecretStorage 加密保存一份给余额指示器使用；不会写入 prompt、扩展状态或日志。

聊天菜单和命令面板中的 `DSH: Manage Providers` 可查看 Provider 是否启用、配置及其凭据来源，设置或移除 API Key，并打开 Harness 官方配置文件进行高级编辑。`DSH: Manage Agent Presets` 可列出 system/user Preset、显示损坏原因、打开只读 composition 快照，并通过 Harness 提供的操作复制、编辑、删除或设为默认 Preset。DSH Workspace 会根据目录自动发现；`DSH: Manage Workspaces` 支持重命名和移除分组，并调整 Workspace 与组内 Session 的显示顺序。移除分组不会删除目录或 Session 日志。

多个 VS Code 窗口会优先复用同一个本地 Harness Runtime。扩展启动的 Runtime 使用进程锁公布其随机 loopback 端口，后续窗口经 `host.describe` 验证后连接，避免多个写进程竞争同一 Session 存储。

### 对话大纲与导航 API

DSH 侧栏提供原生“对话大纲” TreeView：当前会话的用户消息会按顺序列出，点击条目即可滚动到对应消息。其他扩展也可以通过导出的 API 注册自己的导航节点：

```ts
const registration = api.registerConversationNavigation([
    { seq: 42, label: "检查 PPO 实现", detail: "训练配置" },
]);
context.subscriptions.push(registration);
```

### 自定义 Agent 状态文案

默认会在每轮流式输出开始时从 `dsh.agentStatusLabels` 随机选一句，并在这一轮保持不变。默认候选围绕“大肥鱼”梗，可直接在设置中改成自己的文案；设置 `dsh.agentStatusLabel` 则可改为始终显示固定文案。

### 插件 API：Agent Status Label

其他 VS Code 扩展可通过 DSH 扩展导出的 API 自定义流式 Agent 状态文案。注册项按后注册优先，释放返回的 `Disposable` 后会恢复此前的文案：

```ts
const dsh = vscode.extensions.getExtension<import("dsh-vsc-integration").DshExtensionApi>(
    "harcochen.dsh-vsc-integration",
);
const api = await dsh?.activate();
context.subscriptions.push(
    api?.registerAgentStatusPresentation({ label: "🐋 深潜中" }),
);
```

## 开发

```bash
npm install
npm run check      # TypeScript 检查
npm run compile    # 构建到 dist/
npm run package    # 编译 + vsce 打包
```

建议使用 VS Code.

## 更多信息

- [更新日志](CHANGELOG.md)
- [产品 TODO](TODO.md)
- [第三方资产说明](THIRD_PARTY_NOTICES.md)

## 致谢

感谢 [dsh-reasoning-effort](https://github.com/HanaAyane/dsh-reasoning-effort) 提供推理强度控件的 chibi runner 跑步 sprite 参考与素材。对话大纲则受到 `dsh-milestone` 项目启发，将 Hub 风格的里程碑导航转化为 VS Code 原生 TreeView。

## 许可证

[MIT](LICENSE)
