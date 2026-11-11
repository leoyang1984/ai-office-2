# AI Office 2.0 — Codex 开发规格（SPEC.md）

**状态**：可执行的初版研发规格（P0→MVP）  
**日期**：2026-11-10  
**目标平台**：macOS / Apple Silicon / Mac mini M1 16 GB  
**核心运行时**：DeepSeek Harness（DSH）；独立 Web 应用，不修改用户已安装的 DSH Desktop  
**开发执行者**：Codex  
**目标**：从零开始构建多账户、目录隔离、可授权只读知识库、可上传下载文件、可恢复对话、可通过 Tailscale 远程访问的 AI Office。

## 2026-11-11 产品方向修订

用户已确认：沿用官方 DSH 对话界面，统一账户入口，每用户独立 DSH Web 容器与持久化数据，公共镜像共用；公共 Skill 按授权只读共享，个人 Skill 独立保存。实施顺序及验收闸门见 [官方 DSH Web 改造计划](docs/NATIVE_DSH_WEB_PLAN.md)。

该修订与改造计划优先于下文有关自建会话页、仅 SDK 集成及每轮 Worker 生命周期的原始架构要求；原安全、隔离、隐私、测试与不修改已有应用数据的要求继续有效。既有 P0–P4 记录保留为 SDK 版本验收证据；R0 已通过合成数据验收，见 [R0 报告](docs/R0_NATIVE_WEB_REPORT.md)；R1 已通过账户网关测试，见 [R1 报告](docs/R1_NATIVE_GATEWAY_REPORT.md)；R2 已通过实例调度与权限测试，见 [R2 报告](docs/R2_NATIVE_RUNTIME_REPORT.md)；R3 已通过公共与个人 Skill 测试，见 [R3 报告](docs/R3_SKILLS_REPORT.md)；R4 已通过备份、迁移和回滚演练，见 [R4 报告](docs/R4_MIGRATION_REPORT.md)；R5 待实施。

---

## 0. 给 Codex 的最高优先级执行指令

你是此项目的主开发 Agent。请按下面规则自主实施，不要只生成设计图或停留在计划：

1. **先探测再编码**：先检查本机 DSH、Node、容器运行环境、Tailscale 的实际安装情况和版本；核对与所用版本匹配的官方 API/SDK。不得臆造 DSH RPC、SDK 方法、可配置项或文件路径。
2. **从新目录开始**：创建全新 `ai-office-2` 项目。绝不修改、迁移或清理 AI Office 1.0、DSH Desktop、个人 DSH Web 的现有配置/会话/目录。
3. **优先复用官方 DSH SDK**：首选 TypeScript SDK `@deepseek-ai/dsh-sdk-client` + 独立 DSH 子进程；具体包名、安装源、方法签名须按已验证版本确定。若 npm 不可用，先记录证据，再评估官方 Python SDK 或 SDK 源码；禁止反向工程个人 DSH Web 的私有 cookie/API 来充当集成接口。
4. **坚守权限边界**：用户工作区可写、知识库只读、其他用户目录不可读不可写。单靠 prompt、路径校验或 `workspace-write` 不算安全隔离。未验证 OS/容器级隔离之前，只允许 Mock Agent 或单一受信任开发账户，**不得宣称多用户安全完成**。
5. **分阶段提交成果**：每阶段完成代码、测试、更新 `docs/IMPLEMENTATION_LOG.md`、`docs/DECISIONS.md`、`docs/RISKS.md`；验收失败先修复，不跳阶段。
6. **无需等待逐小步指示**：在不破坏现有数据、不做危险系统变更的条件下自行推进 P0 至 MVP。凡需要管理员权限、安装 Docker/Tailscale、修改操作系统权限、公开网络端口、删除/覆盖现有文件或访问真实知识库时，停在边界上，明确给出所需操作与原因，不擅自提权。
7. **版本锁定**：锁定经探测验证的 DSH、Node、依赖和容器镜像版本，避免浮动 `latest` 造成不兼容。
8. **完成标准不是页面能打开**：必须提供自动化的正向与越权验收证据。功能和安全两项都通过才可进入可供多人使用的 MVP。

**第一轮立即执行**：完成 P0 环境探针、官方 SDK 最小往返验证、独立 home/workspace + session 恢复验证；同时生成项目骨架和探测报告。若外部依赖不可用，用 Mock Adapter 继续开发账户、文件和 UI，但明确标记 `runtime_not_verified`，禁止虚报真实 DSH 已接通。

---

## 1. 产品边界与原则

### 1.1 用户需求

- 管理员在 Web 后台创建、禁用、管理普通用户，授予各自可用的知识库。
- 每创建一个用户，自动建立唯一目录，用户所有对话、上传文件、工作项目和生成成果都被隔离地归属该用户。
- 用户在网页中可以新建/继续会话、与 DSH 对话、上传图片/文档、预览或下载成果。
- 用户只允许**读取**管理员授权的知识库目录，不能修改知识库；只能写入自己的工作区。
- 用户不能访问其他用户的会话、文件、凭据、执行环境。
- 管理员可查看账户、授权、任务状态、审计事件，按策略访问或导出用户数据。
- 本机 Web 服务只监听 loopback；以后通过 Tailscale Serve 供已获网络授权的异地设备登录。

### 1.2 非目标（第一版不做）

- 不重新实现 DSH Agent、LLM 推理、插件系统或原生 Web UI。
- 不集成 Pi、Codex、AGY 等为额外执行引擎；本项目的开发者是 Codex，运行时仅 DSH。未来可加 Agent Adapter。
- 不做公网匿名开放、团队 SaaS、计费、组织多租户、复杂 Agent 派工、自动浏览器控制、多节点调度。
- 不需要在用户已安装的 DSH Desktop/Web UI 中创建对应账号；AI Office 账户由本系统单独管理。
- 不将第一版 AI Office 项目里的旧代码直接复制过来，避免继承旧权限假设。

### 1.3 必须明确的术语

- **AI Office User**：本应用账号，不等同于 macOS 账号，也不等同于 DSH Web 账号。
- **Workspace**：用户可读写工作目录。
- **DSH Home**：该用户专属的 DSH 运行配置和会话持久化目录。
- **Knowledge Root**：管理员登记、按用户授权的共享只读目录。
- **Session**：一次可继续的 DSH 会话；属于唯一用户，绑定一个 workspace、一个 DSH Home 和 DSH session id。
- **Worker**：由 AI Office 后端调度、在隔离环境中运行的 DSH 进程或进程组。

---

## 2. 核实过的 DSH 能力与版本风险

基于截至本文编写时公开的 DeepSeek 官方仓库文档，存在以下接口（必须由 Codex 对本机实际选定版本重新验证）：

- 官方 Web 可用 `npx @deepseek-ai/dsh web`，通常监听 `127.0.0.1:3080`；它是供个人使用的 Web 工具，不直接当 AI Office 的用户账户服务。
- 官方 TypeScript SDK `@deepseek-ai/dsh-sdk-client`：以 stdio JSON-RPC 驱动 DSH 子进程，使用 `DeepSeekHarness`、`run(...)`、`onNotification(...)`、`resumeSession(savedId)`、`getWorkingDirectory()`、`setWorkingDirectory()` 等接口；可显式提供 `dshHome`。
- 官方另有 Python SDK `deepseek-harness-sdk`。与 Web profile 不同，SDK 需要 SDK profile，不可假设 Web 后端能直接服务 SDK 客户端。
- **极重要**：官方 `sdk-minimal` profile 默认是 `danger-full-access`，shell 可修改进程可访问的一切路径。**它不能直接用于承诺安全隔离**。可研究 base-backed `sdk` profile 及权限，但仍应将不受信任的执行置于额外 OS/容器边界内。
- DSH `workspace-write` 主要限定**写**；默认可能仍可读取其他可见路径和访问网络/本机 socket。单纯将 cwd 设为用户目录不能保护知识库或其他用户数据。
- DSH 正处于 Developer Preview，官方提醒可能存在破坏兼容的更新。

**官方资料**：

1. https://github.com/deepseek-ai/deepseek-harness
2. https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md
3. https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/sdk-minimal/README.md
4. https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/README.md
5. https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/python-sdk.md
6. https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/public-deployments.md
7. https://tailscale.com/docs/features/tailscale-serve

**禁止**：依据 README 的 `master` 文档假定 npm 当前安装包已经包含相同特性。探针报告要记录源码文档版本、npm 实际版本及能力差异。

---

## 3. 目标技术架构

```text
Browser (local / Tailscale)
        |
        v
AI Office Web (React + Vite, single origin behind API)
        |
        v
API Server (Node.js + Fastify + TypeScript)
  |         |                 |
  |         |                 +-- SQLite (users, grants, sessions, files, audit)
  |         +-- File Service (upload, list, download; owner checks)
  +-- DSH Runner Manager (quotas, lifecycle, SSE, adapter)
                 |
                 v
         Isolated Worker per user/session [required for multiuser]
         DSH SDK <stdio JSON-RPC> DSH runtime
                 |
                 +-- /tenant/workspace  (RW)
                 +-- /tenant/dsh-home   (RW/private)
                 +-- /knowledge/<id>   (RO, only granted roots)
                 X-- other tenants / host home / docker.sock / ssh-agent
```

### 3.1 技术默认值

| 层 | 默认方案 | 备注 |
| --- | --- | --- |
| Monorepo | pnpm workspaces | Node 按选定 DSH 兼容版本锁定 |
| 前端 | React + Vite + TypeScript | 手机与桌面自适应 |
| 后端 | Fastify + TypeScript | Zod 做请求校验 |
| 数据库 | SQLite + Drizzle / better-sqlite3（二选一） | WAL；迁移脚本、外键、备份 |
| 认证 | 密码登录 + HttpOnly Cookie Session | Argon2id 哈希；不把 token 放 localStorage |
| Runner | DSH SDK Adapter + Worker Manager | 最小可用，先不做分布式队列 |
| 隔离 | Linux ARM64 容器（Docker Desktop/Colima 可验证者） | 在 Mac M1 上需先验可用性与资源开销 |
| 流式输出 | Server-Sent Events（SSE） | 后端统一转换 DSH notification；断线重连 |
| 远程访问 | Tailscale Serve | 只代理 AI Office，不直接代理个人 DSH |
| 测试 | Vitest + Playwright + 容器安全集成测试 | 有可重复验收命令 |

如果验证证明在 macOS 上使用容器运行 DSH 不可行，Codex 必须提交替代隔离方案及测试结果。**不可自动降级为所有用户共享同一个 macOS 登录身份的无隔离 DSH 子进程。**

### 3.2 运行隔离设计（MVP 强制）

- 后端应用进程不直接承接任何来自用户的 shell 命令。
- 只有后端的 Worker Manager 能创建/终止容器，浏览器与 DSH Worker 都不能调用容器引擎 API。
- 每个用户至少独立 DSH Home；每个并发活跃 Session 独占 DSH 运行进程（或经证明等效安全且会话不串的数据通道）。
- 容器只挂载当前用户的工作区与 DSH Home 为可写；只挂载此用户**已授权**的知识库为只读。其他目录不挂载，禁止宿主 Home 根目录挂载。
- Worker 使用非 root 用户；禁用特权容器、宿主 PID/网络、Docker socket、ssh-agent、宿主钥匙串及可写的系统目录；默认丢弃 Linux capabilities，启用 no-new-privileges，设定资源/进程/内存上限；基础文件系统只读 + 必需 tmpfs。
- 由受信任的服务端组装 mount，所有路径均经 `realpath` 与白名单校验。对含符号链接、跨目录引用、特殊文件的情况拒绝或进行隔离验证。
- 知识库是否包含机密资料属于独立风险：只读不能防止 Agent 把读取到的内容发送到外部模型或网络。需要配置模型/网络出口白名单并在 UI 提示数据使用边界；如客户有严格保密要求，未经模型服务审查不得接入该知识库。
- 容器内若要访问模型 API，须使用最小化凭据范围；凭据可被 Agent 进程读取的风险必须记录。长期应考虑独立 LLM Gateway 与审计。
- 若官方 SDK 在容器内运行与宿主存在差异，优先把 SDK client 与 DSH runtime 一并置于 Worker 内，后端通过**自建的受限 Worker RPC** 通信；Worker RPC 只允许固定命令（创建会话、发消息、订阅事件、停止、恢复），绝不提供任意命令执行接口。

---

## 4. 目录布局与数据归属

**示例**：实际根目录通过环境变量 `AI_OFFICE_DATA_ROOT` 指定（使用绝对路径，不硬编码个人用户名）。

```text
ai-office-2/                         # 新源码仓库
  apps/
    web/
    api/
  packages/
    shared/
    dsh-adapter/
    runner-contract/
  workers/
    dsh-worker/                      # 隔离运行中的执行桥接进程
  infra/
    container/
    tailscale/
  scripts/
  tests/
    integration/
    security/
    e2e/
  docs/
    IMPLEMENTATION_LOG.md
    DECISIONS.md
    RISKS.md
    ENV_PROBE.md
  .env.example
  README.md
  SPEC.md

$AI_OFFICE_DATA_ROOT/
  db/
    office.sqlite
  users/
    <internal-user-uuid>/
      dsh-home/
      workspace/
        uploads/
        outputs/
        projects/
      logs/                        # 仅服务端和本用户可见的非敏感记录
  knowledge/                      # 可选：受管理知识库目录
  backup/
```

设计约束：

- 登录名/显示名**不能**直接拼接成磁盘路径；使用数据库生成的 UUID。
- “用户所有对话在用户文件夹中”落实为 DSH 的持久化 Session 保存在专属 `dsh-home`；SQLite 保存 Session 索引、所属用户、展示标题、状态和审计，不依赖数据库作为唯一会话内容来源。
- 项目文件保存在自己的 `workspace`。每个 Session 绑定 `workspace/projects/<project-id>` 或用户主工作区，具体由交互场景决定，默认**每个新对话新建 project 子目录**，便于隔离与下载。
- 单独保存用户本地上传图片与生成文件，UI 无须暴露 DSH 底层路径。
- 修改用户名不会移动或重命名用户目录。
- 删除账户：MVP 先禁用/软删除，数据移除必须有明确的管理员二次确认、备份及单独清理命令，不得立即递归删除。

---

## 5. 身份、权限与账户生命周期

### 5.1 角色

- `ADMIN`：管理账户、重置密码、启停用户、管理知识库登记和授权、查看审计与运行状态、按授权访问用户成果。
- `USER`：只查看和操作自己的会话、文件与已授权知识库；不能执行管理员接口。

### 5.2 创建用户的原子流程

1. 管理员提交用户名、显示名称、初始密码（可自动生成强随机临时密码），可选知识库授权。
2. 后端校验唯一性、用户名规则、密码强度与管理员身份。
3. 数据库创建 `pending` 用户记录及 UUID。
4. 安全创建目录：`dsh-home/`、`workspace/uploads/`、`outputs/`、`projects/`、`logs/`；设置限定权限；防止路径穿越/链接攻击。
5. 完成授权记录和用户激活；若任何步骤失败，回滚数据库并清理**仅本事务新建**的空目录，不破坏现有数据。
6. 写审计事件；页面告知账户已创建。首次登录强制更换临时密码。

**首次管理员引导**：提供仅本机 CLI 的一次性 bootstrap 命令，生成随机管理员凭据/初始化令牌；不可内置默认账号密码，不可通过开放的 `POST /register` 自动创建管理员。

### 5.3 必须具备的安全控制

- 密码 Argon2id 哈希，限速、防暴力破解、通用错误消息。
- Cookie `HttpOnly`、`Secure`（HTTPS 时）、`SameSite=Lax/Strict`；服务端会话失效和登出；CSRF/Origin 校验。
- 每个资源的服务端授权以当前登录 session 的 user id 为准，绝不能信任浏览器提供的 `userId`、`dshHome` 或绝对路径。
- 接口防 IDOR：无权限访问其他用户资源统一拒绝；不要通过错误信息泄漏存在性。
- 知识库授权精确到知识库 ID；默认拒绝全部。管理员改变授权后，**现有运行中的 Worker 必须终止/重建挂载**，不能继续读取已撤销目录。
- 所有管理操作写 `audit_events`，不记录明文密码、API Key、完整模型提示词或敏感文档内容。
- 审计至少保留：谁、何时、操作类型、目标 ID、结果、来源 IP/设备（按隐私需求）、Request ID。

---

## 6. 知识库授权机制

### 6.1 管理端

- 管理员通过配置或可信本机操作登记知识库：`id`、名称、宿主路径、启用状态。
- 宿主路径必须存在、是允许登记的目录，不能是系统敏感路径、其他用户目录或 DSH 凭据目录；拒绝链接逃逸。
- UI 提供“授予用户”“撤销用户授权”，展示当前权限（P0/MVP 只有 `READ_ONLY`）。
- 初期不做用户通过 Web 浏览任意宿主目录的功能。新增原有系统目录由管理员手动审核；可以提供 CLI `knowledge:add --path ...`。

### 6.2 Worker 端

- 每次启动从数据库读取当前授权列表，在容器内映射 `/knowledge/<knowledge-uuid>` 为 `ro`。
- 未授权知识库完全不挂载，不只是隐藏 UI。
- Agent 可以读取已授权目录中的文件，但新建、修改、删除、重命名、chmod、软链接绕过等写操作应在 OS/容器层失败。
- 知识库内容可包含嵌入式指令，必须当数据处理，不接受文档内容作为系统级权限更改命令。
- 授权撤销后先停止对应 Worker，后续会话仅能以新授权重新启动。

---

## 7. 对话、文件与执行行为

### 7.1 对话

- 新建 Session：生成 AI Office `conversation_id`，新建其 project 目录、启动或复用**该用户隔离的** Worker，将 DSH `session_id` 与 home/workdir 持久关联。
- 消息：用户文本和支持的图片内容通过 DSH Adapter 提交；后端把 DSH notifications 转换为统一事件（`queued`, `started`, `delta`, `tool`, `completed`, `failed`）。
- UI 显示消息流、工具动作摘要、会话状态；有“停止本轮”“重新加载”“继续历史会话”。
- 同一 Session 在任一时刻最多一个运行中 turn。请求必须有客户端幂等键，断线重连不能重复发消息。
- 重启服务器后使用官方 `resumeSession(savedId)`（或该版本等效官方接口）恢复；必须保证同一 `dsh-home`、会话 id、工作目录；恢复失败要明确提示，不偷偷新建一个同名空会话。
- 保存历史会话列表及可阅读的历史消息；如 SDK 没有稳定历史读取接口，先实现自有的只读事件投影存储/回放，不直接解析不稳定的内部 JSONL 格式作为长期唯一方案。
- 长耗时消息由服务端继续运行；网页断连不应导致任务立即取消。Worker 结束、浏览器重连后正确反映状态。

### 7.2 上传

- 支持 PNG、JPEG、WebP、PDF、TXT、MD（是否可让模型直接理解，依 DSH 能力决定；其余文件可作为工作区素材）。
- 上传使用 `multipart/form-data`；文件大小默认上限 20 MiB/个，可配置；服务端限制类型、扩展名、魔数、数量、总配额。
- 服务端生成存储文件名；原始文件名仅做展示字段。禁止 `../`、绝对路径、特殊文件、符号链接、压缩包目录穿越。
- 上传到当前用户 `workspace/uploads/`；用户可以将图片绑定到下一条消息，若 SDK 版本不支持某种附件，需提示该文件已入工作区但未直接作为模型图像输入，严禁假装发送成功。

### 7.3 文件浏览和下载

- 用户能浏览 `workspace` 中的相对目录和生成结果，下载单个文件；可以预览文本及常见图片。
- 后端实现安全文件 ID 或相对路径解析：固定到当前用户的根目录，做规范化 + `realpath`/打开后的文件身份验证，拒绝路径穿越、链接逃逸、其他用户目录和特殊文件。
- 下载设置安全 `Content-Disposition`、MIME 类型、大小限制，禁止任意宿主路径读取。成果文件不会自动共享给其他用户。
- MVP 可实现按选中路径下载；ZIP 批量导出属于后续增强，若实现必须防目录穿越和 ZIP bomb。

---

## 8. 数据库模型（建议字段）

- `users`: `id(uuid PK)`, `username(unique)`, `display_name`, `password_hash`, `role`, `status`, `must_change_password`, `created_at`, `updated_at`。
- `auth_sessions`: `id`, `user_id`, `token_hash`, `created_at`, `expires_at`, `revoked_at`, `last_seen_at`。
- `knowledge_bases`: `id`, `name`, `canonical_host_path`, `enabled`, `created_at`。
- `knowledge_grants`: `user_id`, `knowledge_id`, `permission=READ_ONLY`, `created_at`, unique(`user_id`,`knowledge_id`)。
- `conversations`: `id`, `user_id`, `dsh_session_id`, `workspace_relative_path`, `title`, `status`, `created_at`, `updated_at`, unique(`user_id`,`dsh_session_id`)。
- `messages` 或 `conversation_events`: `id`, `conversation_id`, `turn_id`, `seq`, `role/event_type`, `payload_redacted_or_projected`, `created_at`；不得保存明文密钥。
- `files`: `id`, `user_id`, `conversation_id?`, `relative_path`, `display_name`, `mime_type`, `size_bytes`, `sha256?`, `created_at`。
- `agent_runs`: `id`, `conversation_id`, `turn_id`, `worker_id`, `status`, `started_at`, `ended_at`, `error_code`。
- `audit_events`: `id`, `actor_user_id`, `action`, `target_type`, `target_id`, `success`, `request_id`, `created_at`。

要求数据库迁移可重复执行，外键生效，SQLite WAL 和备份策略可测；密码与密钥绝不进入审计或业务日志。

---

## 9. HTTP API 契约（第一版）

统一前缀 `/api/v1`；JSON 错误体：`{ "error": { "code": "...", "message": "...", "requestId": "..." } }`。响应字段以 Zod schema + OpenAPI 为唯一规范，不要前后端各写一套类型。

| Method | 路径 | 权限 | 作用 |
| --- | --- | --- | --- |
| POST | `/auth/login` | 公开/限流 | 密码登录并设 Cookie |
| POST | `/auth/logout` | 已登录 | 注销当前会话 |
| GET | `/auth/me` | 已登录 | 当前用户和角色 |
| POST | `/auth/change-password` | 已登录 | 修改密码 |
| GET | `/admin/users` | ADMIN | 用户列表 |
| POST | `/admin/users` | ADMIN | 创建用户并自动建目录 |
| PATCH | `/admin/users/:id` | ADMIN | 禁用/启用/重置状态 |
| GET | `/admin/knowledge` | ADMIN | 已登记知识库 |
| POST | `/admin/knowledge` | ADMIN | 登记经过白名单校验的知识库 |
| PUT | `/admin/users/:id/knowledge/:kbId` | ADMIN | 授予只读权限 |
| DELETE | `/admin/users/:id/knowledge/:kbId` | ADMIN | 撤销授权并重启对应 Worker |
| GET | `/knowledge` | USER/ADMIN | 当前用户可用知识库概览 |
| GET | `/conversations` | 已登录 | 本人历史会话 |
| POST | `/conversations` | 已登录 | 新建会话及 project 目录 |
| GET | `/conversations/:id` | 所有者/受授权管理员 | 会话元数据及消息 |
| POST | `/conversations/:id/messages` | 所有者 | 发送文本/引用附件，带幂等键 |
| POST | `/conversations/:id/stop` | 所有者 | 停止活跃运行 |
| GET | `/conversations/:id/events` | 所有者 | SSE 流；支持 Last-Event-ID |
| POST | `/files/upload` | 已登录 | 上传素材至本人工作区 |
| GET | `/files` | 已登录 | 本人目录文件列表 |
| GET | `/files/:id/download` | 文件所有者 | 安全下载 |
| GET | `/admin/audit` | ADMIN | 审计记录（分页） |
| GET | `/health/live` | 本机/探针 | 进程存活，不暴露敏感详情 |
| GET | `/health/ready` | 本机/探针 | DB / Worker 依赖就绪摘要 |

接口要求：所有 `/admin/*` 后端检查 ADMIN；所有资源接口使用当前身份绑定用户；分页和上限；上传单独速率与体积限制；SSE 建连必须鉴权；跨站请求受保护；日志敏感字段脱敏；避免将绝对宿主路径返回给浏览器。

---

## 10. 前端页面

1. **登录页**：用户名/密码、错误提示、首次修改密码。
2. **普通用户工作台**：左侧历史会话列表；中间对话及实时流；右侧可折叠“工作区文件/授权知识库”区域。手机改为分层抽屉。
3. **会话页**：新建、切换、继续、停止；上传图片/文档；工具执行状态；下载成果。初期不仿造完整 DSH Web UI。
4. **文件管理**：树形/列表浏览工作目录，图片预览、文本预览、下载。
5. **管理员面板**：用户列表、新建/禁用/重置、知识库注册/授权、Worker 状态、基础审计。
6. **错误/离线/重连**：网络断开、Agent 不可用、未授权、上传失败等都有明确状态。

界面优先干净、可用，不进行大规模动画/编辑器研发。

---

## 11. Worker Manager 与 DSH Adapter 契约

定义独立于 DSH 版本的应用内部接口（示意，不是声称官方已有该 API）：

```ts
export interface AgentAdapter {
  createConversation(input: {
    tenantId: string;
    conversationId: string;
    dshHome: string;
    workingDirectory: string;
  }): Promise<{ dshSessionId: string }>;

  resumeConversation(input: {
    tenantId: string;
    dshHome: string;
    dshSessionId: string;
    workingDirectory: string;
  }): Promise<void>;

  send(input: {
    conversationId: string;
    turnId: string;
    text: string;
    attachmentIds: string[];
  }): Promise<void>;

  subscribe(
    conversationId: string,
    onEvent: (event: AgentEvent) => void,
  ): () => void;

  stop(conversationId: string): Promise<void>;
  dispose(conversationId: string): Promise<void>;
}
```

- 内部还需定义可序列化的 `WorkerContract` 与受控 RPC；不能直接把宿主绝对路径暴露给用户。
- P0 用 `MockAgentAdapter` 跑通账号/UI，再用 `DshSdkAdapter` 接真实 SDK。
- DSH 通知流必须按用户/Session 过滤；官方 SDK 的通知可能涉及同一运行时的所有 Session，因此默认采用每隔离 Worker 单用户（更严格可单 Session）的策略，并在后端校验归属。
- Worker Manager 负责限流、超时、取消、清理残留进程、启动失败重试、冷启动恢复。默认全机最多 2 个活跃 DSH Worker、每用户最多 1 个活跃模型 turn；按 M1 16GB 实测后调整。
- 用户关闭浏览器不终止服务端任务。任务可以在用户重新登录后继续查看/恢复。
- 对 DSH API 的每次适配调用写契约测试；版本升级必须重新跑合同测试与安全测试。

---

## 12. Tailscale 远程访问与部署

- AI Office Web/API 对外只监听 `127.0.0.1:3000`（前端打包后由统一应用或同源反向代理提供）。开发阶段 Vite 可用独立端口，但不对外暴露。
- 安装并登录 Tailscale 后，以官方文档为准先测试：`tailscale serve 3000`；确认可以通过 tailnet 内 HTTPS 域名访问。后台运行需要先检查当前 CLI 是否支持 `--bg`。
- **绝不使用 Funnel**、不监听 `0.0.0.0`、不把 DSH 的 `3080` 端口直接开放给远程用户。
- 所有远程用户既需要 Tailscale 网络访问资格，也需要 AI Office 自己的用户名/密码及角色授权；不要把 Tailscale 网络身份当成唯一身份认证。
- 检查 HTTPS 下 Cookie、SSE、文件上传、下载及断线重连，不要硬编码 `localhost` 到浏览器端 API URL。
- 提供 `docs/DEPLOYMENT.md`：开机自动运行的可选配置、备份、恢复、更新回滚、Tailscale 检查与关闭方法。用户批准之前不得创建常驻系统服务。

---

## 13. 研发阶段、每阶段交付和闸门

### P0 — 环境探针和 DSH SDK 真实验证（必须首先完成）

工作清单：

1. 检查 macOS 架构、Node/npm/pnpm、DSH CLI、Web 端安装状态、`dsh --version`（若有）、本机监听端口、容器引擎、Tailscale CLI；只读探测，不读取/输出密钥明文。
2. 核实官方 TS SDK 包是否在所选版本中可安装并运行；读取对应版本源码/类型；记录 npm 与源码版本差异。
3. 在临时新建的测试目录中完成 DSH 的 Hello World：提交文本、收到回复、获取 Session ID；记录 SDK 通知与错误对象。
4. 用两个不同的 DSH Home、两个 workspace 测试：各自运行、恢复会话、工作目录与会话内容不串。
5. 评估 SDK profile 是否支持图片输入、工具事件、取消、超时、审批、历史读取；若不可用标记为缺口。
6. 容器 ARM64 最小验证：仅挂载测试用户工作区 RW 和假知识库 RO；尝试读取另一用户目录、修改只读知识库，必须失败。
7. 输出 `docs/ENV_PROBE.md`（具体版本、路径、结果、未验证项），`docs/DSH_COMPATIBILITY.md`（API 对照表），并固定 lockfile/镜像 digest。

**P0 验收**：至少完成一次真实 DSH 文本对话与新进程恢复，或明确阻塞证据。若模型密钥未配置，只能把模型调用标为 BLOCKED，不得标 PASS；可先完成不依赖模型的 SDK/容器探针。

### P1 — 账户、数据库和目录服务

- 初始化全新仓库、数据库迁移、一次性管理员 bootstrap。
- 密码认证、Cookie session、角色守卫、管理员创建用户、自动建目录。
- 实现安全文件服务及知识库登记/授权模型。
- `MockAgentAdapter` 跑通前后端。

**P1 验收**：重启后账户有效；目录创建正确；不能跨用户调用 API 或下载文件；路径穿越被拒；禁用用户不可登录。

### P2 — 隔离 Worker 和真实 DSH

- 容器安全配置、Worker RPC、DSH Adapter、会话创建/恢复、流式 SSE、任务停止及错误处理。
- 实现启动后从持久状态恢复与按需启动/关闭 Worker。
- 通过负向权限测试后方可允许普通用户使用真实 Agent。

**P2 验收**：两普通用户真实会话彼此独立；Agent 对只读库的增删改、对其他用户目录的访问均失败；被撤销知识库授权后，重新运行的 Agent 不可访问。

### P3 — 文件上传下载与可用的 Web UI

- 完成登录、对话、会话列表、文件面板、管理员控制台、上传/预览/下载、消息流。
- 适配窄屏手机页面和网络断线重连。

**P3 验收**：用户在网页上传 PNG，DSH 确认可读取（若模型支持）；生成文件保存于本账户目录、下载成功；退出/重新登录恢复历史。

### P4 — 远程部署、稳定性与文档

- Tailscale Serve 测试，Cookie/SSE/上传下载经 HTTPS 完整通过。
- 资源限额、崩溃恢复、审计、数据库备份恢复、用户数据备份策略。
- README、部署文档、风险清单、回滚和人工操作说明。

**P4 验收**：第二台 tailnet 设备可登录且仍受账户权限限制；运行中断重启后会话可恢复；所有强制安全测试通过。

---

## 14. 自动化验收矩阵（必须留有可复跑证据）

| ID | 场景 | 预期 |
| --- | --- | --- |
| A01 | 首次初始化管理员 | 只允许本机引导，默认密码不存在 |
| A02 | 管理员创建 A、B | 各自 UUID 目录、数据库记录一致 |
| A03 | A 登录、B 登录 | 各自只见自己会话和文件 |
| A04 | A 请求 B 的会话 ID/文件 ID | 403/404，绝不泄漏内容 |
| A05 | A 访问任意 `/admin/*` | 被拒绝且记录审计 |
| A06 | A 上传 `../secret.txt` / symlink | 拒绝或安全归一，不得逃逸 |
| A07 | A Agent 创建、修改自己项目 | 成功且保存到 A 工作区 |
| A08 | A Agent 写入授权知识库 | OS/容器层拒绝，文件哈希不变 |
| A09 | A Agent 读取未授权知识库 | 因未挂载/不可访问而失败 |
| A10 | A Agent 读取 B 工作区或 dsh-home | 因未挂载/不可访问而失败 |
| A11 | A Agent 尝试访问 Docker socket/SSH agent/宿主 Home | 全部不可用 |
| A12 | 管理员撤销 A 的某知识库权限 | 旧 Worker 停止，重启后不可读 |
| A13 | A/B 各建一个 DSH Session | 独立历史、独立目录，无事件串流 |
| A14 | 关闭浏览器再打开 | 无重复提交，能继续会话 |
| A15 | 重启 API/Worker | 会话恢复；失败时有明确报错 |
| A16 | 上传有效图片/无效伪造图片 | 有效成功、伪造拒绝 |
| A17 | 下载本人文件/别人的文件 | 前者成功、后者拒绝 |
| A18 | 两个浏览器同时发同一幂等请求 | 仅创建一次模型 turn |
| A19 | 远程 Tailscale 登录及 SSE | 正常、无需公网端口 |
| A20 | 容器/DSH 崩溃、超时、资源耗尽 | Worker 清理，用户目录完整，状态一致 |
| A21 | 被恶意文档诱导执行越权操作 | 底层权限仍拒绝 |
| A22 | 高负载并发 | 不超过可配置限制，剩余排队或拒绝，不拖垮主机 |

A08–A12 与 A21 为**安全发布硬闸门**。如果仅在 prompt 层拒绝，不算通过。测试中要对原文件做 hash 对比，必要时检查实际 mounts、容器权限、进程环境和网络边界。

---

## 15. 资源/安全/兼容性主要风险

1. **DSH 预览版接口变动**：SDK、CLI、profile 和通知格式可能变化；版本锁定 + 适配器 + 合同测试。
2. **`sdk-minimal` 默认高权限**：只能放在验证过的隔离容器内，且不能挂载宿主敏感文件；默认阻止其在宿主裸跑。
3. **`workspace-write` 不限制读取或网络**：只读库通过真正的只读 mount；未授权目录不挂载，禁用直连宿主敏感 socket。
4. **Mac mini 16GB**：并发 Agent/构建可能造成内存压力；初始最多 2 Worker，按需启动、空闲退出、资源限制和日志测量。
5. **SDK 本地保存与恢复兼容性**：新版本可能改持久化结构；至少做好版本信息记录、备份和升级前恢复测试。
6. **模型服务数据泄露**：Agent 阅读资料后有可能发送给云端模型；默认只允许管理员批准使用的模型/出口，机密知识库先进行保密审查。
7. **知识库挂载路径变更/符号链接**：从登记到启动存在 TOCTOU 风险；启动前再校验，拒绝超出白名单的目录，挂载后验证。
8. **Web 远程暴露**：只通过 tailnet，仍要自身身份认证、Cookie/CSRF、安全头和访问日志；不要使用 Funnel。
9. **凭据/数据备份**：不记录 API Key，备份有权限限制；恢复时保持 ID 和文件路径映射一致。
10. **个人 DSH 干扰**：绝不复用个人 `~/.dsh` 或 Desktop profile；需专用 DSH Home 和固定运行时。

---

## 16. Codex 最终输出与汇报格式

每个阶段完成后在终端给出简明报告：

```text
阶段：P0/P1/P2/P3/P4
已实现：...
变更文件：...
执行命令：...
自动测试：PASS / FAIL / BLOCKED（逐项注明）
权限验证：PASS / FAIL / NOT RUN
已知风险/阻塞：...
下一阶段：...
```

交付物必须包括：

- 新项目源码，可在本机复现；`README.md` 和 `.env.example`；固定依赖版本。
- `SPEC.md`、`docs/ENV_PROBE.md`、`docs/DSH_COMPATIBILITY.md`、`docs/IMPLEMENTATION_LOG.md`、`docs/DECISIONS.md`、`docs/RISKS.md`、`docs/DEPLOYMENT.md`。
- 完整迁移、账户初始化、启动/停止、测试及备份/恢复命令。
- P0 SDK 真实对话及恢复证据、P1–P4 验收报告（安全案例必须可重复执行）。

**第一条工作命令的意图**：读取此 SPEC，创建全新项目，并从 P0 开始探测实际环境、验证官方 SDK。不要把开发者正在安装的个人 DSH Web 当成应用的长期后台，不要复用私人 DSH Home。

---

## 17. 本 SPEC 所做的假设（如事实不符须记录并调整）

- 本机为 macOS Apple Silicon、16GB RAM；尚未确认 Docker/Colima、Tailscale 或 DSH SDK 的实际安装版本。
- 开发者正在单独安装 DSH Web；这有利于手动熟悉产品，不意味着 AI Office 必须嵌入那一 Web UI。
- MVP 规模先按少量已授权用户、有限并发设计，不承诺无边界的生产多租户安全性。
- 所有真实知识库在管理员完成路径登记与敏感性确认前不接入测试，P0 必须使用假的临时知识库。
- 模型 API Key 由用户在本机安全配置；缺 Key 时不伪造真实 API 通信结果。

**执行优先级：实际可运行 > 安全隔离可验证 > 基本用户体验 > UI 精修 > 扩展能力。**
