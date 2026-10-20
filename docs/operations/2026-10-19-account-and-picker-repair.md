# 账号凭据与附件弹窗修复

## 已确认原因

两个新 Codex 会话的 app-server 日志包含 `token_revoked` 和 `refresh_token_invalidated`。DSH 的 Codex 子工具也记录了同类错误。当前 auth.json 与 HAPI 在 10 月 13 日保存的账号凭据一致，修改时间对应新会话启动；账号启动路径会直接覆盖 auth.json。证据支持旧快照覆盖风险，不能据此判定服务端最初为何撤销令牌。

## 修复

账号加载先同步相同身份且 last_refresh 更新的原生凭据，再刷新或激活保存账号。仍使用同一 CODEX_HOME。附件选择器补齐中英文文案。DSH 保留结构化错误详情、识别被撤销的 Codex 凭据，并区分 stderr 子工具错误与 prompt 失败。公共 ACP 认证提示不再一律要求 Gemini 登录。Codex 失败或中断的 turn 不发送 ready；Web 在 systemError 状态清除并拒绝迟到的 ready 通知。

## 验证

CLI 账号、根会话、错误转换与 ACP transport 的 146 项回归通过；后续 DSH launcher/error 20 项通过。Web 附件弹窗和 readiness 6 项通过，Web 类型检查通过。CLI 类型检查仍受旧 codexRemoteLauncher 缺失模块影响。本机使用 webshot 渲染并查看真实附件组件的 390×844 截图，中文按钮、标题正常。

用户明确暂缓重新登录，因此未宣称 Codex 401 已恢复，也未用新会话成功回复作为验收结果。旧会话已记录的错误文本不会被重写。

## 发布

已按完整工作区发布 `20261019T190405Z-4fcc70b5ed-working`。构建产物冒烟通过；Linux 服务、Windows Runner/native 就绪，两端 machine 在线。Windows Session 0 在更新前后均通过 DNS、直连 HTTPS 与 WebSocket 检查。线上 Web 返回 `index-CiA-UhR3.js`，确认包含修复后的附件文案。运行中的旧 DSH 包装进程不会被热替换；后端修复在新启动或恢复的进程中生效。
