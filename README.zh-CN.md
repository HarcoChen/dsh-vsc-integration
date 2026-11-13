<p align="center">
  <img src="resources/dsh.png" alt="DSH IDE" width="96">
</p>

# DeepSeek Harness for VS Code

[English](README.md) · **简体中文**

在 VS Code 中使用 DeepSeek Harness（DSH），附加编辑器上下文、审批工具调用、查看原生 Diff，通过 Trace 和用量面板跟进任务。

<p align="center">
  <a href="https://open-vsx.org/extension/harcochen/dsh-vsc-integration"><img src="https://img.shields.io/open-vsx/dt/harcochen/dsh-vsc-integration?style=flat-square&label=Open%20VSX%20%E4%B8%8B%E8%BD%BD%E9%87%8F" alt="Open VSX 下载量"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=HarcoChen.dsh-vsc-integration"><img src="https://vsmarketplacebadges.dev/installs-short/HarcoChen.dsh-vsc-integration.svg?style=flat-square" alt="VS Code Marketplace installs"></a>
  <a href="https://github.com/HarcoChen/dsh-vsc-integration/stargazers"><img src="https://img.shields.io/github/stars/HarcoChen/dsh-vsc-integration?style=flat-square" alt="GitHub Stars"></a>
  <img src="https://img.shields.io/badge/dsh目标-0.2.2--rc.1-2f6feb?style=flat-square" alt="dsh 目标 0.2.2-rc.1">
  <img src="https://img.shields.io/badge/Laya%20%2F%20Jev-支持-8250df?style=flat-square" alt="支持 Laya / Jev">
  <a href="https://github.com/HarcoChen/dsh-vsc-integration/blob/main/LICENSE"><img src="https://img.shields.io/github/license/HarcoChen/dsh-vsc-integration?style=flat-square" alt="许可证"></a>
</p>

[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=HarcoChen.dsh-vsc-integration) · [Open VSX](https://open-vsx.org/extension/harcochen/dsh-vsc-integration) · [下载 VSIX](https://github.com/HarcoChen/dsh-vsc-integration/releases)

![DSH 工作流演示](public/scene-intro.gif)

## 开始使用

需要 VS Code **1.106.0+**，Runtime 兼容目标为 **dsh 0.2.2-rc.1**。

1. 从上方链接安装扩展。下载 `.vsix` 后，可通过 `Extensions: Install from VSIX...` 安装。
2. 安装并启动官方 DeepSeek Desktop，它会注册 `dsh` 命令。打开并信任项目文件夹，运行 `DSH: 打开聊天`。[Desktop 下载](https://www.deepseek.com/zh/download/)
3. 运行 `DSH: 配置 API Key` 配置 DeepSeek 凭据。其他 Provider 可通过 `DSH: 在浏览器中打开 dsh Web UI` 配置。选择或注册 DSH Workspace，再选择模型。
4. 发送任务，用 `@` 附加上下文，响应审批卡片，通过工具 Diff 检查改动。

DSH Workspace 用于在 Harness 中组织会话，可关联项目路径。同一 Runtime 上的会话也可在 Web UI 中继续。

## 主要功能

- **原生审阅**，并排查看工具改动，审批前预览文件写入，也支持 Git 仓库以外的文件。
- **编辑器上下文**，附加文件、选区、符号、诊断、Git Diff 和暂停时的调试状态。
- **持久会话**，支持独立编辑器标签、对话大纲、搜索、归档及 Markdown/JSON/ZIP 导出。
- **任务跟踪**，集中查看 Trace、活动、子代理、Todo、Token 用量和模型费用估算。
- **Runtime 管理**，提供终端、定时任务、账户和插件安装入口。
- **Worktree 与 PR 评审**，需启用官方可选组合包 `@deepseek-ai/dsh-experimental-forge-bundle`。
- **行内补全与 Agent 调试**，自动补全和自主调试默认关闭。

## 配置

在 VS Code 设置中搜索 `dsh` 查看全部选项，在命令面板搜索 `DSH` 查找操作。界面随 VS Code 显示语言提供英文或简体中文。

连接已有 Runtime 时，将 `dsh.serverUrl` 设为包含 Token 的启动地址，也可单独填写 `dsh.serverToken`。远程地址须使用 HTTPS。`dsh.connectionMode` 设为 `attach-only` 可仅连接已有进程。`DSH: 连接桌面端` 接受 Desktop 的 `dsh-vscode-connect` 插件提供的连接地址。

内置的 Laya / Jev 集成提供循环检测、输出整形、完成检查、工具裁剪和 Skill 路由。打开 `dsh.jev.enabled` 和需要的子功能，运行 `DSH: 配置 Jev API Key`，按提示重启 Runtime。Key 加密保存在 SecretStorage，启用的功能可能将所需样本发送至配置的端点。该集成应用于本扩展启动的 Runtime。

使用 Laya 时，将 `dsh.jev.baseUrl` 指向兼容 System One 接口的 HTTPS 地址，设置 `dsh.jev.model` 并配置 API Key。服务端接受占位 Key 时可填写占位值。

## 排查问题

运行 `DSH: 诊断环境`，再通过 `DSH: 显示 dsh Runtime 日志` 查看错误。反馈时附上扩展版本、操作系统和脱敏后的错误信息。[提交问题](https://github.com/HarcoChen/dsh-vsc-integration/issues)

扩展在启动本机 Runtime 及配置变化时创建备份，每个 DSH Home/配置保留最近 10 份。运行 `DSH: 打开配置备份` 可取回文件并手动恢复。

## 开发

使用 Node.js 22+，构建前初始化随包集成。

```bash
git submodule update --init --recursive
npm ci
npm run check
npm run package
```

`npm test` 运行发布检查。Runtime 兼容性和联调结果见维护记录，其他扩展可接入导出的对话导航和 Agent 状态 API。[维护记录](MAINTENANCE.md) · [扩展 API](src/agentStatusPresentation.ts)

<details>
<summary>发版流程</summary>

将改动记在 `CHANGELOG.md` 的 `Unreleased` 中。补丁发布运行 `npm run release -- patch`，再用 `git push origin HEAD --follow-tags` 推送提交和 tag。正式版使用偶数 minor，预览版使用更高的奇数 minor。纯数字预览版在 Marketplace 标记为 pre-release，带 SemVer 预发布后缀的版本发布到 Open VSX 和 GitHub Releases。

Marketplace 使用 GitHub OIDC 和 `vsce 4.1.0` 发布。首次发布前，在 publisher `harcochen` 下创建 Trusted Publishing 策略，owner 填 `HarcoChen`，repository 填 `dsh-vsc-integration`，workflow 填 `release.yml`，Environment 留空。[Trusted Publishing 设置](https://developer.microsoft.com/blog/trusted-publishing-visual-studio-marketplace/)

</details>

## 项目

本项目由社区独立维护。跑步精灵参考 `dsh-reasoning-effort`，对话大纲受 `dsh-milestone` 启发。[精灵素材来源](https://github.com/HanaAyane/dsh-reasoning-effort)

[更新日志](CHANGELOG.md) · [JetBrains 版](https://github.com/HarcoChen/dsh-intellij-integration) · [MIT 许可证](LICENSE)
