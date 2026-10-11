# 会话状态、活动时间与跨设备修复

本文对应 [调查记录](2026-10-11-session-state-investigation.md)，记录工作树中的实现与本地验证。代码尚未提交或部署；测试没有重启生产 Hub、Runner 或用户正在使用的 Codex，也没有发送模型输入。

## 修复范围

状态链路为：所属原生引擎 → Windows/Linux 共用 SharedCodexRoot → Hub 接受并编号 → REST、全局 SSE、会话 SSE → 各 UI 入口使用同一分类器。连接在线、原生执行、等待交互、后台任务和用户已读分别处理。

采用了本机 tmux listener 的原生 status/activeFlags、轮次终结保护及拥有者代际原则。没有采用 picker 的“最近 60 秒文件有写入就算运行”启发式。

| 编号 | 已发现问题 | 本次实现 |
|---|---|---|
| 1 | currentTurn 缓存压过原生状态 | 新增 NativeRuntimeStateTracker，采用 active、idle、notLoaded、systemError 和等待标志；历史 inProgress 不再独立证明运行。 |
| 2 | 迟到 started 复活结束轮次 | 记录有界的终结 turn 集合，拒绝 completed/failed/interrupted 后同轮 started，拒绝更旧 UUIDv7 turn。 |
| 3 | 双 SSE、REST 和旧连接回调覆盖新状态 | 执行快照使用持久递增 executionVersion；列表和详情均拒绝旧执行补丁，完整快照按各字段版本合并，关闭的 EventSource 回调失效。 |
| 4 | Hub 接受旧运行报告 | 原生报告包含 owner、generation、sequence；Hub 按连接接管顺序和报告序号拒绝旧源及重复报告。已采用原生报告的同一连接不能再用裸 thinking 覆盖它。 |
| 5 | 原生断线但 CLI 心跳健康时继续 Running | 心跳同时检查原生初始化、重连和停止状态，独立发布 disconnected；CLI 到 Hub 的在线不再证明原生仍运行。 |
| 6 | 失活补丁只清 active | 结束、断线及失活发布同一版本的完整执行快照，清 thinking、轮次计时和后台计数；旧 socket 的结束事件不能关闭新连接。 |
| 7 | 列表、Running、正文和输入栏各自判断 | 共享 classifySessionActivity；阻塞输入和审批不计入 Running。异步问题标为 blocking:false，可以同时显示运行和待答；错误、未读及问题提示不再互相掩盖。 |
| 8 | 排队时间冒充原生开始时间，真实开始时间丢失 | 原生 turn startedAt/started_at 贯通 Hub 和客户端，支持同轮后续快照补齐开始时间；原生排队不制造运行状态。非原生 agent 保留原有队列宽限语义。 |
| 9 | 浏览器 importedAt 覆盖活动时间 | 列表移除导入时间覆盖，Codex 使用 codexUpdatedAt；从官方 App 或另一客户端继续执行也会更新。 |
| 10 | 心跳、内容活动和执行计时混用 | activeAt 只证明连接活跃；codexUpdatedAt 用于 Codex 活动年龄；execution.startedAt/activeTurnStartedAt 用于执行计时。标题的活动标签不再使用心跳时间。 |
| 11 | 活动时间完全依赖 20 秒 SQLite 采样 | turn/item 事件更新活动时间，item 最多每秒上报一次，保留 SQLite 补偿读取。新增 activityOnly 报告只改元数据，不额外使聊天历史失效。 |
| 12 | 空闲页面相对时间停住 | 可见行共用一个分钟时钟，卸载最后一个订阅者时清理定时器；不增加每行轮询。 |
| 13 | 更新时间与稳定排序、日期分组混乱 | 保留列表稳定排序；分组使用同一排序快照，时间标签继续更新；日期筛选仍使用实际活动时间，主动刷新 Recent 才重取顺序。 |
| 14 | 手机隐藏机器身份，工作区号替代设备 | 手机也显示固定机器图标和机器标签；工作区/pane 位置仅补充导航，不能替代机器归属。 |
| 15 | 已读和手动未读只存在单个浏览器 | Hub 按 namespace/user/session 保存版本化游标，PUT 使用 CAS，SSE 仅向同用户同命名空间推送和重放。客户端按 Hub/用户隔离缓存，保留离线待同步操作并拒绝旧账户晚到响应。 |
| 16 | 同 thread ID 跨机器或存储错误合并 | Hub、网页去重及父子归属加入机器和原生存储身份；桌面连接入口也要求机器匹配。 |
| 17 | 状态来源没有完整拥有者与代际语义 | 从 root 绑定的所属原生 endpoint 获取状态，而非任意历史读取器。绑定、刷新与通知交错时保留新通知；Hub 拒绝接管后旧连接的状态、结束及历史活动通知。 |

主要入口：`cli/src/codex/shared/execution.ts`、`root.ts`，`hub/src/sync/sessionCache.ts`，`hub/src/store/sessionPresenceStore.ts`，`shared/src/sessionActivity.ts`，`web/src/lib/sessionSummaryPatch.ts`、`sessionLastSeen.ts`。

Hub schema 从 29 升到 30，新增执行版本表和用户阅读游标表；没有复制聊天正文。Android、iOS 协议模型和补丁处理同步扩展，生成的 SSE fixture 更新了真实轮次开始时间的应用行为。

## 验证与证据

本地组件测试覆盖原生 idle/notLoaded、等待标志、三种终结后迟到 started、原生断线、初次绑定时晚到快照、开始时间补齐、连接接管、旧 SSE/REST、失活完整快照、相同 thread 的机器/存储隔离、异步与阻塞问题、已读 CAS、用户隔离及离线待同步操作。

- 全仓 CLI、Hub、Web、Shared、Relay 和历史读取/依赖/谱系/搜索测试均已运行；CLI 后续边界修补另跑 root 回归测试。
- CLI/Hub/Web/Relay 完整类型检查通过，Web 生产构建通过；已运行 `bun run gen:fixtures`。
- 额外运行 Linux 原生 Codex 集成测试，使用独立临时 CODEX_HOME 和测试专属 app-server，验证原生重命名、遗漏通知补偿及重连。测试通过，没有加载消息正文或调用模型，也没有操作用户已有引擎。
- Android 使用 Java 21 的 `:core:protocol:test` 通过，包含聊天和 SSE fixture 一致性检查。
- `e2e/session-presence.spec.ts` 使用两个独立 Chromium 上下文，分别为桌面与手机宽度，运行实际 router/App/列表，仅模拟 Hub 边界。同原生 ID 的两台机器都保留；较旧 Running 不覆盖新 idle；行 DOM 身份稳定；桌面手动未读同步到另一上下文；旧阅读事件不能撤销它。
- 用 webshot 生成并实际查看 1440×900、390×844 截图，检查机器身份、Running、等待输入和错误可见。截图是模拟数据的布局验收，不是真机或生产连接验收。

本地日志位于 `/mnt/cache/data-cache/hapi-status-*`，浏览器测试为 `hapi-status-final-browser.log`，截图为 `hapi-status-phone.png` 和 `hapi-status-desktop.png`。该目录自动清理，长期依据以仓库内回归测试为准。

## 尚未完成的环境验收

Windows/Linux 使用相同状态适配代码，但本轮没有在 Lis-iMac 实机进行断线、注销或重启验收。前次 Windows SSH banner 超时不能解释为设备离线。本轮也没有用手机 Chrome 真机验证。

本机没有 Swift 工具链，且没有已缓存的 Swift Docker 镜像；iOS 协议变更完成源码对齐，但尚未编译和运行 Swift conformance。不能把 Android 通过当成 iOS 通过。

部署需要协调 CLI、Hub、Web 版本。以上结论只覆盖当前工作树和明确列出的测试，不表示线上故障已经消失，也不包含现有其他 agent 的 Windows Rust supervisor、会话创建或文档工作区改动的上线。
