# R0 原版 DSH Web 双实例验收报告

日期：2026-11-11。状态：R0 可行性探针通过，可进入 R1。全部模型响应为合成数据；实际运行官方 DSH Web 前后端、官方 SDK、Linux ARM64 容器和本机 Chrome。未调用真实云模型，未使用个人 Key 或真实账户数据。

## 交付与固定版本

- DSH CLI、SDK、Web 资源均为 0.2.2-rc.1，沿用已有冻结依赖。官方源码对应提交 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。
- 基础镜像沿用已验收的 `ai-office-2-dsh:p3-0.2.2-rc.1`，ID 为 `sha256:015fabdf2a516a0593ba12fcbda06535dbd261539b8d0f72bfc3af4d069212e7`。
- Web 专用镜像标签 `ai-office-2-dsh-web:r0-0.2.2-rc.1`，最终 ID 为 `sha256:9cb1dc98542b674dff52bdd5443f78576bff1a176217fff565882410d3a40613`。
- 新镜像复用基础镜像的全部 8 层，只增加项目包装代码和测试配置的一层。实测增量未压缩大小 28,251 字节；没有再次安装 DSH，也没有改动官方前端或后端包。既有包的许可证随基础层保留。
- 新增 `workers/dsh-web/bridge.mjs`、`probe.patch.yml`、`packages/dsh-web-probe/src/relay.ts`、专用 Dockerfile 和构建脚本。`.dockerignore` 显式列出允许参与构建的 R0 文件，用户数据继续排除。

## 运行与传输

两个实例共用镜像，各自挂载全新临时 workspace 和 DSH Home。原版 Web 在各自容器内部监听 loopback 3080，容器保持 `--network=none`，不发布 Docker 端口。宿主测试转发器仅监听随机 loopback 端口，将 HTTP 和 WebSocket 字节经 docker attach 的 stdio 多路通道转发到对应容器。目标只能是该容器内部的固定 Web 端口，浏览器不能指定任意宿主地址。

模型访问使用独立的受限消息通道，容器内为本地代理占位值；测试模型在宿主生成合成响应。宿主验证固定模型、输出上限、请求和响应体积及超时。Web HTTP 流量与模型响应均设置传输缓冲上限。R0 没有引入容器外网、宿主网络模式或公开网络端口。

沿用非 root、只读程序层、全部 capability 丢弃及 no-new-privileges。每个 Web 探针设 1 CPU、1 GiB 内存、128 PIDs 和 64 MiB noexec 临时盘；Web 的限额与原每轮 SDK Worker 分开，R2 还需验证正式调度和负载。浏览器使用全新临时上下文，测试结束关闭浏览器、移除自己创建的容器与临时数据。

本转发器只服务 R0 合成环境，尚未接入 AI Office 的账户鉴权；不可将它直接替换生产入口。DSH 原生 Cookie 隔离的通过不等于 R1 平台账号鉴权完成。

## 自动化验收

| 项目 | 结果与范围 |
| --- | --- |
| 类型、Node 语法、Shell 语法 | PASS。严格 TypeScript 检查覆盖新增代码 |
| 两实例官方页面 | PASS。两个独立 Chrome 上下文显示 DeepSeek Harness 原版页面，真实 HTTP RPC 和 WebSocket 正常 |
| 文本与事件隔离 | PASS。A/B 分别完成消息，模型侧确认各自标记与历史且无另一用户标记，会话 ID 集合互不重叠 |
| 图片和普通文件上传 | PASS。经原版控件上传 PNG 和 TXT；原生图片字节抵达模型消息，TXT 在原版消息中显示为已上传附件 |
| 生成、预览、下载 | PASS（下载动作由测试脚本触发）。官方 write/present 工具生成 report.txt，原版侧栏预览内容正确；认证后的原生二进制 RPC 返回完整字节，再由浏览器保存，下载与宿主文件逐字节一致 |
| 会话和文件越权 | PASS。有效参数下本人读取成功，其他实例的 session ID 无法用于文件读取；A 的原生 Cookie 不能访问 B 的 HTTP API 或 WebSocket |
| 知识库授权 | PASS。A 的原版文件 API 可读获授权库，B 的同样请求失败；容器 OS 层改写、删除、改名尝试被拒，原文件哈希一致 |
| 宿主与其他租户边界 | PASS。各实例只见自己的 private.txt，另一宿主测试目录、Docker socket、SSH agent 和宿主 Home 不可用 |
| 网络出口 | PASS。无外部路由；公网地址、代表性的私网地址和 host.docker.internal 连接均失败。模型仅经受限 stdio 代理 |
| 新容器恢复 | PASS。A/B 分别重建容器后由原版页面显示旧历史并继续对话；A 已生成文件仍完整 |
| SDK 到原版 Web | PASS（同版本合成数据）。先用 SDK 写入独立持久化会话；停止 SDK Worker 后，原版 Web 发现同一 ID、读取历史，通过官方接口登记工作区、选择同一模型激活会话后，在展开的原版侧栏中显示历史并继续聊天；激活本身没有增加模型请求 |

SDK 兼容测试验证了一条可行路径，不代表真实历史已批量迁移。工作区映射、权限变化和回滚仍由 R4 单独验收。测试不会让 SDK Worker 与 Web 同时写同一 home。

## 发现的问题与修复

1. 精简 Linux 容器没有系统 Documents 目录，首次默认工作区创建失败。通过官方 `workspace-controller.documentsDirectory=/tenant/workspace` 指定用户挂载区，复测通过，没有安装或修改系统目录。
2. 探针曾禁用 plugin-manager 服务，导致 standard preset 的依赖不可用。R0 恢复官方依赖，复测通过。正式的插件/设置权限收紧属于 R1/R2，必须同时处理服务与后端授权，不能简单移除依赖服务。
3. 原生生成的 wire 字段是 `workspaceFileScopeId`，SessionAddress 需要 `kind: session`。修正测试契约后，先验证本人请求有效，再检查其他用户请求被拒，避免用无效参数制造越权测试假阳性。
4. SDK 历史的侧栏存在折叠分组，且旧会话需按官方运行时恢复规则激活。测试以原生返回标题和 `aria-expanded` 状态操作侧栏，已验证显示与继续；没有改写 DSH 日志格式。

## 后续范围与明确缺口

- **原版通用下载按钮未完成。** 当前版本的文件预览主打本地打开和侧栏预览。本轮验证了原生认证二进制传输与浏览器下载，未声称已有用户可点击的通用下载按钮。R1 应通过官方界面扩展槽或小范围独立扩展补充，保留原版对话页面。
- R1 的统一账户、所有 HTTP/WS 鉴权、退出/重置/禁用即时失效尚未完成。
- 原版 Web 上传及图片限制尚未与工作台的配额策略统一；本轮仅验证小型 PNG/TXT，R1/R2 需统一后端限额并测试超限请求。
- R2 的正式实例调度、每用户/全局 turn 限制、配置与插件权限收紧、撤权重建、异常和负载回归尚未完成。旧 SDK 测试结论不能直接覆盖新版。
- 公共和个人 Skill 在 R3 实测；真实数据迁移在 R4；真实云模型、手机 Tailnet HTTPS 与最终使用体验在 R5 验收。
- 未变更现有 DSH Desktop、个人 DSH Web、AI Office 1.0、当前 Tailnet Serve 配置或真实用户数据；本轮未切换当前 AI Office 入口。

## 复跑命令

在项目根目录、Docker Desktop 已运行且既有 P3 基础镜像存在时执行：

```sh
export PATH="$PWD/.runtime/node-v24.21.0-darwin-arm64/bin:$PATH"
sh scripts/build-web-probe.sh
pnpm typecheck
node --check workers/dsh-web/bridge.mjs
sh -n scripts/build-web-probe.sh
node tests/e2e/r0-web.ts
node tests/security/r0-sdk-web.ts
```

这两条探针不需要 API Key，临时端口由系统分配，不占用 3000/3080。不要用它们迁移实际使用中的 DSH Home。测试截图保存在临时目录，不加入 Git。

## 公开源码依据

- [固定版本 Web 组合与启动参数](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/bundle/web-app/README.md)。
- [连接、Cookie、原版 RPC 与 WebSocket](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/connection/README.md)。
- [工作区与 Documents 配置](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/api/workspace-controller/README.md)。
- [文件读权限及原生字节接口](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/api/workspace-files/README.md)。
- [原版预览与界面扩展槽](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-sidebar-documentpreview/README.md)。
