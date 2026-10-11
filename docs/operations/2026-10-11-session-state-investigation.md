# HAPI 会话状态、时间与跨设备辨识调查

调查时间：2026-10-11 UTC。范围为当前源码、实际部署入口、本机 tmux 实现和只读线上观测；没有重启服务、恢复会话、发送输入或调用模型。本文是调查结果，不表示修复已经上线。

## 结论

问题存在于状态事实、时间语义和设备归属三条链路，不是换一套状态栏样式就能解决。

用现有生产类和测试夹具完成了三项隔离回放，三项均违反预期：原生 idle 没有清除运行标志；同一轮完成后迟到的 started 会重新激活；晚到的旧 SSE 运行补丁会覆盖较新的空闲状态。前两项直接检查 `ApiSessionClient.keepAlive` 的实际参数，第三项调用网页实际使用的 `applySessionDetailPatch`。

同时，当前按所属引擎逐个读取的 22 个 Linux 活跃 HAPI 会话，`thinking` 与原生 `status.type === active` 均一致。两种证据并不冲突：静态快照正常，不能覆盖状态转换、事件乱序和断线恢复。不能用当前快照反推截图时刻没有问题。

## 一、本机 tmux 路径实际具备什么

已追踪 `.tmux.conf`、常用菜单、`tmux-agent-picker`、`codex-session-listener` 和 `agent-tmux-notify`。当前配置中会话选择器绑定为 prefix+a，菜单也进入同一个 picker；本轮没有逐键复现用户提到的 Ctrl+B、空格、T 入口，不能声称快捷键完全对应。

| 环节 | 现有 tmux 实现 | HAPI 对照结果 |
|---|---|---|
| 原生状态 | listener 解析 `thread/status/changed`，保留 active、idle、systemError、notLoaded 和等待标志 | SharedCodexRoot 没有将这个状态作为运行事实 |
| 轮次终结 | listener 对同一 turn 已 completed/failed/interrupted 后迟到的 inProgress 做拒绝；也检查更旧的 UUIDv7 turn | root 的 started 分支直接覆盖 currentTurn |
| 身份 | 对 server、client、tmux server、pane 的进程代际和归属逐项校验 | HAPI 有运行时所有权机制，但状态补丁没有相同完整的事件代际/次序语义 |
| 注意力 | 原生等待标志和真实 turn 完成驱动 input/done；关闭连接时清理 pane 状态 | HAPI 的 pending、thinking、background、unread 分散于多个分类器 |
| 时间 | picker 的 Codex age 来自绑定 rollout 的 mtime；Claude 使用状态更新时间与 transcript mtime | HAPI 还混入浏览器导入时间、Hub 更新时间与原生更新时间 |

值得复用的是 listener 的状态事实、进程代际、终结保护和注意力语义。不能整套盲搬：picker 的 Codex `is_working` 仍然用“rollout 最近 60 秒有写入”作启发式判断，并不是精确的原生 busy 状态。长时间无输出和刚完成的轮次都可能被这个启发式误判。

源码：

- `/home/chris/src/codex-tmux-integration/features/session-listener/session_listener/metadata.py`：`runtime_status`。
- 同目录 `cli.py`：`_consume_metadata`、`_deliver_attention`。
- `/home/chris/src/codex-tmux-integration/features/window-attention/bin/agent-tmux-notify`：`sync_listener_event`。
- `/home/chris/repo/tmux-agent-picker/lib/agent_sessions.py`：`codex_registry`、`describe_codex`、`is_working`、`age_of`。

## 二、已经确认的状态缺陷

### 1. 运行事实被压缩为一个本地 currentTurn

`cli/src/codex/shared/root.ts:109` 的 started/completed 分支维护 currentTurn；`:337` 的心跳只上报 `Boolean(currentTurn)`。`refreshNow` 从历史 turns 的 inProgress 恢复这个值，但不采用 thread.status。

因此原生 idle、notLoaded、systemError 或等待标志，并不能独立纠正这个本地缓存。不能假设历史 turn 状态与当前引擎状态永远一致；只靠“已开始但尚未收到结束”也不能覆盖丢通知和关闭引擎的情况。

回放 A：`turn/started(A) → thread/status/changed(idle) → activate/keepAlive`。预期不再报告运行，实测心跳仍传 true。

回放 B：`turn/started(A) → turn/completed(A) → 迟到的 turn/started(A) → keepAlive`。预期 A 保持终结，实测又传 true。tmux listener 已经有针对这种同轮迟到 started 的处理。

另外，`publishSteering` 检查 reconnecting 和连接初始化状态，心跳没有同样检查。原生连接已丢、HAPI 到 Hub 仍连着时，旧 currentTurn 可以继续被心跳报告为运行。此项为源码确认，本轮没有主动断开生产连接验证。

### 2. 状态补丁没有次序保护

`shared/src/schemas.ts:428` 的 SessionPatch 对 metadata、agentState 等内容有版本包装，active/thinking 没有。Hub `markSessionActive` 对 activeAt 取最大值，却无条件接受 thinking；网页 `sessionPatch.ts:65` 和 `useSSE.ts:535` 也直接覆盖状态。

`App.tsx` 在普通会话模式可能同时开启全局和会话 SSE。两条流各自有顺序，不代表它们共同有顺序；REST 快照与流式更新也需要同一套新旧判定。

回放 C：已有 `thinking=false, activeAt=3000`，收到迟到的 `thinking=true, activeAt=2000`。网页实际补丁函数将 thinking 改回 true，activeAt 也倒退。这能解释某类来回闪动，但本轮没有抓到截图时刻的两条网络流，不能断言那一次闪动就是此竞态。

### 3. 多个入口对“运行”的定义不一致

- `SessionList.tsx:1549` 的 Running 计数包含 thinking、待处理请求或后台任务。
- `bucketRunningSessions` 先判断 thinking/background，再判断 pending。
- `classifySessionAttention` 优先 pending，再判断其他状态，且所选行抑制部分注意力展示。
- `WorkspaceActivity` 又单独处理 offline、permission、input、running、background、idle。

因此一个等待用户的会话仍可能进入 Running 计数，在不同入口显示不同状态。异步问题尤其不能简单等同于阻塞：需要区分“执行中且有未答问题”和“已阻塞等待回答”，保留现有异步问题能力。

### 4. 断线失活补丁不完整

`expireInactive` 在 Hub 内把 active 和 thinking 都清成 false，但 SSE 只发送 `{active:false}`。已经连着的浏览器会保留旧 thinking，重新 GET 的客户端得到 false，两者可以产生不同状态。虽然 spinner 通常另有 active 条件，`classifySessionAttention` 仍会被残留 thinking 阻止显示未读。失活应发布同一个版本的完整状态变化；轮次时间和后台任务是否保留必须按事实明确处理，不能靠隐式残留。

### 5. 原生轮次开始时间没有完整贯通

`markMessageQueued` 使用 Web 排队时间设置 activeTurnStartedAt，普通原生 thinking 心跳从 false 变 true 时却不设置它。本轮曾观察到 HAPI Main 原生轮次 inProgress 且有 started_at，而 Hub 的 activeTurnStartedAt 为 null。排队时间也不能当作引擎真实开始时间。应贯通实际 turnId 和 startedAt，并把 queuedAt、startedAt、completedAt 分开。

## 三、时间为什么会错、为什么不同客户端不同

### 浏览器导入时间覆盖会话活动时间

`SessionRowSummary.tsx:81` 只要找到本地导入记录，就直接使用 importedAt；它没有和最近活动取一致语义，也没有随原生继续执行而自动结算。记录来自 `hapi.codexImportedSessions`，仅以原生 thread ID 为 key，既不含 Hub/namespace，也不含机器。

清理导入记录的发送成功回调只处理该浏览器里通过 HAPI 发出的消息；从官方 App 或另一个浏览器继续会话，无法清理当前浏览器的标记。这是同一会话在两个客户端显示不同时间的确定代码路径。没有读取用户手机的 localStorage，因此不能把截图中的 24m 精确归因于某一条导入记录。

### 不同时间字段有不同职责

- activeAt 是连接心跳，不能当成会话最近活动。
- 原始 session.updatedAt 包含 Hub 侧变更，普通 agent 消息并不都会推进它。
- Codex 列表已优先使用 metadata.codexUpdatedAt；这部分能力应保留，不能推倒重做。
- 外部原生 bridge 每 20 秒读取一次 Codex SQLite 更新时间，可能有约一个采样周期的更新延迟；不等于 native status 的实时通知。
- useSessionListOrder 冻结的是排序时间，目的是避免用户操作时行移动；当前行时间标签没有使用这份冻结值。不能误把它认定为所有旧时间标签的根因。
- 相对时间函数没有自己的刷新时钟，标签依赖其他渲染触发。空闲页面的年龄增长也应单独验证。

修复时必须把“排序位置保持稳定”与“标签时间继续正确更新”分开。不能为了显示最新时间又让列表来回重排。

## 四、跨设备问题分成三个层次

### 已确认的手机归属信息丢失

`desktop-session-density.css:12` 将机器图标默认隐藏，只在 >=920px 桌面重新显示。`SessionList.tsx:967` 的 workspaceLocation 查的是网页工作区树；`SessionRowSummary` 在手机有这个位置时，以工作区名字和 pane 号替代带机器标签的备用行。

所以截图里的 TH/P1、W1/P3、MPT/P1 都是网页目的位置，不是 Windows/Linux 或远端 tmux 身份。用户很容易把另一台机器的会话当成本机会话。机器身份必须始终可见，工作区位置只能补充它。

### 已确认的客户端状态分裂

sessionLastSeen、manualUnread、导入记录及排序快照都来自浏览器本地。localStorage 的 storage 事件只能同步同一浏览器存储范围内的标签页，不会同步手机与桌面。

已读属于用户状态，不能由各设备独立猜测成一个“全局已读”状态。修复应让 Hub 保存用户的已读游标，客户端缓存用于即时反馈；真实执行状态则由所属机器上报，不能被阅读动作改变。

### 已确认的机器隔离缺口，但尚无本次串机实例

`SessionCache.extractAgentSessionId:1656` 仅 Pi 把 machineId 放进去重身份，Codex 仅按 codexSessionId 去重。跨机器同步/拷贝 Codex 历史后，相同原生 ID 可能触发跨机器合并。

当前 87 条列表记录中未发现跨机器同 flavor/native ID 的重复，所以这属于确定存在的隔离缺口，不是已证明发生在本截图里的合并。网页 sessionHierarchy 已按 machineId/flavor/threadId 区分父子关系，应保留这一正确处理。

## 五、线上观测与限制

按运行时所有权文件定位真实所属引擎，仅执行 initialize、thread/read(includeTurns=false)，读取 22 个 Linux 会话，未发现当下 thinking/active 类型不一致。HAPI Main 和实现文件互传工具当下原生均 active，HAPI 也报告运行。

OpenHarmony 是独立 HAPI 引擎拥有的会话；在桌面共享 daemon 上读同一历史 ID 会得到 notLoaded，在实际拥有者引擎上读则 active。比较前必须先确认拥有者，不能拿某一个 daemon 的快照当所有会话的全局事实。

Linux bridge 实际使用 Oct 7 构建入口，Hub 使用 native-open 构建入口，工作树另有未发布改动。调查对照了这些入口，隔离回放运行的是当前工作树代码，不宣称已完成所有已发布资源的一致性验收。

本轮 Windows SSH 在 banner 阶段超时，没有重启任何组件。SSH 不通不证明 Windows 设备离线，也不证明它到 Hub 的连接失败；Windows 原生事件与 HAPI 状态的同刻对照仍待完成。

## 六、建议的修复边界与验收

1. 复用 tmux listener 已验证的原生状态语义，在 Windows/Linux 共用 root 适配层处理 status、等待标志、turn 终结及源引擎代际；与传输在线、排队、后台任务、未读分开保存。
2. 给执行状态提供 Hub 接受后的单调版本。全局 SSE、会话 SSE、REST 快照都按此版本接收。仅比较不同设备的墙钟不能替代版本；沿用现有 metadata/state 版本机制的做法，不新增哈希验证。
3. 对断线采用明确的连接状态和快照恢复，停止用旧 currentTurn 心跳证明原生执行仍有效；原生 notLoaded 不等于本地历史丢失。
4. 统一列表、Running 过滤、workspace 和 composer 的分类器。异步未答问题可以与执行中并存，阻塞等待另有明确事实。
5. 移除导入时间对活动标签的覆盖；保留原生活动来源、稳定排序与有界缓存。单独刷新相对时间，不重排列表。
6. Codex 身份按 namespace/机器/原生存储归属/thread 区分，展示机器图标。已读按用户共享，工作区位置保持为导航信息。

验收需要同一事件序列覆盖：started/completed/迟到 started、idle/notLoaded/systemError、阻塞与异步问题、断线中持续 Hub 心跳、引擎重启、快照与通知交错、双 SSE 乱序、同原生 ID 位于两台机器、手机与桌面互相阅读及官方 App 继续会话。比较所有入口的状态、标签和计数，不能只检查截图或一次 GET。

本次只完成调查和隔离复现，未修改产品实现，未上线。
