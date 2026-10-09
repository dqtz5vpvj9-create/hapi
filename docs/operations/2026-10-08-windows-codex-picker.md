# Lis-iMac Codex 会话列表查询超时

2026-10-08，Lis-iMac 的 Runner 在线，但“连接 Codex 会话”列表请求在 30 秒后返回 503 `operation has timed out`。Linux 相同请求正常，Windows 已接入会话的历史读取也正常。

## 原因和修复

`ApiMachineClient` 先从本地索引取得一页，再调用 `nativeCodexEligibility()` 区分已加载与历史会话。后者读取 `codex-runtimes` 并逐条调用 `runtimeAlive()`。Windows 每条记录要调用 `tasklist`，活跃记录还会再调用进程存活和 CIM 启动时间检查；旧运行记录累积后，这些同步子进程检查串行阻塞 Runner。

设备探测读出 50 条索引记录用了 167 ms，18 份运行记录的筛选到约 69,977 ms 才完成。随后初始化桥接和读取已加载会话仅需约 21 ms。单独一次无匹配 PID 的 `tasklist` 也耗时 2,211 ms。因此故障不在 Codex 历史数据库或网络连接，延长超时不能解决该串行工作量。

`nativeConnection.ts` 现在先按 Codex home、Hub 和认证标识筛选候选，再通过 `getWindowsProcessStartMarkers()` 一次异步 CIM 查询取得候选 PID 的启动时间。与保存的启动时间逐项比较，继续排除退出或被复用的 PID，并保留多桥接歧义错误。失败的系统查询不跳过身份检查。Linux 路径未改变，原生历史、进程终止和运行记录存储未改动。

## 验证和更新

- 67 项相关 CLI 测试通过，包括批量查询、进程代际、认证边界、桥接歧义、Linux 路径和会话目录权限；CLI 类型检查通过。
- Bun 1.4.0 编译 Windows 候选，从已经发布的文档功能源码快照仅带入此次两处源文件修改。
- Windows Session 0、原后台账户下的预检用 2,055 ms 完成，返回 8 个已加载 thread。
- 计划任务只更换 Runner 的稳定可执行文件，保持现有监督器、引擎、原生桥接、relay 和受观察的 Codex 进程代际。Runner 从 PID 1360544 更换为 1689460，计划任务返回 0。
- 生产 API 的首批、后续页和中文搜索复核分别为 2,385 / 2,595 / 2,571 ms，返回 50 / 50 / 4 条记录。两个既有 Windows 会话仍可读取历史，未发送模型请求。
- 生产浏览器在 1440 和 390 CSS 像素宽度下，弹窗分别用 5,127 / 4,570 ms 展示 50 条 Windows 会话；中文搜索各返回 4 条。没有页面异常。验收早期曾有一次中文查询和一次浏览器等待超时；直接设备搜索 15 ms 完成、复核成功，目前不能确认这两次额外延迟的来源，不能将其归为已经查明的索引故障。
- webshot 截图 `picker-mobile.png` 已查看，真实 Windows 会话列表可见；所用代理仅供本机只读截图，验收后停止。临时 Windows 预检程序和更新计划任务已清理，版本和回退备份保留。
- 生产 API 与浏览器验收结果见 `/mnt/cache/data-cache/hapi-windows-session-list-20261008`。真实 Windows 接口由 Linux Chromium 浏览器调用，不能据此称为 Windows 桌面真机视觉验收。

回退 Runner 可使用 Windows 上 `D:\hapi\bin\hapi-20261004.pre-session-list-20261008.exe`；仍由计划任务和原监督器更新 Runner，避免操作 Codex 引擎或重放消息。不要删除旧运行记录来掩盖查询成本：进程代际检查需要正确处理这些记录。
