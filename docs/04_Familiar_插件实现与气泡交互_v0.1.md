# Familiar 插件实现与气泡交互 v0.1

日期：2026-09-17。状态：本地开发预览；详细验收结果见文档 05。

## 已确认的产品修正

最初不设聊天页面；按最新要求，控制器现已提供历史会话浏览与继续聊天，见文档 09。桌面仍采用宠物头顶气泡输出，配合按需出现的文字输入条。语音后续作为另一个输入插件接入同一个对话能力，不替代文字输入。

- 双击宠物、点击“说句话”、托盘菜单或 Ctrl+Alt+Space 唤出输入条。
- 输入条默认两行；Enter 换行，Shift+Enter 发送，也可以点击发送按钮；IME 组合输入时 Enter 不发送。
- 输入与回复共用宠物头顶锚点；编辑时隐藏回复，流式分片不能覆盖输入。发送被接受后切回回复；发送失败时保留输入文本并显示错误。
- Esc 收起并保留未发送草稿；重新唤出继续编辑。
- 回复在头顶气泡中流式出现。按文本长度调整气泡高度，超过上限使用内部滚动，不截断正文。
- 气泡可停止生成、收起、继续输入；托盘可重新显示最近一次回复。
- 不展示推理字段。等待仅显示“正在回复…”，首版不增加工具或命令执行能力。
- 用户关闭正在生成的气泡后，后续分片不擅自重新打开同一气泡。
- 对话历史保存在后台，用于下一轮上下文；不渲染历史消息列表。
- 输入和回复随宠物移动并使用同一定位规则，头顶空间不足时进入边缘回退位置，限制在显示器工作区内。
- 安静模式只抑制日常主动气泡，用户主动发起的对话正常显示。

后续增加 Agent 时，工作气泡只展示“正在整理文件”“执行中”“已完成”等用户可理解的任务状态，可提供停止入口。推理文本不进入此通道，技术日志也不作为聊天正文。该工作状态通道为后续约定，本轮没有加入命令执行能力。语音输入以后与文字输入共用会话入口，文字入口始终可用。

## 学习 DSH 的方式

只读查看了本机 `deepseek-harness` 中的 `vendor/cordis/src/context.ts`、`packages/core/scope/src/index.ts`、`packages/core/agent-default-model/src/index.ts` 等文件。本项目没有引用该工作目录、复制其业务代码或修改其内容。

沿用的设计思想：作用域化 Context、按能力依赖、显式注册服务、插件生命周期拥有副作用、Profile/Host 装配产品。当前实现是 Familiar 自己的最小内核，尚未实现 Cordis 的全部动态注入、热替换或纤程机制。

## 实际模块边界

| 路径 | 职责 |
| --- | --- |
| `packages/kernel` | 插件注册、装载/启动/停止/卸载、能力选择、依赖检查、事件作用域、清理集合、权限门和诊断 |
| `packages/contracts` | 产品能力的 TypeScript 契约；内核不反向依赖这里 |
| `packages/protocol` | 本地 IPC 客户端、协议版本和地址计算 |
| `apps/shared/bootstrap.ts` | Electron 引导、独立单实例锁、官方插件组合、退出顺序 |
| `plugins/commands` | 可撤销的命令注册表 |
| `plugins/storage-local` | 应用目录内的串行原子文件写入 |
| `plugins/pet-config` | 宠物配置 Schema |
| `plugins/conversation/config.ts` | 人格配置 Schema |
| `plugins/provider-compatible/config.ts` | Provider 配置 Schema |
| `plugins/settings` | 三个首版配置域的校验、版本冲突、应用/持久化/回滚；无 Provider 网络逻辑 |
| `plugins/platform-windows` | 窗口、托盘、屏幕坐标、输入命中切换、拖动、快捷键、窄 IPC 桥 |
| `plugins/autostart-windows` | 用户选择的登录启动；仅启动 Runtime，不自动打开控制器 |
| `plugins/secrets-local` | 系统加密的模型密钥 |
| `plugins/character-pack` | 角色清单和资源加载；现阶段仅随包可信角色 |
| `plugins/renderer-sprite` | 精灵表现、语义动作映射；不调用 LLM |
| `plugins/behavior-basic` | 本地互动、睡眠、等待状态；不实现模型网络请求 |
| `plugins/llm-registry`、`plugins/llm-router` | 供应商注册、模型目录缓存、能力校验、凭据路由、上下文预算与计数 |
| `plugins/provider-*`、`plugins/llm-shared` | 七种供应商的原生协议、参数、SSE、用量、原生状态与公共 HTTP 代码 |
| `plugins/conversation` | 单轮互斥、配置快照、稳定会话前缀、整轮裁剪、历史、停止和清空 |
| `plugins/bubble-chat` | 头顶气泡与临时输入条；无 Electron 导入、无模型供应商逻辑 |
| `plugins/runtime-controls` | 为控制器提供受限的产品命令与状态快照 |
| `plugins/transport-local` | 本地命名管道、随机会话令牌、包大小限制、请求去重 |
| `plugins/control-center` | 独立控制器页面与 RPC 转发 |

每个运行实例通过 `install → load → start` 进入运行；`stop` 等待逆序清理；`unload/uninstall` 可单独调用。提供者仍被依赖时拒绝直接停止，宿主退出按实际启动顺序的逆序执行。

能力允许多个实现，但需要通过内核 `select` 明确选择。消费者必须在清单声明依赖，不能访问未声明服务。停止以后旧服务引用失效；清理期间允许完成既有资源释放。事件与定时器由上下文管理，异常会归属到插件诊断。

业务插件只依赖公共契约。Windows 系统调用只出现在平台/系统适配插件。新增能力应新增插件和契约，不能向 Kernel 加入业务分支。

## 首版配置与数据约束

默认目录为当前用户 `%APPDATA%/Familiar`；测试通过 `FAMILIAR_DATA_DIR` 使用独立工作区目录。

- Runtime 和 Controller 使用不同的 Electron userData 与单实例锁。
- Runtime 是宠物配置和对话数据的唯一写入者。
- `data/settings.json` 是三个已定义配置域的一次事务快照；各域的 Schema 属于其插件。它不是未来所有插件追加字段的通用大配置；新增插件需建立自己的配置域与存储键。
- `data/model-secret.json` 按供应商与规范化地址的散列隔离系统加密密钥；旧版单密钥启动时迁移到原配置对应的地址，不混入配置、快照或宠物界面。
- `data/conversation.json` 保存稳定会话 ID、前缀版本与保留消息。已取消 200 条/12,000 字符限制；按模型窗口预留输出与安全余量，优先原生 token 计数，不支持时标注保守估算。只有超预算时从模型请求移出最旧完整轮次，完整历史文件保留。详细策略见文档 07。
- `data/model-catalog.json` 保存模型目录和能力元数据，不含 API Key；十分钟刷新期限，可以手动刷新。
- 模型配置和人格在轮次开始时快照化，当前回复不会被中途修改。
- 只有完成的历史消息进入后续模型上下文，取消/失败的助手片段不作为完整回复使用。
- 传输令牌仅在两个应用的主进程间使用；不暴露到 Web 渲染页面。管道不监听公网地址。
- 当前权限门约束官方插件经 Context 的受控调用，不声称能沙箱隔离任意恶意本地 JavaScript。

## 2D 与未来 3D

角色包中的 `representations.sprite` 独立拥有帧和帧率；公共动作协议只传 `idle/greet/happy/think/sleep/drag` 等意图。未来可增加其他 Renderer 与 `representations.vrm` 等资源字段，无需让聊天插件认识骨骼或模型路径。

当前自绘 SVG 帧是用于验证架构的原创占位美术；`mori` 与 `luna` 两个包验证替换能力。它们不是已经确定的正式角色风格。3D 渲染器和模型资产尚未实现。

## 验证边界

已有自动化测试覆盖内核生命周期、配置冲突回滚、角色包替换、坐标计算、SSE 中文分片、401/429、断流、超时、取消与会话清理。真实 Electron 烟雾测试用独立数据和本地模拟 HTTP 模型验证双应用与气泡交互。

尚需手工或后续专项验证：真实供应商 API、中文输入法实际选词、多实体显示器与混合 DPI、全屏应用策略、登录后的自启动效果、2 小时以上的资源趋势，以及真实 3D Renderer。模拟服务通过不能被描述为真实 LLM 供应商验证通过。
