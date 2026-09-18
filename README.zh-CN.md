<p align="center">
  <img src="resources/dsh.png" alt="DSH IDE" width="128">
</p>

<h1 align="center">DeepSeek Harness for VS Code</h1>

<p align="center">
  将 DeepSeek Harness（DSH）带进 VS Code：结合IDE的上下文完成任务，查看原生Diff，通过 Trace 和用量面板了解Agent的执行过程。
</p>

<p align="center">
  <a href="README.md">English</a> | <strong>简体中文</strong>
</p>

<p align="center">
  <a href="https://open-vsx.org/extension/harcochen/dsh-vsc-integration"><img src="https://img.shields.io/open-vsx/dt/harcochen/dsh-vsc-integration?style=flat-square&label=Open%20VSX%20%E4%B8%8B%E8%BD%BD%E9%87%8F" alt="Open VSX 下载量"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=HarcoChen.dsh-vsc-integration"><img src="https://vsmarketplacebadges.dev/installs-short/HarcoChen.dsh-vsc-integration.svg?style=flat-square" alt="VS Code Marketplace installs"></a>
  <a href="https://github.com/HarcoChen/dsh-vsc-integration/stargazers"><img src="https://img.shields.io/github/stars/HarcoChen/dsh-vsc-integration?style=flat-square" alt="GitHub Stars"></a>
  <a href="https://github.com/HarcoChen/dsh-vsc-integration/blob/main/LICENSE"><img src="https://img.shields.io/github/license/HarcoChen/dsh-vsc-integration?style=flat-square" alt="许可证"></a>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=HarcoChen.dsh-vsc-integration"><strong>安装到 VS Code</strong></a> ·
  <a href="https://open-vsx.org/extension/harcochen/dsh-vsc-integration">Open VSX</a> ·
  <a href="https://github.com/HarcoChen/dsh-vsc-integration/releases">下载 VSIX</a> ·
  <a href="CHANGELOG.md">更新日志</a>
</p>

<p align="center">
  <em>独立社区项目，欢迎提 <a href="https://github.com/HarcoChen/dsh-vsc-integration/issues">issue</a>。</em>
</p>

<p align="center">
  JetBrains IDE（IDEA、PyCharm 等）版本请见 <a href="https://github.com/HarcoChen/dsh-intellij-integration">dsh-intellij-integration</a>。
</p>

<p align="center">
  <img src="public/scene-intro.gif" alt="DSH IDE 工作流演示" width="100%">
</p>

## 为什么选择 DSH？

- **看清代码改动**：在 VS Code 原生并排 Diff 中审查工具编辑，非 Git 仓库也能使用。
- **在执行前做决定**：审批卡展示命令与目标文件，受支持的文件写入可预览拟议改动。
- **带着上下文开始任务**：引用文件、选区、Git Diff 或暂停时的调试状态，减少来回复制粘贴。
- **随时接着做**：恢复持久会话，在活动面板查看工具执行、子代理、Todo 与 Token 用量。

## 快速开始

需要 **VS Code 1.106.0 或更高版本**，以及已配置的 DSH 模型服务与凭据。

1. **安装扩展**：选择上方 Marketplace 或 Open VSX 入口，也可以在扩展面板搜索 `harcochen.dsh-vsc-integration`。
2. **打开聊天**：打开项目文件夹并确认信任，在命令面板运行 `DSH: 打开聊天`（`DSH: Open Chat`）。扩展会自动启动或连接 Runtime；缺少可用环境时，默认尝试下载托管 Runtime。
3. **完成首次配置**：通过 `DSH: 配置 API Key`（`DSH: Configure API Key`）设置 DeepSeek 凭据。其他 Provider 可在 `DSH: 在浏览器中打开 dsh Web UI` 中配置。选择或注册 DSH Workspace，再选择模型。
4. **开始一个任务**：输入 `@` 引用文件，或右键选区选择 DSH 操作。查看执行过程，在需要审批时确认操作，并通过工具卡打开 Diff 审查结果。

### 从这些任务开始

| 你想做什么 | 可以这样开始 |
| --- | --- |
| 读懂一段代码 | 选中代码并右键使用 DSH 解释：“说明这段代码的执行流程和边界条件。” |
| 审查改动 | 对 Git Diff 使用 DSH 评审：“检查这些改动是否引入回归，并标出相关位置。” |
| 排查断点 | 调试暂停时运行 `DSH: Explain Current Debug State`，附加调用栈和局部变量等上下文。 |
| 继续之前的工作 | 切换到历史会话，通过对话大纲定位之前的讨论。 |

## 核心功能

### 逐次编辑皆有原生 Diff，无需 Git

`write` / `edit` 类工具调用完成后，打开目标文件即可查看 VS Code 原生并排 Diff。底层通过 Session 日志倒放 Hunks 重建历史，即使在非 Git 仓库或被 Git ignore 的文件中也能正常工作。

![原生并排 Diff 预览](public/assets/diff.png)

### 批准前预览

审批卡片会展示真实的命令行、工作目录以及写入的目标文件，对于受支持的文件写入工具，还可以在批准前打开原生 Diff，检查拟议改动。

若目标文件在编辑器中仍有未保存改动，审批不会被放行：卡片会列出这些文件并保持待处理，保存或还原后即可重新批准。

### 斜杠命令

斜杠菜单会动态拉取当前会话 Runtime 注册的命令（`/plan`、`/compact`、`/goal` 等），并与扩展自有的 IDE 命令合并展示。

![实时下拉斜杠命令](public/assets/slash.png)

### 编辑器与 Git 上下文

- 右键菜单直接对当前文件、选区或 Git Diff 执行解释、修复、评审或文档生成。
- 资源管理器中右键 `Ask about resource` 即可提问。
- `@` 菜单补全项目文件及历史 Session。
- `DSH: Capture AppShot`（仅 macOS）捕获窗口截图并作为草稿插入对话。

### 会话、Trace 与活动面板

侧栏提供原生对话大纲树视图；Trace、Token 用量、Todo 清单与子代理统一归集在活动面板。UI 适配 VS Code 深浅主题。

运行 `DSH: 在编辑器标签页中打开聊天`（`DSH: Open Chat in Editor Tab`）可以把同一份对话镜像到编辑器标签页，让聊天紧挨着正在改的文件。两个界面共用一个会话与一条流，切换不会重开或分叉。

![Trace 和活动面板](public/assets/Trace.png)

### 自主调试（默认关闭）

开启 `dsh.autonomousDebugging` 后，扩展会在本窗口内起一个只监听回环地址的 MCP 端点，Agent 由此操作 VS Code 调试器：`debug_start` 启动工作区里已有的 launch 配置，`debug_breakpoint` 增加、删除、列出断点，`debug_control` 继续、单步并等待下一次暂停，`debug_context` 读取暂停时的调用栈、变量与源码。名字疑似密钥的变量在离开窗口前会替换为 `[redacted by dsh-ide]`。端点仅绑定 `127.0.0.1`，校验 `Host` 头与每次启动单独的令牌，也不允许模型自造 launch 配置。该能力只对本窗口自行启动的 Runtime 生效；切换设置后需重启 Runtime，扩展会在设置变更时提示。

### 凭据与余额

底部快速查看当前余额，支持峰谷定价显示，支持低余额采用醒目颜色警示。

![余额指示器](public/assets/balance.png)

## 常见问题

**需要手动安装 DSH 吗？** 通常不需要。扩展会寻找可用的本地环境，并在需要时尝试下载托管 Runtime。首次下载需要联网；`dsh.installWhenMissing` 可控制自动安装。

**可以连接已有 Runtime 吗？** 可以，将 `dsh.serverUrl` 设置为正在运行的 `dsh web` 地址；如果地址中没有 Token，再将启动 Token 填入 `dsh.serverToken`。本扩展接受所有不低于 `dsh 0.1.5-rc.1` 的合法 SemVer，包括更新的预发布版本及正式版；默认下载及升级目标仍是 RC.1，继续使用 V3 历史和显式订阅的 Assistant 流。会话迁移保留原始日志，但旧 Runtime 无法读取迁移后的 V3 文件。

源码审计覆盖上游 master `c291e7961a` 和发布标签 `dsh-v0.1.5-rc.2`（`fb2c4b9e698e30edb738bca4cf0618587db7d203`）。消息反馈保留正负评价的分类，包括编辑及版本冲突返回值。Runtime 提供 master 新增的可选 `modeSelectionEnabled` 策略时，关闭开关会隐藏 IDE 模式选项、清除暂存模式，并在空会话首次发送前恢复有效默认模式；已开始的会话保留原有组合。Skill 补全悬浮提示展示 Runtime 提供的 `SKILL.md` 路径；缺少可选字段时保留 RC.2 行为。版本是否可用按最低版本判断，不受此次源码审计版本限制。

本次检查时，npm 的 `latest` 仍指向 RC.1，RC.2 发布在 `next` 标签；扩展默认仍请求 `0.1.5-rc.1`，本机已有兼容的 RC.2 时直接复用，不降级。

默认 `dsh.command: "auto"` 依次探测 PATH 和 npm 全局目录中的 `dsh --version`。本机 CLI 兼容就直接调用；不兼容则先提示当前版本、目标版本和安装位置，用户同意后才将已确认的旧版 npm 全局安装升级到 `dsh.runtimeVersion`，随后重新探测同一 CLI。用户拒绝或关闭提示后，才依次回退固定版本的 pnpm、npx、CNB 托管 Runtime；没有本机 CLI 时也走这条回退路径。升级失败可选择回退或取消启动。版本未知或不属于当前 npm 全局目录的旧安装只提供手动升级指引。诊断命令只读，不提示或执行升级。显式本机路径遵循相同升级流程，显式 pnpm/npx 保留包管理器启动。若之前保存了 `dsh.command: "pnpm"`，需重置或改为 `auto` 才会启用本机优先。

默认应用参数为 `web --no-open`，没有保存参数覆盖时会自动为 pnpm/npx 补齐启动前缀。已有包管理器参数配置保留，auto 选中本机 CLI 时移除包管理器及包名前缀。共享 Runtime 的发现仍先于新启动器选择，回退会复用健康的 Runtime，而不是再起一个。

本次适配检查时，CNB 独立 Runtime 镜像的 `0.1.5-rc.2` 仍返回 404；镜像发布前可使用兼容的本机 CLI、固定版本的 pnpm/npx 回退或已有实例，独立 Runtime 下载路径尚未验证通过。编译后可执行 `node scripts/verify-runtime-discovery.mjs`，在隔离 POSIX CLI 环境中验证选择及实际启动参数，不下载包、不请求模型。

**支持多根工作区吗？** DSH 支持多个彼此独立的 Workspace，但每个 Session 只有一个工作目录（`cwd`）。VS Code 多根工作区启动 Runtime 时使用第一个 workspace folder；如果不同根目录需要不同工作目录，请分别建立 DSH Workspace 或 Session。

**会自动识别密钥或个人信息吗？** 不会。上下文目前只根据用户主动选择的文件、选区和附件计算大小与截断；不会把文件内容交给额外的秘密/个人信息分类器。

**启动失败怎么办？** 在命令面板运行 `DSH: Diagnose Environment` 查看诊断，再用 `DSH: Show dsh Runtime Logs` 查看日志。提交 [issue](https://github.com/HarcoChen/dsh-vsc-integration/issues) 时请附上扩展版本、操作系统和脱敏后的错误信息。

**支持中文吗？** 支持。命令、聊天、活动面板和 Trace 界面会跟随 VS Code 显示语言，提供英文与简体中文。

## 架构与运行机制

扩展通过 RC Remote RPC 连接 Runtime，使用 HTTP 调用和多路复用 WebSocket 获取实时会话更新。

多个 VS Code 窗口通过 Runtime 广告互相发现，再回退到端口 `3080` 及配置的 `dsh.serverPort`。每个候选都先做健康检查：认证及 `session/list` 调用成功才算可用，广告中低于最低要求的版本直接排除。外部服务不会归本扩展所有，断开连接不会停止它。需要认证但缺少凭据时，会提示将 `dsh.serverUrl` 设为完整启动 URL（包含 token）。

广告只是发现用的元数据，任何字段都不授予也不否决启动权限。广告缺失、过期或无法读取都不会阻塞启动，最坏情况只是多做一次失败的健康探测，然后本窗口启动自己的 Runtime。

每个窗口只发布自己那一份 `<ownerId>.json`，位于系统临时目录下的 `dsh-runtime-advertisements-<user>`，记录端点、启动 URL、版本、PID 和 composition hash。窗口只写自己的文件，从不回收别人的；旧的 `dsh-runtime.lock` 仅作只读提示，不再写入或删除。读取时只取最近 16 条，被遗弃的文件挤不掉仍然存活的。

广告生命周期：

- 只有已就绪的端点才发布。在产生 URL 之前失败的启动不留下任何文件。
- 启动时通过回环 mutex 做短暂协调——最多等 250 ms、最多持有 500 ms——并在 spawn 前重新检查是否已有共享 Runtime。抢不到从不阻塞启动，只意味着本窗口起自己的 Runtime。
- 显式 stop、dispose 以及启动失败都会撤回广告。
- 启动器意外退出时放弃所有权，但只要端点仍然应答就保留广告——包管理器包装进程经常自己退出而它拉起的 Runtime 仍在服务。只有明确被拒绝的回环连接才撤回；超时或主机名有歧义时一律保留。
- 启动固定 `--host 127.0.0.1`；未设置 `dsh.serverPort` 时使用操作系统分配的端口。指定端口在 bind 竞争中失败时，会用操作系统分配的端口重试一次。
- 退出时先停止本扩展拥有的进程树，再撤回广告。POSIX 使用独立进程组，Windows 在根进程身份仍可确认时使用限定 PID 的 `taskkill /T`。

运行 `npm run compile` 后，分别执行 `node scripts/verify-runtime-discovery.mjs`、`node scripts/verify-runtime-shutdown.mjs`，验证启动器/端口选择、广告、升级确认及退出清理；脚本仅使用隔离临时目录、子进程及回环监听器。

```mermaid
graph TD
    A[VS Code Extension Host] <-->|RC Remote RPC| B[Standalone Harness Runtime]
    A <-->|Typed Full-State Bridge| C[React Webview UI]
    B <-->|CNB Distribution| D[Managed Local Engine]
    A <-->|Process Lock| E[Multi-Window Shared Runtime]
```

## 配置

完整列表可在 VS Code 设置界面搜索 `dsh`。

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `dsh.serverUrl` | `""` | 已运行的 dsh web Runtime 地址，设置后扩展将直接连接；可在地址中附加 `?token=...`，或单独设置 `dsh.serverToken`。 |
| `dsh.serverToken` | `""` | `dsh.serverUrl` 对应的启动 Token；地址与 Token 分开配置时填写。 |
| `dsh.autoStart` | `true` | 扩展激活时自动启动或连接 dsh web。 |
| `dsh.installWhenMissing` | `true` | 若无可用的 npm/dsh 环境，自动下载并托管独立 Runtime。 |
| `dsh.runtimeVersion` | `0.1.5-rc.1` | 用户同意后的 CLI 升级及插件下载目标，接受不低于 RC.1 的合法 SemVer；CNB 下载需镜像已发布。 |
| `dsh.npmRegistry` | `https://registry.npmmirror.com` | 下载后备重试的 Registry 镜像。 |
| `dsh.npxTimeoutMs` | `120000` | 等待包管理器下载与启动的超时时间。 |
| `dsh.enableCompaction` | `true` | 扩展自行启动 DSH Web server 时启用官方 `/compact` command。 |
| `dsh.autonomousDebugging` | `false` | 允许 Agent 通过本机回环 MCP 端点操作本窗口的调试器；只对本窗口自行启动的 Runtime 生效，切换后需重启 Runtime。 |
| `dsh.maxContextBytes` | `120000` | 单次请求中 `<ide_context>` 的最大 UTF-8 字节数。 |
| `dsh.persistSession` | `true` | 尽可能复用当前工作区上次的 Session ID。 |
| `dsh.agentStatusLabels` | *内置“大肥鱼”状态文案* | 每轮流式输出随机展示的文本提示，支持自定义。 |
| `dsh.agentStatusLabel` | `""` | 设置后将固定显示该提示文案。 |
| `dsh.enableEffortKnob` | `true` | 推理强度滑块使用跑步 sprite 动画作为按钮。 |

## 其他安装方式

**从 GitHub Releases 安装**：下载 [Releases](https://github.com/HarcoChen/dsh-vsc-integration/releases) 里的 `.vsix`，运行 `Extensions: Install from VSIX...`。预发布版本会带 pre-release 标记发到 Open VSX，同时挂在 GitHub Releases：在 Open VSX 上只有把该扩展切换到预发布版本的用户才会收到；它们不会进 VS Code Marketplace，那边不接受带 SemVer 预发布后缀的版本号。`0.8.0` 起正式版使用偶数 minor（`0.8.x`）、预发布使用更高的奇数 minor（`0.9.x`），因此正式版不会盖过更新的预发布版本。

**从源码构建**：

```bash
npm install
npm run check
npm run package
```

随后通过 `Extensions: Install from VSIX...` 安装生成的 `.vsix`。

## 扩展 API

其他 VS Code 扩展可以接入 DSH 导出的 API。

<details>
<summary><strong>对话导航 API</strong>：注册自定义节点</summary>

```ts
const registration = api.registerConversationNavigation([
    { seq: 42, label: "检查 PPO 实现", detail: "训练配置" },
]);
context.subscriptions.push(registration);
```

</details>

<details>
<summary><strong>Agent Status Label API</strong>：自定义流式状态文案</summary>

```ts
const dsh = vscode.extensions.getExtension<import("dsh-vsc-integration").DshExtensionApi>(
    "harcochen.dsh-vsc-integration",
);
const api = await dsh?.activate();
context.subscriptions.push(
    api?.registerAgentStatusPresentation({ label: "🐋 深潜中" }),
);
```

</details>

## 开发与测试

```bash
npm install
npm run check      # TypeScript 检查（宿主 + webview）
npm test           # 发布门槛：webview 检查 + 编译 + 测试套件
npm run compile    # 构建到 dist/
npm run package    # 编译 + vsce 打包
npm run release    # 测试 + 版本提升 + CHANGELOG 归档 + 打 tag
```

用已安装的 `0.1.5-rc.2` 启动器验证 Remote 集成：

```bash
npm run compile
node scripts/verify-remote-runtime.mjs --launcher /absolute/path/to/dsh
```

脚本使用临时 DSH_HOME、工作目录和回环地址上的模拟模型，不使用现有 Session 或外部模型凭据。验证脚本要求 Node.js >=22.15.0，且 `node:zlib` 支持 Zstandard（`zstdCompressSync`；Node 23 用户需 >=23.8.0）。

验证托管 Runtime 的发布逻辑：

```bash
node scripts/verify-managed-runtime.mjs              # 仅校验远端契约
node scripts/verify-managed-runtime.mjs --full       # 安装并冒烟测试
```

## 更多信息

- [更新日志](CHANGELOG.md)
- [产品 TODO](TODO.md)
- [第三方资产说明](THIRD_PARTY_NOTICES.md)

## 致谢

感谢 [dsh-reasoning-effort](https://github.com/HanaAyane/dsh-reasoning-effort) 提供推理强度控件的"大肥鱼跑步"参考。对话大纲受 `dsh-milestone` 项目启发。

## 许可证

[MIT](LICENSE)
