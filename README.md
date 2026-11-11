# AI Office 2.0

AI Office 2.0 是基于 DeepSeek Harness 的本地多账户工作台。登录后进入原版 DSH Web，各账户的对话历史、工作区和个人 Skill 分开保存。管理员可以创建用户、管理知识库和授予公共 Skill。

## 1. 准备 Mac

当前验证平台是 **Apple 芯片 Mac**。下面的命令都在 Mac 的「终端」执行。

1. 运行 `git --version`。如果系统提示安装开发者命令行工具，按提示安装，或运行 `xcode-select --install`。参见 [Apple 命令行工具安装说明](https://developer.apple.com/documentation/xcode/installing-the-command-line-tools)。
2. 下载 Apple 芯片版 Docker Desktop。安装后从「应用程序」打开 Docker，完成首次设置，等 Docker 引擎运行。参见 [Docker Desktop 安装说明](https://docs.docker.com/desktop/setup/install/mac-install/)。
3. 安装 **Node.js 24.21.0**。下载 macOS 安装包 `node-v24.21.0.pkg`，安装后打开一个新终端。参见 [Node.js 官方归档](https://nodejs.org/dist/v24.21.0/)。
4. 安装 **pnpm 12.16.1**。参见 [pnpm 安装说明](https://pnpm.io/installation)。

   ```sh
   npm install -g pnpm@12.16.1
   ```

   如果 npm 报目录权限错误，可改用当前用户目录安装。以后打开新终端时再次执行下面的 `export PATH`。

   ```sh
   npm install --prefix "$HOME/.local/ai-office-tools" pnpm@12.16.1
   export PATH="$HOME/.local/ai-office-tools/node_modules/.bin:$PATH"
   ```

5. 在 [DeepSeek 开放平台](https://platform.deepseek.com/) 登录并创建 API Key，供启动时输入。参见 [DeepSeek API 入门](https://api-docs.deepseek.com/)。

确认终端能找到这些工具，Docker 能显示服务端版本：

```sh
uname -m
git --version
node --version
pnpm --version
docker --context desktop-linux version
docker buildx version
```

`uname -m` 应输出 `arm64`，Node 应为 `v24.21.0`，pnpm 应为 `12.16.1`。

## 2. 克隆、安装和首次登录

```sh
git clone https://github.com/leoyang1984/ai-office-2.git
cd ai-office-2
pnpm setup:local
pnpm start:local
```

`setup:local` 下载锁定的 npm 依赖与 Docker 基础镜像，构建前端和 DSH 镜像。首次安装需要联网，下载中断后可重跑该命令。之后使用 `pnpm start:local` 启动。

首次启动时，终端显示管理员账号 `admin` 和临时密码，再提示输入 DeepSeek API Key。输入 Key 时屏幕不会显示字符，按回车继续。打开 [本地工作台](http://127.0.0.1:3088)，登录并修改临时密码。先发一条测试消息，确认能收到 DeepSeek 回复。普通用户由管理员在「账户管理」创建。

保持终端运行。按 `Ctrl+C` 停止工作台。账号、会话和文件默认保存在当前用户的 `Library/Application Support/AI Office 2.0`，重启后会继续使用。

## 3. 从手机访问

只在 Mac 上使用时，可以直接打开上面的本机地址。要从手机或其他电脑访问，请按 [Tailscale 安装与 Serve 配置](docs/TAILSCALE.md) 操作。指南包括两台设备登录同一个 Tailnet、启用 HTTPS、启动和关闭 Serve。

## 4. 更新与维护

更新前停止工作台并备份数据。更新源码后运行 `pnpm setup:local`，再运行 `pnpm start:local`。自定义端口、数据目录、备份恢复和迁移见 [部署与维护](docs/DEPLOYMENT.md)。

## 开发与验收

```sh
pnpm typecheck
pnpm test
```

原版界面、安全回归、迁移和手机实测见 [改造计划](docs/NATIVE_DSH_WEB_PLAN.md) 和 [R5 验收记录](docs/R5_TAILNET_REPORT.md)。旧版 SDK 工作台的命令见 [旧版工作台](docs/SDK_WORKBENCH.md)。
