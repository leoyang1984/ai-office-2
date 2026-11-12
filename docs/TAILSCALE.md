# 用 Tailscale 从手机访问 AI Office 2.0

先在 Mac 上完成 [本地安装](../README.md)，确认本机能登录和对话。Tailscale 让 Mac 和手机加入同一个私有网络（Tailnet）。Tailscale Serve 把手机访问的 HTTPS 地址转发到 Mac 上的 AI Office。手机访问时还要用 AI Office 账号登录。

## 1. 让 Mac 和手机加入同一个 Tailnet

1. 在 Mac 下载并打开 Tailscale。首次使用时按提示允许 VPN 配置或系统扩展，然后登录 Tailscale。推荐 macOS 独立安装版。参见 [Tailscale Mac 安装说明](https://tailscale.com/docs/install/mac)。
2. 在手机安装 Tailscale，打开后允许添加 VPN 配置，用同一账号或受邀账号加入同一个 Tailnet，并打开连接开关。参见 [iPhone/iPad](https://tailscale.com/docs/install/ios) 或 [Android](https://tailscale.com/docs/install/android)。
3. 在 [Tailscale 管理控制台的设备列表](https://login.tailscale.com/admin/machines) 核对 Mac 和手机都已加入。用受邀账号时，Tailnet 的访问规则需要允许该手机访问 Mac 的 HTTPS 端口。

在 Mac 的「终端」运行 `tailscale version`。如果找不到命令，使用独立版时从 Tailscale 的 Settings 找到 CLI integration，按提示安装。若使用 App Store 版，在下面的终端命令中把 `tailscale` 换成 `/Applications/Tailscale.app/Contents/MacOS/Tailscale`。项目的预检脚本也能找到该应用内置的命令。参见 [Tailscale CLI 安装说明](https://tailscale.com/docs/reference/tailscale-cli?tab=macos)。

## 2. 在 Tailnet 启用 HTTPS

打开 [Tailscale 控制台的 DNS 页面](https://login.tailscale.com/admin/dns)，确认 MagicDNS 已开启，然后在 HTTPS Certificates 下选择 Enable HTTPS。这个操作需要 Tailnet 管理权限。申请 HTTPS 证书时，设备域名会出现在公开证书记录里，建议先给 Mac 取一个不包含个人姓名的设备名。Serve 会处理证书。参见 [Tailscale HTTPS 说明](https://tailscale.com/docs/how-to/set-up-https-certificates)。

## 3. 在 Mac 启动应用和 Serve

下面使用 Mac 本机端口 `3088` 和 Tailnet HTTPS 端口 `8443`。在 Mac 第一个终端先停止原本的本机模式（若已运行），进入克隆的项目目录，再预检：

```sh
node scripts/tailnet-check.mjs 8443
```

如果预检提示 8443 已被使用，请选其他空闲端口（例如 9443），并在预检、HTTPS 地址和 Serve 命令中使用同一个新端口。复制预检显示的 `AI_OFFICE_ORIGIN=...`，在同一行后面加上 `pnpm start:local`。例如，下面的域名需要换成你自己的：

```sh
AI_OFFICE_ORIGIN='https://office-mac.example-tailnet.ts.net:8443' pnpm start:local
```

按提示输入 DeepSeek API Key，保持第一个终端运行。然后打开 Mac **第二个终端**：

```sh
tailscale serve --https=8443 http://127.0.0.1:3088
```

在手机 Safari 或 Chrome 打开 Serve 打印的完整 HTTPS 地址，包括 `:8443`。使用原来在本机创建的 AI Office 账号登录。两个终端都需要保持运行。此指南使用 Tailnet 内的 Serve，设备接入规则仍由 Tailnet 管理员控制。参见 [Tailscale Serve 官方说明](https://tailscale.com/docs/features/tailscale-serve)。

## 4. 停止与排查

- **停止远程访问**：在第二个终端按 `Ctrl+C`。再运行 `tailscale serve status`，确认本次配置的端口已消失。在第一个终端按 `Ctrl+C` 停止 AI Office。
- **手机打不开页面**：确认两台设备都连上同一个 Tailnet，Mac 没有睡眠，两个终端仍在运行。重新复制 Serve 打印的完整地址。
- **页面返回 403**：核对启动应用时的 `AI_OFFICE_ORIGIN` 与手机输入的 HTTPS 域名、端口一致。若改过本机端口，Serve 目标也要用相同端口。
- **登录成功但对话没有回复**：先检查 Mac 上 Docker Desktop 和 DeepSeek API Key 的状态。Serve 只转发网页和对话流，云模型请求由 Mac 发出。
- **能对话，但不能搜索网页、运行 `curl` 或执行脚本**：当前版本未启用这类工具，DSH 容器也没有公网网络。Tailscale、浏览器权限和 AI Office 管理员角色都不会改变这个设置。
- **长任务达到上限**：看页面上是模型请求次数提示还是任务超时提示。两者都可在原会话继续；服务端限制见 [部署与维护](DEPLOYMENT.md#原版-dsh-web-本地安装)。
- **恢复为仅本机访问**：停掉 Serve 和当前工作台后，运行 `pnpm start:local`，使用 `http://127.0.0.1:3088`。
