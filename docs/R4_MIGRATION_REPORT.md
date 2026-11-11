# R4 迁移、备份恢复和回滚

日期 2026-11-11。验收范围为独立测试数据目录、合成账户、合成模型响应和本机 Chrome。使用固定的 0.2.2-rc.1 SDK Worker 与 R3 原版 Web 镜像。正式入口继续使用现有部署。

## 数据和会话如何迁移

- 快照格式 2 包含办公室数据库、用户文件与 DSH 状态、托管知识库、公共与个人 Skill、Skill 数据库和已有迁移报告。文件目录和 SHA-256 记录在私有清单中。旧格式 1 仍可校验和恢复。
- `verify` 对照清单校验完整文件集合，再用临时数据库副本执行 SQLite 完整性和外键检查。恢复时再次校验复制结果，重新绑定知识库宿主路径，清空登录会话。账户 ID、密码哈希、状态和授权随快照保留。
- `migrate` 将已校验快照恢复到新目录，逐账户启动隔离的原版容器。它核对旧工作台的会话 ID、原版目录记录和原容器工作目录，确认历史可读后用官方 RPC 登记工作区并选择受管模型。迁移命令无需 API Key，无需启动 HTTP 服务。每次演练使用新目标目录。
- `db/native-migration.json` 记录账户、旧对话、DSH 会话 ID、工作区和处理结果。没有原生 ID、不可读历史、路径不匹配、待转换格式、原版拒绝激活和停用账户均有可辨识原因。会话内容仍在原有数据库或原生状态中，报告只含映射和结果。
- 「办公室账户」中的「旧版对话记录」可查看旧工作台保存的文字。只有 Mock 或 SQL 文字记录的对话可在这里阅读。可接管的历史保留原 DSH ID，并在原版工作区中续聊。原版目录沿用 DSH 标题，工作台原来的标题仍在文字记录中。

## 合成数据验收

| 步骤 | 实际结果 |
| --- | --- |
| 旧 SDK 数据 | 生成两个账户的真实 SDK 会话。另造三条兼容缺口，分别为 Mock 文字、映射到另一账户的原生 ID、停用账户 |
| 快照校验 | 账户、工作区、上传、知识库和 Skill 成对恢复。篡改公共 Skill 被 SHA-256 检出；替换数据库并更新清单后仍被 SQLite 检出；原版服务运行时拒绝备份 |
| 导入和显示 | 接管 2 条，保留为归档 3 条。Chrome 显示旧文字和原版历史；跨账户不可读；原登录会话失效；原账号可重新登录 |
| 续聊 | Chrome 使用原会话继续对话，合成模型收到旧 SDK 上下文。工作区、知识库和原版 Skill 目录已用实际 RPC 验证 |
| 迁移后恢复 | 新版续聊、迁移报告和授权从迁移后快照恢复到第三个独立数据目录 |
| 回滚 | 从迁移前快照恢复到独立回滚目录，启动旧 SDK 路线，用原 ID 和上下文继续。原数据及迁移前快照的跟踪文件哈希保持一致 |
| 回归 | 严格类型检查、旧格式备份及现有账户集成、R3 Skill、R2 权限与浏览器、R1 网关及原版界面 |

验收中修正了原版 Skill 目录可追加模型上下文时的合成探针识别方式。最终继续对话后等待原版会话完成并确认回复已落盘，再创建迁移后快照。

## 复跑与回滚步骤

在项目根目录运行完整自动演练。Docker Desktop 需有已验收的 P3 与 R3 镜像，R3 镜像 ID 为 `sha256:56a0a59b5255d6841f64ff8fd6880f1f17dcce35cf5bc8607cb697bd360d5ad2`。

```sh
export PATH="$PWD/.runtime/node-v24.21.0-darwin-arm64/bin:$PATH"
export TMPDIR=/private/tmp
pnpm typecheck
pnpm test
node tests/e2e/r4-migration.ts
```

单独复跑维护命令时，请替换为本次演练的绝对路径。备份来源需停机，目标目录需尚不存在。

```sh
AI_OFFICE_DATA_ROOT=/absolute/test/legacy pnpm maintenance backup /absolute/test/before
pnpm maintenance verify /absolute/test/before
pnpm maintenance migrate /absolute/test/before /absolute/test/migrated
AI_OFFICE_DATA_ROOT=/absolute/test/migrated pnpm maintenance backup /absolute/test/after
pnpm maintenance verify /absolute/test/after
pnpm maintenance restore /absolute/test/after /absolute/test/recovered
pnpm maintenance restore /absolute/test/before /absolute/test/rollback
```

1. 在隔离的迁移副本上验收登录、原版历史、续聊、授权和文件。切换准备阶段保留原 SDK 代码、Worker 镜像和迁移前快照。
2. 需要回滚时，先停止新版并保存一份校验通过的新版快照。将迁移前快照恢复到独立目录，用旧 SDK 启动方式和原镜像指向该目录，重新登录并验证原会话可续聊。
3. 将切换后的新版历史保存在新版快照，之后可在独立原版实例查阅。回滚演练使用迁移前时间点，迁移后产生的消息未做双向合并。
4. 维护失败后，用校验通过的快照和新的目标目录重试。只有带完整恢复标记的副本可作为数据根，只有成功生成迁移报告的副本通过迁移步骤。原版和 SDK 都通过数据根锁与备份操作互斥。

这次验收覆盖当前锁定版本。更老的原生日志格式、既有个人 DSH 的状态目录、未绑定到工作台的日志以及旧附件的完整预览矩阵需要分别验证。
