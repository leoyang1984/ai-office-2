# AI Office 2.0 部署与维护

## 原版 DSH Web 本地安装

从仓库克隆后执行 `pnpm setup:local`，再执行 `pnpm start:local`。系统和工具要求见 [README](../README.md)。安装从锁定的 npm 依赖和固定的基础镜像构建 ARM64 镜像，把本机的镜像 ID 记录在项目的 `.runtime/native-web-image`。DSH 构建依赖缓存在 `.runtime/dsh-store`，网络中断后可重新执行安装。启动按该 ID 加载镜像。两个账户使用同一镜像，按需创建各自的容器。

默认访问 `http://127.0.0.1:3088`。项目更新后重新运行 `pnpm setup:local`，再启动。已有账户、聊天和 Skill 留在独立数据目录。自定义目录请选绝对路径，确保父目录存在。既有的数据根需要由运行账户拥有，且仅该账户可以访问。

```sh
AI_OFFICE_DATA_ROOT="/absolute/path/to/office-data" AI_OFFICE_PORT=3089 pnpm start:local
```

启动时从当前终端获取 Key。前台服务以 Ctrl+C 停止。Docker Desktop 停止时，请先启动 Docker Desktop。镜像记录丢失或镜像被移除时，重新运行 `pnpm setup:local`。若首次引导中断且 SQLite 文件已创建，使用同一个数据目录运行 `pnpm bootstrap`。已存在管理员时，引导命令会拒绝再创建一位。

备份前先停止服务。下面假定使用默认数据根，快照和恢复目录用自己的绝对路径，且目标目录尚不存在。

```sh
export AI_OFFICE_DATA_ROOT="$HOME/Library/Application Support/AI Office 2.0"
pnpm maintenance backup /absolute/path/to/new-snapshot
pnpm maintenance verify /absolute/path/to/new-snapshot
```

恢复到新目录后可以单独启动并检查。

```sh
pnpm maintenance restore /absolute/path/to/new-snapshot /absolute/path/to/restored-data
AI_OFFICE_DATA_ROOT=/absolute/path/to/restored-data pnpm start:local
```

若需要从旧 SDK 快照继续原生历史，用 `pnpm maintenance migrate <快照> <新目录>`，再用 `pnpm start:local` 打开新目录。兼容边界见 [R4 迁移报告](R4_MIGRATION_REPORT.md)。异常终止留下旧锁时，在确认该进程已经停止后，用原数据根执行 `pnpm maintenance unlock`。

## 手机与其他设备访问

首次安装、加入 Tailnet、启用 HTTPS 和运行 Serve 见 [Tailscale 配置指南](TAILSCALE.md)。

## 旧版 SDK 部署

应用监听 `127.0.0.1:3000`。日常启动见 [旧版 SDK 工作台](SDK_WORKBENCH.md)。DSH 模式会验证当前 Mac 上通过验收的镜像 ID，再清理同一数据目录上次遗留的 Worker。服务由本机交互终端启动，Ctrl+C 关闭。

## 旧版 SDK 的 Tailnet HTTPS

从同一 Tailnet 的第二台设备验证前，请先连接 Mac 和该设备。以下步骤只为 AI Office 工作台配置临时 Serve，选择默认 HTTPS 443。预检检测到已有 443 配置时，请先保留原服务并选独立的可用端口。

```sh
node scripts/tailnet-check.mjs
```

把输出的 `AI_OFFICE_ORIGIN=https://…` 放入启动应用的终端环境，再按旧版 SDK 说明启动服务。第二个 Mac 终端中，在已获准发布到 Tailnet 的情况下运行：

```sh
tailscale serve --https=443 http://127.0.0.1:3000
```

使用 Serve 输出的 HTTPS 地址从第二台设备登录，发送测试消息并查看 SSE 状态，再上传和下载合成文件。用普通用户 A 的浏览器会话请求 B 的测试文件，确认返回 404。验收后在 Serve 终端按 Ctrl+C，再用 `tailscale serve status --json` 确认该临时入口已关闭（包括 `Foreground` 配置）。长期运行可在授权后按官方命令使用 `--bg`，按相同端口和路径执行 `off` 回滚。应用仍要求自己的账号和密码。参见 [Tailscale Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)。

## 备份与恢复

Ctrl+C 停止服务后操作。快照是包含 SQLite、用户文件和 DSH 状态、托管知识库、Skill 数据和校验清单的私有目录。目标路径使用绝对路径，并选择尚不存在的目录。将快照保存在你控制的私有位置。

```sh
pnpm maintenance backup /absolute/path/to/new-snapshot
pnpm maintenance verify /absolute/path/to/new-snapshot
pnpm maintenance restore /absolute/path/to/new-snapshot /absolute/path/to/new-data-root
export AI_OFFICE_DATA_ROOT=/absolute/path/to/new-data-root
pnpm start
```

恢复会核对文件 SHA-256 和 SQLite 完整性。旧登录会话失效，原账号和密码可重新登录。恢复到新路径会重新绑定托管知识库的位置。把 `AI_OFFICE_DATA_ROOT` 改回旧目录即可回滚数据选择。

服务崩溃后，若重启提示旧锁，请先确认原服务已停止，再执行 `pnpm maintenance unlock`。该命令会检查锁对应的进程。DSH 模式的旧锁需先完成同一数据目录的遗留 Worker 清理，清理失败时保留锁。重启会将中断的消息记录为失败，保留已完成的 DSH 会话。继续原会话时，应用用保存的 session ID 恢复。

升级前创建快照并记录当前 Git 提交及 Worker 镜像 ID。新版独立验收后，再切换服务启动路径和数据目录。回滚时使用原提交构建和原镜像，配合旧数据目录或新目录中的快照。若需开机自动运行，可在确认好数据根、Node 路径、代理和凭据注入后单独配置用户级服务。

## 验收记录

```sh
pnpm typecheck
pnpm test
node tests/e2e/p4-https.ts
node tests/security/p4-runtime.ts
node tests/security/p4-failures.ts
```

本机 TLS 测试用临时证书验证 Secure Cookie、SSE 和文件传输。2026-11-11，用户在真实手机上经 Tailnet HTTPS 完成首次改密、真实 DSH 对话、图片上传与处理、生成文件下载，以及退出后重新登录恢复历史。账户归属和越权拒绝由本机自动化安全测试验证。

`p4-failures.ts` 仅对随机测试数据目录的容器注入故障，检查失败事件、容器清理、原有合成文件完整性及下一轮恢复。资源耗尽探针只写满容器的 64 MiB tmpfs，未执行宿主磁盘写满或整机内存耗尽测试。当前远程入口为临时前台会话，应用和 Serve 需同时保持运行；本轮未安装常驻服务。

## 原版 Web 网关研发状态

R1 已通过合成账户的原版界面登录、HTTP/WS 鉴权、连接撤销及下载按钮验收，见 [R1 报告](R1_NATIVE_GATEWAY_REPORT.md)。当前普通启动命令仍使用 SDK/Mock 分支，尚未发布原版网关，也未迁移真实数据。不要用 R1 测试脚本操作现有数据；正式运行、迁移与手机 HTTPS 按 R2–R5 的闸门推进。

R2 已通过独立数据根、实例回收/恢复、并发、撤权、文件权限和故障配额验收。研发用镜像与复跑命令见 [R2 报告](R2_NATIVE_RUNTIME_REPORT.md)。仍沿用原 SDK/Mock 正式启动方式；R2 未安装常驻服务，未迁移数据。

R3 使用独立测试镜像。管理员和用户从原版界面的「办公室账户」管理 Skill。运行选项、版本和复跑命令见 [R3 报告](R3_SKILLS_REPORT.md)。

R4 新增 `maintenance migrate`，把快照恢复到新目录并登记可续聊的 SDK 会话。停机、校验、试运行和回滚顺序见 [R4 报告](R4_MIGRATION_REPORT.md)。

R5 的原版 DSH Web 手机演练走独立测试端口，使用专用临时账户和数据根。启动、停止、异常清理和真机步骤见 [R5 验收手册](R5_TAILNET_REPORT.md)。
