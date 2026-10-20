# HAPI ACP 图片与 DSH 权限修复

改动全部位于 HAPI。DSH 安装目录及源码未修改。

ACP 的显式图片附件现在通过队列保留元数据，并在公共后端按协商到的 `promptCapabilities.image` 转成 MIME/base64 image block，包括 Cursor 的运行中追加消息。单图上限 10 MiB，每轮总计 20 MiB；超限、不可读、未声明图片输入时保留有说明的路径引用，不声称 agent 已读取图片。前端在已知不支持图片时直接显示提示。

DSH 模型名称来自会话目录的 value/name 映射；无名称的 JSON 二元组只格式化显示，不改变线上 model 值，也不把 v4 改称 v4.1。新建页明确说明启动后选择模型和推理强度，权限入口放在高级设置中。

官方 DSH CLI 启动时加载 HAPI 生成的 Cordis 适配插件。HAPI 注入 `DSH_PERMISSION_MODE`，并通过 DSH 的 `sandbox/mode` 事件更新已恢复的会话和运行中的权限。适配插件在本机回环地址监听，用随机 bearer token 认证，插件和地址文件保存在当前用户的 HAPI runtime 私有目录，退出时清理。权限请求串行执行，确认 DSH 实际模式后才向界面回报。

适配 patch 保留 approval=ask，YOLO 由 HAPI 权限处理器自动批准，因此从 YOLO 降级不会遗留启动时的 approval=never。已经启动的工具调用不会被此设置追溯取消。

预检使用 DSH 自身 settings/credentials 服务解析选中路由的 apiKeyEnv 引用，兼容自定义引用和 DSH 凭据存储，不读取或返回密钥。新会话在接受首条消息前检查，切模型时也检查。无 apiKeyEnv 的账号认证路由仍由对应 provider 校验；自定义非官方 ACP 可执行程序不自动加载 Cordis 插件，其未实现的实时权限接口会明确返回错误。

验证包含公共 ACP 图片构造及线上协议载荷测试、缺失能力和大小上限降级、队列附件保留、错误分类、显示名称、前端交互、凭据预检和权限切换。真实安装的 DSH 已完成同会话 workspace-write → danger-full-access → workspace-write，以及缺失凭据在 prompt 前被拦截的验证。该 DSH initialize 返回 image=false，尚未完成真实视觉路由的图片理解验证。

## 上游 issue 草稿

DSH 的 ACP 默认模型为 `deepseek-v4-flash`，但安装版本的模型目录未登记该默认模型，请补齐目录信息及准确的输入能力声明。

另一个增强建议：sandbox-policy 的 workspace-write 支持显式配置额外可写根目录，以便会话工作目录外的仓库能够在保留沙箱的情况下使用。

## 检查结果

相关 CLI 回归 407 项通过，Web 相关用例 115 项通过（另补的 composer 即时附件提示用例也通过），共享逻辑 53 项通过；Web、Hub、Relay 类型检查通过。根级全量测试执行到了 CLI，仍有 Codex native history/fork 的既有失败；CLI 全量类型检查仍受旧 codexRemoteLauncher 引用已缺失模块影响。相关文件保持原样，没有排除或移走。未修改 DSH 源码，也未替用户提交上游 issue；上方为可提交的报告文本。

## 部署结果

2026-10-19 13:09 UTC 已按完整工作区发布 `20261019T130700Z-64904a13f5-working`，执行 `bun run deploy:production -- --working-tree --components all --skip-tests`。本次沿用上述回归结果，未重复全量测试；Linux 构建产物冒烟测试通过。Linux Hub、Runner、native、共享网关均 active；线上入口返回新资源 `index-Aq-VhDqO.js`。Windows Runner/native 已切换新可执行文件并报告 nativeReady；重启前后的 Session 0 直连 DNS、HTTPS、WebSocket 检查通过。两台机器原 ID 均在线，分别抽查既有会话历史，各返回 5 条消息。移动端原生项目同步完成，本次未生成或安装 APK。真实视觉路由的图片理解验证仍待完成。

## DSH 生命周期加固

2026-10-19 第二轮修复把 HAPI 对 DSH 状态的解释收紧为显式契约：

- 控制插件不再监听每个 `session/created`，改为 HAPI 在 `newSession/resume` 后显式 `claim-root` 当前根会话。DSH 派生的子会话从此继承父会话的实时权限，而不会被进程启动模式覆盖。`claim-root` 失败会重试一次；default 模式下降级为无实时控制并继续，read-only/YOLO 仍失败关闭。
- `session/followup` 返回的 `messageId` 被保留。steer 失败区分 `indeterminate` 与明确拒绝：只有明确拒绝才把消息放回队列；超时/断链按 `dispatching/indeterminate` 持有，等待显式重试或取消。成功投递会等待 Hub 对 `messages-consumed` 的 ACK；ACK 丢失则转 indeterminate，不再让行永久停在 dispatching。
- Bundle 目录区分 `switchable` 与必需层：`dsh-base`/`dsh-acp-app` 只能查看，不能停用；`dsh-subagent-codex`/`claude-code` 停用后仍留在目录中，可再次启用。写入使用 HAPI 文件锁（读-改-写同一临界区）和临时文件原子替换；`restartRequired` 落成 profile 目录侧标记，直到新的 DSH 进程完成组合才清除。
- DSH 文本块使用 `delta` 语义。DSH 每个 `assistant/message` 都是已提交消息，连续两个合法的相同块不能再被通用去重吞掉。
- 凭据预检不再阻断启动：配置 RPC 先注册，初始路由缺 key 只发出会话错误，用户可在会话内切换模型自救；`model: null` 会解析成目录默认值后再预检。
- 会话元数据记录 `dshCapabilities`（control/steering/resume/images），Web 不再只凭 `flavor === 'dsh'` 宣告 steer 或显示权限选择器；旧会话缺少能力戳时默认不宣告 steer。显式 JSON-RPC 错误保留 `code/data`，结构化 stderr 不再退化成 `[object Object]`。

**历史覆盖边界**：HAPI 只保证 HAPI 创建/接入之后写入 Hub 消息库的内容。DSH 的 `session/resume` 只恢复执行上下文，不回放原生历史；HAPI 当前没有 DSH 原生会话导入入口，因此不在 UI 中声称已恢复接入前的完整会话。未来若增加导入，应先由 DSH 提供稳定的历史读取接口（或版本化事件契约），再按原生 message/tool id 去重补读，不能用当前 v4 JSONL 的内部格式做长期耦合。
