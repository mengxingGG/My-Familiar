# Familiar 继续开发指南

## 开发前阅读顺序与当前决策

1. [开发宪法](02_Familiar_开发宪法_v0.1.md)：特别是平台抽象与 2026-10-11 增补的第 87–99 条。
2. [Tauri 多平台改造方案](15_Familiar_Tauri多平台改造方案.md)：目标分层、现有依赖清单、M0–M5 阶段和待验证决策。
3. 本文与 [当前插件实现](04_Familiar_插件实现与气泡交互_v0.1.md)，再阅读受影响功能文档和公共契约。
4. [验收记录](05_Familiar_本地预览验收记录_v0.1.md)：区分代码已实现、夹具通过与真实设备通过。

**已确定：Tauri 2 是后续多平台改造的目标宿主，Familiar 现有插件架构继续保留。当前代码仍运行在 Electron/TypeScript Windows 宿主，Tauri/Android 改造尚未开始。** 新目录、能力名、运行引擎或后台行为只有实际实现并验证后才能标为可用。

文档职责：宪法约束工程边界，文档 15 规定当前迁移路线，文档 04 和源码说明实际实现，文档 05 保存验证证据。文档 01/03 的首版排期是历史基线，不能用其中“Android 后置”等旧范围否定新路线，也不能据新方案误报已经支持移动端。发现冲突先明确记录并同步修订。

## 当前边界

Windows 本地开发预览；独立宠物 Runtime、独立 Controller、七个原创 2D 角色、七种 LLM 接口。宠物以气泡说话；控制器提供可继续聊天的历史会话管理。文字输入与回复共用头顶位置，Enter 换行，Shift+Enter 或按钮发送。开发版新增图片、文件与并列语音输入，不替代文字。

当前已增加基础 Agent 往返、文件记忆、独立 Skill/MCP 管理和工具确认，保持宠物陪伴定位。主动问候和用户自定义提醒已实现；图片与语音开发版见文档 14，尚无持续桌面视频和自主后台执行循环。未来 3D 通过渲染器和角色表示扩展，不把骨骼、镜头或具体模型格式塞入内核。v0.1.0 开始提供 Windows x64 安装程序与免安装 ZIP，发布流程见 [首版说明](releases/v0.1.0.md)。

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
| `plugins/control-center` | 设置界面与运行状态，不拥有宠物或模型请求生命周期；`ui/index.html` 是外壳与导航，各页内容由同目录的页面模块填充 |
| `plugins/settings` 与配置域插件 | 三个首版配置域的校验、版本冲突和事务保存 |
| `plugins/home-files`、`plugins/memory-files` | 数据之家、路径边界、核心规则上限与条目改写、程序索引、每日追加和检索 |
| `plugins/memory-judge`、`plugins/memory-trace` | 记忆判断能力（主模型实现）与诊断记录；后续判断模型作为 `memory.judge` 的其它实现接入 |
| `plugins/skills-local`、`plugins/mcp-client` | 独立 Skill 包管理与 MCP 服务生命周期 |
| `plugins/agent-tools`、`plugins/tools-basic`、`plugins/agent-runner` | 工具注册、参数校验、具体确认、执行和模型往返 |
| `plugins/companion-controls` | 记忆、Skill、MCP 与确认的管理命令，不持有界面 |
| `tests`、`scripts/smoke.mjs` | 逻辑验证、真实窗口与本地 SSE 夹具 |

参考 DSH 的作用域、服务声明和插件装配思想，Familiar 没有 DSH 运行时依赖。核心外的能力通过插件实现；不得为单个 Provider、角色或 UI 需求向内核添加业务分支。具体能力声明、生命周期与清理约定见文档 04。

## Tauri 改造时的实施规则

- 先从文档 15 的 **M0：基线与契约** 开始，随后做 Android 前台最小闭环；后续系统能力、Windows Tauri 对照和其它平台分别验收。当前没有 Tauri 构建脚本，不能把拟议命令当作现成工具。
- 不先重写整个项目或搬空 `plugins/`。按单项能力提取纯业务逻辑，再分别接现有 Electron 与新增 Tauri 适配器；跨端共享逻辑只维护一份。
- 新共享代码不得新增 `electron`、`@tauri-apps/*`、`node:*` 或原生系统依赖；同时检查间接依赖和 `Buffer/process/require`。必要调用留在平台/系统适配插件。
- `packages/protocol` 当前包含 Node IPC，并非纯跨端协议；`Surface` 当前偏桌面。拆分前先列出生产者和消费者，保留版本映射，不直接在手机调用命名管道或模拟桌面窗口成功。
- Tauri 原生插件只连接系统能力，Familiar 业务插件继续通过 Context/Capability 协作。Rust 启动入口只装配，不接管 Provider、记忆和 Agent 的全部业务。
- Android 前台原型中的 JS Runtime 不能被宣传为后台常驻。需要后台运行的任务先确定原生所有者、状态交接和恢复协议；后台业务执行器仍是专项决策，不默认添加 Node/JS 引擎。
- 桌面 Runtime/Controller 保持独立生命周期；移动端按 Activity/Service 设计。UI 不成为持久化状态第二写入者，重连取快照并过滤旧代次事件。
- 不支持的能力通过 Profile 和可用性状态处理；不假报权限成功、不自动改 Provider、不默认依赖电脑或远程代理。
- 新宿主使用隔离数据目录，迁移在样本上先验证。两个宿主不能同时写现有用户目录；凭据按平台安全存储处理，不直接复制 Electron 密文冒充迁移成功。
- 每个实施任务写明目标平台、阶段、契约变化、数据影响、测试与回退。未完成阶段验收，保留 Electron 启动/构建路径。

## 修改与验证规则

### Live 语音改造的并行边界

2026-10-11 用户确认“唤醒后自动进入持续对话”，并要求重点研究 Live。先读 [语音改造方案](16_Familiar_Live语音改造调研与实施方案.md) 与宪法第 100–106 条，再从 V0/V1 进行实现；方案不是已完成能力清单。

- 当前源码仍保留链式语音和强制 `ask_familiar` 代理 Live；第一批已实现模型接入提示/预检、持续对话设置、有限的唤醒音频交接、40ms 采集块和可选识别提示。原生直接回答、无缝首句交接、已播同步与恢复尚待实施，不能只把 `tool_choice` 改为 `auto` 就宣布改造完成。
- 快速原生 Live 需用户配置实时模型、端点和对应凭据；型号推荐与当前适配状态见文档 16。常规模式继续有限优化，不能宣传为同等 Live 体验；配置检查只证明字段齐全，不证明真实连接、时延或准确率。
- 语音任务主要涉及语音契约、`voice-*` 插件、音频 Host、设置界面及相应测试；记忆/日记/压缩由另一组会话推进。共享历史接口先对齐方案第 7 节，不复制记忆权威，不覆盖对方模块修改。
- 保留任意主模型的链式语音，同时评估原生 Live；显式区分答案生成模型。Qwen Omni 声音注册和 MiniCPM-o 本地双向为候选，未完成协议和设备验证前不能标为可用。
- 实施验收包括旧轮次隔离、已播进度、工具副作用、真实中文与扬声器插话；云端普通通话和工具通话分开测量，不用测试夹具宣称真实延迟或准确率改善。

### 通用修改规则

1. 先读受影响插件的清单和公共契约，确定能力提供者与消费者。
2. 副作用归插件作用域，注册清理；窗口等原生操作留在平台插件。
3. 调整交互时同步界面提示、README 用法和文档 04；补充能覆盖实际行为的现有烟雾测试。
4. 修改现有源码时运行 `npm run check`。窗口、输入和生命周期改动还需运行 `npm run smoke`，不能只看编译结果。Tauri 新宿主还需所属阶段的构建与目标设备验证；只改文档时检查链接、内容一致性和 Markdown 结构即可，不需要启动应用或真实设备功能。
5. 把结果及未验证项记入文档 05。烟雾测试使用本地模型夹具，不等价于真实供应商和实际中文输入法测试。

构建输出、测试数据、运行数据与本机快捷方式均由 `.gitignore` 排除。`package-lock.json` 随源码管理。`npm run package:release` 只生成本地 EXE 与 ZIP；GitHub 发布是显式单独步骤，须有用户授权。

当前发行版为 [v0.3.0](releases/v0.3.0.md)。发布时顺序运行五组 `smoke:*:packaged` 窗口检查，语音与唤醒用源码版 `smoke:voice`、`smoke:wake`；`node scripts/upgrade-smoke.mjs <上一版的 Familiar.exe>`（支持 v0.1.0 与 v0.2.0）使用独立演示目录验证旧数据升级，不操作正常使用的数据。真实语音链路经用户授权后用 `node scripts/voice-live.mjs --saved-api` 检查。

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

飞书 CLI、GitHub 登录/MCP、通道独立会话、七个角色与独立性格见 [文档 10](10_Familiar_飞书GitHub与角色性格.md)。修改相关插件需运行 `npm run smoke:integrations`；修改 CLI 版本和参数需运行 `npm run check:cli`，不要把下载检查当作真实账号登录验收。不能覆盖用户已经保存的自定义性格或 CLI 配置。

## 下一步顺序

多平台改造以文档 15 的 M0–M5 为准：M0 整理依赖/契约与基线 → M1 Android 前台闭环 → M2 移动系统能力 → M3 Windows Tauri 对照 → M4 其它平台 → M5 默认入口切换。每阶段必须达到准入条件；“支持多平台”不能只指打包成功。桌面替换时间、后台业务执行器和最低系统版本仍需在所属阶段确定。

下列事项是现有 Windows 版的持续验收清单，与多平台路线配合推进，不表示 Android 要先复制所有桌面功能。

记忆和上下文的当前实现见 [重要日记与会话压缩](11_Familiar_重要日记与会话压缩.md) 与 [记忆系统改造方案](17_Familiar_记忆系统改造方案.md)：核心规则锁定上限、写满拒绝，索引由程序生成，记忆快照按会话冻结并在压缩时刷新；日记由模型工具主动选择，压缩由独立插件在发送前触发，归档与日记分开。修改后运行 `npm run smoke:agent` 与 `npm run smoke:context`。不要恢复旧的逐轮抄写日记、核心自动精炼或只丢弃旧轮次的行为；向量检索和判断模型是文档 17 中的候选步骤，须先用记录做离线对比再接入。连续压缩质量和轮中超大工具结果仍需继续完善。

1. 按文档 07 的供应商矩阵，用真实服务验证模型列表、参数、流式回复、取消、长会话及缓存用量。夹具测试不能替代真实接口验收。
2. 手工验证中文输入法、多显示器、混合 DPI、透明区命中与全屏使用。
3. 做至少 2 小时的待机和重复交互资源趋势测试，再确定资源预算。
4. 确认角色美术方向，替换占位资源；保持角色包与 Renderer 分离。
5. 功能稳定后再做安装、升级、卸载；登录启动已验证注册读回，仍需真实注销/重登验收。

记忆和基础 Agent 的当前契约见文档 08。主动问候、精确权限策略、会话历史和高德/位置接入见文档 09。[图片、语音与宠物声音](14_Familiar_图片语音与宠物声音.md) 描述开发版媒体插件、声音档案、已验证接口和真实设备验收缺口。持续视频和自主后台循环仍未交付；新增插件不得绕过工具确认器。
