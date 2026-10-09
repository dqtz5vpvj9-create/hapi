# 历史往返滚动与缓存修复（2026-10-05）

用户报告上拉、补页和下拉回看退步，刚读过的内容又要加载。本轮确认并修复了两处问题。

## 原因与改动

1. `HistoryPageRepository` 原来接收历史分页，却没有接收首次 latest、尾部增量同步和直接跳转的上下文。它们被有界显示窗口淘汰后，回看会重新请求。现在这些入口均接入同一个消息池和页覆盖记录；上下文只证明实际返回区间，不能证明到远端最新位置之间的空洞。并发实时更新、请求取消、权限失效和 epoch 变更仍按既有规则处理。
2. `NativeCodexThread` 向下续页只依赖位置变化。Pixel 9 上可在窗口底部停在第 1000 条，继续 wheel 仍不能回到第 1200 条。现在 wheel/touch 输入到达下边界时也可触发续页，与向上的已有入口对称。位置恢复继续由同一个协调层处理。

缓存仍限制每会话 8 MiB、全局 32 MiB、最多 8 个会话；使用原有 LRU，不扩大 DOM 窗口、不复制正文进数据库、不扫描全历史、不请求模型。预算指序列化 payload 估计，不是浏览器总堆上限。超出容量或历史版本失效仍可能重新读取。

## 验证

- 新增 store 往返测试在修复前失败：1200 条读到最早再返回，GET 从应有的 7 次变成 8 次。修复后首次窗口、上下文窗口和新增尾部消息三种往返均不重读已读区间，消息无遗漏或重复。
- 77 项相关既有/新增检查通过，随后新增的增量往返和上下文容量/覆盖检查也通过（共 79 项不同检查）。Web 类型检查通过。
- Chromium 9 项流程通过：连续跨页、方向反转、预取、触摸接近边界、等待期间继续阅读、缓存续页以及延迟图片尺寸变化时的中间帧。静止阅读位置检查仍要求不超过 1 CSS px，重叠帧为零。
- 原 cached-End 测试硬编码“797.0 段应可见”，在紧凑密度下该段已在屏幕外。诊断时实际可见锚点是 797.1；改为验证旧窗口最后一段 800.2 的位置稳定，并把返回路径延伸到 1200。返回 live 模式允许 afterSeq=1200 的新消息检查，禁止重下已经遍历的历史。
- Pixel 9 / Chrome 151.0.7922.173 使用编译后的合成会话，经 ADB 转发到本机测试服务。修复缓存但未补下边界入口时回放失败于第 1000 条；补入口后能读到最早并回到 1200，额外请求仅为 afterSeq=1200 的新消息检查。
- 同次真机四次 CDP touch 手势回放记录 232 帧，空白帧 0，最多挂载 14 行，帧间隔 p95 为 23.3 ms。这是受控回放，不是持续 60 FPS 或所有真实会话均无卡顿的证明。

证据在缓存盘：`/mnt/cache/data-cache/hapi-locality-tests4.log`、`hapi-locality-incremental.log`、`hapi-locality-capacity.log`、`hapi-locality-browser-edge.log`、`hapi-locality-preload.log`、`hapi-locality-phone.log`（修复边界入口前失败）、`hapi-locality-phone-edge.log`、`hapi-locality-phone.json`。

## 发布

前端候选包：`/mnt/cache/build-cache/hapi-chat-release-20261005/web-history-locality`。仅替换 Web 静态资源，旧哈希资源保留。Hub、Linux/Windows 原生引擎及 Runner 不重启。已发布，线上 HTTPS 入口为 `assets/index-BYmCdbpv.js`；旧入口备份在 `/mnt/cache/build-cache/hapi-chat-release-20261005/pre-history-locality-entry`。候选包及线上真实 Linux、Windows 会话的打开与刷新均通过，浏览器未报错；日志为 `hapi-locality-preview.log` 和 `hapi-locality-live.log`。这项线上检查不替代前述合成历史/真机轨迹验收。
