# DSH 插件生态推荐：我们的竞争缺口

日期：2026-10-12（Asia/Shanghai）。本地基线：`codex/dsh-workflow-features@9ca02e8`；公开版：Marketplace/GitHub Release `0.10.3`。

**主要短板是产品定位偏窄、已完成能力尚未公开交付，以及独立多会话、持久恢复和插件界面覆盖上的实际缺口。** 增加 RPC 数量不能直接解决这些问题。原生 Diff、Trace、调试集成和协议适配可以提供价值，但需要转化为用户每天用得上的流程。

用户提供的是一段模型生成的生态介绍，没有测试方法、版本基线或排名依据。文中的“优先考虑”不是 DeepSeek 官方认证，也不能作为性能或稳定性结论。本轮核对作者仓库、Marketplace 页面、公开 Gallery API 与本地代码；没有对竞品做安装后的完整实机横评。

## 公开分发：确实落后于部分直接竞品

2026-10-12 通过 Marketplace Gallery API `extensionquery` 读取 `statistics.install`：

| 扩展 | 版本快照 | install 统计 | 评分人数 |
| --- | --- | ---: | ---: |
| [我们：HarcoChen.dsh-vsc-integration](https://marketplace.visualstudio.com/items?itemName=HarcoChen.dsh-vsc-integration) | 0.10.3 | 639 | 0 |
| [DSH Sidebar：lixxx1.dsh-sidebar](https://marketplace.visualstudio.com/items?itemName=lixxx1.dsh-sidebar) | 0.0.5 | 1,543 | 1 |
| [Xizhi1024.dsh-vs-sidebar](https://marketplace.visualstudio.com/items?itemName=Xizhi1024.dsh-vs-sidebar) | 1.2.0 | 645 | 1 |
| [Jager.dsh-vscode](https://marketplace.visualstudio.com/items?itemName=Jager.dsh-vscode) | 0.13.39 | 4,048 | 3 |
| [rainfishs.dsh-on-vscode](https://marketplace.visualstudio.com/items?itemName=rainfishs.dsh-on-vscode) | 0.0.15 | 10 | 0 |

这是平台统计快照，不是独立活跃用户数或留存率；没有包含 Open VSX、GitHub VSIX、源码安装等渠道。评分样本不足以判断满意度。推荐列表顺序与 install 统计并不一致，尤其 Xizhi 和我们的数量接近。

数据来自 Marketplace 的公开 `/_apis/public/gallery/extensionquery?api-version=7.2-preview.1`，按完整扩展 ID 查询，flags 为 785；表格链接对应相同扩展的产品页。数字会变化，不作为长期常量。

## 真正值得关注的直接对手

| 对手 | 一手资料中的重点 | 对我们的意义 |
| --- | --- | --- |
| [DSH Sidebar](https://github.com/Lixxx1/dsh-vscode) | 用清晰的侧栏 Agent 场景介绍产品，突出自主调试、上下文、权限、变更审查与插件发现。另有专门的[介绍网站](https://lixxx1.github.io/dsh-vscode/) | 核心编码能力并非我方明显缺失；其社区目录搜索比我方“输入包 spec 安装”更容易发现新能力。来源：[插件管理源码](https://github.com/Lixxx1/dsh-vscode/blob/main/src/plugin-manager.ts) |
| [dsh4vscode](https://github.com/DoggyHU/dsh4vscode) | 多个聊天窗口各自绑定独立 Session，可以分屏并行 | 我们的侧栏和编辑器 Tab 共享一个 controller/session，打开 Tab 是镜像；会话中心只解决导航，未解决同时操作两个独立会话 |
| [Xizhi 的版本](https://github.com/Xizhi1024/deepseek-harness-dsh-for-vscode) | 嵌入官方 Web UI，并提供上下文与变更集成；仓库有可选 inline edit、LM routing、FIM 代码 | 官方界面路线可复用其已挂载 Client 插件；我方自己维护界面，只能逐项适配。可选功能的代码存在不证明目标版本完整可用，不能据此把 FIM 当成熟优势 |
| [Jager / NEXTINDIE](https://github.com/NEXTINDIE/DeepSeek-Harness-for-VS-Code) | 原推荐未列出。介绍持久检查点、redo、提交信息生成及会话/任务面板；附带 Host rollback 插件 | 与我方的原生界面路线更接近，应该加入直接竞品清单。最值得比较的是恢复的持久化、用户是否容易找到恢复入口，以及 SCM 日常动作 |

Xizhi 的版本状态在不同入口不一致：本轮 Gallery 返回 `1.2.0`，仓库默认分支 manifest 为 `1.1.3`，Marketplace 正文仍说明 `1.2.0 candidate` 的验收边界。采用各自来源的原文状态，不把仓库、候选文案和发布包自动视为同一实现。其 Marketplace 明确提示 FIM 和部分可选桥接未完整认证：[产品页](https://marketplace.visualstudio.com/items?itemName=Xizhi1024.dsh-vs-sidebar)。

## 五处实际不足

### 1. 完成开发尚未转化为公开产品

`84e9d46` 已加入 Runtime 终端、插件安装/取消/卸载、Problems 和会话中心；`9ca02e8` 又调整聊天与 Settings 的界面结构。公开 `main` manifest 和 Marketplace 仍为 `0.10.3`，公开说明仍写 Runtime 终端待接入。[公开版](https://github.com/HarcoChen/dsh-vsc-integration/releases/tag/v0.10.3)、[当前验收记录](./WORKFLOW_FEATURES_VALIDATION.md)。

因此普通用户和检索模型看到的是旧产品。新增本地代码不能抵消公开版本的功能缺口。建议先完成本轮真实 VS Code 的关键场景验收与公开发布，再更新截图、演示和功能入口说明。

### 2. “在 VS Code 用完整 DSH”的期待与实际覆盖有距离

我方控制 Runtime 与 Session 的公开状态，但没有官方 Client UI 的服务/slot 环境。动态插件面板对 Client half 仍显示去 Web UI 审查；部分 Provider 高级设置也需打开浏览器。安装成功不等于插件界面已经出现在原生聊天内。依据：[`DynamicPluginsPanel.tsx`](./webview/src/components/dock/DynamicPluginsPanel.tsx)、[`chatView.ts`](./src/chatView.ts)、[`pluginManagement.ts`](./src/pluginManagement.ts)。

对于已配置大量 GUI 插件的 DSH 用户，嵌入官方界面的方案更接近他们已有的使用习惯；这是覆盖和切换成本上的推断，不是全面兼容保证。可以评估连接同一 Runtime/Session 的官方界面辅助入口，或明确列出“原生接入 / Host 可用但 UI 要去 Web / 不支持”的能力状态。

插件发现也有差距：我方管理器支持官方包操作，但用户需先知道 npm/Git spec；DSH Sidebar 的管理器还查询社区目录。首要任务是把“查找 → 理解用途与来源 → 安装 → 配置 → 看见已生效能力”串起来。

### 3. 多任务只有切换，缺少独立视图

我方 `openInEditor()` 复用一个 editor surface，所有 surfaces 共享 `sessionId`；两个界面同时切换。这与 dsh4vscode 的独立聊天窗口不同。依据：[`chatView.ts`](./src/chatView.ts)、[dsh4vscode README](https://github.com/DoggyHU/dsh4vscode/blob/main/README.md)。

典型触发：主会话正在修改文件，用户希望另开窗口理解另一个模块或审查改动。现在切换会话能继续工作，却不能让两个独立对话并排保持各自上下文。建议允许每个视图绑定 Session 和草稿，继续共享 Runtime store；同目录并发写入与 Worktree 隔离仍需协调。

### 4. 恢复还不够持久、可逆

我方已有按轮审查、消息处分叉和代码恢复，但审查记录依赖 Extension Host 内存与临时 Git 对象/index，dispose 会清理；恢复提示还写明 DSH 无法撤销这次恢复。跨多轮恢复与同轮目录切换有边界。依据：[`changeReviewStore.ts`](./src/changeReviewStore.ts)、[`chatView.ts`](./src/chatView.ts)。

Jager 的作者说明使用持久隐藏 refs 和记录，提供 `/redo`；这些是应该实装比较的具体能力：[rollback 说明](https://github.com/NEXTINDIE/DeepSeek-Harness-for-VS-Code#turn-level-git-rollback-setup)。建议验收“重载后仍能审查/恢复 → 恢复前保留当前状态 → redo → 用户并发修改时拒绝覆盖”，再决定存储方案。不能只比较是否有 Undo 按钮。

### 5. 给普通用户的第一选择理由不够鲜明

原推荐把我方概括为 Diff、活动面板和 Token，反映了产品被压缩后留下的形象。现有首屏主要强调 Runtime 版本、Remote contract 与 Jev；这些信息对维护者有价值，普通用户更需要知道“装完之后怎样更快完成任务”。依据：[公开 Marketplace 描述](https://marketplace.visualstudio.com/items?itemName=HarcoChen.dsh-vsc-integration)、[`README.md`](./README.md)。

DSH Sidebar 把熟悉的右侧栏编码流程讲得直观，Xizhi 用官方完整界面降低理解成本，dsh4vscode 用独立窗口解释差异。我们也应把价值描述成具体动作：选区起任务、看清审批、在编辑器审查、接管调试/终端、跨任务跟进和恢复改动。名称、仓库描述、市场页与演示使用一致的产品名与相同流程。

英文 README 的 zero-config 标记与 Desktop、Provider、Workspace、模型的首次配置步骤有张力；实际代码可以复用已有兼容 `dsh`，Desktop 只是缺失时的引导，不应让用户误以为无条件必须另装桌面端。Jev 默认关闭且需要端点/凭据；保留它作为进阶增强，并提供实际任务证据，再把效果作为核心卖点。

这属于产品定位推断，不代表已经做过新用户研究。当前 `9ca02e8` 已调整本地 UI，不能继续用旧截图断言当前布局落后；需要更新展示物并做相同任务的体验比较。

## 原推荐中的其他项目如何看

- `dsh-vscode-workbench`、`dsh-ide-vscode`、`dsh-vscode-ui` 提供 DSH Web 内的编辑/文件工作台，是另一类产品；原生 VS Code 本来已有编辑器、Git 和搜索，不应把重新造这些面板计为我方必补项。[Workbench](https://github.com/tingfeng347/dsh-vscode-workbench)、[IDE](https://github.com/wang6077/dsh-ide-vscode)、[UI](https://github.com/wangbaoyi/dsh-vscode-ui)。
- `dsh-vscode-plugin` 的 npm 包声明代码浏览功能，但本轮该包 metadata 没有 repository；不能仅凭同名目录条目将它绑定到某个 GitHub 实现。[npm](https://www.npmjs.com/package/dsh-vscode-plugin)。
- `dsh-remote-ssh` 有多个同名仓库和 scoped 包，用户给出的名字不能唯一确定实现。远程执行仍是我方需要验证的工作流，不能直接套用某个包的能力介绍。[Yan-Zero](https://github.com/Yan-Zero/dsh-remote-ssh)、[aijunjiang](https://github.com/aijunjiang/dsh-remote-ssh)、[ZhangFengshun](https://github.com/ZhangFengshun/dsh-remote-ssh)。
- `dsh-open-in-vscode` 的价值是从 Web 回到已有 IDE 的交接，可视为互补。[作者仓库](https://github.com/omdsh-dev/dsh-open-in-vscode)。
- rainfishs 的说明要求先安装 bridge 并启动 DSH；dsh4vscode 也要求已有 Runtime。不能从推荐里的“轻量/自动”推断所有竞品的启动步骤比我方少。[rainfishs 产品页](https://marketplace.visualstudio.com/items?itemName=rainfishs.dsh-on-vscode)、[dsh4vscode](https://github.com/DoggyHU/dsh4vscode)。

## 建议的下一步

1. **先把已完成能力交付出去。** 真实 VS Code 核心场景验收，发布首批工作流与界面调整，更新截图和 30–60 秒演示。公开发布需要单独执行，不由本次调研触发。
2. **缩短第一轮任务的路径。** 清楚显示复用的 Runtime、配置缺项与下一步；复用已有 `dsh` 的用户不重复走 Desktop 安装说明。首屏展示工作流，版本与协议细节放兼容章节。
3. **先补独立会话与持久恢复。** 这两项直接改善多任务和失败后的体验；SCM 提交信息草稿可以作为较小的日常功能。
4. **把生态入口补成闭环。** 社区插件发现、可用状态与官方 GUI 辅助入口，避免“装好了但在哪里用”的问题。
5. **继续用证据建立差异。** 将 Trace、检查结果、未验证项和 Jev 决策汇成交付证据；实测再宣传减少循环、费用或失败率。Worktree 和远程矩阵保持后续计划。

建议用固定任务观察安装到首条成功请求的步骤、同时处理两个会话的操作数、异常后恢复耗时，以及哪些插件需要离开编辑器。没有这些数据，功能表只能说明覆盖，不能说明谁更顺手。
