# 飞书、GitHub 与角色性格

本页对应 v0.2.0 预览版（2026-09-22）。v0.1.0 安装包未包含这些新增功能；使用前请升级到 v0.2.0，或从源码重新构建并重启两端。

## 外形与性格

外形与性格分别保存。`persona.style` 为 `character` 时跟随角色清单的 `recommendedPersona`；固定选择后，换角色不更改性格，也不修改用户取的名字。`instruction` 可补充偏好；旧配置未包含 style 时迁移为 custom，原文完整保留。

| 性格 | 表达方式 | 推荐形象 |
| --- | --- | --- |
| 温柔陪伴 | 先倾听，回应轻柔、具体 | 小森、月团、绵绵（云朵羊） |
| 细致周到 | 留意细节和遗漏，复杂问题分步骤 | 栗栗（猫头鹰） |
| 直白理性 | 平实直接，先说事实和结论 | 方方（机器人） |
| 热情活泼 | 轻快积极，适量幽默 | 柚子（狐狸） |
| 简洁高效 | 默认一到三句，先结论和下一步 | 点点（企鹅） |

控制器“我的灵伴”实时预览真实角色帧；“名字与性格”保存后从下一轮聊天生效。主动问候、桌面聊天、飞书私聊共用 `persona.catalog`。这些预设约束表达习惯，不扩大工具权限。

新角色为项目原创 SVG，每种有 idle/greet/happy/think/sleep/drag 六种语义动作、各两帧。`node scripts/generate-friends.mjs` 可重新生成五个新角色。角色元信息与 `representations.sprite` 分离，推荐性格不依赖渲染器；当前渲染器仍只实现 2D，3D 渲染需另做插件。

## 飞书使用

1. 在“飞书与 GitHub”点击“安装飞书依赖”。下载官方 lark-cli Windows 可执行文件，核对固定 SHA-256 后放进宠物目录，不需要用户另装 Node.js。
2. 点击“登录飞书 / 扫码接入”，在出现的官方页面完成操作。没有应用配置时先走官方创建应用流程；已有配置直接进入用户授权，避免反复创建机器人。
3. 已有机器人可以展开“使用已有机器人”，填 App ID、App Secret。Secret 通过 stdin 交给 CLI，不放入进程命令行或返回给模型。
4. 办公能力选“我自己”或“机器人”，勾选启用并保存。个人文档和日程需要用户登录授权；机器人的访问范围与用户不同。点击“授权完整办公读写能力”一次申请业务域权限；已有少量只读授权的账户需要在官方页面完成新增授权。“自定义授权范围”保留按 scope 授权的方式。
5. 私聊通道需要应用启用机器人，配置长连接事件 `im.message.receive_v1`，授予 `im:message.p2p_msg:readonly` 及机器人发送消息所需权限，并完成应用发布和可见范围设置。官方创建流程是否已配置这些项，以飞书后台实际结果为准。
6. 勾选私聊通道、保存，确认“已连接”。生成配对码，在机器人私聊发送 `/pair 配对码`。之后该用户可以直接聊天；群聊、机器人消息和非文字消息暂不处理。删除已允许用户并保存即可撤销接入。

飞书响应显示在飞书，不重复在桌面冒泡。每个用户和私聊有独立上下文，不切换桌面会话。`/new` 将旧对话归档后开始新对话；记忆仍保留。飞书历史目前保存于独立数据文件，尚未并入桌面的历史列表。

`feishu_cli` 通过参数数组执行官方 CLI。先读取自带 Skill 或 `--help` / `schema`，不靠猜测拼接命令。业务读取归入 read，创建、修改、删除和发送等归入 write，二者默认允许。CLI 返回结构化高风险确认（exit 10）时，在中央工具策略已通过的前提下补充 `--yes` 重试一次，不再另弹一次确认。用户主动把通用 read/write 策略改为询问或禁止时仍生效；其他 MCP 的默认审批策略不变。这是按用户 2026-09-22 明确要求采用的业务权限策略，优先于 CLI 自带 Skill 中的重复确认建议。

支持直接调用 `["--help"]` 和 `["-h"]`。办公工具统一附加设置中的身份，官方示例里的 `--as user` / `--as bot` 应省略；工具描述会告诉模型当前身份，误传时也会明确提示如何修改。登录、配置仍由设置入口管理。

CLI 明确报告 `authorization / missing_scope` 时，工具返回结构化的缺失 scope 和适用于当前身份的处理说明，同时设置页显示“待补充的授权”。用户身份可以点击对应按钮发起增量授权；机器人身份提示在开发者后台开通应用权限，不使用用户 OAuth。只提取明确的 `missing_scopes`，不会把“任选其一”的权限自动全部申请。帮助、预览或完成登录不会宣称权限已恢复，原业务查询成功后才移除对应提示。提示保存在当前运行时，更换机器人或重启后重新检测。

首次登录和完整办公授权使用显式 `--domain` 列表，包括文档、云空间、日历、任务、消息、表格、邮箱等业务域；不使用 `all`，不申请 application 或 contact 管理域。精确范围在 `plugins/feishu-cli/policy.ts` 的 `officeDomains`。联系人只保留人员/机器人查询入口，按需补充只读 scope。授权须同时满足飞书应用已开通权限和用户同意；插件不能替代这两层官方授权。

账户边界在执行前校验，自动模式和 CLI 的 `--yes` 也不能绕过。登录、配置、profile、裸 HTTP API、凭据参数、账户/组织写入、邮箱账户设置不向模型开放；普通文件分享、群聊、邮件、日历、表格等业务读写可用。Skill 只能读取内置文档，不通过此工具安装或执行任意 Skill。该边界针对集成工具；独立 shell/文件工具仍按各自权限设置运行。

订阅按 CLI 的 ready 标记判断连接成功，保持 stdin 开放，停止时先关闭 stdin。消息按 message_id 持久化去重，回复使用 CLI 的 idempotency-key。进程崩溃后的未完成任务不会自动重放，以免重复写入；需要用户重新发起。断连会在设置显示错误，可重新保存启用；官方 CLI 自身负责在线连接恢复。

## GitHub 使用

- **浏览器登录**：先点击“安装登录依赖”，再点击“登录 GitHub”。通过官方 GitHub CLI 在浏览器输入一次性代码并授权，成功后启用、保存，再点击“连接并刷新工具”。不需要自己申请 OAuth Client ID。
- **Token**：选择 Personal Access Token，填写后保存。无需安装 GitHub CLI。建议按实际仓库与任务配置 Token 权限。
- 新配置默认读写，保留可选的只读开关。现有配置不静默迁移，用户可关闭只读并保存。通过官方 `X-MCP-Toolsets: all` 获取完整业务工具集，按固定业务清单过滤账户、凭据、组织和安全管理；未知工具不会自动开放，升级时核对 `plugins/github-integration/policy.ts`。代码、仓库、Issue、PR、讨论、项目等已列出的业务写入默认允许，用户通用 write 策略仍有效。关闭启用并保存会断开连接、撤销工具注册。

连接地址固定为 `https://api.githubcopilot.com/mcp/` 或其 `readonly` 路径。如果在通用 MCP 页面修改了 GitHub 地址，插件会要求重新保存官方配置，不把浏览器登录凭据转交到其他地址。

GitHub 的仓库规则和自定义属性工具同时包含仓库、组织、企业级操作。模型收到的 schema 将 `level` 固定为 `repository`，执行前再次拒绝 `org` / `enterprise` 参数；允许普通仓库配置，保留组织和企业账户管理边界。

应用中的 Token 使用既有系统加密存储。CLI 自己的登录资料按其官方机制管理；GitHub CLI 在系统凭据库不可用时可能回退为本地配置文件，检查方法见官方 auth login 文档。插件不使用终端环境中现有的 GH_TOKEN 或其他 Agent 的飞书凭据。

## 开发入口与数据

| 插件 / 模块 | 职责 |
| --- | --- |
| `plugins/conversation/config.ts` | 性格校验、预设与 persona.catalog |
| `plugins/character-pack` | 加载角色元信息与帧 |
| `plugins/feishu-cli` | 办公工具、私聊订阅、配对和 CLI 配置 |
| `plugins/github-integration` | 浏览器 / Token 登录与官方 MCP 配置 |
| `plugins/channel-chat` | 独立通道上下文、缓存键、归档与记忆 |
| `plugins/cli-dependencies` | 固定版本依赖校验、子进程与可取消登录任务 |
| `plugins/integration-controls` | 设置命令注册 |
| `plugins/control-center/ui/integration-settings.js` | 插件管理页面 |

内核没有加入飞书或 GitHub 业务逻辑。工具仍通过 agent.tools/agent.approvals；通道会话允许与桌面会话允许分别标识，不相互继承。新增命令在共享的 integrationCommands 中列出，随 companionCommands 进入传输和窗口白名单。控制器与后台接口版本同步为 4。

依赖和 CLI 配置分别在实际宠物之家 `plugins/feishu/{bin,config}`、`plugins/github/{bin,config}`。其他设置、去重记录与通道会话仍通过 storage.local 保存。安装版沿用可写 AppData 家目录，便携版优先自身目录。初始化只添加缺少的默认 Skill，不覆盖用户文件；不把凭据、运行数据或下载的 CLI 提交到仓库。

固定依赖为 lark-cli 1.0.96、GitHub CLI 2.101.0。升级时核对官方发行资产与摘要、业务与账户命令边界及 GitHub 业务工具清单，重跑安装、帮助接口与集成测试。自动安装支持 Windows x64/ARM64，当前实际验证的是 Windows x64。MCP 工具列表按分页读完，不再静默截断到 100 个；上下文预算仍按实际模型窗口计算。

## 验证命令

```powershell
npm run typecheck
npm test
npm run build
npm run smoke:integrations
npm run check:cli # 下载到 .artifacts 并检查 CLI 帮助与事件结构，不登录或发送消息
# 使用正在运行的宠物的飞书连接做只读实测（会查询“会议”文档、一级目录、今天日程、一页群列表）
node --experimental-transform-types --disable-warning=ExperimentalWarning scripts/check-feishu-office.mjs
```

自动集成测试使用隔离数据和本地模拟模型，不能代替真实账户联调。只读实测脚本经过真实 `agent.tools → feishu_cli → 官方 CLI`，临时状态隔离，复用 CLI 已有凭据；不发送消息、不发起登录、不停止实际事件通道。报告只记录结果状态、计数和缺失 scope，不保存文档正文与凭据。

2026-09-20 使用已连接用户实测：帮助可用，文档搜索命中 47 条，成功读取一份 docx 的一级目录；日程和群列表分别返回缺少 `calendar:calendar.event:read`、`im:chat:read`。当前私聊通道未启用，真实消息收发、创建/编辑/删除未验证，不能据此宣称飞书全部能力可用。

2026-09-22：76 项测试、类型检查和构建通过；覆盖默认业务写入、CLI 确认衔接、显式收紧 write 策略、账户边界、GitHub 参数级管理限制，以及 MCP 超过 100 个工具的完整发现。设置页完整办公授权与增量授权按钮通过浏览器验证。现有 GitHub 配置已切换读写并实际发现 94 个工具；仅验证连接和工具发现，未向真实仓库执行写操作。飞书完整业务授权流程可生成官方确认页面，新增 scope 仍以用户在官方页面确认结果为准。

## 官方参考

- [飞书 CLI](https://github.com/larksuite/cli)：安装、配置与用户 / 机器人身份。
- [飞书事件接口](https://github.com/larksuite/cli/blob/v1.0.96/skills/lark-event/SKILL.md)：NDJSON、ready 标记与 stdin 关闭契约。
- [GitHub CLI 登录](https://cli.github.com/manual/gh_auth_login)：浏览器 OAuth、Token 与凭据存储行为。
- [GitHub 官方远程 MCP](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)：官方服务、只读路径与工具集。
