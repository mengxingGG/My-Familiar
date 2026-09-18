# 记忆、Skill 与 MCP

## 产品约定

灵伴首先是陪伴用户的宠物。对话、工作状态和具体操作确认都出现在头顶气泡中，不显示推理过程；控制器按最新需求增加历史会话管理与继续聊天，见文档 09。输入 Enter 换行、Shift+Enter 发送，也可点击发送。

Kernel 只管理插件依赖、服务、权限和生命周期。文件之家、记忆、Skill、MCP、工具注册、工具往返、管理器各自是插件。模型插件负责原生协议，不负责工具执行；所有工具执行统一经过注册器和确认边界。

## 数据目录

源码开发默认在项目根目录 `.familiar/` 建立宠物之家；便携运行使用程序旁的 `.familiar/`，不可写时回退至 `%APPDATA%/Familiar/home/`。可用 `FAMILIAR_HOME` 显式指定。测试指定 `FAMILIAR_DATA_DIR` 时使用该目录内的 home，避免污染真实数据。管理器显示实际路径。

```
.familiar/
  memory/
    CORE.md                 # 核心记忆，最多 3000 Unicode 字符
    IDENTITY.md SOUL.md USER.md AGENTS.md
    BOOTSTRAP.md HEARTBEAT.md TOOLS.md
    lessons/YYYY-MM-DD-分类-名称-时间.md
    daily/YYYY/MM/YYYY-MM-DD.md
    .history/               # 编辑前的原文备份
  skills/名称/SKILL.md       # 可包含 scripts、references、assets
  mcp/servers.json
  mcp/servers/名称/          # 固定版本 npm MCP 的私有安装位置
  workspace/                # 文件工具和 Shell 的默认工作目录
```

模型设置、加密密钥、会话仍留在原来的 `%APPDATA%/Familiar/data`，构建只更新 dist，不清理用户数据。删除聊天不会删除记忆。移除 Skill 会移至 skills/.removed，文件编辑保留历史备份。

备份或迁移时还须保留 `%APPDATA%/Familiar/runtime/Local State`，并在同一系统用户下恢复；加密密钥文件不能单独移动。替换便携程序目录前务必将 `.familiar` 一并备份/迁移，不能让打包清理覆盖运行中的数据目录。

## 记忆行为

首次启动只创建缺失的模板，不覆盖已有内容。身份和相处方式体现温暖、诚实、尊重边界，不虚构经历、不制造情感依赖。HEARTBEAT 保留为扩展约定文件；现有主动问候由独立 companion-care 插件调度，见文档 09。

核心记忆、身份和 Skill 目录以稳定顺序进入系统前缀；每日记忆按完成的对话追加到当地日期文件，不逐轮注入整个日记。用户问过去的事时通过 memory_search / memory_read 检索。memory_remember 保存明确确认的长期信息，memory_lesson 单独记录教训或经验。可复用的内容可整理为 Skill，再由用户确认安装。

核心记忆超出 3000 字符时使用已配置模型自动精炼，会产生一次模型调用；保留精炼前资料。失败时采用确定性的保守收纳并提示管理器，原文仍可找回。保存使用 revision 检查，避免覆盖外部编辑。日记与核心不保存匹配到的常见凭据格式；自动过滤不能保证识别所有秘密，工具密钥必须在专用设置项填写。

## Skill 与 MCP 分开管理

Skill 遵循 [Agent Skills 格式](https://agentskills.io/specification)：目录名与 YAML name 一致，包含 description 和说明正文。预装记忆、文件、Shell、网页研究四个 Skill。支持本地目录、SKILL.md 文件、HTTPS 单文件和粘贴文本安装；支持启停和移除。只加载说明，不自动执行其脚本，不授予系统权限。

MCP 使用 [官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) 的 Streamable HTTP / stdio。预置 [Exa](https://exa.ai/docs/get-started/exa-mcp)，默认关闭，可在设置填写 x-api-key（也可使用服务允许的无密钥配额）。支持独立 HTTP / stdio 配置与固定版本 npm 包安装。npm 安装使用 --ignore-scripts，目录位于宠物之家；安装后默认停用。启用 stdio 即允许运行该服务器程序，须自行选择可信来源。

鉴权字段支持 HTTP header、query 参数或 stdio 环境变量，值由系统加密保存，不写入 servers.json，不返回给模型。连接变化会撤销旧工具；启用后自动列出工具。Exa 和高德官方只读工具默认直接调用，其余依服务只读声明和用户权限策略处理，详见文档 09。

## 执行边界

基础文件工具默认从 workspace 开始，支持绝对路径访问外部文件；记忆/Skill 自身的文件格式管理仍检查目录结构。读取、搜索和自身目录内写入默认允许，Shell、外部写入和安装默认询问，可按会话或白名单记住选择。MCP 启用展示完整服务配置。Shell 不是操作系统沙箱，默认 60 秒超时并终止进程树。只应运行用户认可的命令。

工具返回值作为资料进入模型上下文，不能自行提升权限。每轮最多 8 次模型往返，每次最多 16 个工具；取消会中断模型和当前工具、关闭待确认请求。隐藏工具轨迹持久化，以维持下一轮原生工具结果和缓存前缀；气泡仅显示回复与工作状态。

## 开发与验收

运行 `npm run check` 和 `npm run smoke`。测试应覆盖记忆限额与重启、每日追加、文件越界、Skill 导入、审批拒绝与取消、MCP 生命周期、原生工具协议、输入气泡锚点、模型列表以及独立控制器。真实服务验证需单独记录；模拟协议通过不代表所有官方账号均已实测。

`npm run smoke:agent` 验证三类管理页面、记忆精炼、Shell 同意/拒绝和本地 MCP 往返。`node scripts/agent-smoke.mjs --exa-live` 额外访问 Exa 官方工具目录。基础文件读写默认从 workspace 开始并支持外部绝对路径；`skill_read` 可读取已启用 Skill 中的文本资源，`memory_read` 支持 offset 分段。超过 10 万字符的日记在管理器中只读预览，保留完整文件供外部编辑，防止把截断预览误存为全文。
