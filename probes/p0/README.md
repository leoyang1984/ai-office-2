# AI Office 2.0 P0 探针

此目录只包含环境与验收探针。使用独立官方 Node.js 24.21.0 和 pnpm 12.16.1。macOS ARM64 的 Node 发行包和 SHA-256 见 [环境报告](../../docs/ENV_PROBE.md)。Desktop 捆绑的 Node 无法加载 npm DSH 的原生模块。

在当前项目目录的终端中，将已校验的独立 Node 加入当前 shell 的 PATH，然后运行：

```sh
node --version       # v24.21.0
pnpm --version       # 12.16.1
P0_NODE=$(command -v node)
P0_PNPM=$(command -v pnpm)
P0_DIR=$(mktemp -d /tmp/ai-office-2-p0-install.XXXXXXXX)
cp probes/p0/package.json probes/p0/pnpm-workspace.yaml probes/p0/pnpm-lock.yaml \
  probes/p0/sdk-smoke.mjs probes/p0/fixture.mjs "$P0_DIR/"
mkdir -m 700 "$P0_DIR/install-home"
touch "$P0_DIR/empty.npmrc"
(
  cd "$P0_DIR" &&
  env -i PATH="$(dirname "$P0_NODE"):/usr/bin:/bin" HOME="$P0_DIR/install-home" \
    NPM_CONFIG_USERCONFIG="$P0_DIR/empty.npmrc" NPM_CONFIG_GLOBALCONFIG="$P0_DIR/empty.npmrc" \
    "$P0_PNPM" install --frozen-lockfile --ignore-scripts \
    --store-dir "$P0_DIR/store" --registry https://registry.npmjs.org/
)

"$P0_NODE" "$P0_DIR/sdk-smoke.mjs" metadata
"$P0_NODE" "$P0_DIR/sdk-smoke.mjs" fixture
```

`metadata` 不发送模型请求。`fixture` 需要系统允许绑定随机 loopback 端口，只向本机合成模型请求；检查 SDK 事件、恢复后的历史和 cwd、跨 home 拒绝。两种模式均不用个人 DSH 配置。

真实云模型验收在本机 zsh 中运行。可临时使用现有 DeepSeek Key。凭据只在子 shell 和探针子进程内使用。

```zsh
(
  read -rs 'DEEPSEEK_API_KEY?DeepSeek API Key: '
  printf '\n'
  export DEEPSEEK_API_KEY
  "$P0_NODE" "$P0_DIR/sdk-smoke.mjs" cloud
)
```

云模式使用 `deepseek-flash`，继承当前 shell 的 HTTP(S) 和 NO_PROXY 环境变量。输出中的 `proxyConfigured` 表示探针是否继承了代理变量。`TURN_TIMEOUT` 表示达到 90 秒的整轮截止时间。`TURN_FAILED` 会尽可能附上服务端 HTTP 状态码和错误分类。`UNEXPECTED_REPLY` 表示模型完成了请求，但回复未满足探针的精确标记校验。

容器权限验收在现有 Docker Desktop 就绪后执行：

```sh
docker --context desktop-linux version
sh probes/p0/container-isolation.sh
```

探针只使用新建的合成文件，测试容器退出后移除。容器无网络，只挂载当前测试租户的 RW workspace/home 和一个 RO 假知识库；校验拒绝访问其他租户、未授权知识库及宿主 socket，并比对知识库哈希。若本机没有固定镜像，Docker 从官方 registry 拉取。退出码 2 表示外部条件阻塞，不表示测试通过。
