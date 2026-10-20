# 底部导航：window 按内容命名，pane 名退出底栏

2026-10-20。tmux 式 workspace 的底栏原来并列显示「pane 列表（P1 + session 名）」
和「window 列表（自定义名）」。桌面端的 pane 名与 pane header 重复，window 名
`Window 1/2/3` 又不携带内容信息；移动端 3 个窗口时当前窗口会被挤出可视区。

## 改后的模型

- **底栏只剩 window 列表。** 每个 tab 显示位置序号（对应 Ctrl-b 1–9）＋该
  window 当前 focused pane 的 session 名；pane 是 empty / terminal / document
  时回退到 header 的标签（`新窗格`、`Terminal · 会话名`、文档名）。状态点聚合
  该窗口全部 chat pane，按 error > permission > input > running > background >
  idle 取最紧急的一个。
- **桌面端不再显示任何 pane 名或序号。** pane 名留在各自 header；pane header
  新增 `＋`（新窗格），点击后聚焦该 pane 再向右拆分并打开会话选择器。`P＋`
  在移动端仍在底栏。
- **window 自定义名退成别名。** 新窗口默认按位置命名（`W1`、`W2`…），文档新增
  可选字段 `autoName`；重命名（Window actions → Edit window alias）把它置为
  `false`。别名只出现在 Move to 和 Switch window 对话框；底栏标签始终跟随
  focused pane。老文档没有 `autoName`，名字保持原样，只把 `Window N`/`窗口 N`
  这类旧默认文本按位置显示成 `Wn`（纯展示，不改存档）。
- **移动端不再把 chat header 塞进底栏 dock。** 原来的 96px dock 被挤到只剩图标；
  现在 P 按钮右侧是一个 pane 菜单（`···`），包含 Project files、Open a
  conversation、拆分、最大化、Move to、Move to new window、Close pane。
  窗口菜单保持 window 级操作。
- **窗口列表溢出时把当前窗口滚入视野。** 之前只给 pane 列表做了自动滚动，横向
  滚轮也只作用于 pane 列表；现在两处都按容器是否可滚动决定横滚，否则保持切窗。
- 移动端会话列表里已打开会话的目标徽标改为 `W<位置> · P<pane>`，与底栏序号一致。

## 涉及文件

- `shared/src/workspaces.ts`：`WorkspaceDocument.autoName?`，rename 命令应用时置
  `false`（协议仍是 schemaVersion 2，可选字段向后兼容）。
- `web/src/workspace/windowIdentity.ts`（新）：位置、focused pane、标签、活动聚合、
  别名、自动名生成。
- `web/src/workspace/WorkspaceShell.tsx`：底栏结构、窗口 tab、自动滚动、滚轮、
  pane header `＋`、移动端 pane 菜单、别名重命名入口。
- `web/src/workspace/WorkspacePaneActions.tsx`：Move to 用别名；移动端增加
  Project files 入口。
- `web/src/workspace/workspaceStore.ts`：`create()` 自动名 + `autoName`，重命名规则，
  `project()` 同步别名变化；`WorkspaceActivity` 支持聚合 kind。
- `web/src/components/{SessionList,SessionRowSummary}.tsx`：目标徽标 `W·P`。
- 样式 `workspace.css`、i18n en / zh-CN、`web/e2e-fixtures`、性能脚本
  `scripts/testing/workspace-working-set.mjs`、`web/README.md`。
- e2e：重写 `workspace-window-navigation.spec.ts`、`workspace-pane-navigation.spec.ts`，
  更新 `workspace.spec.ts`、`workspace-sync.spec.ts`、`workspace-lifecycle.spec.ts`、
  `propgen-exploration.spec.ts`、`document-files-return.spec.ts`；新增
  `windowIdentity.test.ts`。

## 验证

- `bun run typecheck:web`、`bun run typecheck:hub`。
- `bun run test:web`：448 files / 4907 tests 通过。
- `cd shared && bun test`：374 tests 通过；`hub/src/web/routes/workspaces.test.ts`
  10 tests 通过（需要可写 TMPDIR，沙箱默认的 `/mnt/cache/data-cache` 只读）。
- Playwright（Chromium，`--workers=1`）：
  - `workspace-window-navigation` 6/6、`workspace-pane-navigation` 5/5、
    `workspace.spec` 23/23、`document-files-return` 6/6、`propgen-exploration` 通过；
  - `workspace-sync` 4/4 需要 `PLAYWRIGHT_WEB_PORT=5188`，测试内 Hub 只允许该 origin。
- `workspace-lifecycle` 的 5 个用例在本机仍失败：其中两个（终端焦点、Code changes
  消失）引用的 `.session-workspace-switch` 在 HEAD 就只存在于 CSS，属于既有失效；
  其余用例依赖 12 个窗口 / 48 个 reader，在可用内存约 2GB 的主机上会超时或崩渲染
  进程，单独串行运行时可以通过。这些与本次改动无关。

验收截图：`test-results/workspace-review/`（gitignored）里的
`new-desktop.png`、`desktop-three-windows.png`、`mobile-three-windows.png`。

## 发布

- 提交 `5e4970fb`（function: "feat(web): navigate windows by focused-pane session names"），
  发布 `20261020T171949Z-5e4970fb23`，components `hub`，`--skip-windows`（web 改动
  不涉及 Windows Runner；当时也避免了已知的 Windows SSH 不可用）。
- 发布顺带包含同分支上已提交的 `1bdbb780`（reasoning/process 行高调整），两者都是 web。
  工作区里其它会话未提交的 CLI 改动没有进入这次 commit，也没有进入发布。
- 发布流程自身已跑通：全仓 typecheck、`test:web`、`test:cli`、`test:hub`、web 构建、
  嵌入式 web assets 生成、Linux 可执行文件构建与 built-artifact smoke，
  最后 `systemctl --user restart hapi-hub.service` 并等待 public `/health`。
- 线上验证：receipt 指向 `5e4970fb`，`hapi-hub.service` active，`/health` 返回
  `{"status":"ok"}`；`/assets/index-mpyvdDTS.js` 含 `Edit window alias` 与 `autoName`，
  `/assets/WorkspaceShell-pLjwW-p2.css` 含 `workspace-window-title/.workspace-window-index/
  .workspace-header-newpane`，旧的 `.workspace-pane-title` 已不存在。
