# DSH 子代理支持（HAPI）

## 目标

DSH 会话在 HAPI 里只能看到根会话：DSH 的 ACP 服务端在 `session/resume` / `session/list` 中显式排除 `origin === 'subagent' || parentSession !== undefined` 的会话（deepseek-harness `packages/acp/acp/src/index.ts:253`、`:313`），所以 `spawn_teammate` 创建的队友、`workflow` 子代理和 `subagent_codex` 外部子代理在 HAPI UI 中完全不可见。本改动让这些子代理出现在父子列表与聊天工具卡里，并用主会话同一套 assistant-ui chat surface 打开它们的对话；continuable 子代理（DSH Agent Team 队友、spawn 子会话）可以从 HAPI 追加消息和停止。

上层约束：不改 DSH 源码。扩展点仍是 HAPI 注入 DSH 的 Cordis 控制插件（`cli/src/dsh/utils/dshControl.ts` 的 `DSH_CONTROL_PLUGIN`）。DSH 侧只使用公开服务：`sessions`、`sessionQuery`、`subagents`、`agents`、`agentTeams`。

真实安装的 `acp` profile 组合（`~/.dsh/profiles/acp/package.json`）为：`dsh-base` + `dsh-acp-app` + `dsh-subagent-codex` + `dsh-experimental-agent-team-profile` + cot-translation + session-search + session-titles。`agent-team-profile` 会停用 `tool-subagent`/`tool-subagent-fork`/`tool-subagent-control`，以 `freshProvider: spawn`、`forkProvider: fork` 挂 `tool-agent-team`。因此：

- 队友（`spawn_teammate`）是 spawn provider 的本地子会话，`mode: continuable`，有独立 DSH 会话日志；
- `workflow` 的子代理同样是本地 spawn 会话；
- `subagent_codex` / `subagent_claude_code` 是 external provider，只有目录行，没有本地会话可读；
- `context: 'fork'` 的队友日志带继承前缀，读取时必须跳过 `inheritedEventCount`。

## 线协议

### 1. 控制插件（CLI → DSH 进程，本机回环 HTTP，已有 bearer token 通道）

现有 operation 不变：`claim-root`、`permission`、`title`、`preflight`。新增：

```jsonc
// 直接子代理目录（不递归）
{ "operation": "subagents", "sessionId": "<root dsh session id>" }
// → { "ok": true, "children": [{
//     "sessionId": "session-…",
//     "mode": "continuable" | "one-shot" | "external" | "unknown",
//     "label": "…",              // 目录 label，可能缺失
//     "name": "Ada",             // team 成员名，非队友缺失
//     "teamStatus": "running"|"inactive"|"provisioning"|"failed", // 仅队友
//     "provider": "spawn",       // 仅队友
//     "activity": "running" | "inactive",
//     "createdAt": 1234,
//     "settledMs": 0, "openSince": 1234, "lastTurnCompleted": true
// }] }

// 子会话对话分页。游标是稳定的消息下标（整数），不是字节偏移。
{ "operation": "transcript", "sessionId": "<child dsh session id>",
  "limit": 80, "after": 12, "before": 40, "epoch": "…" }
// → { "ok": true,
//     "sessionId": "session-…",
//     "epoch": "<stable per log>",
//     "messages": [{ "seq": 13, "role": "user|assistant|tool", "kind": "message|reasoning|tool-call|tool-result",
//                    "text": "…", "createdAt": 1234, "callId": "…", "toolName": "bash",
//                    "input": <json>, "output": <json>, "isError": false, "truncated": false }],
//     "before": 13 | null,      // 继续向前翻页的游标（第一条消息的 seq；null = 已到起点）
//     "hasMore": true,
//     "after": 57,              // 下一次增量读取的起点 seq
//     "hasLater": false, "reset": false, "truncated": false }

// 向 continuable 子代理追加一条人类消息
{ "operation": "prompt", "rootSessionId": "…", "childSessionId": "…",
  "requestId": "…", "text": "…", "delivery": "queue" | "steer" }
// → { "ok": true, "messageId": "…" }

// 停止 continuable 子代理当前执行
{ "operation": "interrupt", "rootSessionId": "…", "childSessionId": "…" }
// → { "ok": true, "accepted": true }
```

失败一律沿用现有 `400 { "error": "…" }`。`prompt`/`interrupt` 走
`ctx.get('subagents').prompt({ mode: 'continuable', parentSessionId, childSessionId, requestId, delivery, content: [{ type: 'text', text }] })`
与 `interruptByParent(childSessionId, parentSessionId, 'continuable')`；两者都要求父会话 Agent 仍然 live，返回码 409/400 由 CLI 原样上报。

### 2. 共享协议（`shared/src`）

- `DshSubagentModeSchema = z.enum(['one-shot','continuable','external','unknown'])`
- `DshSubagentSchema`（写入 `MetadataSchema.dshSubagents`）：
  `sessionId`、`label?`、`name?`、`mode`、`activity: 'running'|'inactive'`、`createdAt`、
  `settledMs?`、`openSince?`、`lastTurnCompleted?`、`provider?`、`teamStatus?`
- 消息沿用 Codex 子代理的通用形状：`SubagentMessageSchema` =
  `{ id, role, kind?, text, createdAt, callId?, toolName?, input?, output?, isError?, truncated? }`。
- RPC（会话级，不是机器级）：
  - `ReadDshSubagentMessages: 'readDshSubagentMessages'`，请求
    `{ sessionId, limit, before?, after?, epoch? }`（父会话由 RPC 通道确定），
    响应 `DshSubagentMessagesResponseSchema`（与 Codex 响应同构，`sessionId` 替代 `threadId`）。
  - `PromptDshSubagent: 'promptDshSubagent'`，请求 `{ sessionId, text, delivery, requestId }`，
    响应 `{ messageId?: string }`。
  - `InterruptDshSubagent: 'interruptDshSubagent'`，请求 `{ sessionId }`，响应 `{ accepted: boolean }`。
- 消息 id 形如 `<childSessionId>:<index>`，末尾数字是该子会话转录里的稳定下标，Web 层据此做分页游标；
  `after` 是下一条待读消息的下标，`before` 是向前翻页的排他上界。

### 3. Hub（`hub/src`）

- `GET  /api/sessions/:id/dsh-subagents/:subagentId/messages` → `engine.readDshSubagentMessages`
- `POST /api/sessions/:id/dsh-subagents/:subagentId/prompt` → `engine.promptDshSubagent`
- `POST /api/sessions/:id/dsh-subagents/:subagentId/interrupt` → `engine.interruptDshSubagent`

授权：父会话必须 `flavor === 'dsh'`、`metadata.dshSessionId` 存在、`metadata.dshSubagents` 包含
`subagentId`、machine 归属当前 namespace 且在线（消息读取与 prompt 还要求会话 active）。
沿用 `requireSessionFromParam` / `machine.namespace` 校验和 `Cache-Control: private, no-store`。

### 4. Web（`web/src`）

- `api.client`：`getDshSubagentMessages`、`promptDshSubagent`、`interruptDshSubagent`。
- 通用读取器 `SubagentHistory`（由现有 `CodexSubagentHistory` 泛化）：注入 `read(options)` 与
  `cursorOf(message)`，保留 2s 跟随、前后分页、窗口上限、epoch reset。
- 通用投影 `projectSubagentBlocks(messages)`：把 `SubagentMessage[]` 转成主会话同款
  `VisibleChatBlock[]`（user-text / agent-text / reasoning / tool-call），供 assistant-ui thread 渲染。
- 只读 runtime：用 `useExternalStoreRuntime` + `fromThreadMessageLike` 构造，渲染
  `THREAD_MESSAGE_COMPONENTS`，与主会话同一气泡/工具卡/折叠样式；continuable 子代理追加输入框
  （queue/steer + Stop）。
- 入口：会话侧栏 native subagent 树（Codex + DSH 共用）和聊天内 `spawn_teammate` / `wait_agent` /
  `subagent_codex` 等工具卡上的「打开子代理」入口。
- 路由：`/sessions/$sessionId/subagents/$subagentId`，在 `SessionWorkspace` 的 chat 槽内渲染，
  保留返回栈与移动端返回手势；`CodexSubagentDialog` 迁移到同一视图。

## 数据映射（DSH 事件 → SubagentMessage）

按 `snapshot.events` 顺序，跳过 `seq < inheritedEventCount` 的继承前缀：

| DSH 事件 | 输出 |
| --- | --- |
| `user/message` (`data` 即 UserMessage) | `role:'user'`, `kind:'message'`, text=text blocks 拼接，image block 记 `[Image attachment]` |
| `assistant/message` | text blocks → `role:'assistant'`, `kind:'message'`；reasoning blocks → `kind:'reasoning'`；内容里的 `tool-call` block → `role:'tool'`, `kind:'tool-call'`（`callId`/`toolName`/`input=JSON.parse(arguments)`） |
| `tool/call` | 仅当 `callId` 未从 assistant message 取得时补一条 `kind:'tool-call'` |
| `tool/result` | `role:'tool'`, `kind:'tool-result'`, `callId=message.toolCallId`, `isError`, `output`=content 文本 |
| 其他事件 | 忽略 |

`createdAt` 取事件 `time`；单字段上限 64k 字符，超出截断并置 `truncated`。`epoch` 由
`header.id + header.createdAt` 组成；`after` 超过消息总数或 epoch 不匹配视为 `reset`。继承前缀按
`seq < inheritedEventCount` 跳过。

## 分期（全部并入 P1）

1. 共享协议 + DSH 控制插件 + CLI 会话 RPC（目录、转录、prompt、interrupt）。
2. Hub 路由与授权。
3. Web：通用读取器/投影、子代理 chat 视图（复用主会话 thread）、侧栏树、工具卡入口、
   continuable 输入，`CodexSubagentDialog` 迁入同一视图。
4. 测试：CLI vitest（插件 + launcher）、hub bun test（路由）、web vitest（树 + 视图 + 读取器）、
   `bun run typecheck:cli|hub|web`，真实 DSH 会话 smoke（spawn 队友 + workflow 子代理）。

## 验证边界

- DSH external 子代理（`subagent_codex`）只显示目录行，不提供对话，因为 DSH 不保存本地子会话。
- 转录页大小以消息条数计（`limit` 1..100），不做字节窗口；长时间队友会话依赖前后分页。
- HAPI 只镜像 HAPI 接入之后的 DSH 子会话；更早历史仍以 DSH Web 为准。

## 验证记录（本机）

- **shared**：`cd shared && bun test src/sessionSummary.subagents.test.ts` → 3 pass；新增用例覆盖 `dshSubagents` 经
  `MetadataSchema` 校验和 `toSessionSummaryMetadata` 投影、未知 mode 与负数耗时被拒绝。
- **CLI**：`cd cli && bunx vitest run src/dsh` → 66 pass（控制插件 14、launcher 21、其余 DSH 31）。
  `bunx tsc --noEmit` 只剩 `codexRemoteLauncher` 缺失模块的既有错误，DSH 相关文件无新增错误。
- **Hub**：`cd hub && bun test src/web/routes/dshSubagentMessages.test.ts` → 11 pass；
  `bunx tsc --noEmit` 通过。
- **Web**：`bunx tsc --noEmit` 与 `bun run build` 通过；新增用例
  `bunx vitest run src/components/subagent src/components/SubagentChat src/components/SessionList.subagents.test.tsx src/components/ToolCard/SubagentToolLink.test.tsx`
  → 55 pass（含子代理页 8 项：共享 thread 渲染、continuable composer、Stop、只读态、Codex 迁移、轮询开关）；
  SessionList 相关 137 个文件 1593 个用例通过。全量 web 套件里 43 个失败集中在 PWA/service worker/native/
  fixtures/文件管理，单独复跑 `SessionList.recent-window.test.tsx` 通过，与本改动无关。
- **真实 DSH smoke**：`cli/scripts/smoke-dsh-subagents.ts`（可写 `DSH_HOME` 加一份真实 v3 子会话日志副本）验证：
  - 新建空会话时控制插件在真实 Cordis 运行时加载，`subagents` 返回空目录、`transcript` 返回稳定 epoch 与游标；
    对不存在的子会话，`prompt` 按 DSH 语义拒绝（`subagent cannot be resumed`），`interrupt` 返回 accepted。
  - 读取真实队友会话（`session-a340…`，v3→v4 迁移后 seed 切点之后的 5900+ 事件）：tail 窗口 12 条 =
    3 reasoning + 3 assistant + 3 tool-call + 3 tool-result，前后分页无重复无遗漏，说明真实 DSH 事件到 HAPI
    转录行的映射可用。
- **真实模型端到端（DSH 控制层）**：`cli/scripts/smoke-dsh-subagent-spawn.ts` 用真实 `spawn_teammate` 验证：
  - `subagents` 目录出现队友 `smoke-ajax`（`mode: continuable`、`provider: spawn`），运行期间观察到
    `teamStatus: provisioning` / `activity: running` / `openSince`。
  - 子会话转录 8 条：4 user（含注入上下文）、1 reasoning、1 tool-call、1 tool-result、1 assistant，队友回复 PONG，
    tool-call/tool-result 带 `callId`。
  - `prompt` 追加 PONG2 被接收，转录增长到 10 条并出现新的 user（PONG2）与 assistant 消息；
    空闲子代 `interrupt` 返回 `accepted: true`；最终目录为 `inactive`、`settledMs: 8377`、`lastTurnCompleted: true`。
- **真实 HAPI 全栈端到端**：`scripts/testing/dsh-subagent-stack-smoke.sh`（本地 hub + `hapi runner start-sync`
  + 真实 DSH 会话 + 真实模型，退出时清理 DSH 会话目录），经 Web API 完成：
  - `POST /api/machines/:id/spawn`（agent=dsh）→ 会话 active；
  - 发消息让 agent 调 `spawn_teammate` → `GET /api/sessions` 的 `metadata.dshSubagents` 出现
    `stack-ajax`（`teamStatus: running`、`activity: running`）；
  - `GET /api/sessions/:id/dsh-subagents/:child/messages` 返回真实子会话转录（6 条，含 tool-call）；
  - `POST .../prompt` 返回 `messageId`，随后同一路由读到 PONG2 回复；
  - `POST .../interrupt` 返回 `{ accepted: true }`。
  说明「CLI 会话 RPC → 控制插件 → DSH」和「Web → hub 路由 → 会话 RPC」两段链路都真实跑通。
  该脚本加固进程组与端口预检后重复执行两次通过，退出后端口释放、DSH 会话目录已删除。
- **清理**：两轮 smoke 创建的真实 DSH 根/子会话目录已从 `~/.dsh/sessions` 删除，未污染 DSH Web 历史。

## 全量测试（2026-10-20）

`bun run test` 在 CLI 阶段失败后中止（编排器遇错停止），其余套件逐个补齐：

| 套件 | 结果 | 失败归属 |
| --- | --- | --- |
| cli | 3168 pass / 18 fail（3 文件） | `codex/shared/runtime.forkPayloads`（单独复现，既有）、`codex/shared/nativeHistory` 与 `cursor/cursorLegacyRemoteLauncher`（单独复跑通过，并行负载下的超时抖动） |
| hub | 1641 pass / 1 fail | `sync/opencodeClear`（单独复现，既有；该文件在本次会话开始前已有未提交修改） |
| web | 4801 pass / 45 fail（15 文件） | 全部集中在 PWA/service worker/native/fixtures/文件管理/SessionList 虚拟列表超时；子代理相关用例零失败，`SessionList.recent-window` 单独复跑 15/15 通过 |
| shared | 367 pass / 0 fail | — |
| relay | 118 pass / 0 fail | — |
| integration | 61 pass / 1 fail | `codex-lineage`（单独复现，既有） |
| browser-harness | 32 pass / 0 fail | — |
| mobile | 36 pass / 0 fail | — |

> 备注：生成本记录期间，另一个会话正在同一工作区添加 `qoder` flavor（`shared/src/flavors.ts`、
> `modes.ts`、`apiTypes.ts`），报告时 `web` 的 `tsc` 会因 `NewSession/types.ts` 缺少 `qoder` 键报错，
> 与本改动无关；本节全量结果取自该并发修改落盘之前的运行，之后已复跑 DSH 相关用例（shared/hub/cli/web 共 456 项）全部通过。

`bun run typecheck`：hub/relay 通过；web 因并行编排在 cli 失败后被 SIGINT 取消，单独 `web && bunx tsc --noEmit`
通过；cli 失败于既有的 `codexRemoteLauncher` 缺失模块与 `nativeThreadMigration` 类型错误（均非本次文件，
本次新增/修改的 DSH、shared、hub、web 文件无类型错误）。

## 浏览器肉眼验收

用 `web/e2e-fixtures/workspace-fixture.tsx` 的真实 App/Router 渲染（只模拟 Hub 边界），Vite dev server +
`webshot` 截图，产物在 `/mnt/cache/data-cache/shots/`。新增的 fixture 场景由参数开启，不影响既有用例：

- `?single&dshSubagents`：父会话带两个 DSH 子代理（running 队友 Ada、one-shot 侦察），根部对话含一条
  `spawn_teammate` 工具卡。
- 展开树行用截图脚本的 `--ready-js` 点击 `.app-session-subagent-toggle`，不需要改组件状态。
- `&subagent` 打开 `/sessions/chat-1/subagents/session-ada`；`&subagent=ops` 打开只读的一次性子代理。

已肉眼确认：

- 桌面与移动端 Folders 侧栏都出现 `Subagents (2)` 入口；展开后移动端显示
  `Ada / DSH · Continuable · Running`、`一次性侦察 / DSH · One-shot · Inactive` 两行，桌面紧凑主题按既有
  密度规则隐藏副标题。
- 根部聊天里 `spawn_teammate` 工具卡渲染出 `Open subagent Ada` 入口。
- 子代理页头部是 `DSH 子代理验收 → Ada` 面包屑 + `DSH / Continuable / Running` 徽标 + 累计时长；
  正文气泡、Reasoning 折叠、bash 工具行与主会话同一套组件；底部是 `Message this subagent…`、
  Delivery/Queue、Stop/Send。
- 只读子代理页显示 `DSH / One-shot / Inactive`、转录正文和 “This subagent accepts no further input: the
  transcript is read-only.”，没有输入框。
- 运行中的最后一条 assistant 文本带有 assistant-ui 的流式光标（截断是平滑流式动画的中间帧，等待后文本完整），
  与主会话行为一致。

### 外部子代理的委派记录（真实使用反馈）

外部 provider（`subagent_codex`、`subagent_claude_code`）不落本地会话：Codex 用 `ephemeral: true` 的
一次性 thread，Claude Code 用 `persistSession: false`，所以没有逐步转录可读。但它们留下了两份真实记录：
父会话里的委派工具调用（任务 prompt），以及 DSH 注入父会话的 settlement 消息（`source.kind =
'subagent-settled'` / `senderSessionId`，含最终输出或失败诊断）。

外部子代理页现在从父会话日志重建这两段内容，用同一套聊天组件渲染成只读两段式对话：

- 任务：匹配「tool 结果里带 `started subagent <childId>`」的调用，读取其 `prompt`；老日志没有该 id
  时回退到第一个带 prompt 的 `subagent_*` 调用；
- 结果：按 `senderSessionId === childId`（或文本含 childId）找 settlement，取 `Its closing message:`
  之后的内容；失败子代显示失败摘要与诊断；
- 页面隐藏分页/跟随控件（记录是固定的），底部说明这里只有委派任务与最终结果，没有外部 provider 的
  逐步转录；工具卡的「打开子代理」入口对外部子代恢复可用。

真实数据验证：用户截图里的会话 `29607a91…`（`/home/chris`）与子代 `e8166336…`（label
`Review HAPI DSH integration design`）经 `cli/scripts/smoke-dsh-subagents.ts <cwd> <root> <child>`
读出 2 条消息：任务 prompt 全文与最终结论（「建议保留现有 ACP 接入方式…」）；另一个失败子代
`b668c488…` 正确显示 `It left no closing message.` 与 `Product subagent failure (…)` 诊断。
截图：`dsh-external-record-mobile-zh.png`、`dsh-external-record-desktop-zh.png`。

## 上线与生产验证（2026-10-20）

用户反馈 external 子代理页仍为 "No messages yet"。根因不是最新代码，而是线上构建停留在中途快照：

- 当时 hub/runner 是 release `20261020T103332Z-f692c41921`（git HEAD `f692c419`）。该 commit 在功能改到一半时
  被另一个会话提交：`SubagentSessionPage` 的 external 分支还是伪造空转录（`messages: []`），CLI 也没有
  `external-record`，所以页面只能显示空记录；
- 正在查看的会话 `c44dcdb6` 由更早的构建 `20261020T064319Z-10fc78db40-working` 启动，其注入的 control 插件
  （`dsh-control-bE75ui`）只有 `subagents/transcript/prompt/interrupt`，没有 `external-record`；插件在 DSH
  进程启动时生成，无法热更新，所以即使只部署新代码也必须重启会话才能生效；
- 父会话在 hub 消息库里只有 "started subagent …" 的 tool 结果，没有 settlement 文本（旧 CLI 未转发注入消息），
  因此不能靠 hub 侧重建；必须由新插件从 DSH 父会话日志读取。

处理：

- 提交 `879ebb4f`（12 个文件，全部为本功能）。
- 发布 release `20261020T110758Z-879ebb4f80`，组件 hub+runner；Windows 组件本轮跳过（SSH 认证失败，
  `--skip-windows`），Windows 上的 runner 仍是旧版。
- 停掉 `c44dcdb6` 的孤儿旧进程并用 `POST /api/sessions/:id/resume` 重启它和 `cb8b5d1e`；两个新进程都来自新构建。

生产验证：

- `GET /api/sessions/c44dcdb6…/dsh-subagents/e8166336…/messages` 返回 2 条：`Review HAPI DSH integration
  design` 的完整任务 prompt + 最终结论「建议保留现有 ACP 接入方式…」；
- `cb8b5d1e…/509918ed…` 返回 "Use bash to run sleep 25, then reply DONE." + "DONE"；
- 用 webshot 注入 access token 截取线上页面：`prod-external-mobile-zh.png`、`prod-external-desktop-zh.png`
  显示真实内容（长结论、优先级表、三个 PR 建议），底部为外部委派记录说明。

注意：早于本次发布创建的其它 DSH 会话若也有 external 子代，需要各自 resume/重启一次才会加载新插件；本次发布后
新建的会话自动具备。`subagent_codex` 本身当前在本机持续以 `access-policy` 失败（本地栈测试同样复现），记录页会把
这类失败如实显示为失败摘要 + 诊断。
