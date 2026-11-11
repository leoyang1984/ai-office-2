# DSH 兼容性记录（P0）

核对日期：2026-11-10。选定 npm CLI `@deepseek-ai/dsh@0.2.2-rc.1` 与 TS SDK `@deepseek-ai/dsh-sdk-client@0.2.2-rc.1`，使用独立 npm 运行时和 `sdk` profile。

- [CLI 发布元数据](https://registry.npmjs.org/@deepseek-ai/dsh/0.2.2-rc.1) 要求 Node.js `>=24.9.0`。选定 Node.js `24.21.0`。SDK 的 `latest` 为 `0.0.1-rc.1`，`next` 才是 `0.2.2-rc.1`；安装时明确指定版本。
- 源码依据是官方标签 [dsh-v0.2.2-rc.1](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.1)，提交 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。`master` 只用于了解上游方向，不用来推断发行包能力。
- [选定版本 TS SDK 文档](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/sdk/client/README.md)、[选定版本类型](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/sdk/client/src/types.ts)、[协议](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/sdk/protocol/README.md)。

| 能力 | 0.2.2-rc.1 契约 | AI Office 使用限制 |
| --- | --- | --- |
| 启动 | `DeepSeekHarness({ profile, dshBin, dshHome, processCwd, cwd, env, provider, model })`；`start()` 完成初始化；`env` 可替换子进程环境 | 明确指定 SDK 运行时、隔离 home、工作目录和子进程环境，不连接现有 Web |
| 文本与通知 | `session.run(input, { onNotification })`，结果有 `sessionId`、`finalResponse`、`finishReason`、`events`、`notifications` | `session.event` / `session.status` 需要归属检查。普通输入的结果是入队到 idle 期间最后的助手回复，同会话只能有一个活跃 turn |
| 新会话与 cwd | `harness.session()`；`session.getWorkingDirectory()`、`session.setWorkingDirectory(path)` | 两种 cwd 分开指定；cwd 不提供文件读取权限边界 |
| 恢复 | `harness.resumeSession(savedId)`；从原 home 恢复。无效 id 抛错；不会创建替代会话 | 使用保存的 id 和同一 home，核对恢复后的 cwd；不要用 `session(savedId)` 代替恢复 |
| 图片 | `SdkPromptContentBlock[]` 支持内联 base64 raster 和 MIME，模型仍需支持图片 | 发行版文档和类型已核对，真实模型图片输入未实测。通用文件放工作区 |
| 工具事件 | `session.event` 使用 `SessionEvent`，工具活动和助手输出是不同事件；通知可能包含已发现的子会话 | P2 按实际事件类型做投影；本轮不使用真实工具执行 |
| 停止与超时 | `initializeTimeoutMs`、`requestTimeoutMs` 有类型；协议没有取消活跃 turn 的 RPC；`close()` 关闭该运行时并等待退出 | 应用另设整轮截止时间。超时不能假定回滚、不能盲目重试；停止时关闭当前独占进程 |
| 审批 | `approvalRequests: true`；先安装 `harness.client.onRequest`，处理 `approval/request` | 未实测交互；禁止默认批准；审批不能替代容器隔离 |
| 历史读取 | 恢复可继续历史，SDK 协议未提供枚举/读取全部历史的公开端点；`session/query` 用于输入 | 用应用的只读事件投影展示历史。避免直接依赖 DSH 内部日志文件格式 |

版本细节：选定版 SDK README 给出默认 `sdk` profile、工作目录及恢复接口；发布源码含上述类型。官方 [sdk profile](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/bundle/sdk-app/README.md) 默认使用 workspace-write/ask。官方 [sdk-minimal profile 配置](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/bundle/sdk-minimal/cordis.patch.yml) 为 danger-full-access，本机探针不启用。两种 profile 都不能单凭 cwd/home 证明多用户隔离。

若 npm 路线在目标平台仍不可用，官方 [Python SDK](https://pypi.org/project/deepseek-harness-sdk/) 同样使用独立运行时、显式 home 和 SDK stdio 协议，可作为备选；本次未安装 Python SDK，未使用个人 Web 接口。

P2 的 Linux ARM64 镜像保留 noexec 临时目录。原生加载器 `node-addon-native-custom-loader@0.1.9` 默认把二进制复制到临时目录再加载，实测会失败。Worker 使用该版本支持的 `NARB_DISABLE_NATIVE_CACHE=1`，直接加载镜像内的固定预编译模块，并关闭本地构建回退。容器 SDK 往返和新进程恢复复测通过。

## R0 官方 Web 复用实测补充（2026-11-11）

同版发布依赖已经包含原版 Web 静态资源和运行时，Web 镜像从既有 P3 镜像离线扩展，没有另装一份 DSH。原版 HTTP RPC、WebSocket、图片和文件、双实例隔离、重建恢复通过，容器保留 network=none，字节通道经 stdio 转发。

同版 SDK 合成会话能由 Web 枚举和读取，经官方工作区登记和模型选择激活，在原版 UI 展开分组后显示并继续。该路径未改内部日志格式，真实数据迁移尚未实施。原版分页文本接口与原生字节读取返回形式不同：完整下载通过二进制 multipart Remote，用户可点击的通用下载按钮留到 R1 通过界面扩展补充。完整版本、命令、测试边界见 [R0 报告](R0_NATIVE_WEB_REPORT.md)。

## R1 账户网关补充（2026-11-11）

原版 Web 令牌交换返回 303（亦接受 302），由服务端获取原生 Cookie；原版客户端使用 HTTP RPC 和 WebSocket 多路流，启动包含 remoteAccess/follow、account/watch、workspace/follow、$events 及 session/control 等只读订阅。客户端扩展以显式宿主模块文件定位包，使用官方 dsh.client/slots 机制，需保留原版动态模块的 inline/eval 和同源 base 支持。非 loopback 外部 Host 要传入官方 trusted-host；本轮只做 HTTPS 声明与注入验证，真实手机 TLS 留到 R5。详见 [R1 报告](R1_NATIVE_GATEWAY_REPORT.md)。

## R2 固定运行时补充（2026-11-11）

官方 CLI 每次重写空 Loader 根；R2 只在预置根字节一致时跳过该写入，保留其余启动流程。Web 凭据 provider 的内部浏览器会话改存临时路径；用户历史仍用原生会话持久化。官方补丁不允许同 ID 替换模块，受限文件服务采用「禁用默认组件、插入新组件」，构建拒绝未应用补丁。官方 `session/wait` 的 idle、running 和 queue 用于完整轮次释放；原版开发视图关闭后 HTML 走无脚本模式。见 [R2 报告](R2_NATIVE_RUNTIME_REPORT.md)。

## R3 原版 Skill 发现

固定版本的 `dsh-skill-filesystem` 通过 `includeDefaultRoots: false` 与 `customSkillDirs` 只发现平台挂载。官方 `skills/list` 使用会话 ID。版本或授权更新后重建实例，从新的目录加载，原版 `skill` 和 `/name` 都实际验证通过。见 [R3 报告](R3_SKILLS_REPORT.md)。

## R4 迁移验收

固定版本 SDK 会话经原版目录、历史和工作区 RPC 校验后可在重建的原版容器中打开并续聊。Mock、无可读原生日志和停用账户保留旧版文字。迁移按原始容器路径登记，无需重写 DSH 日志。见 [R4 报告](R4_MIGRATION_REPORT.md)。

## R5 附件与远程验收

原版附件模块支持配置独立的 DSH Home。R5 仅把该模块指向既有的租户状态目录，保留只读 CLI/Loader Home 和原版文件、事件协议。原版多选附件会并行上传，平台逐个校验配额。见 [R5 验收手册](R5_TAILNET_REPORT.md)。
