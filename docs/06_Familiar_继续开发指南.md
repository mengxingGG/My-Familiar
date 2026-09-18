# Familiar 继续开发指南

## 当前边界

Windows 本地开发预览；独立宠物 Runtime、独立 Controller、2D 占位角色、七种文字 LLM 接口。宠物以气泡说话；按用户最新要求，控制器增加可继续聊天的历史会话管理。文字输入与回复共用头顶位置，Enter 换行，Shift+Enter 或按钮发送。语音未来是并列输入方式，不替代文字。

当前已增加基础 Agent 往返、文件记忆、独立 Skill/MCP 管理和工具确认，保持宠物陪伴定位。已增加受限的主动问候和用户自定义提醒；尚未增加语音、视觉或自主执行任务的后台循环。未来 3D 通过渲染器和角色表示扩展，不把骨骼、镜头或具体模型格式塞入内核。v0.1.0 开始提供 Windows x64 安装程序与免安装 ZIP，发布流程见 [首版说明](releases/v0.1.0.md)。

## 代码入口与职责

| 路径 | 职责 |
| --- | --- |
| `apps/shared/bootstrap.ts` | Electron 引导、Runtime/Controller 插件装配、启动退出 |
| `packages/kernel` | 作用域 Context、插件生命周期、能力依赖、清理和权限门 |
| `packages/contracts` | 产品能力公共契约，内核不得反向引用 |
| `packages/protocol` | 本地 IPC 客户端与版本协议 |
| `plugins/platform-windows` | 原生窗口、透明命中、拖动、气泡定位、托盘、快捷键 |
| `assets/familiar.svg`、`scripts/build-icons.cjs` | 应用标识矢量源和多尺寸 ICO/PNG 生成；`npm run icons` 更新资源，普通构建直接复制已生成图标 |
| `plugins/renderer-sprite`、`characters` | 语义动作对应的 2D 表现、角色清单和资源 |
| `plugins/bubble-chat` | 气泡、临时输入条和输入交互，不持有供应商逻辑 |
| `plugins/conversation` | 上下文、取消、持久化和单轮互斥 |
| `plugins/provider-*`、`plugins/llm-shared` | 原生供应商协议与共用传输；新增供应商实现 ProviderDefinition 并在宿主装配 |
| `plugins/llm-registry`、`plugins/llm-router` | 供应商注册、模型目录、参数能力、计数与预算；不向内核加入供应商分支 |
| `plugins/control-center` | 设置界面与运行状态，不拥有宠物或模型请求生命周期 |
| `plugins/settings` 与配置域插件 | 三个首版配置域的校验、版本冲突和事务保存 |
| `plugins/home-files`、`plugins/memory-files` | 数据之家、路径边界、核心精炼、每日追加和教训检索 |
| `plugins/skills-local`、`plugins/mcp-client` | 独立 Skill 包管理与 MCP 服务生命周期 |
| `plugins/agent-tools`、`plugins/tools-basic`、`plugins/agent-runner` | 工具注册、参数校验、具体确认、执行和模型往返 |
| `plugins/companion-controls` | 记忆、Skill、MCP 与确认的管理命令，不持有界面 |
| `tests`、`scripts/smoke.mjs` | 逻辑验证、真实窗口与本地 SSE 夹具 |

参考 DSH 的作用域、服务声明和插件装配思想，Familiar 没有 DSH 运行时依赖。核心外的能力通过插件实现；不得为单个 Provider、角色或 UI 需求向内核添加业务分支。具体能力声明、生命周期与清理约定见文档 04。

## 修改与验证规则

1. 先读受影响插件的清单和公共契约，确定能力提供者与消费者。
2. 副作用归插件作用域，注册清理；窗口等原生操作留在平台插件。
3. 调整交互时同步界面提示、README 用法和文档 04；补充能覆盖实际行为的现有烟雾测试。
4. 运行 `npm run check`。窗口、输入和生命周期改动还需运行 `npm run smoke`，不能只看编译结果。
5. 把结果及未验证项记入文档 05。烟雾测试使用本地模型夹具，不等价于真实供应商和实际中文输入法测试。

构建输出、测试数据、运行数据与本机快捷方式均由 `.gitignore` 排除。`package-lock.json` 随源码管理。`npm run package:release` 只生成本地 EXE 与 ZIP；GitHub 发布是显式单独步骤，须有用户授权。

## 数据和调试

默认数据目录 `%APPDATA%/Familiar`，用 `FAMILIAR_DATA_DIR` 可以隔离开发或测试数据。Runtime 和 Controller 使用不同 Electron userData。Runtime 是配置与会话唯一写入者。

- `data/settings.json`：首版配置事务快照；各配置域的 Schema 归其插件。
- `data/conversation.json`：版本 2 当前会话兼容副本与上下文起点；完整会话按 ID 独立保存，可包含不展示的供应商签名、加密推理块或原生 thought 块；按本地对话数据对待，不是长期记忆系统。
- `data/model-secret.json`：版本 2 按供应商/地址隔离的系统加密 API Key，不应进入普通配置或日志；支持旧字符串格式迁移。
- `data/model-catalog.json`：带时效的模型与能力目录；不保存明文凭据。
- `.familiar/`：默认源码版宠物之家，结构和覆盖规则见文档 08；不放在 dist 内。
- 安装版通过 `resources/familiar-installed` 标记将宠物之家放在 `%APPDATA%/Familiar/home`，避免卸载程序目录时丢失；免安装版优先使用 EXE 旁的 `.familiar/`，不可写时回退用户数据目录。环境变量 `FAMILIAR_HOME` 可显式覆盖。
- `runtime/Local State`：Windows safeStorage 密文依赖的加密材料。备份/迁移密钥不能仅复制 model-secret.json；应保留整个 Familiar 用户数据目录，并在原系统用户下恢复。参考 [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)。
- `.artifacts/*/result.json` 与截图：本地测试结果，不提交仓库。

当前只装配可信官方插件。Context 的权限声明检查不构成任意第三方 JavaScript 的安全沙箱。现有角色是原创占位美术，不代表正式角色方向。

新增模块与数据契约见 [文档 09](09_Familiar_日常陪伴与权限会话.md)。Windows 构建需要 Windows 10/11 SDK 与系统 .NET Framework。

## 下一步顺序

1. 按文档 07 的供应商矩阵，用真实服务验证模型列表、参数、流式回复、取消、长会话及缓存用量。夹具测试不能替代真实接口验收。
2. 手工验证中文输入法、多显示器、混合 DPI、透明区命中与全屏使用。
3. 做至少 2 小时的待机和重复交互资源趋势测试，再确定资源预算。
4. 确认角色美术方向，替换占位资源；保持角色包与 Renderer 分离。
5. 功能稳定后再做安装、升级、卸载；登录启动已验证注册读回，仍需真实注销/重登验收。

记忆和基础 Agent 的当前契约见文档 08。主动问候、精确权限策略、会话历史和高德/位置接入见文档 09。语音、视觉与自主执行任务的后台循环尚未交付，不把长期设计写成已实现能力。新增插件仍不得绕过工具确认器。
