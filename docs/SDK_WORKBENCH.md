# 旧版 SDK 工作台

P0–P4 的启动、验收和维护命令适用于 SDK 工作台。

## 简短启动命令

这台 Mac 的项目目录中已放置独立 Node 24.21.0。它位于 Git 忽略的 `.runtime/` 下。连接 Tailscale 后，在本机终端执行：

```zsh
zsh scripts/start-office.zsh
```

首次运行会在本机终端显示管理员临时密码，随后提示输入现有 DeepSeek API Key。网页登录后修改临时密码。保持该终端打开，Ctrl+C 停止服务。仅本机访问可使用 `zsh scripts/start-office.zsh local`。

## 本机运行

需要 Node.js 24.21.0 和 pnpm 12.16.1。进入项目目录后执行：

```sh
pnpm install --frozen-lockfile
pnpm build
export AI_OFFICE_DATA_ROOT="$PWD/data"
pnpm bootstrap
pnpm start
```

bootstrap 会在交互终端显示管理员的临时密码。打开 [本机工作台](http://127.0.0.1:3000)，用该账号登录并修改密码。用 Ctrl+C 停止服务。服务启动时创建 SQLite WAL 数据库和账户目录。使用已初始化的数据目录重启会保留账户、会话与文件。

登记合成知识库时，先在数据目录的 `knowledge/` 下创建一个普通子目录，再在后台填写子目录名。每个账号默认没有任何知识库授权。

## 验收

```sh
pnpm typecheck
pnpm test
```

验收使用临时 SQLite 和合成文件。应用运行时的 OpenAPI 规范在 `/api/v1/openapi.json`。P0 环境、兼容性和 P1 实施记录见 [环境报告](ENV_PROBE.md)、[DSH 兼容性](DSH_COMPATIBILITY.md)和[实施日志](IMPLEMENTATION_LOG.md)。

## 启动 DSH 模式

完成管理员引导后，在本机 zsh 的项目目录执行。服务使用当前 Mac 已验收的 Worker 镜像，Key 在当前子进程环境中提供。

```zsh
(
  read -rs 'DEEPSEEK_API_KEY?DeepSeek API Key: '
  printf '\n'
  export DEEPSEEK_API_KEY
  AI_OFFICE_AGENT_MODE=dsh NODE_USE_ENV_PROXY=1 pnpm start
)
```

## Worker 与浏览器验收

下列命令在 Docker Desktop 运行时执行。Worker 基础镜像和 SDK 依赖均按版本及完整性锁定。

```sh
sh scripts/build-worker.sh
OFFICE_TEST_IMAGE=ai-office-2-dsh:p3-0.2.2-rc.1 node tests/security/p2-worker.ts
OFFICE_TEST_IMAGE=ai-office-2-dsh:p3-0.2.2-rc.1 node tests/security/p2-api.ts
node tests/e2e/p3-browser.ts
```

`p2-worker.ts` 检查实际 Worker 镜像的文件权限、跨会话拒绝和新容器恢复。`p2-api.ts` 验证授权变更取消正在运行的 Worker、后续 Worker 读取失败，以及 SSE 事件回放。这两条命令使用合成模型响应。云模型验证通过 `node tests/security/p2-worker.ts cloud` 运行，需在本机终端临时提供 `DEEPSEEK_API_KEY`。终端通过 HTTP(S) 代理时，可用 `NODE_USE_ENV_PROXY=1` 启用 Node 对该环境的支持。

浏览器测试使用本机 Chrome、临时浏览器会话和临时账户。P3 的浏览器复跑默认使用合成响应，可在本机终端提供 Key 并执行 `NODE_USE_ENV_PROXY=1 node tests/e2e/p3-browser.ts cloud` 验证实际图片识别。

P4 故障测试通过 `node tests/security/p4-failures.ts` 复跑，使用独立临时数据和容器，覆盖容器崩溃、DSH 进程崩溃、模型超时及容器临时盘耗尽。

[部署与维护](DEPLOYMENT.md)包含 Tailnet HTTPS、备份恢复、异常退出和更新回滚的操作说明。当前远程入口使用临时前台 Serve；需要保持应用终端和 Serve 会话运行，尚未配置开机自启。
