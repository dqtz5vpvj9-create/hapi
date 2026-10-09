# 文档工作区发布与 PPT 首屏延迟修复

2026-10-07 已更新 Linux、Windows 的 HAPI 文档读写能力，并发布 Hub/Web 的 Office 按需预览。生产站点为 <https://hapi.tail.lixinrui000.cn>，前端入口为 `index-CHbZAAmr.js`。

## 半分钟空白的原因与修复

旧前端等待 `response.blob()` 收完完整 PDF，随后才启动 PDF.js 显示第一页。用户打开的 Choreo v18 共 20 页，派生 PDF 为 24,201,257 字节，因此首屏被整份文件传输阻塞。此前对 v5 的功能验收没有覆盖 v18 在弱网下的首屏等待，这是本轮验收的遗漏。用户设备上约半分钟的各阶段耗时未记录，不能把这段时间全部归因于网络。

新流程先返回预览描述符，再由 PDF.js 通过带会话授权的 Range 请求读取所需字节；Worker 加载与转换并行。每段请求仍校验用户、命名空间与来源会话，句柄不代替授权。服务端现有有界转换缓存继续复用，未访问的隐藏文档不提前加载；用户主动下载原文件仍使用原入口。

同一台机器、同一份 v18、预热转换及静态资源后整页重新打开，在 Chromium 模拟 500,000 B/s（约 4 Mbps）、40 ms 延迟下，从发起预览到首屏画布可见，旧版单次为 72,771 ms，新版为 9,805 ms。新版首屏接收 936,165 字节，翻页和区域引用通过。旧版浏览器 Blob 数据事件计数缺失，日志中的 0 不代表没有传输；完整响应大小由独立 HTTP 检查确认。该比较是单组限速模拟，不能视为用户设备实测或稳定分位数。首次 Office 转换仍需要数秒；生产 v18 首次准备接口记录为 5,607 ms。

## 发布边界

发布快照位于 `/mnt/cache/build-cache/hapi-document-release-20261007`，没有包含尚未完成的 TerminalHost。Linux Hub 使用 `range-hub/index.js`，原生桥接和本机 `hapi` 命令使用已测的 Bun 1.4 编译包。Windows 由既有 `HAPI-background` 计划任务和监督进程接管 HAPI 原生桥接及 Runner；没有通过 SSH 直接启动运行服务。

Linux 原生 Codex 引擎 PID 2259627、桌面应用 PID 2124751、桌面 stdio Codex PID 2130771 均保留。Windows Codex 引擎 PID 865668、ChatGPT 主进程 PID 1542012、桌面 Codex PID 1615092 均保留。服务切换只涉及 HAPI。此前用户报告的 Codex 中断原因仍未查明，不能仅凭进程仍在就否定该中断。

本次发现源码目录中的 `web/dist` 曾被生产直接使用，构建会提前替换线上前端。已把生产资源隔离到发布目录 `published-web/`，`source/web/dist` 指向它，Hub 从发布快照启动；现在对开发目录的构建不再直接发布。旧带哈希资源保留，根文件及入口按发布顺序原子替换。

SQLite 数据库仍为 schema 29，没有数据库迁移。工作区协议为 schema 2。

## 验证结果

- 发布前完成 Windows Runner 账户 Session 0 的新 DNS 查询、直接 HTTPS、WebSocket、原生命名管道初始化/重连及已存会话的认证历史读取。两台机器以原 machine ID 恢复在线；Linux Main、第二个 Linux 会话和 Windows 会话均可读取历史。
- 生产 HTTP → Hub → 原机器桥接链路验证 Linux/Windows 临时文本文件保存、读回、陈旧版本冲突；浏览器继续验证选择引用只进入原会话草稿，不自动发消息。
- Windows 真文件测试发现 Bun 替换文件会丢失 DACL，且 Bun 1.4 的写权限探测未正确拒绝测试 ACL。实现改用 PowerShell 7/.NET 进行实际写权限检查、版本比较和保留 DACL 的 File.Replace；Session 0 下 Unicode 路径、保存、冲突、DACL 保留和明确拒绝写入均通过。
- 生产 Range 接口验证 206 字节段、未认证拒绝、其他会话拒绝；本地真实路由验证非法 Range 与缓存过期响应。v18 的生产桌面与 390px 浏览器截图已查看，首屏、文字层可见。生产 1600px / 390px 浏览器的 v18 翻页、选区草稿、Linux/Windows 文本保存和引用、两个平台会话打开及刷新均通过，无页面脚本错误。结果见下方证据文件，不能把窄屏模拟称作 Pixel 9 真机验收。
- 此次性能修复 Web 348 个文件 / 3,709 项测试通过；Hub 1,463 项通过、3 项跳过；Web/Hub 类型检查通过；最终改动的 5 项文档浏览器流程通过。Playwright 需用 Node 运行：Bun 对测试内泛型函数的序列化有兼容问题，Node 下原测试通过。
- 文档基础实现此前完成完整类型检查、Shared 325、Relay 118、原有工作区 30 项浏览器回归及 4 项历史/索引集成检查。CLI 全量为 3,083 通过、11 跳过、3 个历史测试超时；隔离重跑所属两个文件 18 项通过，不能记为一次全绿。

最终浏览器回归额外发现同一来源会话的两条旧 artifact 返回 404，服务端明确报告原文件不存在。与 PDF 按需接口独立，保留在验收记录中，未把它们改记成成功。截图中聊天的旧资源错误也仍可见。

## 证据与回退

本地证据根目录：`/mnt/cache/data-cache/hapi-document-release-20261007`。主要文件为 `production-documents.json`、`production-range-api.json`、`browser-release-v18.json`、`range-benchmark.json`、`artifact-failure-investigation.json`、`windows-switch-status.json` 和生产截图。该临时目录按主机策略七天清理；持久结论保存在本记录与设计页。

发布目录保留 `previous-web/`（原版本）、`web/`（文档基础版本）、`range-web-final/`（此次版本）。证据目录保留 `previous-hub.conf`、`previous-native.conf`、`before-range-hub.conf` 与原命令入口备份。Windows 备份为 `D:\hapi\bin\hapi-20261004.pre-documents-20261007.exe` 和 `D:\hapi\scripts\start-hapi.pre-documents-20261007.ps1`。

仅回退 Range 时，可恢复文档基础 Hub 配置及对应前端；完整回退需一起恢复 CLI/桥接、Hub、Web。服务操作只针对 HAPI，先执行相同 Windows 连接预检，切换后确认原 machine ID 和认证历史。不要用数据库备份覆盖并发产生的新数据；本次没有需要回滚的数据迁移。

仍未验证 Pixel 9 触摸和中文输入法。Office 是静态转换，不支持动画，不保证与 PowerPoint 字体及排版完全相同；Excel 为数据视图，不重算公式。外部编辑器不参加 HAPI 文件锁，最后比较与替换之间仍有竞争窗口，不承诺对所有外部写入提供文件系统 CAS。

## 后续：Codex 文件引用显示为原始标记

同日用户截图显示 `:codex-file-citation{path="…v19.pptx" purpose="output"}` 直接出现在正文。原因是 Markdown 管线只处理普通链接和路径，没有解析 Codex 的文件引用语法。

现已接入 remark-directive 的标准语法解析，再把文件引用交给原有文件导航与工作区路径校验。正文显示文件名或显式标签；点击仍进入来源会话的文档查看器。代码示例、未知标记和流式未完成标记保留文本；文件引用出现在现有链接标签内时不生成嵌套链接。Windows 路径、中文、空格以及文件名中的 `#`/`%` 均有回归测试。此修复只发布 Web 资源，入口更新为 `index-D9CaeKoo.js`；之前的 `index-CHbZAAmr.js` 是 Range 修复发布点。Hub、原生桥接和 Codex 进程未因本次修复重启。

候选包与发布后的生产站点都完成 1440px / 390px 浏览器验收：从真实会话点击 v19 引用，打开 20 页 PPT，无页面脚本错误；实际消息截图已查看。Web 全量 349 文件 / 3,725 测试通过，之后补充链接标签边界并通过 33 项针对性测试。CLI 全量 3,087 项通过、11 跳过；Hub、Shared、Relay 和四组历史/索引集成检查通过。全部包类型检查完成，其中 Web 在修正新节点字段类型后单独重跑通过。

发布前根资源备份：`/mnt/cache/build-cache/hapi-document-release-20261007/before-citation-web-root`。相关证据以 `citation-` 为前缀保存在上述临时证据目录。旧带哈希资源保留，回退入口与 Service Worker 等根资源即可切回前一前端版本，无需重启后端。

## 后续：切走 PPT 后画面残留在聊天窗格

用户补充的复现步骤是打开 PPT 预览，再切换到另一个 pane。原实现为了保留窗口几何和阅读状态，对后台窗格使用 `visibility:hidden`；`PdfDocument` 却在渲染完成后给画布和文字层显式设置 `visibility:visible`。CSS 允许子节点覆盖父节点的 visibility，因此隐藏文档仍能绘制，形成截图中的 PPT 叠在聊天文字上的现象。这不是聊天附件尺寸问题。

修复仅将这两层完成后的可见性改为 `inherit`，未完成时继续隐藏。没有改变聊天滚动、历史窗口、工作区几何保留或 Office Range 读取。源码和验收之间此前缺少“打开 Office 后切走”的组合场景，单独检查预览成功与 Markdown 草稿切换不足以覆盖该问题。

已用真实 Choreo v19、生产接口和浏览器本地的隔离工作区配置对比：390px 手机布局及 1440px 桌面布局，旧包均出现隐藏父层下仍可见的 canvas/textLayer；新包和发布后的生产包在逐帧采样中均为 0 次残留。覆盖手机换 pane、桌面聊天最大化、切换工作区并返回，返回仍在第 2/20 页。隔离配置只拦截测试浏览器的工作区读取，未修改用户工作区或发送模型消息。

增加自包含的两页 PDF 与 Office Range 测试数据，文档工作区 9 项浏览器测试通过，覆盖 PPT/PDF、两种宽度、反复切换、页码和 125% 缩放保留，并复查文本保存、冲突和选区引用。另有文档状态及图片查看器 12 项单元测试、Web 类型检查和发布构建通过。使用 webshot 生成并查看了切回聊天后的手机布局截图。本轮为 Chromium 窄屏模拟，未声称手机真机验收。

仅更新前端至 `index-DzpC2i8h.js`；Hub、原生桥接、Codex 与桌面应用均未重启。候选包位于 `pane-visibility-web/`，发布前根文件备份为 `before-pane-visibility-web-root/`，证据前缀为 `pane-media-`。回退只需恢复备份根文件；旧带哈希资源继续保留。
