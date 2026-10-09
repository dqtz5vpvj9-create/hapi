# 普通文件预览被 Git 错误挤出首屏

截图中的 `/android/.lavish/choreo-65g-plan-20261006/PLAN.md` 可以正常读取，但会话工作目录 `/android` 不是 Git 仓库。`SessionFile` 此前对所有文件同时请求正文与 Git diff，等待两者完成，再把 Git 命令错误全文放到正文上方。Git 的 usage 帮助因此占据多个屏幕。这不是 Markdown 渲染失败。

## 修改

`web/src/routes/sessions/file.tsx` 使用现有导航信息区分两种入口：项目文件省略 `staged`，代码变更明确传入 `true` 或 `false`。普通文件仅请求正文，并忽略同一路径之前缓存的 diff 内容或错误。没有新增 RPC、协议字段或服务端 Git 探测。

代码变更继续默认显示 diff。用户可在 diff 尚未完成时切到文件，文件读取无需等待 diff；命令失败或网络请求失败会显示文件，并提供默认折叠的简短提示。技术详情展开后最多占 160 CSS px，可以独立滚动。文件与变更间导航会重置显示意图，后台刷新不会覆盖用户主动选择的 File 视图。已删除文件的 diff 也不再被正文读取失败遮住。

## 验证

- 11 项文件页面测试与 4 项文件错误翻译测试通过；Web 类型检查及正式构建通过。覆盖普通文件无 Git 请求、缓存错误隔离、暂存／未暂存 diff、慢请求、命令／网络失败、导航切换、删除文件、Markdown Source／Preview、复制、换行及原有滚动位置保存。
- 真实 HTTPS 服务、390 × 844 Chromium 视口下，原发布版 `/assets/index-DLr2d-OT.js` 打开上述文件发出一次 Git diff 请求，错误可见，Markdown 内容顶端位于视口 Y=1938。
- 候选版 `/assets/index-BaXEGoai.js` 使用同一服务与文件，普通打开时 Git diff 请求为零、错误提示为零，内容顶端 Y=278；Source／Preview 与实际下载通过。显式 diff 请求失败时，详情默认折叠，展开高度为 160 px。没有聊天发送、文件上传或工作区修改。
- `webshot` 截图已打开检查。此项是桌面 Chromium 的手机尺寸模拟，不是真机测试。桌面脚本第一次因聊天中的另一个 Preview 按钮导致选择器不唯一；已限定到文件面板，重跑通过；桌面内容顶端 Y=264，Source／Preview、下载及受限错误详情也通过。原失败记录已保留。

临时证据位于 `/mnt/cache/data-cache/hapi-file-preview-20261006`，候选构建与冻结源码位于 `/mnt/cache/build-cache/hapi-file-preview-20261006`。本轮只修改文件页面、对应测试及本记录。发布前已核对冻结源码与当前 Web 非测试源码一致；并行输入框／恢复流程的 45 项编译版浏览器验收及线上发布另见 [该轮记录](2026-10-07-workspace-attachment.md)。


## 发布

并行前端发布 `/assets/index-OXCOhRYp.js` 已带入此次主要修复；用真实 HTTPS 页面分别复核了桌面和窄屏，无资源替换，普通文件不再发出 diff 请求，Source／Preview、下载和显式 diff 失败详情均通过。

2026-10-07 04:15:03 UTC 发布最终 `/assets/index-BaXEGoai.js`，包含后台刷新失败时继续使用已有成功查询结果的最后调整。发布前确认上一版本仍为 OXCOhRYp，保存根文件回滚副本，先复制资源再原子替换入口；旧资源保留。Hub/native PID 仍为 3233230/2502589。本轮没有重启服务、提交或推送。

最终线上窄屏验证见 `published-final-mobile.json`。截图 `preview-mobile.png` 是此前已检查的候选版截图，不标作真机或最终线上截图。临时只读预览服务器验证后关闭。
