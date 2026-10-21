# Familiar Android：开工与系统能力方案

当前进展：已进入 ARM64 APK 设备验收，真实共享核心、常驻 Overlay 和基础无障碍链路已接通。下方 M0 初次核查保留为历史证据，最新状态与缺口以 [文档 19](19_Familiar_Android常驻运行实施.md) 为准。
日期：2026-10-19。状态：**已交付 Claude 编写的移动前端，以及 Codex 的版本化接口、传输桥和隔离预览；Android 宿主、APK 和真实系统工具尚未实现。M0 工具链与核心可移植化仍待完成。**

承接 [Tauri 多平台方案](15_Familiar_Tauri多平台改造方案.md)，不替换 Plugin First / Thin Kernel。用户本轮确定：Android UI 由 Claude Code 延续桌面风格设计，核心由 Codex 开发，首轮使用模拟器；同时参考 AutoGLM、Cherry Studio 和用户自己的 Hermes Android，把日历、笔记与跨应用操作纳入设计。

## 1. 产品起点

Android 版以随身伙伴为主入口：角色、文字/后续语音交流、历史与记忆，并通过独立工具插件帮用户处理手机上的具体事务。界面保持桌面版的奶油底色、鼠尾草绿、柔和描边、角色插画和贴纸式面板；布局改为适合触摸的移动导航。

首个可运行切片是「打开应用 → 看见角色 → 配置模型 → 发送文字 → 流式回复/停止 → 重启后看到历史」。随后用「把这件事放进日历」和「把这段内容记下来」验证真实系统工具。跨应用 UI 操作单独验收，不让它成为基础聊天的启动条件。

这里的“系统能力”指 Android 正式 API、ContentProvider、Intent 和用户开启的系统服务；不预设 root、系统签名、隐藏 API 或远程电脑代理。

## 2. 分工与交付边界

| 负责人 | 交付 | 不承担的职责 |
| --- | --- | --- |
| Claude Code | 在桌面风格内自主设计移动信息架构、页面与组件，并完成可接产品桥的 HTML/CSS/TypeScript 前端源码、交互状态与适配 | 会话权威状态、Provider、持久化、密钥、工具执行、原生服务 |
| Codex | 共享核心拆分、Familiar 插件装配、产品桥、Tauri/Rust/Kotlin 适配、工具权限与生命周期、构建和验收 | 不把自己编写的 UI 冒充 Claude 交付 |

开发任务见 [UI 任务书](android-ui/BRIEF.md)。用户随后明确要求 Claude 自由设计并开发完毕，不再将交付限制为四份静态原型文件。前端源码位于 `apps/tauri/ui/`；真实能力的可用状态由核心返回。UI 不直接调用 Android、写业务文件或自行请求模型。独立预览适配器使用示例数据并明确标记；生产入口绝不自动回退到预览。

CLI 核查确认 `.cmd` 与 PowerShell 启动脚本指向同一个 Claude Code 2.1.280。先前的 401 来自 Codex 进程继承的 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` 覆盖；这两项不在用户/机器持久环境中。仅在调用子进程内去掉覆盖后，现有 Claude 登录实际返回 `CLAUDE_OK`，因此不能将旧错误归结为用户 CLI 不可用。未修改用户的全局配置。原有 UI 参考资料，以及新增 `packages/mobile-contracts/index.ts` 与更新后的任务书，均已取得用户明确外发授权。

## 3. 当前源码的复用结论

使用现有 esbuild 对下列入口及其运行依赖进行 browser bundle 检查，同时用 TypeScript AST 检查递归导入和 Node 隐式全局。类型依赖也纳入静态扫描。这是迁移筛查，不等于 Android 运行验收。

| 模块 | 本轮结果 | 下一步 |
| --- | --- | --- |
| `packages/kernel`、`packages/contracts` | 浏览器构建通过，扫描未发现宿主依赖 | 增加移动桥 DTO；不向 Kernel 添加 Android 分支 |
| `plugins/settings` | 构建通过，扫描未发现宿主依赖 | 用原生存储替换其 `storage.local` 提供者 |
| `plugins/renderer-sprite` | 构建通过，扫描未发现宿主依赖 | 仍依赖现有 Surface 语义；需应用内表面适配，不能认定已兼容手机 |
| `memory-files/entries`、`memory-judge`、`memory-trace` | 构建通过，扫描未发现宿主依赖 | 可复用纯规则/判断逻辑；文件主体和实际服务另验收 |
| `packages/protocol` | 浏览器构建失败，直接依赖 Node IPC/文件/路径/加密 | 拆纯 DTO 与桌面 transport，保留 v1 兼容入口 |
| `conversation`、`llm-router`、`llm-shared/config` | 浏览器构建失败，有 Node 加密依赖；部分还有 Buffer | 将 ID/指纹与 I/O 从业务编排中提取；保持会话、缓存和凭据作用域语义 |
| `llm-shared/http`、`provider-compatible`、`agent-runner` | **构建通过但仍含 Buffer 依赖** | 替换字节处理并做真实浏览器运行测试；单看打包成功会漏检 |
| `storage-local`、`secrets-local`、`character-pack` | 源码使用 Node 文件系统或 Electron safeStorage | 原生存储、Keystore 与资源解析器分别适配 |

另一个重要边界：现有 `conversation` 必需依赖 Agent、工具、记忆、Skill 目录、压缩、媒体等服务。移动最小 Profile 不能只删掉 Windows 插件。应从共享插件提取可复用职责；空目录可以真实返回空列表，但未实现的执行能力必须返回不可用，不注册假成功服务。

现有 `ProviderInput.key` 是明文字符串，`secrets.local.has/get` 是同步接口；不能将桌面接口直接搬进 WebView。移动凭据桥需独立版本化：UI 只知道是否配置及凭据引用，由原生网络适配器受控绑定认证信息。供应商消息格式和 SSE 解析仍属于 Familiar 业务插件。

## 4. 系统工具路线

以下能力名都是**候选**，尚未注册进 Kernel。选择顺序由工具适配器决定：可验证的结构化接口优先；应用提供的 Intent/App Link 用于交接；缺乏接口的具体场景才评估无障碍 UI 操作。

| 场景 | 实现方向 | 结果与边界 |
| --- | --- | --- |
| 查询日程 | `device.calendar.read`，Kotlin `CalendarContract`/`ContentResolver` | 获取系统读权限后按时间范围和选定日历查询；支持重复事件、全天和时区；不假定本机日历已经云同步 |
| 新建/修改日程 | `device.calendar.write`，写权限和 Familiar 工具授权；或交接系统日历表单 | 原生写入必须返回对象 ID 并读回；Intent 打开表单仅为“待用户完成”，不能报“已创建” |
| 快速记笔记 | `notes.local` 保存 Familiar 内的普通笔记；`device.notes.compose` 交接外部应用 | 普通笔记不混入角色核心记忆；外部笔记优先分享或已支持的 Intent/应用 API；无统一跨厂商笔记数据库承诺 |
| 提醒 | Familiar 自有提醒调度，或受支持的 `ACTION_CREATE_REMINDER` | 交接外部提醒应用不代表已保存；本地通知/时间精度/后台调度分别验收 |
| 文件与附件 | 系统文件选择器、受限 URI 授权、分享面板 | 使用资源 ID，不把任意路径或全盘访问交给模型 |
| 跨应用操作 | `device.ui.observe/act`，独立 Kotlin `AccessibilityService` | 用户在系统设置中开启；限定目标应用与任务，观察当前页面并验证动作后状态，提供停止与人工接管 |
| 新系统的语义调用 | 单独评估 Android AppFunctions | 官方仍为实验预览，Android 16+，跨应用调用需要相应权限且完整链路开放有限；不作为首版必需依赖 |

依据：[Calendar Provider](https://developer.android.com/identity/providers/calendar-provider) 支持读写和日历 Intent；[Intent 文档](https://developer.android.com/reference/android/content/Intent#ACTION_CREATE_NOTE) 中 `ACTION_CREATE_NOTE` 从 API 34 提供，`ACTION_CREATE_REMINDER` 从 API 30 提供；两者都需要实际接收应用，不能据 Action 名称推断任意应用可用。AppFunctions 状态见 [官方概览](https://developer.android.com/ai/appfunctions)。

### 无障碍服务如何进入 Familiar

无障碍服务是可选平台执行器，模型仍通过 `agent.tools` 请求动作，不能直接控制系统。建议链路：

```text
用户目标 → 共享 Agent / 工具注册 → Familiar 授权与参数校验
                                      ↓
                          Android 任务所有者（Kotlin）
                         ↙                      ↘
             Calendar / Intent / 文件         无障碍观察与动作
                         ↘                      ↙
                         可验证结果 / 等用户 / 失败
                                      ↓
                           同一会话历史与任务状态
```

无障碍任务的最小契约需要 `taskId`、任务代次、目标包名、观察版本、动作参数、截止时间、取消和结构化结果。观察与执行之间页面已经变化时重新观察；坐标操作只在有明确视觉依据时使用。页面文字/通知内容属于外部数据，不得改变系统授权。

能力权限应区分“查看当前界面”和“代操作”。日历读写、截图、通知读取、无障碍服务分别授权；开启一个权限不自动授予其它能力。写入、发送和删除遵循现有 Familiar 的具体工具策略，不把每一次普通点击都变成重复审批。

任务开始、等待用户、执行中、已停止、完成、失败、结果未知都需要明确呈现。对于写入后超时，先查验结果，避免重试造成两条日程。停止要到达原生执行器，撤销权限立即停止后续动作，旧代次回调不能恢复任务。

原生服务拥有 Android 资源，但这不自动解决 WebView 暂停后的完整 Agent 推理。跨应用长任务必须在 M2 明确业务执行器与交接协议，再验证切应用/锁屏；不能依靠页面计时器实现常驻。Tauri 支持 [Kotlin 移动插件与原生桥](https://v2.tauri.app/develop/plugins/develop-mobile/)。

分发条件需要留作专项决策：Google Play 当前[无障碍 API 政策](https://support.google.com/googleplay/android-developer/answer/10964491)限制通过该 API 自主规划和执行的自动化，一般 AI 助手不能仅因使用无障碍功能就声明为面向残障人士的辅助工具。开发原型与商店可发布性分别验证；不借此阻止系统 API 能力先落地。

## 5. 三个参考项目的采用范围

### AutoGLM

[Open-AutoGLM](https://github.com/zai-org/Open-AutoGLM) 的公开方案以屏幕感知、动作规划、执行和再次观察组成循环，支持敏感动作确认和登录等场景的人工接管；所核查的 Android 路径依赖电脑端 Python/ADB。Familiar 参考其任务循环与接管设计，不把 ADB 当作发布版的手机执行器，也不将项目描述成已经提供 Android 原生无障碍实现。

### Cherry Studio Mobile

[Agent 架构](https://github.com/CherryHQ/cherry-studio-app/blob/main/docs/references/agent/README.md)将会话、状态和工具授权留在 Host，运行引擎通过能力适配器使用工具。[系统工具文档](https://github.com/CherryHQ/cherry-studio-app/blob/main/docs/references/agent/agent-tools-and-resources.md)已描述设备日历、平台权限、执行前再次校验、结果未知与系统表单交接。

最适合参考：只向模型暴露当前可用工具；每轮冻结工具描述，真正执行前再检查权限；系统表单返回“待用户操作”；写入可能发生后不自动重试。该文档明确 **Reminder 工具仅限 iOS**，不能把其提醒能力表述为 Android 已实现。其 Expo/React Native/Pi 选型不改变 Familiar 已确定的 Tauri/插件路线；本轮不复制第三方实现代码。

### 用户的 Hermes Android

已通过授权 GitHub 连接只读检查私有仓库 [mengxingGG/hermes-android](https://github.com/mengxingGG/hermes-android)，`main` 树快照 `b24e08dde8aa38f89f9e04669b7dd51a75ca895d`。本地保存的同名目录当前不存在。

| 可参考内容 | 已读证据 | Familiar 的采用边界 |
| --- | --- | --- |
| Android Keystore、配置与密钥分离、错误脱敏 | [ADR-003](https://github.com/mengxingGG/hermes-android/blob/main/docs/adr/ADR-003-provider-settings-and-secrets.md)、[ProviderSettingsRepository.kt](https://github.com/mengxingGG/hermes-android/blob/main/app/src/main/java/dev/hermes/mobile/ProviderSettingsRepository.kt) | 参考原生加密与不回填明文；Familiar 用凭据引用和受限原生传输，不照搬子进程环境注入 |
| 服务拥有运行时、后台任务与 UI 分离 | [ADR-008](https://github.com/mengxingGG/hermes-android/blob/main/docs/adr/ADR-008-hermes-keep-alive.md)、[Manifest](https://github.com/mengxingGG/hermes-android/blob/main/app/src/main/AndroidManifest.xml) | 参考所有权和恢复；按新目标 SDK 重新验证，不能照搬服务类型和开机自拉行为 |
| 真正的审批卡、停止、续聊、工具可用性、键盘与返回 | [交互记录](https://github.com/mengxingGG/hermes-android/blob/main/docs/progress/04-2026-08-07-approvals-continuity-android.md) | 借鉴状态与交互；Familiar 使用自己的公共契约 |

该仓库 README 明确其内嵌 Python/Node、ARM64-only、`targetSdk 28` 与旁加载路线，都是特定运行时的取舍；不自动成为 Familiar 的决定。本轮所读 Manifest 未声明无障碍服务或日历读写权限；不能把它作为这些能力已经实现的证据。该私有仓库资料没有交给 Claude Code，设计授权范围仍是 UI 任务书列出的参考文件。

## 6. Codex 的实施切片

| 顺序 | 实际工作 | 验收目标 |
| --- | --- | --- |
| M0-A：完成基线 | 固定工具版本和模拟器；提取纯协议/字节处理/ID 边界；明确最小 Profile 与产品桥 | 浏览器运行检查、既有 Windows 回归、无 Node/Electron 隐式依赖、文档有真实版本 |
| M1-A：宿主与角色 | 独立 Tauri Android 入口、Kotlin/Rust 桥、资源解析、Claude UI 接线 | 模拟器启动，角色展示与触摸，安全区、返回、中文键盘；使用隔离数据 |
| M1-B：真实文字闭环 | 原生可取消网络流、Keystore、共享 Provider/会话、设置与历史 | 用户配置的一个兼容 Provider 通路；本地夹具覆盖取消/断网/重启；真实服务单列验收 |
| M2-A：第一个系统工具 | 日历创建：先展示事件预览，再交接系统日历；随后补读写权限与回读 | 可取消；打开表单与实际保存区分；拒绝/撤回不误报成功；无重复创建 |
| M2-B：笔记与系统交接 | 本地普通笔记、分享/创建笔记、受限文件、明确目标应用 | 检查接收应用；有结果才报保存；无应用时可恢复降级 |
| M2-C：受控跨应用任务 | 无障碍观察/动作、原生任务状态、授权、停止、接管、后台执行器决策 | 从测试应用的固定任务开始；界面变化、权限撤回、打断和进程回收测试 |
| M2-D：语音与悬浮陪伴 | 音频所有者、前台服务、Overlay、手机任务与语音结合 | 继续遵循文档 14/16；扬声器插话与耗电必须补真机证据 |

本表把文档 15 的 M2 细分，并加入用户本轮提出的系统工具目标，不表示以上实现已经开始。日历、笔记可以较早获得使用价值，不必等待通用手机 Agent 完成。

## 7. Claude UI 需要补充的系统能力设计

信息架构与布局由 Claude 自主设计。在合适的设置入口呈现“手机能力”，在对话中用任务卡呈现日历/笔记预览、授权、进度、停止和结果。

- 能力详情用“能做什么、何时使用、当前状态、如何停用”说明，不显示内部 SDK/Kernel 术语。
- 开关表达用户偏好；系统授权事实由原生层单独返回，不能开启开关就显示已授权。
- 无障碍连接为“未开启 / 已连接 / 已断开 / 本任务暂停”等状态；提供可触达的停止入口。
- 日历写入卡显示标题、具体日期/时间/时区、目标日历；笔记显示目标应用和内容摘要。
- 预览适配器中的操作标注示例状态，不实际弹系统权限或修改用户日历；真实模式严格呈现核心事实。

这些是向 Claude 的产品要求，布局、组件和最终视觉由 Claude 交付后再审阅。Codex 提供接口并进行集成验收，不接管前端设计。

## 8. 初次 M0 工具链核查与历史证据

| 项目 | 本轮检查 |
| --- | --- |
| 现有桌面版 | `npm run check` 通过：类型检查、105/105 测试、Windows 构建 |
| Node/前端 | 仓库已有 TypeScript 6.0.3、esbuild 0.28.1；尚未添加 Tauri 依赖 |
| Rust | PATH 与默认 `.cargo/bin` 未找到 rustc/cargo；未完成 Rust 安装与目标配置 |
| SDK | `C:/AndroidSDK` 有 Platform 34/35/36、Build Tools 34/35/36、NDK 27.0.12077973 |
| 模拟器 | `AppData/Local/Android/Sdk/emulator` 有 36.4.10；`.android/avd` 未找到虚拟设备配置；已见系统镜像目录仅有安装器占位，不能当成已安装镜像 |
| JDK/环境 | 找到 JDK 17.0.2 目录；当前进程未设置 JAVA_HOME/ANDROID_HOME/NDK_HOME；没有据此锁定构建版本 |
| ADB | 首次在沙箱启动服务失败，未证明正常环境 ADB 不可用；本轮未启动 Android 模拟器 |

下一次进入 M0-A 时补齐 Rust 与可启动 AVD，优先使用一个稳定系统镜像，另加较新版本做权限/返回/边缘布局对照；最低支持版本和 targetSdk 在工具链实际构建后记录。模拟器可验证功能与生命周期，语音、OEM 后台限制和耗电仍需真机。工具链依据：[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)、[AVD 管理](https://developer.android.com/studio/run/managing-avds)。

证据位于 `.artifacts/android-start/`：

- `desktop-check-native.log`：105 项测试与构建成功。
- `desktop-check.log`：初次沙箱受本地网络/文件权限限制而失败，正常权限复测已通过。
- `portability-audit.mjs` / `portability.json`：14 个模块入口的导入、隐式全局与浏览器构建调查。
- `claude-result.json`：实际设计请求的 401 结果；状态查询不能替代真实请求。

初次核查之后，用户明确要求 Claude 完成前端开发，本轮已新增 `apps/tauri/ui`、`packages/mobile-contracts`、`packages/mobile-bridge`、隔离预览、构建与测试脚本。前端源码来自实际 Claude Code 调用，并由 Claude 按 Codex 审查结果修复跨会话草稿与结果不确定的提示。交付细节见 [集成说明](android-ui/INTEGRATION.md)及 [Claude 设计说明](../apps/tauri/ui/DESIGN.md)。

未改变用户配置或其它项目；没有创建 APK、安装工具链、启动麦克风、启用无障碍、修改真实日历/笔记，也没有提交或发布 Git。M0 仍未完成，下一步是完成工具链和共享核心可移植化，再将真实宿主接入已完成的 UI。
