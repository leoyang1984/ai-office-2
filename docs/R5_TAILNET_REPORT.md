# R5 原版 DSH 手机与云模型验收

日期 2026-11-11。仅使用临时合成数据和独立路由。正式入口、旧数据和现有应用配置未切换。**手机 Tailnet HTTPS、管理员和普通账户登录、真实 DeepSeek 对话已通过。手机文件上传下载、Skill、断线恢复和撤权待实测。**

## 启动

Mac 连接现有 Tailnet，Docker Desktop 保持运行。使用已经启用的 MagicDNS 与 HTTPS；本轮不修改 Tailnet 管理设置。测试使用 Tailnet HTTPS 8443 到 Mac 的 `127.0.0.1:18445`，已有配置或端口占用时停止。参考 [Tailscale Serve 官方文档](https://tailscale.com/docs/reference/tailscale-cli/serve)。

在 Mac 的「终端」进入项目根目录后执行。需要时先用固定 Node 在项目根运行 `pnpm build`，缺镜像时运行 `sh scripts/build-web-r5.sh`。当前验收镜像为 `ai-office-2-dsh-web:r5-0.2.2-rc.1`（`sha256:ed68b7540cb03646604d9aa57afa087b855f2db242c5e191250eb1270590b7f1`）。

```zsh
(
  read -rs 'DEEPSEEK_API_KEY?DeepSeek API Key: '
  printf '\n'
  export DEEPSEEK_API_KEY
  NODE_USE_ENV_PROXY=1 .runtime/node-v24.21.0-darwin-arm64/bin/node tests/e2e/r5-tailnet.ts phone
)
```

Key 输入无回显，只在本次测试进程使用。测试服务不读取现有应用 Key，也不把 Key 传给容器或 Serve。终端会显示手机入口、管理入口和随机生成的临时密码。保留终端运行，不要分享密码。测试使用独立 Cookie 名称、私有临时数据和新账户。使用 HTTPS 时浏览器应正常验证证书。

## 手机验收顺序

1. 手机连接同一 Tailnet，用 Safari 打开「手机测试入口」。登录 `r5-phone`，更换至少 12 位的测试密码，确认进入原版 DeepSeek Harness。发「只回复 R5_PHONE_OK」，确认回复，终端应记录 DeepSeek SSE 已连接。失败时记录失败步骤与错误，不要发 Key 或密码。
2. 在同一会话输入「创建 r5-report.txt，内容只有 R5_SYNTHETIC_FILE，请用呈现工具把文件显示出来」。点文件预览中的「下载文件」，保存到手机文件夹。再用附件按钮上传刚下载的文件并发送测试消息，确认附件发送成功。可以另选一张自己生成的合成图片，勿选择真实资料。
3. 开新会话输入 `/r5-marker`，应回复 `R5_SKILL_BLUE_PAPER`。再开新会话输入 `/r5-personal`，应回复 `R5_PRIVATE_ORANGE_PAPER`。如命令菜单要求点选 Skill，选择对应条目后发送。
4. 手机短暂断开 Tailscale 再连上，重新打开测试页并点回第一段会话，确认对话和成果仍在，可以续聊。再退出办公室、重新登录，复核历史。
5. Mac 用另一个浏览器或无痕窗口打开「Mac 管理入口」，登录 `r5-admin` 并改密。打开「账户管理 → 公共 Skill」，选 `r5-phone` 和 `r5-marker · 1.0.0`，在「授权操作」选「撤销所选版本」，保存。手机原会话连接应断开；点「继续使用 DSH」或刷新后，新会话中不再发现 `r5-marker`，个人 Skill 仍存在。已进入旧会话的文字不会被删除。移动布局可先关闭文件预览，再用左上侧栏打开历史。最后在账户列表禁用 `r5-phone`，确认手机被送回登录页且无法再次登录。若 Mac 不能访问自身 Serve 地址，可在手机另一个浏览器里打开同一个管理地址，保留两个独立的登录上下文。

## 停止与回滚

在启动测试的 Mac 终端按 Ctrl+C 停止。关闭终端发出 SIGHUP 时也会触发清理。超过 45 分钟自动停止。脚本先停止自己启动的前台 Serve，再关闭测试网关与容器，检查作用域内无残余容器后清理合成目录。运行 `tailscale serve status --json` 复核，没有指向 `http://127.0.0.1:18445` 的 8443 前台路由即完成测试回滚。

如异常中断，只处理经核对指向上述回环地址的 R5 前台进程。优先停止原测试终端，或核实对应进程命令行后发送 SIGINT。不要使用 `tailscale serve reset`，也不要停止或恢复正式实例。本轮无需把任何测试数据写回正式目录。需要恢复快照或回退到旧 SDK 数据时，按 [R4 迁移与回滚](R4_MIGRATION_REPORT.md) 恢复到新目录。

## 自动复跑与边界

```sh
export PATH="$PWD/.runtime/node-v24.21.0-darwin-arm64/bin:$PATH"
export TMPDIR=/private/tmp
pnpm typecheck
pnpm test
node tests/e2e/r5-tailnet.ts local
node tests/e2e/r5-tailnet.ts probe
# 仅当 Mac 可以从自身的 Tailnet HTTPS 地址访问时运行：
node tests/e2e/r5-tailnet.ts fixture
```

`local` 在独立回环 HTTPS 代理下测试原版 Chrome 界面、Secure Cookie 与 WSS，使用手机尺寸模拟和合成模型。`probe` 检查短时 Serve 路由与 Mac 自访 TLS 后退出，不能替代第二台设备。手机仍需使用 `phone` 经过真实 Tailnet HTTPS 完成云模型验收。

排查发现原版界面会并发上传多选附件，网关此前会拒绝其中一个。现将同一账户的原版上传有界排队，保持轮次互斥和逐个配额校验。另将原版附件模块指向已有的账户数据目录，使它可以初始化文件存储，平台配置仍为只读。配额监控收回容器后，若超额文件仍在，唤醒请求继续返回配额错误。


| 验证 | 结果 |
| --- | --- |
| 本机 Chrome 经独立 TLS 代理 | 通过。手机尺寸首次改密、独立 Secure/HttpOnly/SameSite Cookie、原版聊天和 WSS；图片与文本并行上传、原版写入/呈现工具及精确下载 |
| 断线、会话与重放 | 通过。主动断开已连接的 WSS，浏览器离线后重新加载；同一会话有完整历史，重放原请求 ID 不重复调用模型 |
| 授权与账户 | 通过。A/B 会话和下载隔离，公共及个人目录只展示授权内容；公共 Skill 加载、撤权中断连接和重建、退出重登、账户禁用立即断开均通过 |
| Tailnet 前台测试入口 | 端口和转发目标符合预期，停止后测试路由已清理；Mac 回访自身时 TLS 握手未通过，手机已确认能打开测试页 |
| 最终安全回归 | 严格类型检查、8 项集成测试及 R1–R4 的 6 条脚本均通过。R1 禁用测试直接观察两组网关连接，避免把页面切换时未完成的浏览器连接算为存活 |
| 手机登录和 DeepSeek 云 | 用户确认手机经独立 Tailnet HTTPS 入口，管理员和普通账户均可登录，发送消息有回复 |
| 手机文件、Skill、断线恢复和撤权 | 待用户实测，本机合成浏览器验收已通过 |

关闭终端曾留下独立 Serve 进程，已单独清理。已复测 SIGHUP 下测试路由、回环监听和临时数据清理。
