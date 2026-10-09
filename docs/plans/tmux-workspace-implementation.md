# tmux 工作区实现计划：聊天重构后的版本

核对时间：2026-10-06T09:28:23+08:00（北京时间）。源码基线：`59eba809` 加当前工作树改动及未跟踪文件。

这是开始实施前的设计基线。用户随后已授权完成整个目标；当前状态、设计稿差异和验收缺口见 [完整交付进度](tmux-workspace-progress.md)，早期实施情况保留在 [第一阶段记录](tmux-workspace-stage-one.md)。以下能力盘点和源码行号保留为规划时的快照，不代表当前尚未开发。原型交互继续沿用最终接受版本。

## 结论

先将重构后的单会话入口拆成独立 pane 接口，再同时接入分屏布局与多会话调度。复用 NativeCodexThread、SessionPresentation、NativeChatProjection、DSH 阅读协调、HAPI 虚拟历史和现有 composer；其他 agent 保留 HappyThread。共享工作区和机器级长期终端仍需实现。

HEAD 尚未覆盖聊天重构。只检查提交记录会漏掉新文件，实施应以实际工作树为基线，保留其他并行改动。

## 当前能力与缺口

| 能力 | 当前状态 | 已有实现 | 待完成 |
| --- | --- | --- | --- |
| 原生消息与展示 | 已实现 | NativeExecution 身份、NativeChatProjection、按节点订阅、过程折叠已经在工作树中。原生 Codex 默认使用新路径，其他 agent 使用 HappyThread。 | 复用现有投影和业务组件；不再计划重写内容语义。 |
| 滚动与历史 | 已有可复用核心 | DSH 的 Reading / Navigation / Follow 与 HAPI NativeChatViewport、虚拟历史相连；每个容器一个位置控制者。 | 补窗格级离开／恢复、尺寸和可见性边界；覆盖新旧两种正文路径。 |
| 切换与缓存 | 已有单会话优化 | SessionPresentation 缓存最近 5 个原生会话；保留投影、展开状态和同宽度测量，不保留离开的 DOM。 | 已挂载会话必须被缓存保留；最近缓存预算不能驱逐正在显示的对象。 |
| 后台预热 | 已有单当前会话调度 | RecentSessionWarmup 复用全局 SSE，最多 5 个最近会话，串行读取最新 20 条，弱网／后台暂停。 | active 字符串改为可见集合；隐藏会话只预热有界缓存，不能覆盖任一可见阅读窗口。 |
| 路由与操作 | 仍依赖单路由 | SessionPage 读取 URL 参数；恢复会话、上传目标变化会调用全局 navigate；快捷键和部分选择器仍全局。 | 拆 SessionPaneController 与 PaneContext；异步结果只更新其所属窗格。 |
| 多工作区与分屏 | 未实现 | SessionWorkspace 仍是一个聊天加一个工具面板；未安装 FlexLayout 或 Dockview，未找到多工作区存储与 API。 | 实现已接受的工作区、分屏、底栏、移动投影、持久化和跨设备结构同步。 |
| 长期终端 | 仍需改造 | 浏览器断线可临时 detach；但视图重挂生成新 terminalId，CLI 断线仍 closeAll，默认 15 分钟 idle。 | 机器端长期宿主、稳定资源身份、显式 detach／terminate，以及两平台故障验收。 |

## 已接受的交互

多个工作区，每个工作区容纳聊天和独立终端。普通点击已打开会话只聚焦；未打开会话替换当前 pane；边缘拖放或“在旁边打开”才分屏。终端默认继承源聊天的机器和目录。

支持左右／上下分屏、调大小、方向焦点、放大还原、跨工作区移动、刷新恢复及关闭工作区撤销。关闭视图不结束 Agent 或终端。桌面工作区在底部；手机无产品顶部栏，P1/P2/P3 与工作区导航在底部同一行。布局切换按宽度，不由键盘高度触发。

输入和状态保持紧凑，模型／推理／权限／Goal 都作用于当前 pane。Ctrl-b 为工作区前缀，双 Ctrl-b 透传一次；组合输入不被拦截。底栏悬停滚轮切工作区，正文滚轮只阅读。

## 升级后的模块

### WorkspaceController：结构与打开意图

维护 paneId 与资源绑定；区分新打开、聚焦已有窗格、恢复和返回最新。普通聚焦不触发当前 switchTo 的跳尾逻辑。布局库只提交几何命令。

### SessionPaneController：从路由中抽出的业务入口

从 SessionPage 提取 session 查询、发送、恢复、上传和错误状态；sessionId 来自参数。恢复返回新 sessionId 时只重绑定发起窗格，不导航整个页面。

### PaneHost / PaneContext：呈现生命周期

输入 paneId、sessionId、focused、visible、openIntent、scrollerRef 和工具入口。可见移动保持 DOM；隐藏前保存阅读与草稿，取消定位和测量，再按既有缓存恢复。

### PresentationRegistry：扩展现有缓存

沿用 SessionPresentation 和 NativeChatProjection。挂载中的会话持有引用，不被最近 5 项缓存驱逐；释放后进入有界最近缓存。不要新建第二套消息 store。

### SubscriptionCoordinator：扩展现有预热

将 selectedSessionId / active 改为 visibleSessionIds 与 focusedPaneId 两个概念。整合 useSSE、恢复同步与 RecentSessionWarmup，保证可见正文优先、隐藏预热有界。

### LayoutAdapter 与 TerminalHost

前者只计算 splitTree 几何，后者在机器上拥有终端进程。两者都不能拥有聊天消息；DSH 聊天核心的引入并未实现这两项。

## 必须改变的单会话假设

1. **打开意图区分。** 聚焦已有 pane、切工作区、手机切 pane 和 zoom 还原均为 resume，不调用会清书签的 `switchTo` / `openMessageTailFromCache`。新选未打开会话为 open-latest。刷新为 restore；历史链接为 navigate-anchor。
2. **pane 业务入口。** 从 SessionPage 提取会话查询、发送、失败恢复、上传及 resume。异步操作固定到发起 pane 和资源绑定版本；返回新 sessionId 只重绑定原 pane，不导航整个应用。已被替换的 pane 不接受旧操作覆盖。
3. **生命周期。** 可见移动与 resize 保持 DOM；真正隐藏前保存书签／草稿、取消导航和采样，再卸载正文，复用既有展示缓存恢复。使用显式 pane 离开事件替代只靠 Router 的 onBeforeNavigate。首版不常驻所有工作区 DOM；输入组合期间不在拖动预览中卸载。终端视图卸载只 detach。
4. **缓存所有权。** 沿用 ApiClient + sessionId 的 SessionPresentation，挂载时保留引用，闲置后进入最近缓存。当前 5 项 LRU 不能淘汰正在挂载的对象；历史仓库的 8 会话缓存也不是产品窗格上限。语义书签保持 sessionId，消息身份保持原生 thread/turn/item 或 tool call ID。
5. **可见集合调度。** RecentSessionWarmup 的单 active 扩为 visibleSessionIds；每个可见会话都按前台处理，不因未聚焦被当成后台。串行最新 20 条、最近 5 个、弱网／后台暂停和不轮询策略继续保留。任何可见历史阅读都不能被后台预热换成 tail。
6. **SSE 交接。** 当前全局流仍传正文，新预热使用它。服务端过滤隐藏正文时，同时保留轻量正文变化通知以及队列控制身份。可见集合一个完整流；先连流，再对新增／缺口资源取快照，以消息身份、epoch 和可用版本合并。旧集合 cursor 不能证明新集合已经完整。队列快照水位需单独核实。
7. **唯一滚动控制者。** NativeCodexThread 的 Reading / Navigation / Follow 与 NativeChatViewport 继续拥有位置；布局库和虚拟列表只管几何／挂载。变宽不能使用旧测量；同宽复用缓存。作用域选择器、全选、弹窗、工具入口和已读必须指向 pane。
8. **交互草稿先独立。** RequestUserInputFooter 当前把步骤、选择和文本存在组件 useState 中。阶段 A 按 sessionId + tool call ID 保留本机问题草稿，答复完成或用户明确丢弃时释放；在途提交由 pane 控制器跟踪，重开不得自动重发。附件、Goal 编辑器也需逐一验证离开恢复。只有这些状态能恢复后才启用隐藏卸载，不能把聚焦行 pin 当成跨工作区保存。

## 状态与协议

Hub 只保存 workspaceId、paneId、资源引用、名称、顺序、桌面分屏树、权重、revision 和 schemaVersion。焦点、临时放大、手机选择、草稿与书签留在客户端；机器端拥有执行进程。工作区不复制聊天正文。

工作区使用普通 expectedRevision 更新与事务。跨工作区 move 同时校验两边版本并原子提交；冲突后重取再重放仍有效的操作。远端删除当前编辑 pane 时保留本机临时视图和草稿，等待用户离开或放回工作区。关闭撤销只恢复结构和引用，不复活已退出进程。沿用认证、namespace、路径和环境变量边界，不新增哈希校验或 CRDT。

拟新增工作区 list/create/update/move/close/restore API 与变更事件；SSE 增加服务端订阅种类、sessionIds 集合和必要轻量正文变化通知。这些 API 尚未实现。先建立 pane 业务接口，再固定最终命名。

## 长期终端

浏览器短暂断线目前可 detach，CLI 断线仍 closeAll，视图重挂创建新 terminalId，默认 idle 15 分钟、最多 4 个终端。聊天重构没有改变这些事实。

机器级 TerminalHost 保存稳定 terminalId、进程和有界输出序号。Hub 做授权、登记与转发；Web create/attach/detach/input/resize/terminate。重试先查询同资源，不能重复 spawn；多端可观察，输入与 resize 只由显式控制端执行，旧按键不重放。隐藏不发零尺寸，不因静默计算就自动杀进程。

验证关闭窗格、刷新、网络中断、聊天结束、Hub 重启不主动结束任务。分别测 Runner、宿主、机器故障；原进程失去时明确报告，不用新 shell 冒称恢复。新宿主纳入 Linux／Windows 监督；Windows 既有后台监督不等于新终端通过验收。旧 CLI 的 PTY 不强行搬迁，让旧任务自然退出。

## 开发顺序

### A. 独立聊天入口与生命周期

先在单窗格入口提取 SessionPaneController / PaneContext；建立打开意图、离开保存、恢复和展示引用。问题草稿与在途提交脱离组件生命周期后，才允许隐藏卸载。

- 改动边界：router SessionPage、SessionChat、NativeCodexThread、useMessages、SessionPresentation、RequestUserInputFooter；新增 pane 接口与必要交互状态。
- 验证任务：聚焦与恢复不跳尾；主动打开仍到最新；发送失败、上传、resume 新 ID 的晚到结果不覆盖另一资源。问题回答、附件、Goal 草稿能离开恢复；同宽缓存和 epoch 失效正确。
- 完成条件：旧入口经新控制器仍完成完整单窗格任务；挂载缓存不会被第 6 个最近会话驱逐；未提交的问题输入和在途操作不会随隐藏丢失。
- 回退：旧单路由外壳继续可用；不改内容语义和原生历史格式。
- 依赖：第一步；先把当前正确行为做成可复用接口，再接布局库。

### B. 真实分屏与多会话调度

用新版原生正文、legacy 正文和终端视图接 FlexLayout；实现底栏和分屏，整合可见集合、SSE 与隐藏预热。

- 改动边界：WorkspaceShell / LayoutAdapter / PaneHost；App、useRecentSessionWarmup、useSSE；Hub events / SSEManager 及必要共享协议。
- 验证任务：双聊天同时流式和补页；焦点切换不切正文集合；移动／resize 保持可见 DOM，隐藏恢复保持书签；去除全局正文后预热仍工作。
- 完成条件：2／4 pane 的状态、事件和历史独立；无重复制订阅与恢复风暴。布局库无需侵入聊天核心；否则同场景对照 Dockview。
- 回退：切回旧壳；不丢消息或书签。此阶段旧终端只是布局接入样本，不能宣称长期任务已完成。
- 依赖：依赖 A；布局与订阅必须一起验证，避免只交付静态分屏。

### C. 工作区持久化与跨设备同步

新增 WorkspaceStore、结构命令、刷新恢复、深链接、原子跨工作区移动与关闭撤销；手机只保存本机投影。

- 改动边界：Hub Store / routes / SSE、shared workspace schema、Web Controller / LocalViewState。
- 验证任务：两端同时 resize/move/delete；断网编辑再重连；删除当前带草稿 pane；恢复缓存被淘汰的旧工作区。
- 完成条件：共享结构一致、焦点独立；冲突不丢 pane、不清草稿、不停止任务；恢复路径不会误用 open-latest。
- 回退：保留新增工作区文档，回到单壳；不逆迁移消息库、不删除用户布局。
- 依赖：A 的命令与身份确定后可推进存储；集成验证依赖 B。

### D. 长期终端与两平台故障恢复

机器级 TerminalHost、稳定 terminalId、资源目录、attach/detach、单输入控制端、有界输出恢复和显式结束。

- 改动边界：CLI/机器监督、TerminalManager、Hub terminalRegistry / handlers、Web TerminalPane；Windows 托管路径。
- 验证任务：刷新、关闭 pane、断网、聊天退出、Hub 重启；长时间静默任务；分别记录 Runner／宿主／主机故障中的原进程身份。
- 完成条件：CHRIS 和 Lis-iMac 都通过所承诺的故障矩阵；不靠新 shell 冒充恢复；旧任务不被迁移杀掉。
- 回退：页面可退旧壳，但保持有任务的新宿主及重连入口；旧 CLI PTY 不强行搬迁。
- 依赖：A 的终端 pane 接口确定后可独立推进；仍可能是最长路径。

### E. 手机投影与整体验收

完成底部 P1/P2/P3、软键盘与宽度切换；集成内容、布局、同步和终端，形成试用候选。

- 改动边界：WorkspaceShell / responsive projection / themes；用户任务 E2E 与真机性能回放。
- 验证任务：以当前重构版为基线比较 1／2／4 可见 pane；隐藏会话超过 5 个；真实 Chrome 输入、附件、代码阅读与持续终端输出。
- 完成条件：正文无空白与重叠、操作不串目标、恢复可靠；报告 CPU／帧间隔／内存／网络的对照结果与未测范围。
- 回退：按 Web 入口或机器能力回退，保留消息和运行中的终端。
- 依赖：集成 B/C/D；手机基本路径从 B 开始验证，不等到最后才检查。

阶段 A 先降低耦合风险；B 交付真实双／多聊天试用。C 和 D 在 A 的身份接口稳定后可分工推进；完整目标需 C、D、E 全部完成。布局库仍按既有评估先验证 FlexLayout 0.11.1，必要时对照 Dockview 8.4.0；本轮未刷新上游版本，也没有接入两者。

## 验收与发布

优先验收用户任务：A 看历史、B 流式与输入、C 后台更新；拖动和变宽中补页；工作区往返；累计访问超过 5／8 个缓存会话；resume／上传后切换资源；两端同时改布局；手机键盘与 P1/P2/P3；长期静默终端及故障恢复。混合原生与 legacy 正文，检查 Goal、权限、Stop、审批、附件及所有菜单目标。

记录操作意图、pane/资源绑定、消息身份、窗口 epoch、网络事件和中间帧。静态同宽补页锚点误差不超过 1 CSS px；宽度变化以语义内容连续性判断，不能要求 scrollTop 不变。正在输入的问题行须保留 DOM 与草稿。

性能基线改为**当前重构版单路由**，不再与重构前旧核心混比。固定数据与回放，对照 1／2／4 可见 pane 和有界隐藏缓存；每条件至少 5 次，报告主线程、帧间隔、内存、DOM、恢复延迟和网络字节的中位数及范围。既有聊天文档报告的性能数字不是 tmux 实测结果。

先上线新增 Hub／机器能力，再打开相应 Web 入口；旧任务保留。首次进入只创建当前会话引用，不扫描全历史。回退旧壳不删除布局文档或结束新宿主任务。验证按仓库约定：包内相关测试与类型检查；跨包协议／依赖改动运行完整类型检查和测试，并按受影响链路运行原生一致性。源码、发布、生产浏览器与真机接受分别陈述。

本轮只检查计划内容、链接、网页交互和截图；没有重新执行上述产品验收。实验、录制与构建中间产物使用缓存盘，默认使用已有会话或受控回放，不额外调用模型。

## 源码证据

- [1] 单路由与 pane 控制器入口：`web/src/router.tsx:339,517,552,905；web/src/components/SessionWorkspace.tsx:31`。SessionPage 使用 URL 参数；resume/upload 结果仍全局 navigate。SessionWorkspace 只有聊天＋工具面板。
- [2] 消息窗口与卸载：`web/src/hooks/queries/useMessages.ts:64；web/src/lib/message-window-store.ts:1187,1244,1264`。激活、取消旧页、online/visibility 恢复与主动切换尾部的真实边界。书签和窗口仍按 sessionId。
- [3] 全局 DOM 与按键：`web/src/components/SessionChat.tsx:354,818,838,848；web/src/router.tsx:227；web/src/chat/nativeViewport.ts`。全局选择器、window keydown、按路由 seen；NativeChatViewport 的 ownerDocument 查找需改为容器内。
- [4] SSE 与预热交接：`web/src/App.tsx:178,324,415；web/src/hooks/useSSE.ts:223,690；hub/src/web/routes/events.ts:51；hub/src/sse/sseManager.ts:302`。all 仍含正文，scope 未发给 Hub；global onEvent 已被 RecentSessionWarmup 使用；完整流仍只有一个 selectedSessionId。
- [5] 新版阅读与测量：`web/src/components/AssistantChat/NativeCodexThread.tsx:70,136,333；web/src/components/AssistantChat/VirtualMessageList.tsx:49；web/src/chat/nativeViewport.ts`。每实例 viewport、onBeforeNavigate 保存、虚拟挂载与同宽测量缓存。多 pane 生命周期接口尚未接入。
- [6] 终端的现有保证与缺口：`web/src/routes/sessions/terminal.tsx:270；hub/src/socket/handlers/terminal.ts:331；hub/src/socket/terminalRegistry.ts:32；cli/src/api/apiSession.ts:375,1680；cli/src/terminal/TerminalManager.ts:28`。浏览器断线只是 detach；CLI 断线会 closeAll。相同 terminalId 重连可重新登记，但路由重挂会生成另一个 ID。
- [7] Windows 部署基础：`scripts/windows/README.md；scripts/windows/start-hapi.ps1`。已有后台监督与当前连接配置；本轮未重跑 Windows 故障测试，不能用旧引擎保证替代 TerminalHost 验收。
- [8] 工作区协议的复用边界：`hub/src/store/versionedUpdates.ts；hub/src/store/types.ts；shared/src/schemas.ts；AGENTS.md`。版本检查、事务、namespace 鉴权可以延续；新的 WorkspaceStore／工作区 API 仍待实现。
- [9] 既有布局库评估：`library-maturity-review.md；当前 web/package.json`。沿用先前 FlexLayout 0.11.1／Dockview 8.4.0 评估；当前未安装两者。本轮没有重新调查上游，也没有运行接入实验。
- [10] 已落地的聊天重构：`web/src/chat/dsh/README.md；web/src/chat/nativeProjection.ts；web/src/chat/dsh/use-chat-scroll.ts；shared/src/nativeExecution.ts；SessionChat.tsx:709,1428`。源码明确保留 DSH 5badb150 的版权／适配说明；原生与传统正文并存。这个移植现在是既有 HAPI 能力，不再列作 tmux 待开发项。
- [11] 最近展示与后台预热：`web/src/chat/sessionPresentation.ts:74；web/src/hooks/useRecentSessionWarmup.ts；web/src/lib/recent-session-warmup.ts；对应 .test.ts`。5 项 LRU、单 active、串行预热、主动切换清书签均可在实现和测试中对应；测试存在不等于多窗格已通过。
- [12] 现有验收记录与本轮边界：`docs/chat-experience-contract.md:101,127；web/src/lib/history-page-repository.ts:68；refactor-audit/baseline.json（缓存盘）`。既有文档记录聊天发布及性能结果；本轮只做源码审计和报告验证，未重新证明线上部署状态。工作树快照记录了实际读取的源码。
- [13] 交互草稿的剩余生命周期耦合：`web/src/components/ToolCard/RequestUserInputFooter.tsx:84–98；web/src/components/AssistantChat/VirtualMessageList.tsx:65,150`。工具问题的步骤、选择与输入仍为组件本地状态；聚焦行 pin 只防虚拟卸载。允许工作区隐藏卸载前，需要把这些状态独立保留。

网页计划沿用现有 Lavish 审查入口；构建源与本轮源码快照位于缓存盘 `hapi-workspace-migration`。
