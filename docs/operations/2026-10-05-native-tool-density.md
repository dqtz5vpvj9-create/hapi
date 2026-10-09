# 原生工具行密度回归

新版独立内容节点保留了 assistant 消息的上下留白、ToolMessage 的上下留白，再叠加 12 px 的虚拟列表间隔。紧凑工具头被重复包裹，因此连续工具显得稀疏。

修复限定在原生 Codex 呈现：工具节点取消重复上下 padding，虚拟列表间隔改为 4 px；普通正文节点补回上下各 4 px，保留正文之间原有的总间距。ToolCard 自己的 header padding、工具名称、时间、状态、详情对话框和待回答交互保持不变。其他 agent 的列表间隔仍为 12 px。虚拟器测量与正常文档流使用同一个 rowGap，未加独立滚动修正。

新增 `native tool seats retain compact headers when a process is expanded` 浏览器检查，展开两层过程后验证工具内容行高度不超过 32 px，打开并关闭详情后仍保持紧凑。窄屏截图 `/mnt/cache/data-cache/hapi-tool-density-phone.png` 已实际查看。相关回归记录分别在 `hapi-tool-density-browser.log` 与 `hapi-tool-density-recheck.log`；首轮存在首次加载超时及测试漏展开内层过程的问题，保留日志，不算通过。

复测结果：工具密度与详情检查通过；过程展开／收起保持答复节点、待回答问题保留焦点与草稿的检查通过。历史补页逐帧检查在 4 倍 CPU 降速下实际执行 43.5 秒通过，本次运行仅将整项测试超时上限设为 90 秒，产品逻辑及像素／重叠断言没有变化。图片与文件组件不在本次改动范围。

已发布 Web 入口 `index-D9DnrGyF.js`。Web 类型检查和正式构建通过。发布保留旧内容寻址资源，入口备份在 `/mnt/cache/build-cache/hapi-chat-release-20261005/pre-tool-density-entry`；Hub 与原生引擎未重启。
