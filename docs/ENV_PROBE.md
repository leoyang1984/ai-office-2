# P0 环境探测报告

日期：2026-11-10。P0 通过。官方 SDK 的本地往返、真实云模型会话恢复和 Linux ARM64 权限探针均通过。

| 检查 | 实测结果 | 状态 |
| --- | --- | --- |
| 宿主 | Mac mini / Apple M1 / 16 GB / macOS 27.2 (26B123) / arm64 | PASS |
| PATH 上的工具 | `~/.local/bin/node` v22.23.2、npm 10.9.8、pnpm 12.16.1；Node 22 不满足所选 CLI 要求 | PASS（已识别版本冲突） |
| 兼容 Node | 官方 darwin-arm64 v24.21.0 临时二进制，tarball 已核对 SHA-256。Desktop 自带同版 Node 能运行，但加载 npm 原生模块时因签名 Team ID 不一致失败 | PASS（改用独立 Node 后复测） |
| DSH Desktop | `/Applications/DeepSeek Harness.app`，0.2.2-rc.1，带内部 CLI；`dsh` 不在 PATH | PASS |
| DSH Web | 现有进程以 DSH Web 启动，监听 `127.0.0.1:3080`；无凭据 HEAD 返回 401。3000 无监听 | PASS（只读识别） |
| 官方 TS SDK / CLI | 同为 0.2.2-rc.1。临时安装禁用生命周期脚本，跳过探针不用的可选 LibreOffice 二进制；冻结锁文件复装成功，文件逐字节一致 | PASS |
| DSH 文本与通知 | SDK/CLI 真实进程，模型使用随机 loopback 端口的合成 Messages SSE 响应；A、B 分别完成首轮与恢复轮。收到 `session.event`、`session.status`，结束状态 `completed` | PASS（本地合成模型） |
| 会话和目录 | 两套临时 OS HOME、DSH Home、工作目录。验证初始 cwd、切换项目目录、关闭进程后恢复同 id 与 cwd；合成模型端收到各自历史且无另一组标记 | PASS（逻辑隔离） |
| 跨 Home 恢复 | 在 B 尝试恢复 A 的 id，返回 `JsonRpcResponseError`，code `-32603` | PASS |
| 真实云模型文本与恢复 | 用户提供的终端截图显示 `deepseek-flash` 使用当前终端代理。两套 home 与 cwd 分别完成首轮和新进程恢复，共四轮 `completed`，并收到 `session.event` 和 `session.status`。跨 Home 恢复返回 `JsonRpcResponseError`，code `-32603` | PASS |
| 容器引擎 | Docker Desktop 4.87.0，CLI 和引擎均为 29.7.2。用户授权启动后，`desktop-linux` 报告 `linux/aarch64` | PASS |
| Linux ARM64 权限测试 | 工作区与 DSH Home 可写。获授权知识库可读，创建、改写、删除、改名、chmod 和创建符号链接均被拒绝，原文件 SHA-256 一致。未授权库、其他用户目录与宿主 socket 不可访问 | PASS（合成挂载探针） |
| Tailscale | `/usr/local/bin/tailscale`，1.98.9；当前仅验证版本，未更改 Serve、网络或登录状态 | PASS（安装） |

DSH 版本和方法签名见 [DSH_COMPATIBILITY.md](DSH_COMPATIBILITY.md)。锁定信息：

- Node.js：[官方归档](https://nodejs.org/dist/v24.21.0/) SHA-256 `bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057`（darwin-arm64 tar.gz）。
- pnpm 12.16.1：[冻结锁文件](../probes/p0/pnpm-lock.yaml) 包含 CLI、SDK 及传递依赖的完整性数据。
- 容器探针已拉取并运行 Docker 官方 Alpine 3.22.2 Linux ARM64 镜像，manifest 为 `sha256:24bb3511a0db7b5114a4aee033c65a8a4148f39b7b80a398e548546db967a36f`。正式 DSH Worker 镜像在 P2 验证。

复跑命令见 [P0 探针说明](../probes/p0/README.md)。未读取个人 DSH 密钥或会话、未启动现有 Web、未修改 DSH Desktop、DSH Web 或 AI Office 1.0 的配置及数据。

## 2026-11-11 运行与远程验收补充

项目使用独立 `.runtime/` 中经过官方 SHA-256 校验的 Node 24.21.0，避免依赖会被系统清理的临时目录。Mac 与手机已连接同一 Tailnet，临时前台 Serve 将 HTTPS 443 代理到本机 127.0.0.1:3000。用户确认手机登录、真实 DSH 对话、图片处理、成果下载及重新登录恢复历史均通过。未配置公网 Funnel 或系统常驻服务。
