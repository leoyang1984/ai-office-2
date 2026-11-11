# R1 原版 DSH 账户网关验收报告

日期：2026-11-11。状态：R1 测试验收通过，可进入 R2。全部测试使用独立临时数据库、合成账户和合成模型响应；真实 DSH Web、Docker ARM64、Chrome 和原生工具参与执行。没有切换正式入口、修改 Tailnet 配置或迁移真实数据。

## 已实现

### 平台登录与独立原版界面

复用现有账户、Argon2id 密码、首次改密、管理员创建/禁用/重置和审计 API。新增可选 `createApp({ nativeWeb: { image, model }, ... })` 路径与 `/api/v1/native/status`。启用该路径的测试服务在登录、必要改密完成后进入 `/dsh/`；原版扩展提供“办公室账户”和“退出办公室”，管理页沿用现有前端。默认 main.ts 和启动脚本仍走原有 SDK/Mock 分支，未增加自动切换。

用户实例只由服务端当前登录身份绑定，浏览器提交的用户 ID、会话 ID、路径或自定义目标不能选择另一个实例。用户 workspace、DSH Home 和已授予的知识库从既有 Store 按身份解析，挂载校验继续使用原有容器边界。

### 私有传输与身份检查

通用 DSH Web 传输抽到 `packages/dsh-web`。R0 的 loopback 页面转发只是显式启用的探针包装；R1 使用私有 Duplex 通道，不建立可绕过平台鉴权的宿主 TCP 入口。容器保持 network=none，不发布 Docker 端口。

DSH 启动令牌及其原生 Cookie 只在实例与服务端之间交换，不转交浏览器；浏览器仅持有平台 HttpOnly、SameSite=Strict 登录 Cookie。HTTPS 声明下的平台 Cookie 带 Secure。原生请求的 Cookie、Host 和 Origin 由网关重建，不能由客户端伪造内部凭据或目标。底层使用专用 HTTP Agent 和保留的 `.invalid` 地址，避免传输错误时落回个人 DSH 的本机端口。

所有 `/dsh/` HTTP 路由在读取请求体前检查登录、改密要求、账户状态、Host/Origin 和路径；每个请求从开始读取到响应完成都登记撤销回调。WebSocket 握手独立验证同样的身份并严格要求匹配 Origin；随后解码官方多路协议，按明确清单允许只读订阅并拒绝任意 uplink/执行端点。传输有消息、流数量和缓冲上限。

退出会撤销该平台会话、关闭其 HTTP/WS 连接；改密、管理员重置和禁用会关闭该用户全部连接并停止实例，再更新账户。启动等待和向浏览器输出前重复确认登录态。另有 500 ms 周期检查处理到期或其他会话状态失效，直接操作的撤销不等待该周期。退出本身不承诺取消已入队的后台 turn，该执行策略在 R2 单独处理。

原生模型配置、凭据写入、插件管理和终端 API 默认拒绝；设置和凭据描述显示为只读。唯一配置写入例外是官方首次预览提示的固定版本“已阅读”标记，精确限定命名空间、一个 op 和字段值。必要的启动、会话管理、目录和作业状态读取按固定版本端点清单开放。

### 原版下载与浏览器数据分离

`workers/office-native` 是独立的小型官方界面扩展，不替换原版聊天界面。通过官方 `sidebar.right.tab.document.actions` 槽添加“下载文件”，并通过 `shell.overlay` 提供账户入口。下载服务认证后在本人实例中调用原生二进制 RPC，限制 session 和规范化 workspace 路径，设置安全文件名、附件响应和 20 MiB 上限。

原版启动前加载平台存储隔离脚本：localStorage/sessionStorage 与 IndexedDB 名称按账户分开；切换账户时清理其他账户的原版缓存，等待清理完成后才启动官方入口脚本，失败时不启动原版界面。页面恢复和身份变化重新校验，响应使用 no-store。修复了异步 IndexedDB 清理误用已包装 deleteDatabase 导致重复前缀的问题，并用真实浏览器建库后切换验证。

原版动态模块需要 inline/eval 与同源 base，因此仅 `/dsh/` 响应设置兼容 CSP；原账户页继续使用既有严格策略。原版脚本仍限制为同源，禁止对象嵌入；worker-src 仅允许 blob，阻止持久化 Service Worker 脚本。更广泛的插件/预览脚本边界必须在 R2/R5 验证，不能将这组兼容策略描述为完整的脚本隔离证明。

## 版本和镜像

- DSH/SDK/Web：0.2.2-rc.1；Node：24.21.0。
- 新增运行依赖 ws 8.21.3，开发类型 @types/ws 8.18.1，已固定 lockfile。未安装全局软件。
- R1 镜像：`ai-office-2-dsh-web:r1-0.2.2-rc.1`。
- 最终镜像 ID：`sha256:250a2862a1b5d04cba8fc3480281d7904596fc8aa68485e47866bf76ee6ebdd3`。
- 基于已验收 P3 镜像，复用全部 8 个基础层，只增加 3 层扩展与配置，没有按用户重复安装 DSH。R1 构建脚本检查基础镜像和本地 Docker context。
- 外部 Host 通过受限环境项传给官方 trusted-host 参数；不开放容器网络，不设置宿主 DNS 或证书。

## 实际执行与结果

| 命令 / 场景 | 结果 |
| --- | --- |
| `pnpm build`、严格 TypeScript 检查 | PASS |
| `node tests/e2e/r1-native.ts` | PASS：平台登录/首次改密后进入原版，HTTP/WS 聊天和真实 write/present 工具正常，官方槽下载按钮保存精确字节 |
| 匿名、伪造 DSH Cookie/令牌、跨源 WS | PASS：平台身份仍必需，不能用原生凭据绕过 |
| A/B 会话、文件、下载、WS 历史及目标伪造 | PASS：实例绑定平台身份，合法本人请求成功，另一用户 session ID 被拒，URL 用户参数不能切换实例 |
| 管理/配置端点 | PASS：普通用户的管理员 API、模型配置写入和 WS 设置端点被拒 |
| 退出 | PASS：旧 HTTP Cookie 和新 WS 握手被拒，已有 WS 关闭，另一用户仍能使用 |
| 换账号与浏览器缓存 | PASS：同一浏览器 A→B 后无 A 草稿/会话；实际 IndexedDB 库被清理，不只是界面列表隐藏 |
| 密码重置、强制改密、禁用 | PASS：原连接失效，重置后须先改密，禁用后旧会话与重新登录均失败，另一用户的会话及文件保留 |
| 原版退出控件 | PASS：回到平台登录页 |
| `node tests/security/r1-host.ts` | PASS：非 loopback 的 HTTPS 声明、Secure Cookie、内部 Cookie 不回传、Host/CSRF/下载路径拒绝；这里为注入验证，未宣称真实 TLS 已验收 |
| 未完成的 HTTP 上传 | PASS：真实 loopback 请求只发送部分 body，平台退出立即中止上传连接 |
| 既有 API/备份集成测试 | PASS：2 个测试文件、8 项测试 |
| `node tests/e2e/r0-web.ts` | PASS：原版双实例、图片/普通文件、负向隔离和重建恢复回归 |
| `node tests/security/r0-sdk-web.ts` | PASS：SDK 合成历史在原版 Web 发现、显示与继续回归 |

修复并复测过：Node `agent=false` 未使用私有 createConnection、原版 303 登录交换、原版客户端 CSP、必要只读 WS 订阅缺失、首次提示的最小设置写入、显式文件路径的官方客户端扩展发现、异步缓存清理，以及读取上传体前的连接撤销跟踪。没有靠跳过鉴权或关闭隐私钩子解决问题。

## 边界与下一阶段

R1 是账户入口和连接鉴权阶段，不等于新版已达到完整多人发布闸门。

- 已有两个实例的基础容量限制；每用户一个 turn、全局 turn 限制、空闲回收、故障/超时、异常清理和持久化配额由 R2 实施和验证。实例数不能冒记成 turn 数。
- HTTP/WS 配置 API 已限制，但不等于已经防止 Agent 修改本人可写 profile 后改变插件加载。正式使用前，R2 必须锁定平台控制的配置和客户端插件/执行边界，不能只依赖界面只读。
- 请求体上限 20 MiB、原生图片上传 2 MiB；当前 R1 下载和账户测试使用小型合成文件，未完成新版全部上传边界、持久化总量和突发负载验收。
- 浏览器存储隔离已测同一上下文切换；任意恶意客户端插件、复杂预览与多标签页缓存占用不在已通过案例之内，留作明确风险。
- 公共/个人 Skill、真实数据迁移与回滚、真实云模型/手机 Tailnet HTTPS 分别留到 R3、R4、R5。旧 SDK 的手机验收不能代替新版验证。

## 复跑

本报告记录 R1 提交的验收基线。当前 main 上两条 R1 探针复用 R2 镜像做回归，按 [R2 报告](R2_NATIVE_RUNTIME_REPORT.md)的命令运行；以下为原 R1 复跑步骤。

在项目根目录、Docker Desktop 运行且已验收 P3 基础镜像存在时执行：

```sh
export PATH="$PWD/.runtime/node-v24.21.0-darwin-arm64/bin:$PATH"
pnpm install --frozen-lockfile
sh scripts/build-web-r1.sh
pnpm build
pnpm typecheck
node tests/e2e/r1-native.ts
node tests/security/r1-host.ts
pnpm test
node tests/e2e/r0-web.ts
node tests/security/r0-sdk-web.ts
```

两条 R1 验收脚本无需 API Key，自动创建并清理临时数据和容器。没有新增正式启动命令，普通启动脚本保持原分支。不要把测试路径指向现有 DSH Home 或真实数据目录。
