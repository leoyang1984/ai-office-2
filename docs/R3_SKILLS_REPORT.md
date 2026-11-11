# R3 公共与个人 Skill 验收

日期 2026-11-11。验收使用独立临时数据、合成账户和模型响应，原版 DSH 0.2.2-rc.1、Docker ARM64 与 Chrome 参与执行。正式入口继续使用现有部署。

## 使用入口

在原版 DSH 打开「办公室账户」。所有登录用户可在「个人 Skill」保存、编辑或删除自己的 Skill，并查看获授权的公共版本。管理员在「账户管理」的「公共 Skill」发布版本、选择用户、授予或撤销该版本。发布新版本后，管理员可对指定账户切换版本。用户在 DSH 对话中可用 `/skill-name` 加载，也可由模型通过原版 `skill` 工具加载。

安装时输入名称、版本、说明和指令正文，平台生成标准 `SKILL.md`。参考文件可使用平铺的 UTF-8 Markdown、TXT、JSON 和 CSV，每包最多八个参考文件，合计最多 128 KiB。脚本、二进制、路径穿越和重名文件会被拒绝。可用的 Agent 工具沿用 R2 的文件与展示工具，加上原版 Skill 加载器。

## 安装、刷新和边界

- 公共版本按名称和版本号固定。一份版本内容只写入一个平台目录，各获授权的容器只读挂载同一份来源。相同内容重复发布返回原版本，修改已发布内容需要新版本号。授权绑定版本，发布本身不会改变已有账户的授权。
- 个人 Skill 保存于该用户单独的目录，由账户页编辑或删除。容器只读挂载当前版本，产物写入本人工作区。保存前预留 R2 存储配额。同一账户的个人名称与已授权公共名称冲突时，保存或授权会在断开实例前被拒绝。不同用户可以有同名个人 Skill。
- DSH 只扫描镜像配置指定的 `/office-skills`。平台按授权把单个 Skill 挂入该目录，工作区的默认 Skill 发现目录未启用。授权和个人内容变化先停止受影响实例，再保存新配置。打开 DSH 或点击「继续使用 DSH」后，原版目录与加载器从新挂载发现内容。
- 撤权先中断相关模型执行和连接，重建后旧 Skill 不再出现在目录、文件挂载和加载工具中。已经进入历史或由用户复制的内容仍可能保留。其他账户的授权和运行实例继续生效。
- 公共文件保存在数据根的 `skills/`，个人文件保存在各用户的 `skills/`。目录索引和授权存于 `db/native-skills.sqlite`。这三类数据应纳入 R4 的备份、恢复与回滚演练。

## 实测

| 验证 | 结果 |
| --- | --- |
| Chrome 账户页与 API | 公共发布、授权、个人保存和编辑通过；匿名及普通用户发布拒绝，重复发布和同名冲突符合规则 |
| 原版目录与加载 | 官方 `skills/list` 只发现获授权与本人内容；实际 `skill` 工具及 `/name` 加载正确；工作区放置的合成 Skill 未自动发现 |
| 双容器挂载与工具限制 | 两容器公共版本使用同一个宿主来源，个人来源不同；OS 拒绝写入，模型无法改写 Skill、读取未授权 Skill 或执行 Shell；参考文件可读，产物落在本人工作区 |
| 刷新、持久化与撤权 | 单账户切换版本后加载新内容，另一账户继续旧版本；管理页打开时重启，个人修改和授权恢复；撤权中止实际模型请求和 WebSocket，重建后加载被拒 |
| 回归 | 严格类型检查、8 项集成测试、R2 权限与浏览器、R1 鉴权与原版界面回归 |

探针改用带会话 ID 的原版目录接口验证发现。重启验证发现打开管理页时的 HTTP 连接可能拖住服务退出，修复后先收回原版实例与 WebSocket，再关闭剩余 HTTP 连接。保持浏览器打开复测成功。

R3 测试镜像 `ai-office-2-dsh-web:r3-0.2.2-rc.1` 使用固定 R2 基础镜像。验收镜像 ID 为 `sha256:56a0a59b5255d6841f64ff8fd6880f1f17dcce35cf5bc8607cb697bd360d5ad2`。测试通过 `createApp({ nativeWeb: { image, model, skills: true } })` 启用 R3。

## 复跑

在项目根目录、Docker Desktop 运行且已验收的 R2 基础镜像存在时执行。

```sh
export PATH="$PWD/.runtime/node-v24.21.0-darwin-arm64/bin:$PATH"
export TMPDIR=/private/tmp
sh scripts/build-web-r3.sh
pnpm typecheck
pnpm test
node tests/security/r3-skills.ts
node tests/security/r2-runtime.ts
node tests/e2e/r2-browser.ts
node tests/security/r1-host.ts
node tests/e2e/r1-native.ts
```
