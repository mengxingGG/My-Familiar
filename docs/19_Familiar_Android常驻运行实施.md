# Android 常驻运行实施与验收

日期：2026-10-21。当前版本：Windows / Android 1.1.0。本轮修复后台无障碍，新增 GitHub 正式版更新、气泡回车发送、稳定上下布局和半头像停靠；见 [发行说明](releases/v1.1.0.md)。按平台保留能力差异，硬件与账号未验收项见文档 20。本文保留实施历史。

当前交付与全部目标的核对见 [Android 目标与验收核对](20_Familiar_Android验收核对.md)。本文按时间保留实施记录；早期条目中的缺口和旧包结果不代表当前状态。

## 已确认的交付目标

用户要求可安装、可常驻的 Android 宠物，功能向当前 Windows 版对齐；初期 UI 由本机 Claude Code 设计开发，额度不足后按用户授权由 Codex 接手，继续沿用桌面风格。Codex 负责共享核心、原生平台适配和验收。沿用 Tauri 2、薄 Kernel、插件架构。Android 无障碍是手机控制的主要适配器。

用户进一步指定直接使用 ARM 包。当前模拟器 API 34，主架构 x86_64，但 `ro.product.cpu.abilist` 包含 `arm64-v8a`，原生桥为 `libhoudini.so`。**构建与安装目标固定为 arm64-v8a；不另交付 x86_64 APK。** 此环境属于 ARM 转译验证，不能替代真实 ARM 手机的性能、功耗或厂商后台策略验收。

## 后台业务执行器决策 ADR-2026-10-19-01

当前 Windows 业务插件含 Node 文件、加密、Buffer 和网络依赖，全部迁入 Activity WebView 无法保证关闭页面后继续对话。为复用现有 Kernel、Provider、会话、Agent 和记忆插件，本轮选择验证**前台服务拥有的嵌入式 Node 运行库**；Tauri Activity 只提供 Claude UI 和受限命令桥。并非启动外置 Node 可执行文件，也不依赖电脑在线。

- 运行库候选固定为 `fogtape/nodejs-mobile v24.22.0-0` Android full ARM64 构件，下载后对照发布方 SHA256SUMS；它是社区维护分支、预发布构件，不是 Node.js 官方移动发行版。集成验收前不可标记生产就绪。
- 原 `nodejs-mobile/nodejs-mobile` 已发布二进制仍为 Node 18.20.4，因此不直接采用该旧运行库。QuickJS 需要额外重建现有 Node I/O 适配和标准库兼容，作为后续可替换候选。
- 独立 `:runtime` 进程中的后台服务拥有单个运行实例、宠物悬浮窗和取消资源。控制器用未导出的绑定服务和校验同 UID 的私有 socket 连接，避免 Binder 大消息限制；Tauri 控制进程退出不结束运行进程。设置页可以反复附着/离开；业务状态只有一名写入者。
- Android Keystore 替换 Electron safeStorage。私有文件替换桌面路径，用户文档走系统文件选择器。Shell、Windows CLI、stdio 工具必须按能力排除或提供明确 Android 等价实现，不注册假成功服务。
- 插件只装配随包可信代码；嵌入 Node 不构成第三方脚本安全沙箱。运行库与原生桥需要设备回归及依赖维护记录。

依据：[Node Mobile 原生嵌入指南](https://nodejs-mobile.github.io/docs/guide/guide-android/getting-started/)、[原运行库发布记录](https://github.com/nodejs-mobile/nodejs-mobile/releases)、[选定分支发布记录](https://github.com/fogtape/nodejs-mobile/releases/tag/v24.22.0-0)、[Tauri 移动插件](https://v2.tauri.app/develop/plugins/develop-mobile/)。选择不改变宪法第 87–99 条；保留共享业务，原生启动入口只负责装配。

## Android 系统适配依据

| 能力 | 实现与边界 | 官方依据 |
| --- | --- | --- |
| 常驻宠物 | 用户从可见 Activity 启动前台服务，常驻通知包含打开和停止；使用 specialUse 并说明持续可见宠物用途；不可借 dataSync 类型无限保活 | [前台服务类型](https://developer.android.com/about/versions/14/changes/fgs-types-required) |
| 悬浮窗 | SYSTEM_ALERT_WINDOW、Settings.canDrawOverlays、TYPE_APPLICATION_OVERLAY；拒绝后仍能使用应用内聊天；撤回后释放窗口 | [Settings](https://developer.android.com/reference/android/provider/Settings#canDrawOverlays(android.content.Context)) |
| 后台启动 | 遵守 Android 12+ 启动限制；Android 15 的悬浮窗豁免还要求当前有可见悬浮窗；不承诺强行停止后自动复活 | [后台启动限制](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start) |
| 开机启动伙伴 | 默认关闭；解锁后的 BOOT_COMPLETED 检查应用偏好与悬浮窗权限，只启动 specialUse 宠物服务；不打开控制页、不启动录音和唤醒 | [开机启动类型限制](https://developer.android.com/about/versions/15/behavior-changes-15#fgs-boot-completed) |
| 无障碍 | BIND_ACCESSIBILITY_SERVICE、明确披露、用户手动启用；限定事件，按需获取节点；动作经过 Familiar 工具批准和执行时权限复核 | [官方服务指南](https://developer.android.com/guide/topics/ui/accessibility/views/service)、[手势 API](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService#dispatchGesture(android.accessibilityservice.GestureDescription,android.accessibilityservice.AccessibilityService.GestureResultCallback,android.os.Handler)) |
| 日历 | Calendar Provider 或插入 Intent；Intent 只能记为等待用户操作，不能假报日程已保存 | [日历接口](https://developer.android.com/identity/providers/calendar-provider) |
| 笔记 | 应用内笔记与系统 CREATE_NOTE 分开；先查询目标应用是否支持 | [CREATE_NOTE](https://developer.android.com/reference/android/content/Intent#ACTION_CREATE_NOTE) |
| 小米系统 | 后台弹出页面、自启动分别管控，不能把标准悬浮窗授权当作全部后台权限已开放；界面显示真实检测状态和系统设置入口 | [小米后台弹出页面说明](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1625)、[自启动管理说明](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1624) |

构建采用本机已有 API 36 / NDK 27.0.12077973 / JDK 17，配套固定 AGP 8.11.1 与 Gradle 8.13，符合[官方兼容表](https://developer.android.com/build/releases/agp-8-11-0-release-notes)。Tauri 2.12.3 CLI / Rust crate 2.12.4；本项目缓存内 Rust 1.99.1 GNU 宿主编译 ARM64，不依赖全局 Visual Studio。

已完成的开发验证：

- 共享核心装配使用现有七类 Provider、会话、Agent、技能、记忆、上下文压缩插件；新增平台凭据/原生工具适配。全部 116 个 Node 测试通过，包括类型/地址凭据隔离、共享文件目录别名/越界、记忆与 Skill 工具、日历批准边界、流式检查点和重启历史。真实云模型仍未验收。
- Claude Code 已完成常驻卡片、九项能力分组、无障碍说明确认、工具批准卡片、七类模型与七个伙伴界面以及已授权能力的系统设置入口。19 个浏览器场景通过，包含四种宽度；原生软键盘仍待验收；系统返回及 Activity 销毁与重建另做设备回归。
- 下载的运行库压缩包 SHA256 已与发布方核对：`9b068f4ad4c755f26c04b31883c536f037a4831e6575847a699cdf5fa72dde25`。其中 ARM64 `libnode.so` 的 ELF LOAD 对齐为 `0x4000`（16 KB）。尚未完成 16 KB 页设备运行验证。
- ARM64 APK 已构建、安装并在 API 34 模拟器运行；系统安装 ABI 为 `arm64-v8a`。四个原生库的依赖完整、ELF LOAD 与 APK ZIP 16 KB 对齐均通过脚本检查。
- 本地隔离模型夹具通过设备上的 Keystore 写入/重启读取、流式回复、取消、Home 后继续生成、进程恢复与停止常驻测试。无障碍节点读取、逐项批准、真实返回桌面及再次观察已通过。审批通过产品命令桥驱动，不等于用户在跨应用场景下的所有审批交互都已验收。
- 真正关闭控制页时暴露 Tauri 默认进程退出的问题，因此将核心与宠物迁入独立 `:runtime` 进程；最终 9 项设备回归全部通过，包含销毁/重建控制页时运行进程 PID 不变且同一回复完成，结果见 `.artifacts/android-device/device-smoke.json`。
- 设备检查发现路径别名误判与强退丢失流式内容，已修复共享模块并回归 Windows 构建；不会重放中断的有副作用操作。最近尚未落盘的片段不属于已提交检查点。

## Windows 功能对齐清单

每行分别记录代码、设备运行、真实服务验收，不以构建通过替代功能验收。

| 功能 | 复用/Android 等价路线 | 当前 Android 状态 |
| --- | --- | --- |
| 原创角色、动画、触摸互动、拖动 | 共享角色包与 renderer-sprite/behavior-basic/bubble-chat；服务 Overlay 承载 | 七角色原始动作帧、回复气泡、长按菜单、尺寸/安静/可见设置已接入；新增 Android 边角吸附、闲置/向外滑收成头像与位置记忆，验收见下方停靠增量 |
| 昵称、人格、设置与历史 | 复用 settings/conversation，原生私有持久化 | 已接真实核心；设置、历史与重启通过夹具/设备回归 |
| 七类 Provider、流式聊天与取消 | 共享 Provider/llm-router/agent-runner | 七类已装配，各自档案和密钥隔离已设备验证；高级参数、模型目录/搜索与可取消连接测试已接入并用隔离服务验收；七类真实服务待验收 |
| 记忆、上下文压缩、技能、工具审批 | 共享现有业务插件；Android 工具按能力装配 | 记忆与技能管理、文件工具和手机审批已测；上下文用量、自动压缩摘要及原文分页/搜索管理页已接入，模拟器长会话触发压缩并回查通过 |
| 常驻、通知、关闭控制页、服务恢复 | 前台服务；中断状态落盘，不自动重放有副作用任务 | 已实现与分项验证；熄屏暂停动画；真实通知按钮停止、悬浮窗权限撤回及熄屏/亮屏保持进程已测；OEM 长时策略与功耗待补 |
| 开机启动 | Windows 登录自启的 Android 等价为用户选择的 BOOT_COMPLETED 原生入口 | 默认关闭的常驻卡片开关已实现；开启/关闭后的真实模拟器重启已验证，控制页不启动、无自动录音。小米等厂商自启动权限仍由用户单独设置，真机待验收 |
| 屏幕理解与手机控制 | 无障碍节点/手势，截图按系统授权和任务需要获取 | 节点读取、点击/输入/滚动/返回/Home、跨应用实体触摸审批和 Android 14+ 窗口截图已接入；自绘控件手势已验证。新增按名称查找和批准打开应用入口，仍须观察并批准后续步骤；复杂真实应用任务仍需继续验收 |
| 日历、笔记和提醒 | 系统结构化 API 与可用 Intent | 可见日历/实例查询、一次性/全天/重复创建、详情、普通事件改删与提醒已设备验证。新增无例外系列整组重排、含例外的系列删除，以及具有同步标识系列的单次改期/取消；未同步系列拒绝单次写入，已有例外的重排与取消恢复交给日历应用。标准外部笔记交接不当作保存；云日历同步、邀请及实际通知仍待验收 |
| 图片、文件与相机输入 | 系统选择器/相机适配，共享媒体业务 | 图片与 UTF-8 文本选择、预览、原件发送及历史恢复已设备验证；PDF/DOCX 本地提取文字、发送与重启恢复已用 ARM64 包验收。前台粘贴剪贴板图片、预览/发送及重启历史已设备验证。系统相机接口/UI 已接入但设备没有预装相机，确认拍照待实测；其他格式与扫描文档 OCR 待补 |
| 麦克风、语音、唤醒、播放 | Android 音频所有者 + 共享会话编排；分别验证后台权限/音频焦点/取消 | 录音转文字、连续语音、独立 STT/TTS、系统本地朗读已设备验证；离线关键词待机/回放、系统听写交接及 Live 协议/真实音频通路已有隔离夹具验收。真实云服务、真人识别与唤醒率、系统引擎连续转写仍待补 |
| 关怀、位置、天气 | 共享关怀规则 + Android 一次定位与宠物气泡 | 日常时段问候、自定义提醒、预览/取消、单次前台大致位置及 10 分钟内存缓存已接入；高德附近建议复用共享数据源并按误差处理，模拟位置不外发。真实高德/天气服务待验收，没有独立自动天气播报规则 |
| MCP、飞书/GitHub | 网络接口优先；桌面 CLI 不视为手机前提，逐项记录替代与缺口 | HTTP MCP、GitHub 官方 Token 只读/可写入口已设备验证；大目录及图片的固定窗口适配已用隔离服务验证。飞书私聊、ARM64 办公执行器、个人设备授权与刷新均已实现，主包办公 10 组设备检查通过。真实账号授权/业务未验收；GitHub 浏览器登录、stdio 等桌面进程工具仍有差异，Houdini 子进程偶发故障尚未根治 |

## 设备验收顺序

1. ARM64 APK 安装、Tauri 页面加载、原生库启动与 ABI 记录。
2. 服务启动/停止、悬浮窗授权与撤回、Home/关闭 Activity 后驻留。
3. 真实共享核心的设置、历史、流式消息、取消、重启恢复；测试数据与真实用户数据隔离。
4. 无障碍启用、节点查询、确认后单步操作、权限撤回；禁止代替用户自动确认系统授权。
5. 日历/笔记及语音、媒体、关怀、工具的功能对齐。
6. ARM64 真机及不同 Android/小米版本：16 KB 页、软键盘、后台/锁屏、功耗、升级与数据恢复。

## 本轮构建与证据

- 构建：`powershell -ExecutionPolicy Bypass -File scripts/build-android.ps1`。工具环境只设置在当前构建进程，不改全局 PATH/Claude 配置。
- 包检查：`scripts/verify-android-apk.ps1` 强制 ARM64、四个必需原生库、依赖闭包、16 KB ELF/ZIP 对齐。证据 `.artifacts/android-device/apk-verification.json`。
- 设备：`node scripts/smoke-android-device.mjs`；已手动在系统设置启用灵伴无障碍后可加 `--accessibility`。只连接调试包，用本机 HTTP 协议夹具和测试密钥，结束恢复配置。不要对已有真实密钥的调试数据直接运行。
- 系统“强行停止”后无障碍可能断连，需用户重新启用，不能通过代码静默恢复权限。
- 证据：`.artifacts/android-device/device-smoke.json`、`core-tests.log`、`core-connected.png`、`overlay-home.png`；浏览器证据见 `.artifacts/android-frontend/`。
- 外部笔记交接、完整日历功能、关怀及更多语音/媒体能力，以及真实 ARM 手机、真实云模型仍未完成；已完成的语音、宠物、资料和模型/上下文管理增量见下文，当前 APK 是开发验收包，不是 Windows 功能等价正式版。

补充手工设备验收：通过真实通知栏“停止伙伴”停止服务与窗口；通过系统设置撤回悬浮窗后核心仍在但窗口已释放（`overlay-revocation.json`），恢复授权后再次显示；熄屏/亮屏保持同一运行进程。宠物可能遮挡系统开关，测试时先拖离开关。授权后的系统设置快捷入口已由 Claude 实现，日历/麦克风/位置已授权时由原生打开应用权限详情。

## 七类模型、共享工具与日历增量

- Claude Code 2.1.303 通过本机 CLI 完成七模型/七伙伴/权限 UI，61 轮交互、无权限拒绝。只向其提供既有授权资料与自身源码，没有新增角色素材或 Hermes 源码。最初继承第三方 API 路由导致 ECONNRESET；本次进程指定官方地址、清理覆盖后完成，不改变用户全局配置。
- Windows PowerShell 5 将无 BOM 的 UTF-8 中文脚本解析错误，导致紧邻注释的环境设置未执行。Android 构建脚本统一保留 UTF-8 BOM，并用 .NET SHA256 避免继承的模块路径导致 Get-FileHash 不可用；`npm run android:build` 已验证。
- `createToolsBasic` 和 `createSkillsLocal` 保留 Windows 默认配置，Android 排除 Shell、本地 MCP 进程及依赖它们的内置 Skill。文件访问限定私有 workspace（包含真实路径/链接越界检查），不会将应用凭据目录暴露给模型工具。记忆仍由原有 memory.files 独立拥有。
- 日历执行遵循 [Calendar Provider 官方文档](https://developer.android.com/identity/providers/calendar-provider)和 [Instances 查询接口](https://developer.android.com/reference/android/provider/CalendarContract.Instances)。每次执行复检 READ/WRITE_CALENDAR，具体工具任务另走共享批准；查询最多 31 天/100 项，创建明确校验 ISO 偏移与 IANA 时区。
- 创建先原子记录操作号和内容摘要，再写系统 Events 并核对回读字段；同编号同内容返回原结果，不再次插入，同编号不同内容拒绝。进程中断后的未确认账本项返回 unknown，要求先查日历，不自动重放。当前没有提醒器、全天或重复日程创建。
- `.artifacts/android-device/parity-smoke.json`：5 项新增设备场景，覆盖七类配置及凭据隔离、七角色同步、本地笔记/记忆/Skill、拒绝后零写入、批准后写入回读和防重。测试只创建本轮唯一名称的临时日历，结束核对 ID/名称后清理。执行：`node scripts/smoke-android-parity.mjs --calendar`（日历权限先通过系统可见对话框允许）。
- 新证据：`core-tests-parity.log`、`claude-ui-providers-official.jsonl`、`smoke-providers.log`；无真实云模型调用，所有测试密钥在结束时清理。完整桌面等价目标继续进行。

本轮可安装开发包：`release/android/Familiar-0.3.0-arm64-debug.apk`（268078856 字节）；SHA256 `6f8652b9063f7da393039e93717cf29f3c005fcfb5952779d7553766cd7eaccd`。同一文件已安装，最终状态见 `final-boot.json`：核心 ready、常驻 running、悬浮窗 visible、未保留模型测试密钥。调试符号保留，包大小不是最终优化后的发行体积。

## 跨应用审批增量

- Claude Code 通过本机 CLI 完成独立 `mountApproval`、卡片样式和设计说明，18 轮、无权限拒绝。维持此前授权资料范围；核心与原生实现由 Codex 完成。
- `familiar.approvals-android` 订阅共享 `agent.approvals`，只推送版本、序号和任务；原生不复制会话或审批引擎。响应复用 `task.respond`，只允许当前仍待处理的任务；拒绝是拒绝该步骤，取消整轮仍通过停止回复。
- 卡片位于 `:runtime` 的无焦点应用悬浮窗，收起不会批准，点击伙伴可重开。按照 [WindowManager 参数文档](https://developer.android.com/reference/android/view/WindowManager.LayoutParams)使用 `FLAG_NOT_FOCUSABLE`；跨应用执行前核对实际窗口编号、包名及刷新的节点身份、文字、可用性和边界。自动化不能操作本应用及系统权限/安装界面。
- 按照 [Android 本地内容文档](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)和 [原生 WebView 桥文档](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges)，采用 WebViewAssetLoader、本地资源精确允许列表、禁止网络/文件访问与导航、CSP、最小 JS 接口。独立进程使用独立 WebView 数据目录，调试端口只在 debug 构建启用。
- `scripts/smoke-android-approval.mjs` 的四项设备场景通过：真实 ADB 触摸收起/重开/批准后计数增加；拒绝后零点击；修改目标文字后旧节点被拒绝；取消回复后待办消失且零点击。所有场景底层测试 Activity 保持前台。CDP 只定位卡片和读取状态，没有用 CDP 调用批准。证据 `approval-smoke.json`、`approval-card.png`。
- 靶场为无网络、无权限、无持久化的 `tests/android-fixture`，通过 `node scripts/build-android-fixture.mjs` 构建后安装 `.artifacts/android-fixture/fixture.apk`。`smoke-android-device.mjs --accessibility` 也使用此靶场，避免让自动化操作自身审批页面。
- 测试清理先清除夹具 URL 对应密钥再恢复原档案。发现早期脚本留下三个孤立哑密钥后，用仅匹配本轮固定测试值的调试 instrumentation 清理，未输出或修改其他凭据；`fixture-cleanup.log` 记录数量。完成后从模拟器移除测试 APK。
- `smoke-android-approval-ui.mjs` 四项浏览器测试覆盖 280/336 布局、完整详情纯文本、防重复、等待快照、错误重试和迟到结果；原主界面 19 项回归、共享核心 117 项、常驻设备 9 项通过。七模型/七角色/笔记记忆/日历的五项设备证据沿用上一增量，未冒充本次重跑。
- 此审批增量后的语音、外部笔记交接、更多角色动作、复杂手机操作及完整 Windows 功能对齐继续进行；图片/文本附件进度见下一节。真实云模型、ARM 硬件和 HyperOS 长时功耗未验证。

## 图片与文本附件增量

- Claude Code 通过本机已登录 CLI 用 56 轮完成聊天附件托盘、移除、预览、历史附件与失败恢复 UI，零权限拒绝；仍只使用已授权接口、任务书及自身 UI 源码。核心媒体库、Android SAF、缩略图和传输由 Codex 完成。
- 遵循 [Storage Access Framework 官方文档](https://developer.android.com/training/data-storage/shared/documents-files)，使用 `ACTION_OPEN_DOCUMENT` / `CATEGORY_OPENABLE` 读取用户选中的内容 URI，不申请整盘读取权限，也不保留长期 URI 授权。图片上限 12 MiB，UTF-8 文本上限 400000 字节，一次最多八项；未知长度也在流读取过程中执行上限。文本类 MIME 与 JSON 统一导入共享文本附件。
- MainActivity 插件拥有系统选择器，原件复制到私有 UUID 暂存区，经私有 IPC 传令牌给运行进程。公开插件命令明确拒绝 `media.import`；核心校验令牌、路径、链接和长度，然后复用 `media.assets` 存储。原件不以大块 base64 穿过 WebView 或控制 IPC。
- 大图由 Android 做尺寸受限的本地 JPEG 缩略图，处理 EXIF 方向并保留独立原件。预览只返回受限 data URL/文本与元数据；桥拒绝外部 URL、错误附件关联和原生私有路径。模型输入通过既有 `media.input` / conversation / Provider 解析原件；选择和预览不会触发模型请求。
- 图片与文字可单独发送。历史快照保留附件引用，重启后可再次预览。系统选择器回调绑定打开时的会话；发送中的新附件不会被成功回调清空，失败时只把原附件合并回原会话。文字沿用新草稿优先策略，不覆盖发送期间新写的文字。
- `.artifacts/android-device/media-smoke.json` 记录系统选择器取消、2.79 MB 图片/文本本地预览、超限文本拒绝、附件单独发送、重启及内部命令隔离；Provider 请求中的图片 SHA256 与本轮合成原件一致。`media-preview.png` / `media-chat.png` 是设备截图。未调用真实云模型。
- 119 项共享测试、19 项既有界面回归、5 项媒体界面检查、4 项审批卡片回归通过。媒体浏览器测试含迟到选择/发送失败的会话隔离、纯文本预览、取消保留附件及 360/390/430/768 布局。已有常驻/日历/审批设备证据仍保留，不代表本次全部重新运行。
- 该附件增量当时未含相机/截图；后续进度见下一节，剪贴板与更多文档格式仍待补；真实供应商的视觉能力取决于所选模型，尚待实测。原件与缩略图随应用私有数据保存，未发送或已移除附件的媒体库回收仍待完善；不会为了清理而破坏历史引用或失败重试。

## 系统相机与受控窗口截图增量

- UI 继续由本机 Claude Code 2.1.303 设计开发：40 轮、零权限拒绝，只改已有 UI 文件，资料范围没有扩大。增加独立拍照按钮、与文件共用的选择锁/会话草稿、能力说明和无障碍截图披露。截图本身复用既有悬浮任务审批，不增加自动采集入口。
- 遵循 [Android 相机 Intent](https://developer.android.com/media/camera/camera-intents)、[最小化权限](https://developer.android.com/privacy-and-security/minimize-permission-requests)和 [FileProvider](https://developer.android.com/reference/androidx/core/content/FileProvider)：ACTION_IMAGE_CAPTURE 委托系统相机，不申请本应用 CAMERA 权限；只把本次私有缓存 JPEG 的 content URI 临时授权给接收端。确认后通过原媒体导入/缩略图通道加入附件，取消返回空数组，最终由用户发送。返回后撤销授权并清理原缓存，异常清理不会锁死下次选择；崩溃遗留缓存按 24 小时清理。
- 当前模拟器没有预装系统相机。按 [Android 11 官方行为变化](https://developer.android.com/about/versions/11/behavior-changes-11#media-capture)，普通安装的第三方测试相机不能响应隐式拍照请求。本轮验证了不可用状态与 UI 降级，没有修改系统策略、加入测试后门或声称已验证镜头成像/拍照确认链路。后者须在有预装相机的设备验收。
- `android_screenshot` 工具通过共享 Agent 的 outsideWrite 类别逐项批准。先用 android_screen 观察获得 snapshotId，再用该引用请求截图；原生复检未锁屏、服务仍连接、snapshotId/包名/窗口号仍相符，拒绝自身应用、设置、权限和安装确认页面。
- 遵循 [AccessibilityService.takeScreenshotOfWindow](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService#takeScreenshotOfWindow(int,java.util.concurrent.Executor,android.accessibilityservice.AccessibilityService.TakeScreenshotCallback))，本增量只对 Android 14/API 34 及以上开放窗口截图；旧版本返回不可用，不退回可能包含悬浮层的整屏截图。系统 FLAG_SECURE 保护继续生效。事件回调不采集画面，没有循环截图或后台录屏。
- 截图硬件缓冲区在受限尺寸下复制，完成后释放；10 秒超时，迟到结果清理。JPEG 原件通过私有暂存令牌进入共享 media.assets，source=screen，走现有多模态 ToolResult/Provider 通道；不通过控制 WebView 传大块原图。
- `.artifacts/android-device/capture-smoke.json` / `captured-window.jpg` 记录设备真实审批触摸、原图交付、拒绝无图片、切换至桌面后旧引用失效和 FLAG_SECURE 拒绝。测试图为 1440×2560，画面下半部分全部是测试应用蓝色背景，宠物和审批卡片未混入。模型请求仅发给本机隔离 HTTP 夹具，不等同于真实视觉模型验收。
- 120 项共享核心测试通过；19 项主 UI、6 项媒体 UI（新增相机能力显隐/共用锁/取消/迟到会话隔离）、4 项独立审批 UI 回归通过。设备检查中系统设置页隐藏悬浮窗，故窗口切换靶场改为桌面；不会用看不见的卡片坐标代替实体批准。
- 最终 APK 仍只含 arm64-v8a 四个原生库，ELF 与 ZIP 均满足 16 KB 对齐。增量打包曾保留无引用旧数据导致文件膨胀；删除单个构建 APK 后重新打包恢复约 256 MiB。调试包不包含测试靶场。
- 后续仍需相机实机确认、语音/音频生命周期、剪贴板/更多文档、外部笔记、完整日历与关怀等，以及真实 ARM 硬件/真实云模型/小米后台与功耗验收；本轮不宣称达到 Windows 全功能等价。

最终交付复核：截图五个设备场景（另附像素证据）、原有四项触摸审批、五项系统附件场景均在最终包回归通过。安装包 SHA256 与交付文件一致。`final-boot.json` 记录 2026-10-19T10:02:00Z 核心 ready、常驻 running、悬浮窗 visible、无障碍 granted、相机不可用；七供应商档案均无测试密钥，当前无回复。测试 APK 与下载目录合成文件已移除。

## Android 语音增量：Codex 接手 UI

- 本机 Claude Code 本轮达到 session limit，没有完成语音 UI。用户明确授权“额度不够你就接手做了吧”，因此 Codex 接手界面和核心，沿用奶油纸底、鼠尾草绿、纸片面板。历史 Claude 成果继续保留，未扩大发往外部服务的资料范围。
- `bootstrapAndroid` 装配原有 `voice.api` / `voice.session`；`androidAudio` 只实现设备音频宿主、私有音频文件传递和生命周期。没有另写转写、VAD、模型对话、朗读队列或语音缓存。Windows 默认行为保持，Android 默认关闭未接入的唤醒和参考音色。
- 新界面提供录音转文字、连续语音、完成录音、全局停止、已完成回复朗读，以及独立 STT/TTS 服务、模型、密钥、音色、速度、自动朗读、持续接话与流式开关。录音转文字只追加原会话草稿，按结果 ID 去重，不自动发送；连续对话绑定会话，活动时核心拒绝切换/删除/新建/文本误发。`voice.host` 仅允许原生运行进程私有 IPC，公开 WebView 桥拒绝。
- 根据 [前台服务类型](https://developer.android.com/develop/background-work/services/fgs/service-types)、[后台启动与使用时权限限制](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)和 [音频焦点](https://developer.android.com/media/optimize/audio-focus)，新增独立 microphone/mediaPlayback 前台服务。用户手动开始后才使用 AudioRecord；24 kHz 单声道 PCM 经共享核心封装 WAV。权限授权不会自动录音，服务 START_NOT_STICKY，不在进程重启后自动开麦。停止、错误与焦点丢失释放录音/播放设备；焦点回来不自动恢复。
- 播放使用 AudioTrack 流式 PCM 与 MediaPlayer 缓存/编码文件两条路径。原生校验采样率、PCM 对齐、队列上限，使用 epoch/playback/sequence 丢弃迟到数据；完整音频走私有 UUID 文件，不把大块 base64 放入控制 IPC。流式服务须返回 PCM 采样率；不兼容服务可在设置关闭流式，使用完整音频响应。
- 新增测试暴露并修复共享 `voice.session` 的缓存 clip.id 覆盖等待回执 ID 问题：现在播放命令以本次等待 ID 为准，音频完成后会正确退出 speaking；Windows 同样受益。
- `tests/android-voice.test.ts` 用真实共享引擎与隔离 HTTP 服务覆盖独立密钥、权限拒绝、WAV 转写、原会话归属、取消、连续 VAD→转写→聊天→朗读、会话保护、编码文件与缓存回放。整个核心回归 **121/121**，另有主 UI **19**、媒体 UI **6**、审批 UI **4**、语音 UI **3** 组通过。语音 UI 覆盖 360/390/430/768 布局、旧结果不重放、迟到回填与跨页面停止。
- `scripts/smoke-android-voice.mjs` 的 **6 个设备场景**通过：实际 AudioRecord/WAV/本地识别回填；退到桌面仍录音、结束后释放；转写取消；AudioTrack 流式播放与 MediaPlayer 缓存回放；中止回放释放服务；连续语音会话保护及通知栏真实触摸停止；其他应用抢占焦点后停录且不自动重启。前述内容按六条结果记录，见 `.artifacts/android-device/voice-smoke.json`、`voice-smoke-final.log`、`voice-recording.png`。测试识别服务返回固定文本，因此证明设备/传输/生命周期，不证明真实 ASR 准确率或云端语音质量；连续 VAD 全链路用核心测试合成音频验证，没有冒充模拟器真实语音识别。
- 设备测试只将短时录音发给本机隔离服务，不保存录音原件，只记录长度/摘要；结束恢复原配置、移除测试会话和 STT/TTS 哑密钥。焦点测试 APK 无网络/无权限，结束卸载。语音缓存中仅保留测试服务合成的短提示音，按共享缓存策略过期。
- 运行命令：先正常授权模拟器麦克风；`node scripts/build-android-fixture.mjs` 后安装测试 APK，再运行 `node scripts/smoke-android-voice.mjs`。脚本要求各当前模型/语音档案没有真实密钥，避免覆盖用户凭据。生产 APK 不包含测试应用或音频注入后门。
- 后续仍需本地系统音色、唤醒/Live 模式、真正云服务及人声输入、蓝牙/通话/不同系统版本、相机实拍、完整日历/外部笔记/关怀和更多桌面功能，及真实 ARM 手机、HyperOS 长时后台和功耗验收。当前是可安装开发包，不宣称 Windows 全功能已对齐。

语音增量最终交付：`release/android/Familiar-0.3.0-arm64-debug.apk`，268186592 字节，SHA256 `25f4d0e00b6ff913a5bc1842aad9a783fa108b59a91627529d68f508f2bb5737`。六项语音设备场景在该文件安装后复核通过；安装文件哈希与交付一致，签名 v2 通过，四个原生库仅 ARM64 且 ELF/ZIP 16 KB 对齐。Windows 构建也通过。最终状态见更新后的 `final-boot.json`：常驻与悬浮窗开启、语音 off、麦克风已授权但未录音、所有当前 Provider/STT/TTS 档案无测试密钥。测试 APK 已卸载，之前截图阶段安装包保存在 `Familiar-0.3.0-arm64-debug-capture.apk`。

## 宠物动作、气泡与边缘停靠增量（2026-10-19）

- 按用户要求，Codex 继续接手 UI 和核心。Android 装配已有 `renderer-sprite`、`behavior-basic`、`bubble-chat`；原生层只翻译表现协议和处理窗口手势，不复制聊天、动作优先级或气泡寿命业务。七角色使用原动作 SVG；思考、开心、拖动、休息来自实际核心状态。长按菜单可聊天、查看上次回复、休息/唤醒或收起气泡。
- “设置 → 悬浮宠物与停靠”分别保存共享宠物设置和 Android 停靠偏好。自动吸附默认关闭；开启后松手停在最近的边缘，靠近角落则停在角落。闲置收起有独立开关，默认 30 秒，可设 10–300 秒。停靠后向外滑超过 24dp 可立即收起；点击小脑袋仅展开，向内拖动也展开。收起窗口为 48dp，不保留隐藏身体的点击区域。
- 正在回复、气泡可见、待批准或菜单打开时不闲置收起；新回复或审批会展开已经收起的宠物。位置按可用区域比例保存，重置位置保留停靠偏好。屏幕关闭或锁定时移除窗口并暂停帧切换；解锁恢复，不持有唤醒锁。
- 窗口通过 WindowMetrics/WindowInsets 避开系统栏、刘海及系统手势区域，旋转和缩放后重新约束坐标。依据 [Android 官方 Insets 指南](https://developer.android.com/develop/ui/views/layout/edge-to-edge) 与 [WindowManager.LayoutParams](https://developer.android.com/reference/android/view/WindowManager.LayoutParams)。收起使用小窗口裁切头像，不依赖厂商是否允许窗口拖出屏幕。
- 验证：核心 **122/122**、主界面 **19**、媒体 **6**、语音 **3**、审批 UI **4**、宠物 UI **3** 组通过；类型检查和 Windows 构建通过。`scripts/smoke-android-pet.mjs` **8** 组设备场景覆盖自由/边角拖动、手动/定时收起、两种展开、进程重启、菜单/动作、真实流式回复气泡和熄屏恢复；`scripts/smoke-android-pet-geometry.mjs` **6** 组覆盖四边四角、160% 尺寸、横屏、隐藏恢复和私有命令拒绝。模型使用本机 HTTP 夹具。跨应用实体触摸审批 **4** 项再次通过；测试改为读取真实宠物窗口中心，避免沿用旧版固定坐标。
- 强行停止重启测试会断开无障碍；已通过 Android 系统设置界面恢复原有授权，未写系统安全设置。测试夹具已卸载，偏好已恢复为原来的自由拖动、100% 大小、15 秒回复气泡；没有剩余测试密钥、回复或待批准任务。模拟器旋转恢复原 `lock 0`。
- 最终交付 `release/android/Familiar-0.3.0-arm64-debug.apk`：**268223476** 字节，SHA256 **`6c8843ae0fad064c75955170a2d306e2068d288755c6e65bc8720b0511594e5f`**。签名 v2、四个 ARM64 原生库及 ELF/ZIP 16 KB 对齐通过；最终安装文件哈希一致，常驻/核心/悬浮窗正常，设置页“查看对话”已设备确认。语音版原文件保留为 `Familiar-0.3.0-arm64-debug-voice.apk`。
- 证据：`.artifacts/android-device/pet-smoke.json`、`pet-geometry.json`、`approval-smoke-pet.log`、`final-pet-boot.json`、`pet-head.png`、`pet-corner.png`、`pet-menu.png`、`pet-reply.png`、`final-pet-settings.png`。本增量仍是 ARM 转译模拟器验收；真 ARM 手机、HyperOS 长时间保活/功耗和完整 Windows 功能对齐继续按上方缺口推进。

## 记忆与技能管理增量（2026-10-19，Codex）

- 手机“设置 → 记忆与技能”现在可直接整理共享记忆与 Skill。界面延续原有纸色和鼠尾草绿，按核心/身份、教训、扩展记忆、日记分组，提供搜索、新建、全文编辑、长度和修订状态；普通笔记仍由 workspace 文件工具管理，不自动加入长期记忆。
- 核心使用原 `memory.files` / `skills.catalog` / `media.assets` 服务，不在 Android UI 或 Kernel 复制存储业务。正文按需读取，不进入轮询快照；公开结果只投影文档/技能字段，不暴露私有根目录、源路径或宿主错误正文。写入必须带 SHA256 revision，共享写队列、原子保存与历史备份继续生效；并发修改时返回 CONFLICT，不静默覆盖。
- 每个文件的草稿在页面切换和返回时保留，保存等待中的新输入不被回调覆盖。冲突时先读取对照，用户可保留草稿合并，或确认采用最新版本。草稿未落盘，界面进程退出会丢失；需先保存。普通文档最多写入 100000 Unicode 字符，大文件只预览前 100000 字且禁用保存；CORE.md 沿用共享 2000 字符限制及敏感凭据处理。
- 技能支持纯文本查看、启停、移除备份、粘贴安装、HTTPS 文档地址安装和选择单份 SKILL.md。HTTPS URL 先标准化，禁止内嵌用户名/密码和锚点；下载仍使用共享服务的 15 秒超时、64 KiB 限制和禁重定向。Android 不支持的内置桌面技能不能安装或启用，技能说明不改变工具权限。
- 文件导入复用 [Android Storage Access Framework](https://developer.android.com/training/data-storage/shared/documents-files) 的既有 ACTION_OPEN_DOCUMENT，不新增存储权限。选择后以附件 ID 读取完整 UTF-8 文本，不使用截断预览；选择只填入草稿，用户点击安装才写入 Skill。已有草稿被替换前确认；移除同样使用默认取消的确认框。正文只用 textContent/textarea，HTML 作为资料显示。
- 原生公开白名单增加十个 library 命令，控制请求最多 1 MiB，足以容纳 100000 Unicode 字符；仍走私有 socket，不经 Binder 大消息。资料操作由各共享服务串行化变更，长技能下载不阻塞 voice.stop 或会话取消。列表使用请求序号避免旧返回覆盖刚完成的启停状态。
- 验证：类型检查、共享核心 **126/126** 和 Windows 构建通过；原有主界面 **19**、媒体 **6**、语音 **3**、宠物设置 **3** 组通过，新增资料 UI **7** 组覆盖草稿隔离/迟到保存、修订对照、完整导入、移除/替换取消、旧列表不回滚，以及 360/390/430/768 布局。证据 `core-tests-library-final.log`、`windows-build-library.log`、`library-ui-final.log` 与 `.artifacts/android-library-ui/result.json`。
- `scripts/smoke-android-library.mjs` 的 **6** 组模拟器验收通过：超过 300 KB 的 Unicode 原生桥写读；实际编辑/冲突/合并；Android 文件选择器导入 39096 字节 SKILL.md 后手动安装/停用；核心进程重启后恢复；取消移除与确认备份原件哈希；安装 APK 与构建哈希一致。末次纯 UI 修订另经浏览器回归和最终设备启动核对。HTTPS 真公网下载未单独设备实测，URL 校验与等待不阻塞停止由核心测试覆盖。
- 本轮临时记忆、技能、备份和 Download 文件清理完毕；选择器导入的未发送附件仍遵循现有媒体库策略（通用孤立附件回收待补）。重启试验断开的无障碍已从系统界面恢复。最终 `final-library-boot.json` 核对核心 ready、常驻 running、悬浮窗 visible、无障碍 granted、语音 off、无当前回复或待批准任务；没有新模型密钥。宠物偏好保持原自由拖动、100% 大小、默认 30 秒闲置收起偏好。
- 交付仍为 `release/android/Familiar-0.3.0-arm64-debug.apk`，SHA256 与尺寸以同目录 README / SHA256SUMS 为准；签名 v2、四个 ARM64 原生库和 ELF/ZIP 16 KiB 对齐。上一份宠物停靠版完整保留为 `Familiar-0.3.0-arm64-debug-pet.apk`。完整 Windows 功能对齐、上下文/高级模型管理、外部笔记、完整日历、关怀/MCP，以及真实 ARM 手机和 HyperOS 后台/功耗验收仍在进行。

## 模型与上下文管理增量（2026-10-19，Codex）

- 模型页面增加目录获取、搜索、点选与手填，以及已保存连接测试。测试复用 llm.chat.test，仅发送固定测试句，不加载聊天/记忆，不产生聊天消息；20 秒以内超时，可主动停止或离页取消。operationId 防止旧取消影响新请求，独立请求通道不堵塞语音停止和核心快照。
- 高级模型参数覆盖温度、Top P、最大输出、上下文窗口、自动压缩百分比、超时、思考模式/强度/预算及缓存，按类型保存草稿，最终由共享 llm.management/validateProfile 校验。模型目录按类型和规范化地址使用已存密钥；Android secrets.set 现在发出 secrets.changed，使共享目录缓存和在途代次失效。改地址、保存/清除密钥和离页都会废弃旧目录结果。
- 聊天标题栏增加上下文入口。读取上次准备请求的估算/计数、预算来源、压缩触发点、保留/已压缩消息和服务报告用量，展示八类交接摘要；原文每页 16000 字符，支持查找和更早记录。用量不含单独预留的工具说明，输入预算包含工具预留；触发点已扣除工具预留量，界面分别说明，不把估算当官方 token 数。
- 摘要和原文按需读取，不塞入主快照；超长摘要有截断说明。原文索引校验会话哈希，跨会话和已删除会话不可读。只展示共享自动压缩结果，不增加另一套压缩引擎或强制压缩入口。
- 129 项共享测试通过（新增模型请求/取消/凭据轮换、上下文重启读取与会话关联、公开结果投影），19 项主 UI、7 组资料 UI、3 组宠物 UI 回归通过；8 组模型/上下文 UI 检查覆盖草稿隔离、延迟结果、密钥清除、纯文本和四种宽度。Windows 构建通过。证据：core-tests-model-final.log、android-model-ui/result.json、windows-build-model.log。
- scripts/smoke-android-model.mjs 在 emulator-5554 上完成 6 组设备检查：目录选型与高级参数、实际请求参数及固定测试句、慢连接取消、真实会话自动压缩、管理页回查、APK 哈希。隔离服务报告窗口 120000、阈值 70%；第 3 轮自动压缩，输入保守估算从第 2 轮 52234 降至 27526，检查点原文跨页可读。服务报告的 4321/128/缓存 1024 是夹具值，不是真实云模型计费数据。
- 首次验收用 60000 窗口/45% 阈值时，单轮大段中文已经高于扣除工具后的压缩阈值，无法靠删除旧轮次满足阈值；共享核心保留原记录并报错。后续按窗口设置调整测试配置，没有关闭保护或手工写入设备检查点。测试脚本已修正取消命令，并先保存脱敏配置以便恢复；最终清理本轮密钥与对话，恢复默认兼容模型档案。
- 本轮不增加 Android 权限或系统 API，沿用此前核对官方文档的原生桥和私有 IPC。最终包仅 ARM64，签名 v2、四库及 ELF/ZIP 16 KiB 对齐；上一份资料管理版保留为 Familiar-0.3.0-arm64-debug-library.apk。最终启动状态见 final-model-boot.json，安装包大小和哈希见 release/android/README.md。
- 完整 Windows 对齐仍在进行：外部笔记、完整日历/提醒、关怀、MCP、更多媒体/语音，以及真实 ARM 设备、真实云服务、HyperOS 长时驻留与功耗仍需实现或验收。
- 最终同一 APK 另重跑 8 组宠物设备流程（pet-smoke.json）：自由拖动、边角吸附/向外滑收头、点按/向内拖展开、闲置定时、进程重启位置恢复、休息/菜单、回复展开/气泡、锁屏移除与亮屏恢复均通过。停靠开关与等待时间恢复测试前设置；强停断开的无障碍服务通过系统可见界面恢复。

## 日历编辑、提醒与外部笔记增量（2026-10-19，Codex）

- 继续复用共享工具注册和审批。新增日程详情、修改、普通事件删除、提醒替换/清空与变更前快照读取；读操作也需批准。批准参数同时带原标题、时间与 SHA256 revision；执行时复查权限和可写日历，核对版本，再用 Provider 批处理断言当前字段与提醒，最后写入并回读。旧版本返回 CONFLICT，不能静默覆盖同步或用户的新修改。
- 按 [Calendar Provider](https://developer.android.com/identity/providers/calendar-provider)、[Events](https://developer.android.com/reference/android/provider/CalendarContract.Events) 和 [Reminders](https://developer.android.com/reference/android/provider/CalendarContract.Reminders) 文档执行：普通事件修改起止时间时检查 ISO 偏移/IANA 时区与 31 天跨度；全天事件保持 UTC 午夜边界；提醒检查日历允许的方法与上限，同时更新 hasAlarm。设备确认提醒表和 hasAlarm 一致，尚未验证系统日历是否实际通知或响铃。
- 重复系列明确使用 scope=series，仅修改标题/正文/地点和提醒；重复例外只读。系列日期变更、系列删除、单次重复实例取消及创建全天/重复日程尚不支持，交由日历应用处理；不把 Instances 的发生时间误作系列起点。
- 每个变更使用 operationId 和规范化参数摘要，参数顺序变化不影响防重；相同编号换内容拒绝。私有 AtomicFile 账本先记录意图和原字段，未知结果不自动重放；主事件/提醒快照可回查，不含完整参会人/邀请，也不提供自动撤销。新编辑账本上限 8 MiB/10000 项，超大事件不截断后冒充可编辑数据。
- 按 [Google NoteIntents](https://developers.google.com/android/reference/com/google/android/gms/actions/NoteIntents) 使用 text/plain、NAME、TEXT 交接标题正文；[Android ACTION_CREATE_NOTE](https://developer.android.com/reference/android/content/Intent#ACTION_CREATE_NOTE) 只约定打开笔记界面，单独列为 blank 模式并拒绝预填内容。只枚举声明对应 Intent 的可用导出界面，批准后复核组件、标签、模式，锁屏/熄屏不启动。没有加入任意分享接收端、私有笔记数据库或新运行时权限。
- 笔记结果为 handoff / saved=false；等待用户在目标应用核对并保存，不能以 startActivity 返回代替保存确认。系统/OEM 可能限制后台启动，结果文案说明未出现页面时先打开灵伴。交接账本仅存内容摘要与状态，重复请求不再次打开界面；没有兼容应用时，本地 files 笔记仍可使用。
- 设备验收定位并修复一处桥接问题：原生正确拒绝冲突，但 TypeScript 通道统一转成 UNAVAILABLE。现在仅放行 CONFLICT / INVALID_INPUT / NOT_FOUND / UNAVAILABLE 固定码，系统异常正文和路径不外泄。类型检查、共享核心 **131/131**、Windows 构建、主 UI **19** 和宠物设置 UI **3** 组通过。
- `scripts/smoke-android-system.mjs` 使用独立本机模型夹具、本轮唯一日历和无网络/持久化的笔记 Activity，验证真实 Provider 创建/读/改/删、防重/冲突、提醒表、全天/重复边界，以及真实笔记标题正文到达、拒绝不交接和重复不重开。测试不是云模型或真实笔记应用保存验收。证据 `system-smoke.json`、`system-note-handoff.png`。
- 同一最终 APK 重跑宠物 **8** 组设备流程，手动外滑和闲置收起、点击/内拖展开、重启恢复、回复气泡及锁屏恢复通过。四边四角/缩放/旋转单独记录于 `pet-geometry.json`。此前其他媒体、语音、资料/模型设备验收沿用历史证据，不声称本轮全量重跑。
- ARM64 包的签名、四个原生库与 ELF/ZIP 16 KiB 对齐通过；尺寸/哈希见 release/android/README.md。模型管理版保留为 Familiar-0.3.0-arm64-debug-model.apk。完整 Windows 对齐仍在继续：完整重复日历、邀请/提醒实响、真实笔记应用、关怀、网络集成/MCP，以及真实 ARM 手机、真实云服务和 HyperOS 长时保活/功耗仍待开发或验收。
- 最终 `final-system-boot.json` 核对安装哈希一致、核心 ready、常驻/悬浮窗正常、无回复/待批准任务、语音未运行、所有当前模型档案无密钥。测试日历已按唯一名称与编号清理，笔记靶场已卸载；私有防重账本保留本轮测试操作记录。停靠恢复原自由拖动、100% 大小、默认 30 秒闲置收起偏好，旋转恢复 lock 0；强停造成的无障碍停用经系统可见界面恢复。最终 7 组系统、8 组宠物交互、6 组几何检查均针对 SHA256 `2c65bb99cb6d3f9650afeff0d5c8d235bcf2df4322ab549fb8455257b74d622c` 的安装包。

## HTTP MCP 网络工具增量（2026-10-19，Codex）

- 为后续关怀/地图复用桌面的数据源，先装配共享 MCP 服务。Android 只启用 HTTP，Windows 保留默认 stdio 与安装能力；手机不注册 mcp_install。高德/Exa 预置项默认停用，用户可在“设置 → 网络工具 · MCP”编辑、新增、连接、取消连接、断开或移除。没有额外 Android 运行时权限。
- 沿用已安装的 `@modelcontextprotocol/client` 2.0.0。服务只读标记按 [MCP ToolAnnotations 文档](https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations) 处理为提示；Android 未知服务不会单凭 readOnlyHint 降低工具审批类别。已知高德/Exa 只读工具与 GitHub 业务范围复用项目已有策略，本轮未访问这些真实云端服务。
- 管理桥只投影公开 HTTP 配置、版本、连接/密钥是否存在和工具名；密钥不返回 WebView。地址必须是 HTTPS 或回环 HTTP，不能把密钥直接填进 URL。请求头/查询参数密钥复用 Android 加密秘密存储，按服务 ID、端点和鉴权隔离。当前地址的清钥和移除不会删除历史端点的密钥；切回原配置可以单独清除。
- 配置保存/移除增加版本比较；启用服务的 Agent 审批也比较批准前的版本。修改配置、密钥、停用或移除会取消正在建立的连接并撤销工具；旧工具即使后来批准，执行前仍须核对连接、配置和密钥。取消按 operationId 归属，不阻塞快照或聊天取消。
- 连接目录有 45 秒总期限、最多 32 页/256 工具，拒绝重复工具名、循环分页和超限 schema；这些目录边界不等价于 SDK HTTP 响应体有独立总字节上限。工具名按纯文本展示。页面有每服务草稿、迟到保存保护、失败/冲突反馈和移除确认；离开页面清空未保存密钥并取消连接。断开只影响本次运行，启用的服务会在核心重启时自动连接。
- 测试：类型检查与共享核心 **133/133**、主界面 **19**、MCP 界面 **8**、宠物设置 **3** 组通过，Windows 构建通过。核心 MCP 测试覆盖真实 HTTP、审批拒绝/批准、图片、旧工具与启用审批失效、凭据范围、慢连接取消、重复目录拒绝、查询参数鉴权及核心重建。
- `scripts/smoke-android-mcp.mjs` 在 emulator-5554 的实际 ARM64 包上执行 **7** 组检查：真实页面/握手/密钥不回填、共享 Agent 工具批准/拒绝、图片进入后续模型请求、等待期间修改配置拒绝旧启用审批、慢连接取消/旧版本保存冲突、进程重启自动连接、安装哈希一致。使用本机 MCP 和模型夹具，无真实云服务调用；清理本轮新增配置、所有访问过的测试凭据范围及测试会话，恢复原模型设置。
- 交付包 `Familiar-0.3.0-arm64-debug.apk` 为 **268529804** 字节，SHA256 `4a19a7f8b1d1b680c438feb3594deaa727f24181d0cea82abf6851d65acb6062`；v2 签名、四个 ARM64 原生库与 ELF/ZIP 16 KiB 对齐通过。上一份日历笔记包保留为 `Familiar-0.3.0-arm64-debug-system.apk`。MCP 证据 `mcp-smoke.json`、`mcp-after.json` 与 `mcp-settings.png`，最终运行状态 `final-mcp-boot.json`。
- 关怀/定位/天气仍待装配；真实云 MCP、OAuth、飞书专用工作流、完整日历/提醒、更多媒体与语音、真实 ARM 手机、HyperOS 长时驻留和功耗继续保留为缺口。本次不宣称 Windows 功能等价。
- 同一最终 APK 已通过 **8** 组宠物设备回归，包括自由拖动、边角停靠、外滑收成 48dp 小脑袋、点按/内拖展开、闲置开关/定时、重启位置恢复、休息/菜单、回复展开与气泡、熄屏移除和亮屏恢复。最终 `final-mcp-boot.json` 确认核心 ready、常驻/悬浮窗运行、无待批任务/活动回复/活动语音；全部当前模型档案无密钥，MCP 仅剩停用且无密钥的高德/Exa 预置项。测试前的宠物设置已恢复，无障碍经系统可见界面恢复；最终包哈希与安装包一致。

## 日常关怀、提醒与一次定位增量（2026-10-19，Codex）

- “设置 → 日常关怀”接入共享 `companion-care` 的时段问候、自定义提醒、手动预览与停止生成，Android 装配共享 `amap-care` 和独立位置适配器。历史、模型、日程槽去重和气泡继续由既有插件负责；关闭设置页不会终止手动发起的问候。修改关怀设置、切换会话/模型或停止常驻会取消旧生成，语音活动时暂停自动关怀并拒绝手动预览。
- 自动关怀每 15 秒检查一次，仅在常驻服务/宠物可见、屏幕亮且未锁定、控制器不在前台、没有聊天/语音且未静音时考虑执行，还遵循共享核心最近互动后的静默期。普通关怀夜间 22:00–08:00 静默、每天最多五次；自定义提醒有 30 分钟到期窗口及至少一分钟间隔。调用模型前持久化已使用时段，失败和重启不反复调用。它不是系统精确闹钟；进程回收、休眠或其他静默条件可能延迟或错过提醒。
- 根据 [Android 前台位置权限指南](https://developer.android.com/develop/sensors-and-location/location/permissions/runtime)，只在用户进入该功能后请求大致位置权限，随后仍需点击刷新；不申请后台位置。原生 `NativeLocation` 使用 AndroidX `LocationManagerCompat.getCurrentLocation`，限制一次请求、15 秒期限，取消、失焦或锁屏后释放采集；提前取消同样有效。权限与系统定位开关在使用时重新检查，系统设置入口真实可用。
- 获取的位置只在核心内存缓存十分钟，过期、撤权、关闭定位或进程重启后不可继续使用。公开页面仅返回时间、精度和模拟标记，不返回坐标；私有检查/导入命令不在 WebView 公开白名单。位置请求绑定配置版本，旧请求不能把位置写入后续的新配置。
- 附近建议复用原高德数据源与已配置凭据；用户开启该项后才允许把缓存位置发送给高德。查询半径考虑精度，误差超过 500 米不估算步行时间，系统模拟位置不外发。没有用估计文本冒充真实店铺/天气。真实高德服务与天气尚未验收，也没有新增独立自动天气播报。
- 页面沿用奶油纸底和鼠尾草绿，支持提醒增删/启停、版本冲突提示、保存期间继续编辑、轮询不覆盖草稿、定位取消、生成状态与停止。核心 **137/137** 测试、主界面 **19** 项、关怀界面 **7** 组通过；关怀核心四项在最终修改后单独复跑通过，最终类型检查、Kotlin 编译和 Windows 构建通过。记录分别为 `.artifacts/android-device/core-tests-care.log`、`care-core-final.log`、`main-ui-care.log`、`care-ui.log`、`typecheck-care-final.log`、`care-kotlin.log`、`windows-build-care.log`。
- `scripts/smoke-android-care.mjs` 在最终 APK 上通过 **7** 组设备检查：页面保存/真实共享模型与历史、慢请求取消、版本冲突和私有导入保护、前台大致位置/原生回调及两种取消、停服务/锁屏不生成及恢复后提醒、同槽去重、重启持久化与位置缓存清除。证据 `care-smoke.json`、`care-device-final.log`。另以独立到期提醒确认仅请求模型一次且真实 `FamiliarSpeech` 窗口可见，证据 `care-bubble-proof.json` 与 `care-reminder.png`。模型为本机隔离服务，位置由临时系统模拟提供者产生，不表示真实云模型或真实定位精度通过。
- 测试结束清理本轮对话、提醒、模型配置与临时模拟提供者，恢复 shell 模拟位置 app-op，撤销测试新增的大致位置权限；历史防重记录按原存储策略保留。只检查当前 fused/gps 提供者是否仍模拟，不把系统位置事件日志或被动历史缓存误判为活动模拟提供者。无障碍通过可见系统界面恢复；交付时重新开启常驻，`final-care-boot.json` 确认核心 ready、服务/悬浮窗运行、无活动回复/语音/关怀/待办、所有当前模型档案无密钥，MCP 仅剩停用且无密钥的预置项。位置权限未开、缓存为空。
- 交付文件 `release/android/Familiar-0.3.0-arm64-debug.apk` 为 **268553624** 字节，SHA256 `3518383abb45f3a867afd547c7a5a4193ae5c41130a9d5148983f28a59ca5c49`，与模拟器安装文件相同。v2 签名、四个 ARM64 库及 ELF/ZIP 16 KiB 对齐通过；上一份 MCP 包保留为 `Familiar-0.3.0-arm64-debug-mcp.apk`。本轮延用前述宠物吸附/小脑袋交互及其八组设备证据，没有声称全部旧功能重新验收。
- 完整 Windows 对齐尚未结束：真实 ARM 手机与 HyperOS 长时保活/功耗、真实云模型与地图/天气、OAuth/专用业务流程、完整重复日历/邀请/提醒实响、本地音色/唤醒/Live、相机实拍及复杂手机任务仍需后续开发或验收。

## 自绘控件触摸手势增量（2026-10-19，Codex）

- 为完善无障碍手机控制，新增 `android_gesture`，支持节点内相对坐标的点击、长按和滑动。既有 `android_action` 的节点操作继续优先使用；自绘控件没有 ACTION_CLICK 时可使用手势。原生通过 [AccessibilityService.dispatchGesture](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService#dispatchGesture(android.accessibilityservice.GestureDescription,%20android.accessibilityservice.AccessibilityService.GestureResultCallback,%20android.os.Handler)) 与 `canPerformGestures` 声明实现，等待完成/取消回调，不把 API 接受请求当作业务成功。
- 共享 Agent 注册、参数验证和逐步批准负责授权，Kotlin 只拥有触摸宿主。公开 WebView 白名单没有任意手势/取消入口；操作编号由核心生成，模型不能指定。`android_screen` 提供节点 enabled/password/scrollable 字段、相对坐标说明及 120 秒寿命；执行检查当前服务、亮屏/锁屏、应用/窗口、枚举范围内的可访问内容与目标指纹，防止旧引用误触。当前只支持主显示屏，不操作本应用、系统设置、权限和安装确认页面。
- start/end 为节点内 0–1 坐标，原生再校验数值、目标边界与路径。点击 80ms、长按 700ms、滑动 100–1500ms；手势路径不能越过目标节点/窗口，不能被更高层的其他窗口截获。审批通过后先短暂移开自身宠物、气泡与审批窗，再验证并发出一次手势；所有终态恢复宠物，不改变用户停靠偏好。每次操作消费观察引用，之后必须重新观察。
- 回传 dispatched、status（completed/cancelled/rejected/unknown）、requiresObservation。completed 只证明系统触摸回调完成；应用可能拒绝触摸，模型仍须检查页面。取消会阻止尚未发出的手势；已发出的单次触摸不能撤回，按有界时长结束，不注入第二次假触摸来取消，不在未知结果时重试。原生超时取消准备阶段，迟到主线程工作不能继续注入。
- 增加工具后发现默认 32768 估算窗口的图片输入被工具元数据挤出预算。Android 现以 `createMediaInput({desktopCapture:false})` 排除原本不可执行的 desktop_snapshot，保留真正可用的 android_screenshot；精简日历/截图重复说明，参数约束和审批语义不变。Windows 默认媒体装配保留；没有放宽预算或提高测试窗口来掩盖问题。附件测试还改为同时等待服务端收到请求与会话完成，避免排队启动前的空闲被误认为结束，失败时显示隔离会话状态。
- 类型检查、Kotlin 编译、共享核心 **138/138**、Windows 构建通过，记录 `gesture-typecheck.log`、`gesture-kotlin.log`、`gesture-core-all.log`、`gesture-windows-build.log`。一次并行核心回归出现旧会话保存错误，随后该文件 **15/15** 单独复核和完整回归均通过；未据此猜测原因或修改存储实现，单独记录 `gesture-agent-recheck.log`。
- 最终 ARM64 APK 在 emulator-5554 通过 **12** 项手势设备检查，见 `gesture-smoke.json`（10项）与 `gesture-smoke-extra.json`（2项）：原节点点击不能操作无点击动作的画布；实际点击/长按/滑动到达自绘控件；拒绝零触摸；目标变化、换窗、旧引用重放、熄屏阻止执行；批准前取消、批准后尚未注入时取消、其他窗口遮挡均阻止触摸。测试使用无网络/无持久化的 GestureFixtureActivity 与 GesturePad，计数只由 MotionEvent 改变。批准/拒绝通过卡片实体触摸；锁屏场景通过产品 task.respond 提交批准以验证原生拒绝，不声称用户在锁屏上完成确认。
- 同一 APK 的宠物 **8** 组设备回归通过，覆盖自由拖动、边角吸附、外滑/闲置收起、小脑袋点击/内拖展开、重启位置恢复、长按菜单、回复展开和气泡、熄屏/亮屏恢复；见 `pet-gesture-regression.log` 与更新后的 `pet-smoke.json`。手势效果图 `gesture-swipe.png`。其他媒体/语音/关怀/日历的旧设备证据继续保留，未全量重跑。
- 当前 APK **268570720** 字节，SHA256 `2c4a5be5d9d12e3cfc4cc42d706a68be876af264ac73b1ef758294f0daae7c1c`；v2 签名、四个 ARM64 库及 ELF/ZIP 16 KiB 对齐通过。上一份关怀版保留为 `Familiar-0.3.0-arm64-debug-care.apk`。本轮隔离模型/测试会话已恢复清理，测试 APK 已移除；最终状态与安装哈希见 `final-gesture-boot.json`。
- 模拟器只读核查没有 TTS_SERVICE 或 RecognitionService，因此本轮没有把系统音色/识别标记为可用。真实云模型、多步真实应用任务、系统语音引擎、ARM 真机、HyperOS 驻留与功耗等完整对齐项目仍需继续推进。

## 系统本地朗读增量（2026-10-19，Codex）

- Android `voice.local` 从不可用占位替换为真实系统 TTS 适配，继续使用共享 `voice.api`、缓存、`voice.session` 与 NativeAudio。遵循 [TextToSpeech](https://developer.android.com/reference/android/speech/tts/TextToSpeech) 的初始化和文件合成接口、[UtteranceProgressListener](https://developer.android.com/reference/android/speech/tts/UtteranceProgressListener) 完成/失败/停止回调，以及 [Voice](https://developer.android.com/reference/android/speech/tts/Voice) 的联网与未安装标识；Manifest 增加 TTS_SERVICE 包可见性查询，不新增麦克风或存储权限。
- NativeTts 绑定系统首选引擎（未选首选时查询已安装引擎），列出最多 500 个已安装且无需网络的音色。默认音色仅使用引擎实际默认；默认不可本地合成时要求另选音色，不代选其他语言。音色编号绑定引擎包、版本、安装更新时间和音色名；每次朗读在缓存读取前检查引擎/音色仍可用，卸载后不能仅靠旧缓存继续宣称本地语音可用。
- 原生合成为可轮询的单任务，不占用 IPC 等待长音频；使用 UUID、45 秒期限、24 MiB 文件上限、早到取消记忆和私有 tts-inbox 文件。只在完成回调后读取 WAV，成功/失败/取消均清理文件。共享 4096 字符上限按 Android 4000 UTF-16 单元拆段，不丢尾部或拆开代理对；只拼接格式一致且通过 RIFF 边界检查的 PCM 数据。系统引擎不直接扬声播放，现有播放器统一管理音频焦点、结束回执和停止通知。
- “设置 → 语音连接 → 朗读服务”新增设备本地朗读和音色刷新；保持 Claude 纸片风格，速度、自动朗读沿用原设置。system 只用于 TTS，STT 继续走原服务。云参数隐藏，切换清除未提交密钥，保存本地配置不修改云密钥；草稿与原云音色分开保存。没有引擎或语音数据时明确说明，不自动转向云服务。
- 使用 [eSpeak NG 官方 1.52.0 发布包](https://github.com/espeak-ng/espeak-ng/releases/tag/1.52.0) 临时测试：APK 10446659 字节，下载文件 SHA256 `741b46abf84d843f9b0cce80136f60ffee9b9fe591601b9701aa2a9ff99c9ddf`，签名证书 SHA256 `a1f448294e32c782725cf74949e2888441e2e1eb130ab355ba3f89507a9296da`，签名校验通过。这是本地记录的校验值，不是发布方单独公布的哈希。仅向 emulator-5554 安装其 ARM64 库，通过引擎公开 INSTALL_TTS_DATA 入口解压内置语音数据；未将引擎分发进 Familiar APK。
- `scripts/smoke-android-local-voice.mjs --remove-test-engine` 完成 **9** 项设备检查：实际 133 个音色目录，私有任务通道不可从公开 WebView 调用，中英文 WAV 实际合成/播放，缓存播放停止，长文本取消与文件清理，进程重启，实际界面音色加载，卸载引擎后相同文字不能绕过缓存检查。WAV 为 22050 Hz / 单声道 / 16-bit，非零音频数据、MediaPlayer 结束回执与服务释放均验证；未做主观音质或发音准确率评测。设备测试没有调用隔离云 TTS 端点，原模型/语音配置、测试会话及本轮缓存已清理恢复。
- 浏览器语音检查 **4** 组通过，覆盖既有草稿/连续语音/全局停止、本地音色选择与云密钥隔离、四种宽度。实际截图 `tts-local-ui.png` 在音色目录和中文名称加载完成后采集。记录 `tts-ui-final.log`、`.artifacts/android-voice-ui/result.json`。
- 全量回归暴露 Windows 配置/文件原子替换的 EPERM，单独复查通过但并行回归在另一文件再现。新增共享 replaceFile：只对 Windows EPERM/EBUSY 同一路径最多四次延迟重试（合计 750ms），不删除目标；用于配置、文件之家和语音缓存，其他平台仍只调用一次 rename。新增真实 .NET 文件锁验收，证明短锁释放后保存成功、持续锁失败仍保留原文；不把本机防护软件当作已证实原因。修复后类型检查、**141/141** 核心测试、Windows 构建通过，日志 `tts-storage-lock.log`、`tts-core-all-fixed.log`、`tts-windows-build-final.log`。
- 本增量不意味着 Windows 功能已经全部等价：系统识别/唤醒/Live、真实云端及专用办公流程、完整重复日历与实际提醒、相机实拍、复杂手机任务、真实 ARM 手机与 HyperOS 驻留/功耗仍待开发或验收。模拟器卸载临时引擎后应显示无本地音色；实际手机需已安装系统 TTS 引擎及语音数据。
- 最终交付 `Familiar-0.3.0-arm64-debug.apk` 为 **268605696** 字节，SHA256 `c55a73df1361c8cde36b47093abf6f0fb69da1f3257ad0e779606fdf7cfbf380`。v2 签名、四个 ARM64 原生库及 ELF/ZIP 16 KiB 对齐通过，模拟器验收记录 `tts-smoke.json` 同时记录实际安装 APK 哈希；最终回归日志 `tts-device-release.log`。上一份手势包保留为 `Familiar-0.3.0-arm64-debug-gesture.apk`。最终常驻、权限、语音与清理状态见 `final-tts-boot.json`。

## PDF / Word 附件增量（2026-10-19，Codex）

- Android 系统文件选择器增加 PDF 与 Word DOCX，仍使用 [Storage Access Framework / ACTION_OPEN_DOCUMENT](https://developer.android.com/training/data-storage/shared/documents-files)，只读取用户选中的 URI，不新增存储权限。原生层负责有界读取、私有暂存和 MIME 交接；解析业务由新 `document.text` 插件负责，Windows 同时改用该插件，避免两套文档解析规则。
- 复用 [PDF.js 的文本提取接口](https://github.com/mozilla/pdfjs-dist/blob/master/lib/test/unit/api_spec.js) 和 [Mammoth extractRawText](https://github.com/mwilliamson/mammoth.js#raw-text)。每份文档使用可终止的 Node 工作线程，PDF CMap 和标准字体数据随包提供，不下载远程字体；使用纯 JavaScript DOMMatrix 兼容层，Android 无需额外原生 Canvas 库。没有执行 PDF 脚本、Word 宏、HTML 或外部文件读取。
- 每份原文件最多 12 MiB；PDF 最多 100 页，最终提取文字最多 400000 UTF-8 字节。DOCX 先流式验证 ZIP：最多 1024 条目、单条解压 16 MiB、合计 48 MiB；同名条目、加密和错误大小拒绝。工作线程单次 20 秒、Android 一批导入 22 秒，设置 V8 老生代 192 MiB/新生代 32 MiB 限制（不等于进程总内存硬上限）；取消/插件销毁终止线程。文件导入不占主 API 串行队列，快照和停止操作仍可响应。
- 文档作为带“（提取文字）”标记的纯文本附件进入原媒体库，复用预览、会话、模型负载与历史恢复；格式、图像和版式不保留，扫描 PDF 无文字时明确提示改用图片。选择本身不调用模型，点击发送后才把文字交给当前 Provider。空文档、损坏、加密、超页数/文字量与超时有分别提示，失败保留既有草稿和附件，清理本次暂存。
- 核心 **144/144** 通过（`documents-core.log`）；包含真实中文 CMap、Word 表格、加密 PDF、解压限制、线程超时/取消/销毁及导入期间快照响应。附件 UI **7 组**通过；Windows 实际 Electron 验收 **5 组**通过，其中 PDF/DOCX 经过产品文件选择能力提取（`documents-windows-device.log`）。
- 模拟器 **6 项**通过（`documents-smoke.json` / `documents-device.log`）：真实系统选择取消、ARM64 Node 工作线程解析、中文预览、空页/损坏/101 页/加密文档拒绝、真实 Provider 请求文字负载、进程重启后历史和预览恢复。Provider 使用隔离本机服务，这不证明真实云端模型质量。测试生成文档不含用户资料，测试会话和模型配置恢复；UI 截图 `documents-preview.png`、`documents-chat.png`。
- APK **271213841** 字节，SHA256 `b6b091605c8d2d7451472970b7297c2f24b02033cd5c3122a9b1b77692ce07df`；实际安装包与构建包一致，v2 签名、四个 ARM64 库与 ELF/ZIP 16 KiB 对齐通过。原本地朗读包保留为 `Familiar-0.3.0-arm64-debug-tts.apk`。完整 Windows 对齐及真实 ARM/HyperOS/功耗验收继续保持未完成状态。
- 本轮补做此前受自动审批超时影响的宠物 **8 项**设备检查，全部通过（`documents-pet-device.log` / `pet-smoke.json`）。覆盖吸附关闭、边角停靠、向外滑收成 48dp 头像、点击/向内拖展开、闲置开关与计时、重启位置、菜单、回复展开及熄屏/亮屏。最终 `final-documents-boot.json` 确认当前 APK 与交付包哈希一致、核心 ready、常驻 running、悬浮窗 visible、无障碍恢复 granted、原模型/语音/宠物设置与会话集合恢复，无活动任务或录音，文档暂存为空。
## 离线关键词引擎准备（2026-10-19，当时尚未开放语音唤醒）

- 新增 `OfflineKeywordDetector`，采用 sherpa-onnx v1.13.8 的官方 ARM64 JNI / ONNX Runtime 与 `zh-en-3M-2025-12-20` chunk-16 模型。来源及使用方式见 [官方关键词文档](https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html)。JNI Kotlin 接口保留上游完整字段，并配置 R8 保留规则。引擎本身不打开麦克风、不访问网络，也没有新增公开 WebView 调用。
- 构建前运行 `scripts/prepare-android-wake.mjs`：固定两个官方归档的 SHA-256 和长度，校验六个上游 Kotlin 文件，复制两个 ARM64 原生库及 5448043 字节模型/词表。模型文件逐项写入摘要清单，交付 APK 再核对模型摘要、依赖、ABI 与 ELF/ZIP 16 KiB 对齐。软件、模型来源声明以及 ONNX Runtime 的许可证/第三方声明一起入包；官方样本仅放测试 APK，不进入主 APK。
- 检测器由单个线程拥有，接受每块不超过 250ms 的单声道 PCM16LE。支持 8/16/24/48 kHz 输入，但同一条流不能中途改变采样率。词表替换创建新流；默认词表为空，避免上游合并逻辑残留隐藏的固定唤醒词。传入原生的标签使用内部编号，原文字不能注入 `/ @ # :` 等关键词语法。取消、重复释放、流完成后拒绝写入和线程检查均有设备验证。
- `scripts/smoke-android-keyword-engine.ps1` 在 emulator-5554 上通过 **4 组真实 ARM64 JNI 模型测试**：中英官方样本、与现有 Node 库同进程加载、静音、替换词表不误保留旧词、24 kHz 重采样、无效输入、取消/重复释放、标签隔离和线程所有权。证据为 `wake-engine-smoke.json`、`wake-engine-device.log`；测试包在结束后移除。它是预录音回放，不代表真人麦克风、噪声环境、误唤醒率或功耗验收。
- 完整 APK 为 **302601481** 字节，SHA-256 `aae2afb5861dba0818d618d5a13c270e1326e59f6d00a450b860e29ed6a9564b`；v2 签名、六个 ARM64 库及五个模型/词表资源检查通过。构建日志 `wake-full-build.log` 的首次清单校验因 PowerShell 运算符优先级失败，校验脚本修正后对同一 APK 独立复验通过，未忽略失败项。上一份文档包保留为 `Familiar-0.3.0-arm64-debug-documents.apk`。
- 同一主 APK 完成 **8 组宠物设备回归**，证据 `wake-pet-device.log` / `pet-smoke.json`：自由拖动、边角吸附、外滑收成 48dp 小脑袋、点击/内拖展开、闲置开关与计时、重启恢复、菜单/气泡和熄屏恢复。本轮没有修改宠物交互规则。最终状态记录 `final-wake-foundation-boot.json`。
- **尚未接入 `voice.wake`、持续监听开关、自定义文字转音素、通知停用及唤醒后的对话交接。** Android 当前仍需手动开始语音，不能把底层测试写成“已支持语音唤醒”。后续沿用 `NativeAudio` 的唯一录音所有者与共享 `voice.session`，用户必须在前台明确开始；停止通知、撤权、焦点丢失和进程重启后不自动重开麦克风。依据 [Android 麦克风前台服务规则](https://developer.android.com/develop/background-work/services/fgs/service-types#microphone) 继续集成；真实 ARM 手机及 HyperOS 长时驻留、功耗仍未验收。

## 离线唤醒待机接入（2026-10-20，Codex）

本节取代上一节“尚未接入”的当前状态，保留上一节作为底层交付记录。新增前台主动开启的离线关键词待机，继续使用共享 voice.session / voice.api / 会话插件，NativeAudio 仍是唯一麦克风所有者。

- 设置 → 语音连接提供允许唤醒、关键词、灵敏度、保存和开启待机。默认关闭；保存、授权和重启都不开始录音。启动要求已配置转写、主模型和朗读。待机期间绑定会话并锁定冲突设置；全局状态条和常驻通知可停止。
- Activity 校验真实窗口焦点、亮屏、未锁定并写入五秒有效的前台时间；不能从后台伪造网页参数启动。原生服务使用 microphone 前台类型；租约贯穿唤醒、转写和播放交接，使主动开启的会话能在退到桌面后继续。遵循 [Android 麦克风前台服务规则](https://developer.android.com/develop/background-work/services/fgs/service-types#microphone) 及 [后台启动限制](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)。没有开机启动录音或利用无障碍绕过麦克风规则。
- 1–8 个中文/常见英文短语，每个最多 40 字符；未填时使用伙伴名。中文使用 pinyin-pro 3.29.5（MIT）在本机编码，英文使用固定模型归档中的 en.phone。音素逐个对照模型词表；不支持的字符和未收录英文拒绝保存。相关词表及许可证均打包并校验摘要。
- 待机音频只在内存与本机检测器处理，未命中不发音频网络请求。命中后最多保留两秒前文，整段最多八秒，静音结束后交给已配置 STT；转写去掉唤醒词，再由共享对话和朗读处理。过长片段停止并提示，不发送截断指令。此能力不是全离线聊天；识别、模型及云朗读仍使用用户配置的服务，UI 已说明。
- 租约和监听操作编号只在内存保存。全局停止、通知停止、常驻关闭、焦点丢失和音频错误都会撤销租约；晚到初始化/PCM 不恢复录音。进程重启仅恢复配置，需要用户再次开启。
- 核心 **147/147**、语音唤醒 UI **6 组**、真实设备待机生命周期 **7 组**通过。证据：`wake-core-full.log`、`.artifacts/android-wake-ui/result.json`、`wake-device-smoke.json`。设备检查包括真实 AudioRecord、退到桌面、通知实体按钮停止、后台启动拒绝、立即停止、焦点丢失及重启；待机请求记录为空。
- 隔离设备回放 **1 组**通过：实际 ARM64 关键词模型 → 私有 IPC → Android Node 核心 → HTTP STT/模型/TTS 夹具 → 原生文件播放 → 后台继续监听 → 停止与旧事件隔离。测试与主应用均 targetSdk 36，运行环境为 API 34 ARM 转译模拟器；固定样本替代麦克风输入，不在产品添加测试命令。`wake-replay-smoke.json` / `wake-replay-device.log` 记录一次转写、一次模型和一次朗读。测试包结束后移除。
- 原有语音设备回归 **6 组**通过，覆盖真实录音、草稿、转写取消、PCM/缓存播放、通知停止与音频焦点；`wake-voice-regression.log`。Windows 构建通过（`wake-windows-build.log`）。真实人体麦克风唤醒率、噪声、实际云服务、真实 ARM 手机、HyperOS 驻留和功耗尚未验收。
- ARM64 主 APK 为 **303912331** 字节，SHA-256 `b1ca0354b7b6881742b0248d322ddd1b092365ff7e56c07fd002e732d1d3c856`。v2 签名、六个原生库、五个模型资源、三份编码资源/许可证及 ELF/ZIP 16 KiB 对齐通过；主 APK 无样本录音。上一份底层准备包保留为 `Familiar-0.3.0-arm64-debug-wake-engine.apk`。本增量不等于完整 Windows 功能对齐完成。
- 当前主 APK 的宠物设备回归 **8 组**全部通过（`wake-integrated-pet.log` / `pet-smoke.json`）：自动边角吸附、外滑收成 48dp 小脑袋、点击/内拖展开、独立闲置开关与计时、重启位置恢复、菜单、回复展开及熄屏恢复。设置入口仍为“悬浮宠物与停靠”，吸附默认关闭，闲置延迟默认 30 秒、可调 10–300 秒。
- 最终 `final-wake-integrated-boot.json` 确认安装包与交付包哈希一致，核心 ready、常驻 running、悬浮窗 visible、无障碍 granted。原模型/语音/唤醒/宠物设置与会话集合恢复；无活动录音和语音服务，两种临时测试包均已移除。已复制至 `release/android/Familiar-0.3.0-arm64-debug.apk`，仅本地交付，没有提交或上传。

## 系统听写交接增量（2026-10-20，Codex）

- 新增“系统语音输入”，通过官方 [ACTION_RECOGNIZE_SPEECH](https://developer.android.com/reference/android/speech/RecognizerIntent#ACTION_RECOGNIZE_SPEECH) 和 Activity 结果机制使用手机已有的识别界面，无需配置灵伴的转写 API。清单只增加针对该 Action 的包可见性查询，没有新增 Android 权限。入口依据实际接收能力显示；识别应用可能联网，UI 明确说明。
- 选择一次听写交接的依据：[SpeechRecognizer](https://developer.android.com/reference/android/speech/SpeechRecognizer) 不适合作持续识别；[EXTRA_AUDIO_SOURCE](https://developer.android.com/reference/android/speech/RecognizerIntent#EXTRA_AUDIO_SOURCE) 也可能被接收引擎忽略并改用麦克风。因此没有把不确定的文件转写直接接入既有 PCM/STT 流程；已有连续语音、离线唤醒和用户配置保持原有语义。
- 前台启动再次核对焦点、亮屏/解锁、已有选择器、语音/唤醒占用及会话存在。系统界面负责听写与取消；返回首条候选后追加到原会话草稿，不执行其中的 HTML，不自动发送消息。取消和空结果保留原稿，超过 8000 字符明确拒绝。应用侧桥投影只返回 text；没有把接收应用的附加字段传给界面。此模式不启动灵伴自身录音服务。
- **148/148 核心测试、5 组语音 UI、6 组系统听写设备检查**通过；类型检查和 Windows 构建通过。证据：`system-speech-core-final.log`、`system-speech-ui.log`、`system-speech-smoke.json`、`system-speech-device.log`。设备检查使用真实 Intent 分发和 Activity 结果回调，涵盖无接收端、返回/取消/空值、超长拒绝、已有 AudioRecord 时拒绝、后台拒绝及卸载后能力回落。浏览器另验证切换会话后的草稿归属及四种宽度。
- 首次并行全量检查中的文档测试进程异常退出，未产生明确诊断；不能归因为已证实的产品问题。随后单独文档测试 **2/2**（`system-speech-documents-check.log`）和完整 **148/148** 重跑通过。没有删除或跳过该测试。
- 当前模拟器没有真实系统识别引擎；设备测试使用独立接收 Activity 返回固定文字，结束后卸载。该证据证明交接/回填行为，不证明真人识别质量或离线能力。系统引擎连续转写、Live、真实云业务以及真实 ARM/HyperOS 长时间驻留和耗电仍未完成全部验收。
- 主 APK **303912423** 字节，SHA-256 `07ce589601f773ec3503be414739491009c5d281cf6715cffcbd285ada2ba64b`；安装包摘要一致，v2 签名、六个 ARM64 库、模型/编码资源与 ELF/ZIP 16 KiB 对齐通过。上一份唤醒集成包保留为 `Familiar-0.3.0-arm64-debug-wake.apk`。上一版唤醒和宠物设备记录保留，本轮没有把那些记录作为新包全量重跑证据。
- 最终 `final-system-speech-boot.json` 确认核心 ready、常驻 running、悬浮窗 visible、无障碍 granted；模型/语音/唤醒/宠物配置与会话集合恢复，无活动录音或语音前台服务，无临时测试包。交付包和实际安装包摘要一致；没有提交或上传。

## 实时语音与连接阶段保活增量（2026-10-20，Codex）

- 新增独立 Live 表单及 `voice.live.save`，复用桌面已有 `voice.api`、`voice.session/live.ts` 的 OpenAI Realtime 与 Gemini Live 适配。实时模式要求主模型与 Live 配置，常规模式要求 STT/主模型/TTS；录音转文字和单条消息朗读分别仍使用 STT/TTS。普通语音设置保存保留已选模式，不再强制改回常规模式。Live 密钥按协议与地址隔离，在原生加密存储中保存，只回传是否配置。
- 实时服务通过 `ask_familiar` 交给原主模型回答，原有会话、记忆、工具与批准流程仍是唯一业务入口；没有新增独立手机 Agent。配置草稿抗轮询，密钥保存后清空输入，配置锁定与全局停止沿用现有交互。保存、授权或重启均不开始录音。
- 修复握手期间的麦克风服务生命周期：在用户前台启动时建立 microphone 类型服务，但直到 WebSocket 配置完成才打开 AudioRecord。连接、思考与播放阶段保留会话的麦克风服务资格，支持退到桌面继续；状态命令携带 epoch，通知停止后的旧状态不能重新保活。普通语音启动也在 Activity 边界核验焦点、解锁与选择器占用。
- 官方依据：[Android 前台服务后台启动限制](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)、[OpenAI Realtime 客户端事件](https://developers.openai.com/api/reference/resources/realtime/client-events)、[Gemini Live WebSocket](https://ai.google.dev/api/live)。本轮没有更换现有实时协议或推荐模型；账户实际可用的模型和音色由用户配置。
- **149/149 核心、6 组语音 UI、6 组 Live 设备检查**通过。核心验证两种协议、独立凭据、缺配置在录音前拒绝、重复工具防重、音频转发及取消；设备使用实际 ARM64 Node、AudioRecord、AudioTrack 和本机 WS/HTTP 夹具。覆盖连接中退桌面、准备阶段零音频、模型代理、播放回执、通知停止、断线、握手未完成停止、主模型取消及加密凭据重启恢复。证据：`live-core.log`、`live-ui-final.log`、`live-smoke.json`、`live-device-final.log`。
- 原有语音设备回归 **6 组**及唤醒待机回归 **7 组**通过（`live-voice-regression.log`、`live-wake-final.log`），类型检查、Windows 构建通过。未把此前系统听写、关键词完整回放或宠物记录冒充本包全量重跑。真实云服务识别、真人语音质量、Live 唤醒完整回放、实际 ARM 手机与 HyperOS 功耗仍待验证。
- 回归脚本首次执行暴露两处前置状态假设：普通语音在 `am start` 后尚未获得焦点就启动，被新边界正确拒绝；接续唤醒测试时仍停留在全屏聊天页，底部设置按钮被聊天输入区覆盖。脚本分别等待真实页面焦点、通过聊天页返回按钮导航后重跑；没有放宽产品检查或强制穿透点击。首次日志保留为 `live-voice-first-attempt.log` / `live-wake-first-attempt.log`。
- 本轮 APK **303912963** 字节，SHA-256 `f01f538eca06f4fb1a9dca46ce943daa543785ed6fc3b3d40bd8e6683ceeaa25`；v2 签名、六个 ARM64 原生库、离线模型/编码资源、ELF/ZIP 16 KiB 对齐通过。上一版系统听写包保留为 `Familiar-0.3.0-arm64-debug-system-speech.apk`。
- 最终 `final-live-boot.json` 核对原配置、会话集合与权限，确认常驻服务/悬浮窗恢复、录音与语音服务已停止、测试包已移除，实际安装包与交付包摘要一致。本轮仅本地更新，不代表整个 Windows 功能对齐目标完成。

## 受控应用查找与启动增量（2026-10-20，Codex）

- 共享 Android 工具新增 `android_apps` 和 `android_open_app`。前者按名称或包名返回当前用户可见、可启动的桌面入口，每页最多 30 项；后者只接受查询返回的 target。两步均沿用共享 Agent / 工具审批，审批卡显示可读应用名称与包名；查询披露只向当前模型发送匹配项。原生私有方法不在公开网页桥中。
- 清单只声明 `MAIN` + `LAUNCHER` Intent 查询，不申请 `QUERY_ALL_PACKAGES`。依据 Android 官方[包可见性声明](https://developer.android.com/training/package-visibility/declaring)、[PackageManager](https://developer.android.com/reference/android/content/pm/PackageManager) 和[后台 Activity 启动限制](https://developer.android.com/guide/components/activities/secure-bal)。只打开标准入口，不接受任意 Intent、URI、正文或附加参数；遵循系统限制，不自动修改厂商权限。
- 原生 target 是 120 秒内存引用，绑定组件、标签、安装/更新版本及 UID。启动前重新核对可用入口、解锁和无障碍连接；引用单次消费，失效不自动重试。调用系统启动后最多观察三秒：只有实际看到目标包的可访问窗口才返回 visible，否则明确 unconfirmed。两者都要求重新读取页面，不能代表业务完成。
- 取消按原生操作编号隔离，阻止尚未派发的启动与迟到回调；已交给系统的启动无法撤回。应用切换后的读取和操作仍分别审批，没有新建 Android 专用 Agent，也没有绕过原有动作校验。
- 新工具暴露了默认 32768 窗口下图片消息的预算回归；精简重复工具说明及日期字段描述后修复，未提高上下文上限、降低估算或跳过预算保护。全部 150 项核心测试（含真实图片请求负载）及类型检查通过；Windows 构建通过。原有审批 UI 4 组检查通过。
- 验收脚本使用独立应用 `app.familiar.fixture` 与本机模型夹具。模拟器拒绝 shell 禁用组件（state 2/3），因此入口失效场景改为卸载本轮安装的夹具后再批准；没有改系统安全策略。该限制不作为产品启动失败。
- 应用设备检查 **10 组**全部通过：私有桥隔离；从 Home 查找、批准打开、再观察、批准点击、再观察 Counter: 1；空结果；拒绝；批准前取消；目标标签篡改；审批中卸载；单次引用重放；熄屏拒绝；实际等待 121 秒后的过期拒绝。审批按钮通过真实覆盖层触摸（熄屏拒绝场景使用公开 task.respond 验证原生防线）。证据 `apps-smoke.json` / `apps-device-final.log`，实际安装包 SHA 与记录一致。只验证隔离入口和模型夹具，不代表任意第三方应用、真实模型选择工具或 OEM 后台弹窗行为已经通过。
- 同一 APK 的宠物设备回归 **8 组**全部通过（`apps-pet-regression.log` / `pet-smoke.json`），覆盖边角吸附、外滑 48dp 小脑袋、点击/内拖展开、独立闲置开关、重启位置、菜单、回复展开和熄屏恢复；截图 `pet-head.png` 已人工查看。强制停止后被系统清除的既有无障碍授权，通过可见系统设置页恢复，没有写 secure settings。
- 交付主 APK **303929719** 字节，SHA-256 `929d8b340660a68f902511b0800f87ad44191129d248ab145cd17d900e9ee1eb`。六个 ARM64 库、模型/编码资源与 ELF/ZIP 16 KiB 对齐通过，v2 签名有效；安装包与交付包摘要相同。上一份 Live 包备份为 `Familiar-0.3.0-arm64-debug-live.apk`，历史包保留。
- `final-apps-boot.json` 确认核心 ready、常驻 running、悬浮窗 visible、无障碍 granted，原模型/语音/唤醒/宠物设置和会话集合恢复，无录音或语音服务，无临时测试包。本轮语音/唤醒设备记录沿用前轮，不作为本包全量重跑；真实云业务、真实 ARM/HyperOS 后台和功耗、完整 Windows 功能对齐仍未完成。只作本地交付，没有提交或上传。

## 剪贴板图片输入增量（2026-10-20，Codex）

- 补齐 Windows 已有的粘贴图片入口。聊天输入框旁增加“粘贴图片”，沿用 Claude 的附件按钮与待发送托盘样式；读取中与文件/相机入口互斥，失败保留草稿，迟到结果只回点击时的会话。添加和预览不发送模型，点击发送后复用共享媒体库、Provider 与历史。
- 原生 Activity 在前台有焦点且亮屏解锁时调用一次 ClipboardManager，不监听剪贴板变化或在快照中读取内容，不新增 Android 权限。官方依据：[复制粘贴与 content URI](https://developer.android.com/develop/ui/views/touch-and-input/copy-paste)、[Android 10 剪贴板访问限制](https://developer.android.com/about/versions/10/privacy/changes#clipboard-data)、[getPrimaryClip](https://developer.android.com/reference/android/content/ClipboardManager#getPrimaryClip())。
- 只接受剪贴板提供的 content URI 图片，PNG/JPEG/WebP/GIF，每张最多 12 MiB、6400 万像素，一次最多 8 张；不执行 Intent、不下载 HTTP 链接、不接受网页传入文件路径。复用原生媒体暂存与缩略图，Node 媒体库保留 clipboard 来源；实际发送原件。公开桥只返回附件元数据，私有导入仍不可从网页直接调用。
- `media.paste` 与可选 `media.paste` 能力声明均为协议增量：旧宿主不声明能力则隐藏入口；后台和熄屏请求拒绝且不会稍后补执行。`platform.media` 的后台命令不获得剪贴板读取能力，操作由持有前台资格的 Activity 发起。
- 核心 **152/152**、媒体 UI **8 组**、类型检查和 Windows 构建通过；UI 覆盖迟到会话归属、错误保留、互斥以及 360/390/430/768 宽度。证据：`clipboard-core.log`、`clipboard-ui.log`、`clipboard-typecheck.log`、`clipboard-windows-build.log`。
- 设备脚本最初只等待 WebView 焦点，系统日志显示原生窗口尚未有焦点时 ClipboardService 拒绝访问。改为等待 WindowManager 的实际窗口焦点，不放宽产品检查。另修正测试 Activity 重用时未更新 Intent 的用例状态。
- 测试夹具曾在构造 file URI 剪贴板时被 Android 的 FileUriExposedException 终止，导致该次内存备份丢失；已精确清除遗留测试文字，无法确认恢复该次测试前的原剪贴板内容。模型、会话和关怀配置已恢复。夹具改为私有目录保存备份、恢复后删除，并捕获设置失败；不关闭 StrictMode 或系统保护，不再用系统不允许的剪贴板写入构造产品测试。后续清理互相独立，单项恢复失败也继续恢复应用配置。
- 最终剪贴板设备 **7 组**全部通过（`clipboard-smoke.json` / `clipboard-device-final.log`）：空剪贴板保留草稿；跨 UID 图片原件进入托盘与预览；非法类型、超量、损坏/超限/失效 URI 拒绝并清理；后台/熄屏及外部 URI 入参拒绝；互斥与迟到会话归属；发送后实际原图摘要核对；重启后历史和预览恢复。最后一轮测试备份恢复成功并卸载夹具；不等于前述早期丢失的备份已找回。
- 同一 APK 的系统文件选择 **5 组**设备回归通过（`clipboard-media-regression.log`），含取消、2.79 MB 原图/文本、超限拒绝、真实请求原件摘要和重启。测试下载文件已移除，原模型/关怀/宠物/语音设置及会话集合核对恢复；强制停止后无障碍通过可见系统设置恢复，未写 secure settings。
- 交付 APK **303946187** 字节，SHA-256 `6a64b9610b35953a140d236c2321189ccbbb8850198030ea7d4c5a46ccf71792`；安装包与交付文件摘要一致，v2 签名、六个 ARM64 库与 ELF/ZIP 16 KiB 对齐通过。上一版备份 `Familiar-0.3.0-arm64-debug-apps.apk`。`final-clipboard-boot.json` 确认核心 ready、常驻 running、悬浮窗 visible、无障碍 granted，无录音服务与测试包。完整 Windows 功能、真实云业务、真实 ARM/HyperOS 长时与功耗仍未全部完成；没有提交或上传。

## 当前安装包边缘收起复核（2026-10-20，Codex）

- 设置 → 边缘停靠：开启“拖动后自动吸附边缘”后，松手吸附最近边缘，接近角落时停在角落；“停靠后闲置收成小脑袋”可独立关闭，等待时间 10–300 秒，默认 30 秒。停靠后向外滑立即收起；点击小脑袋或向内拖展开。关闭吸附时保留自由放置。
- 当前交付包摘要与设备安装包一致，沿用上节 APK，没有重新打包。以真实 ADB 手势复核 5 组交互，含 10 秒闲置收起、关闭闲置收起保持展开、48dp 小脑袋窗口、展开时保持桌面前台及关闭吸附后闲置不收起。截图 `.artifacts/android-device/current-docking-head.png`，检查记录 `current-docking-check.json`。
- 第 6 组核对原偏好、精确窗口位置、休息动作、模型设置和会话均恢复；常驻服务与悬浮窗保持运行，无活跃录音。保持用户现有的吸附关闭状态，用户可在设置中启用。

## GitHub 官方 Token 接入增量（2026-10-20，Codex）

- 对照 Windows `github.integration`：业务工具原本来自 GitHub 官方 HTTP MCP，CLI 主要用于获取浏览器登录 Token。Android 在“设置 → 网络工具 · MCP → GitHub 官方”提供专用表单，默认只读、停用；保存 Token 后可启用并连接，连接/取消/工具目录仍由共享 MCP 服务拥有，不新增一套业务执行器。
- 官方依据：[GitHub Host 集成](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md)、[官方鉴权配置](https://github.com/github/github-mcp-server#remote-github-mcp-server)、[只读模式](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md#read-only-mode)。支持 Authorization Bearer Token 和官方 /readonly 地址；OAuth 需要项目自己的应用配置，尚未接入。
- `mcp.github.save` 固定地址/鉴权并拒绝多余字段。保存队列核对 revision 和原配置身份，只在官方两种模式间保留 Token，清理旧模式副本；清除 Token 同时停用，切回另一模式不会复活旧凭据。UI 不回填密钥，Android 原生 Keystore/GCM 加密存储经进程重启恢复。同名外部服务不会被专用入口覆盖或转移密钥。
- Android 将 GitHub 业务写工具标为 outsideWrite，默认逐项批准；只读服务即使返回写工具也不注册。共享账户管理过滤继续生效，等待审批时更改配置后，旧调用执行前失败；桌面现有写工具策略不变。
- **153/153 核心测试串行通过**、类型检查及 Windows 构建通过。默认并发运行有一个既有文档测试工作进程异常退出，不能声称默认并发命令本轮全绿；记录 `github-core.log`，完整串行记录 `github-core-serial.log`。新增核心用例走真实 MCP 客户端、隔离 fetch 协议响应、共享工具注册和批准/拒绝，未向 GitHub 发送夹具凭据。
- **10 组 UI 检查**通过，含原 MCP 交互、GitHub 模式/清除和 360/390/430/768 布局。当前 ARM64 包 **6 组 GitHub 设备检查**通过，含密码不回填、旧 revision/地址注入拒绝、两种模式间保留、重启、清除与旧凭据不复活；配置全程停用，不发送测试 Token 到网络。证据 `github-smoke.json`、`github-device.log`、`github-settings.png`。
- 同包 **7 组 MCP 设备回归**通过，覆盖本机 HTTP 握手、真实共享 Agent 批准/拒绝、图片结果、旧审批冲突、取消和重启。测试脚本修复上次停留子页时的导航，以及未等密钥保存完成就断言的竞态；删除测试会话前先选回原会话，核对无额外空会话遗留。证据 `github-mcp-regression.log`、`mcp-smoke.json`。
- 最终 APK **303946863** 字节，SHA-256 `3725b50311290e5da3d74dc07050470325b1651e8f66f261f4a4b0246f6a5321`，已安装并更新交付文件，上一版保留为 `Familiar-0.3.0-arm64-debug-clipboard.apk`。v2 签名、六个 ARM64 库及 ELF/ZIP 16 KiB 对齐通过。`final-github-boot.json` 确认核心 ready、常驻 running、悬浮窗 visible、无障碍 granted、原模型/会话/宠物/语音设置恢复且无录音；没有提交或发布。
- 真实 GitHub 账号业务、完整工具目录对模型上下文预算的影响、OAuth 和飞书专用流程仍未完成；本轮不据夹具结果声明云服务已验收。真实 ARM/HyperOS 长时与功耗等完整目标继续保留。

## 大型目录预算与文档稳定性增量（2026-10-20，Codex）

- 复现默认并发测试中的文档工作进程退出，记录到 `3221225477 / 0xC0000005`（`document-parallel-diagnostic-2.log`）。[PDF.js 上游问题 21934](https://github.com/mozilla/pdf.js/issues/21934) 有相同 Windows 工作线程现象，但本机未追踪到具体故障原生模块，不能断言 Canvas 是根因。上游只支持标准 Web Worker；这里的 Node 工作线程路径仍由项目自行维护。
- 将 `pdfjs-dist` 从 5.4.149 固定更新为 6.4.299，保留每份文档独立线程、可取消和解析上限。移除已随上游编译器删除的 `isEvalSupported` 选项，依据 [Mozilla 更新记录](https://bugzilla.mozilla.org/show_bug.cgi?id=2029536)；CMap、字体及新增 WASM 随包加载，禁用 worker fetch、字体面和图像解码器。60 次独立文档线程（48 PDF、12 DOCX）通过，记录 `document-workers-stability.json`；不把有限回归表述为所有文件永不崩溃。
- Android MCP 超过 12 个工具或 6000 字节定义时，使用共享按需目录，完整工具仍注册并保留原校验和审批。初次图片回归证实：即使目录分页，全部内置定义加图片仍会超过 32K。改为预算不足时把当前工具集切换为共享按需目录，另对已经用于后续调用的参数页提供请求副本压缩；完整执行记录和实际结果不删，窗口上限及图像估算不变。
- 检索每页 6 项、参数每页 1800 字符，原工具名作为拒绝键；通过不同目录不能绕过同轮拒绝。执行前和等待审批后复核注册对象，注销/重连后的旧引用不能调用新实现。Agent 每轮更新目录，新增工具可在下一轮使用。核心测试还验证图片后继续查参数并执行另一个工具、完整参数页仍持久化。
- **156/156 默认并发核心测试、类型检查和 Windows 构建通过**，记录 `catalog-core-full.log`、`catalog-typecheck.log`、`catalog-windows-build.log`。这是对上节文档并发失败的后续复查结果，不覆盖或改写先前失败记录。
- 同一 ARM64 包 **11 组 MCP 设备检查**通过，含 138801 字节/80 个工具目录在固定 32768 窗口下检索、完整读参、批准/拒绝、图片回传、自适应目录、配置变更失效和重启恢复。`mcp-smoke.json` 记录初始模型工具定义最多 17227 字节，图片回合切换为三个共享入口。真实 GitHub 账号、云模型选择工具效果、OAuth 和飞书专用流程仍待完成。
- 同包 **6 组文档设备回归**通过：系统选择取消、中文 PDF/Word 段落与表格、纯文本预览、空/损坏/超页数/加密提示、实际模型请求携带提取文字、进程重启后预览恢复。记录 `catalog-documents-device.log` / `documents-smoke.json`；本轮临时文件和会话已清理。
- 同包重新执行 **6 组边缘停靠检查**：拖放吸附边缘/角落、向外滑变成 48dp 小脑袋、点击或向内拖展开、闲置收起独立开关及实际等待、关闭吸附自由放置、原设置与精确位置恢复。记录 `catalog-docking-check.json` / `catalog-docking-device.log`，截图 `catalog-docking-head.png` 已查看。用户原来的吸附关闭偏好保持，默认闲置延迟 30 秒、可调 10–300 秒。
- 最终 APK **304753753** 字节，SHA-256 `c09585cd81131e21b67be9c8fc8a36e6ed502ff665acc4c047b09cd68ad883f4`。安装包、测试证据及交付文件摘要一致，v2 签名、六个 ARM64 库及 ELF/ZIP 16 KiB 对齐通过；上一版保留为 `Familiar-0.3.0-arm64-debug-github.apk`。`final-catalog-boot.json` 确认核心 ready、常驻 running、悬浮窗 visible、既有无障碍授权经可见设置恢复、原模型/会话/宠物/语音配置恢复，文档暂存为空，无录音或待批任务。仍为本地开发包，没有提交或上传。

## 飞书私聊与停靠交付复核（2026-10-20，Codex）

- 使用飞书官方 `@larksuiteoapi/node-sdk` 1.76.0 接入 Android 独立 Runtime，固定生产域名；应用端无需桌面飞书 CLI。依据 [官方 SDK](https://github.com/larksuite/node-sdk/blob/main/README.md) 的长连接、事件分发与机器人回复接口。仅提供自建应用的配对私聊文字入口，不把它称为飞书办公功能全部完成。
- 新增 `feishu.channel` 插件持有连接、10 分钟一次性配对码、有界队列和持久去重。默认关闭，应用密钥沿用原生 Keystore/GCM 加密；更换应用清理旧凭据与配对，清除密钥同时停用。未配对、机器人、群聊及非文字不进入模型。收包立即 ACK，执行前记录去重；回复失败不自动重发，中断副作用不自动重放。
- 私聊复用既有 `channel.chat`、Provider、记忆、技能和共享 Agent；按应用/用户/会话隔离历史，`/new` 清空私聊上下文而保留记忆。审批显示“飞书私聊”来源，目录代理仍核验原工具权限。停止私聊立即断开并取消待批/回复；停止常驻同步暂停连接，保留开启偏好，再次开启常驻恢复连接。新增通道没有改变 Kernel 职责或控制页与宠物的独立生命周期。
- UI 沿用纸色与鼠尾草风格；密钥不回填，revision 冲突保留草稿，保存时锁定输入，迟到轮询不得覆盖新设置。旧宿主隐藏入口。官方 SDK 对 App ID 的格式比原草稿校验严格，已按 `cli_` 加 16 位十六进制提前校验，避免无效编号静默停留在连接中。
- **159/159 默认并发核心测试、类型检查和 Windows 构建通过**，见 `feishu-core-full.log`、`feishu-typecheck.log`、`feishu-windows-build.log`。新增测试使用真实 SDK + 本机 HTTP/WebSocket + 模型协议服务，覆盖配对、单次码、重复消息、共享审批允许/拒绝、发现连接期间取消、全局常驻停止、重启去重、清除/切回旧应用、固定公开错误及资源释放。没有使用真实用户凭据或向外部飞书发送测试消息。
- **7 组 UI 检查**通过，含 360/390/430/768 宽度，截图已查看；同包 **5 组飞书设备配置检查**通过，含实际表单、公开 DTO/端点覆盖拒绝、原生密钥加密、进程重启和清除。见 `android-feishu-ui/result.json`、`feishu-smoke.json`、`feishu-settings.png`。设备配置全程停用；这不是实际飞书应用的收信验收。
- 同包 **11 组 MCP 设备回归**通过，见 `feishu-mcp-regression.log` / `mcp-smoke.json`。首次脚本停留在飞书子页导致点击设置被遮挡，已让测试先通过返回按钮退出子页；失败记录留在 `feishu-mcp-navigation-failure.log`，未放宽产品点击行为。
- 同包 **6 组停靠复核**通过，见 `feishu-docking-check.json` / `feishu-docking-device.log`。真实手势确认贴边/角落、向外滑变为 48dp 头像窗口、点按或向内拖展开、闲置开关、关闭吸附自由放置，以及原偏好和精确位置恢复。默认延迟 30 秒，可调 10–300 秒；`feishu-docking-head.png` 已查看。最初重复运行旧脚本时，其“休息动作必须保持”断言在瞬时动画回到 idle 后失败，未进入偏好修改；旧 `catalog-docking-check.json` 被该次结果覆盖，上一包成功记录仍见 `catalog-docking-device.log` / `final-catalog-boot.json`。新脚本改为验证持久偏好及窗口，而不把瞬时动作当作配置。
- 最终 APK **305534841** 字节，SHA-256 `8edc8435ffa56f6b73a6bb7cbf28488eba82b77bfb1149085da0ffaefbe8e6d3`。安装包、三份设备证据及交付文件摘要一致；v2 签名、六个 ARM64 库及 ELF/ZIP 16 KiB 对齐通过。上一包保留为 `Familiar-0.3.0-arm64-debug-catalog.apk`。`final-feishu-boot.json` 确认核心 ready、常驻 running、悬浮窗 visible、既有无障碍授权已通过可见设置恢复，模型/会话/宠物/语音偏好核对恢复、通道关闭且无测试凭据、无录音或待批任务。
- 真实飞书账号收信、GitHub/高德/云模型业务、飞书办公 API、OAuth、真实 ARM/HyperOS 长时功耗及 Windows 全量功能对齐仍未完成；不据本机协议测试声明这些已通过。保持本地开发，没有提交或上传。

## 开机启动与小脑袋交互交付复核（2026-10-20，Codex）

- 补齐 Windows 登录自启在 Android 的对应入口：小窝 → 常驻伙伴 → 开机启动伙伴。默认关闭，开启前要求悬浮窗权限；停止当前陪伴不改未来开机偏好。原生接收器只订阅解锁后的 BOOT_COMPLETED，位于 `:runtime`、不导出；偏好、广播和服务由同一进程持有。读取 BOOT_COUNT 避免同一轮广播重复拉起；只启动原有 specialUse 宠物服务，不启动控制页、录音或唤醒。界面等待原生保存和快照确认，区分提交请求与服务实际启动。
- 官方依据：[前台服务后台启动豁免与使用中权限](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)、[Android 15 开机启动类型限制](https://developer.android.com/about/versions/15/behavior-changes-15#fgs-boot-completed)、[BOOT_COUNT](https://developer.android.com/reference/android/provider/Settings.Global#BOOT_COUNT)、[小米自启动管理](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1624)。采用 specialUse 是结合已有常驻用途与受限类型清单的适配判断；不代表所有厂商均允许后台启动。小米的系统自启动权限单独提示，应用开关不代表该权限已授权。
- **160/160 默认并发核心测试、类型检查和 Windows 构建通过**；见 `startup-core-full.log`、`startup-typecheck.log`、`startup-windows-build.log`。核心覆盖命令字段拒绝、原生保存失败、持久化所有者、公开 DTO 及不得附带启动录音/常驻。**6 组 UI 检查**通过，覆盖保存等待、失败、撤回权限、旧宿主隐藏与 360/390/430/768 宽度；`android-startup-ui/result.json` 和设备 `startup-device.png` 已查看。
- **6 组开机设备检查通过，分断线前与恢复后两段记录**：初始实际表单默认关闭、启用不改变当前常驻/录音、停止陪伴保留下次开机偏好；开机次数 40 → 41 后没有主 Activity 进程，系统记录来自 BOOT_COMPLETED 的 specialUse 前台服务、悬浮窗及 started 状态；41 → 42 在关闭偏好后不启动宠物；最后恢复原配置与精确位置。第一次脚本误用 Playwright setChecked 与异步快照确认冲突，改为点击后等待真实快照。随后 ADB reboot 在连接中断时返回 ETIMEDOUT，设备实际已经重启；脚本按原始基线和开机次数续验，没有用手动启动冒充冷启动。初始日志 `startup-adb-disconnect.log/json` 保留原始失败，续验 `startup-device-resume.log` / `startup-smoke.json`，开界面之前的原始服务证据 `startup-cold-boot.json`。
- 撤回权限检查另外 **3 组通过**：可见系统设置撤回后状态正确、仍允许关闭已开偏好而禁止重新开启、恢复原权限/配置/位置。**缺失权限时的开机分支未完成设备验收**：两次 ADB 重启后权限都恢复允许；最终记录中 appops 从 `deny` 变为 `allow`，原生快照一致，原因未确认，不能归因为产品绕过或断言为某项模拟器策略。保留 `startup-permission-boot-failure.log/json` 与后续 `startup-permission-device.log` / `startup-permission-smoke.json`，后者明确标记 UNVERIFIED；没有通过 appops/secure settings 写入强造用例。
- 同包 **6 组停靠回归通过**：最近边缘/角落吸附、向外滑变为 48dp 小脑袋及同步缩小触摸窗口、点按或内拖展开且不打开设置、独立闲置开关与真实 10 秒等待、关闭吸附自由放置、原设置与精确位置恢复。默认延迟 30 秒，可调 10–300 秒。证据 `startup-docking-check.json` / `startup-docking-device.log`，`startup-docking-head.png` 已查看；脚本支持不同记录前缀，保留上一包证据。
- 最终 APK **305535097** 字节，SHA-256 `34ab995fd9ec1f0d6d6d856c8a243b3b2ce70c67055f626093d42266da5f8439`；设备、开机/权限/停靠证据及交付文件摘要一致，v2 签名、六个 ARM64 库与 ELF/ZIP 16 KiB 对齐通过。上一包备份 `Familiar-0.3.0-arm64-debug-feishu.apk`。`final-startup-boot.json` 确认核心 ready、常驻 running、悬浮窗 visible、无障碍 granted、开机启动与自动吸附恢复关闭，原模型/会话/语音/宠物偏好恢复，无录音、活动回复或待批任务。
- 当前仍为本地开发验收包；真实账号业务、飞书办公与 OAuth、真实 ARM/HyperOS 长时功耗和 Windows 全量功能对齐仍未完成。此前飞书/MCP/文档/语音等设备记录保留，本轮未全部重跑；没有提交或上传。

## 全天与重复日程创建增量（2026-10-20，Codex）

- 将原本只支持一次性定时事件的 `android_calendar_create` 扩展为全天以及 daily / weekly / monthly / yearly 重复。支持间隔、每周多个星期、包含首次的总次数、包含当天的截止日期；次数与截止互斥，都省略时持续重复。周计划以周一为每周起点，首次日期须落在选中的星期；月/年沿用首次日期，遇到不存在的日期跳过。不接收原始 RRULE 字符串，不注册额外公开原生命令。
- 按 [Calendar Provider 插入规则](https://developer.android.com/identity/providers/calendar-provider) 为重复事件写 RRULE + DURATION，省略 DTEND；普通事件继续写 DTEND。全天使用 UTC 午夜和排他结束日，依据 [Events 写入约束](https://developer.android.com/reference/android/provider/CalendarContract.Events)。重复结束和无效日期依据 [RFC 5545 3.3.10](https://datatracker.ietf.org/doc/html/rfc5545#section-3.3.10)。有时区的截止日转换为该日结束时的 UTC，全天使用日期型 UNTIL；原生验证时间偏移和时区一致，重复事件拒绝亚秒精度。
- 原生端生成规范化规则与防重摘要，等价星期顺序/默认间隔不产生第二次写入；改变计划后不能复用操作号。旧普通事件继续使用原摘要，升级前已完成且所属测试日历已移除的操作号仍返回原结果，不重新创建。写入仍经过共享审批、系统权限复检、原子防重账本和完整字段回读；未知结果不自动重放。
- 创建审批保留 Claude 的纸片卡片布局，显示标题、首次时间/全天日期、时区、重复星期、次数或截止日期、地点及备注。无限重复明确写出未设结束日期；飞书私聊来源标签保留。当前展示日历编号，提醒仍需另设，不能把日程创建当作已经验证通知响铃。
- **160/160 默认并发核心测试、类型检查与 Windows 构建通过**，记录 `recurrence-core-full.log`、`recurrence-typecheck.log`、`recurrence-windows-build.log`。扩展现有系统工具测试覆盖创建审批拒绝无调用、中文预览、来源标签、非法规则与互斥字段。**4 组审批 UI 回归**通过，覆盖 280/336 宽度、详情完整纯文本、提交互斥与迟到结果；记录 `recurrence-approval-ui.log` / `android-approval-ui/result.json`。
- 同一 ARM64 包 **12 组设备检查通过**，记录 `recurrence-device.log` / `recurrence-smoke.json`。共享 Agent 使用本机模型协议夹具，写入独立 LOCAL 日历，再通过真实 CalendarProvider Instances 验证：跨两天全天、每周多个星期/总次数/45 分钟时长、纽约夏令时结束后保持当地 09:00、每两周默认星期、每月 31 日及闰日跳过无效日期、跨年全天与两天持续时间、持续工作日计划、等价防重/冲突/拒绝、非法输入无记录、进程重启与历史操作号兼容。实际跨应用审批截图 `recurrence-approval.png` 已查看，内容可滚动、底部按钮固定；没有真实云模型或云日历同步验收。
- 隔离日历、实例及测试会话已清理，模型/会话/语音/开机/宠物偏好核对恢复；强制停止后的既有无障碍授权通过可见系统设置恢复。最终 APK **305536705** 字节，SHA-256 `cf9c7bf00abe2d293899d98a46d4c580bb4599ba6c5e954f0fc499629ec814db`；安装文件、设备证据与交付文件摘要一致。v2 签名、六个 ARM64 库与 ELF/ZIP 16 KiB 对齐通过；上一包保留为 `Familiar-0.3.0-arm64-debug-startup.apk`。
- `final-recurrence-boot.json` 确认核心 ready、常驻 running、悬浮窗 visible、日历与无障碍 granted，无录音、活动回复或待批任务。已有边缘停靠与开机测试保留上轮证据，本轮未重复全部设备测试。系列时间/规则修改、单次例外、系列删除、邀请及实际通知仍未补齐；真实账号、ARM/HyperOS 长时与整体 Windows 功能对齐继续进行。仅本地交付，没有提交或上传。

## 重复日程修改、取消与删除增量（2026-10-20，Codex）

- 日历读操作返回系列例外、取消状态与原定日期；实例查询增加 seriesId/originalStart，单次改期后仍保留原定定位。新增 instance_read/update/cancel：读取真实 Instances，批准后创建或更新一个例外；取消写 STATUS_CANCELED，不用删除例外导致原安排复现。基于 [Events.CONTENT_EXCEPTION_URI](https://developer.android.com/reference/android/provider/CalendarContract.Events#CONTENT_EXCEPTION_URI)，重复规则仍由 CalendarProvider 展开，不在核心另写日历引擎。
- 整组修改支持无例外、无 RDATE/EXDATE/EXRULE 系列的首次时间、时长、时区与结构化重复计划一起替换，范围包含历史日期。已有单次改期/取消的系列拒绝自动重排；元数据和主记录提醒修改保留已有例外。整组删除先删除例外再删主记录。系列 revision 和原子批处理断言包含主记录、例外成员及各自提醒，期间发生改变即拒绝；上限 50 个例外、读取快照 200 KB，超过时交给日历应用，不截断后继续写。
- **未同步系列的单次操作在写入前拒绝。** 本机实际发现无 `_SYNC_ID` 系列创建例外后其余实例从查询中消失；[AOSP CalendarInstancesHelper](https://raw.githubusercontent.com/aosp-mirror/platform_packages_providers_calendarprovider/main/src/com/android/providers/calendar/CalendarInstancesHelper.java) 的未同步分支按子记录 ID 展开，源码含相关 TODO。应用不伪造同步 ID、不以同步器权限绕过约束；read 返回 editable=false 与原因，写操作返回 unavailable/未写入。纯本地无例外系列仍可整组重排/删除；取消恢复、已有例外重排及特殊规则由日历应用处理。
- 审批明确显示“整个重复系列”或“仅这一次”、原定/当前/新时间、修改字段、例外数量及整组删除范围，保留飞书来源、纸片滚动详情与固定按钮。操作防重与私有原子账本继续使用；恢复资料增加系列和例外字段/提醒，仍不包含完整参会人或邀请，不能当作完整撤销。
- 增加完整定义后触发既有工具体积回归，现复用共享 deferredToolCatalog：日历管理经 android_calendar_tools_search / tool_schema / tool_invoke 按需读取，实际调用仍进入同一原工具的校验与批准。列表、实例查询和创建保持直接可发现；没有新增公开 WebView 原生命令。32K MCP 目录回归保持 20000 字节上限；图片后的预算降级用显式会话负载验证，并等待真实会话 busy 结束后检查落盘，避免将界面完成误作持久化完成。
- **160/160 默认并发核心测试、类型检查和 Windows 构建通过**：`calendar-edit-core-full.log`、`calendar-edit-typecheck.log`、`calendar-edit-windows-build.log`。**4 组审批 UI 回归通过**：`calendar-edit-approval-ui.log`。真实设备截图 `calendar-edit-single-approval.png` 已查看，范围与原定时间可读，详情可滚动。
- 同一 ARM64 包 **12 组设备检查通过**：`calendar-edit-device.log` / `calendar-edit-smoke.json`；模型夹具实际执行 48 次按需目录调用，检查未同步拒绝零写入、跨夏令时定位、拒绝、一次跨日改期与提醒复制、二次修改复用例外、同编号防重、旧目标冲突、系列改名保留例外、取消首次/改期实例、进程重启、恢复资料、整组删除、整组重排、全天边界与审批期间外部修改。仅在独立 LOCAL 夹具日历中模拟同步器赋予标识，**不是云端同步或真实账号验收**。初次失败与原始字段证据保留在 `calendar-edit-first-failure.*` / `calendar-edit-unsynced-diagnostic.*`。
- 测试日历、实例与会话已清理，原模型/语音/宠物/开机/会话设置核对恢复；强制停止后的既有无障碍授权通过可见系统设置恢复。最终 APK **305571337** 字节，SHA-256 `5cd3868059a86a83fccf2b2428f557416c60d1e429bb79c997faa215ba20c73a`，v2 签名、六个 ARM64 原生库与 ELF/ZIP 16 KiB 对齐通过。签名使用明确 JDK 17 的 `calendar-edit-signature-final.log`；默认环境批处理未返回已中止，不把它计为通过。上一包备份 `Familiar-0.3.0-arm64-debug-recurrence.apk`。
- `final-calendar-edit-boot.json` 确认安装包、交付文件和设备证据摘要一致，核心 ready、常驻 running、悬浮窗 visible，无录音、待批任务或活动回复。既有停靠/开机/语音等记录保留，本轮未全量重跑。真实账号服务、飞书办公/OAuth、ARM/HyperOS 长时与整体 Windows 对齐仍继续进行；仅本地开发，没有提交或上传。

## 当前包停靠复核与软键盘验收边界（2026-10-20，Codex）

- 当前安装的日历改删 ARM64 包再次通过 **6 组停靠检查**，摘要仍为 `5cd3868059a86a83fccf2b2428f557416c60d1e429bb79c997faa215ba20c73a`。证据为 `current-docking-check.json` / `current-docking.log`，`current-docking-head.png` 已查看。真实触摸验证最近边缘/角落、向外滑收为 48dp 头像与缩小触摸窗口、点击/内拖展开、独立闲置开关、10 秒实际等待、关闭吸附自由放置。原位置、模型、会话和宠物设置恢复，常驻与悬浮窗仍运行；本轮未改产品代码或重新打包。
- 软键盘验收尚未完成：当前雷电模拟器自带输入法报告 mInputShown=true，但 InputMethod 窗口为 `[0,2560][1440,2560]`，高度为 0，不能以 visualViewport 不变证明遮挡故障或适配通过。现场记录 `keyboard-fixture-inspect.log` / `keyboard-baseline.json`。
- 新增独立、无网络的 `tests/android-ime-fixture`，仅向调试版提交固定测试字符；构建和安装成功。系统选择器与测试命令切换后仍读到原输入法，后续测试 IME ID 又不能被识别，具体原因未确认，未宣称该键盘已运行。夹具不参与主 APK，已卸载；默认及唯一启用项均恢复为 `com.android.inputmethod.pinyin/.InputService`。真实中文组字、键盘遮挡和返回行为仍需兼容模拟器或真机验证，使用说明与官方资料链接见该目录 README。

## 飞书办公原生执行器阶段（2026-10-20，Codex）

核查 Windows/Android 装配后，飞书办公仍是主要代码缺口：Windows 使用官方 CLI，Android 目前仅配对私聊。新增 [Android 飞书执行器](../plugins/feishu-android/README.md)，复用与桌面相同的官方 v1.0.96，通过公开的宿主、凭据和 FileIO 扩展构建 Android ARM64 PIE。没有修改上游源码，没有将 Windows CLI 或 Linux libc 二进制直接打包。NDK 产物使用 `/system/bin/linker64`，所有 LOAD 段至少 16 KiB 对齐；最终大小 50129288 字节，SHA-256 `8a59bcae0513ef74fc6aef897851c2464e7b491571cecba765b1da136fe315ec`。

输入管道携带临时身份/令牌，默认文件密钥链拒绝调用，办公参数不允许覆盖身份或调用账户管理。文件读写使用 `os.Root`，局限于指定工作区，覆盖与排他提交均保留原子语义。TypeScript 执行器实现有界输出、排队、超时/取消/崩溃报告；中断不自动重试外部写入。**尚未装配进主程序，也没有新增可用的办公设置入口**，后续必须接共享 Agent 授权、Keystore 身份管理及刷新、UI 和真实云业务。

4 组 Go 边界测试、2 组真实子进程测试和类型检查通过。独立无网络夹具中的最终 **96 次默认配置设备检查通过**，涵盖官方帮助/Schema/Skill、日历与文档 dry-run 请求正文、工作区文件读取、目录穿越/符号链接拒绝、缺凭据拒绝与账户/身份覆盖拒绝。报告以 runId 和设备内二进制摘要绑定，夹具自动卸载；证据 `.artifacts/android-feishu/smoke-default.json`、`managed-build-final.log`、`runner-tests-final.log`、`typecheck-final.log`。

仍有明确阻碍：此前多轮在 Houdini 转译层出现退出码 139；禁用异步抢占仍复现，已撤去执行器中的该选项。禁用 ARM 原子指令优化的夹具对照无 139，但发生一次输入解析失败，不能视为已修复，生产没有采用该选项。保留所有失败证据，不能用最终一次通过抹去随机崩溃。**稳定性尚未确认，因此未替换交付 APK。** `main-unchanged.json` 核对当前主 APK 仍为 `5cd386…c73a`、核心 ready、常驻/悬浮窗正常、原会话和宠物偏好恢复且无活动任务。整体目标仍包括产品装配、真实云服务、软键盘、真 ARM/HyperOS 长时与 Windows 主要功能对齐。

## 飞书机器人办公接入主 APK（2026-10-20，Codex）

- 本轮将上一节执行器装配进 Android 核心，增加 `feishu.office` 插件与“设置 → 飞书 → 办公能力”。开关默认关闭、与私聊独立，开启前需已保存应用凭据；用户身份登录/OAuth 尚未接入。网页只有配置与固定离线检查入口，业务命令仅从共享 Agent 调用 `feishu_cli`，无任意程序或路径入口。
- 原生宿主传入安装器的 nativeLibraryDir；APK 改用解包原生库，使 ARM64 PIE 能在安装目录启动，不执行可写数据目录代码。构建链自动生成、打包及校验办公程序，七个原生库依赖、ELF/ZIP 16 KiB 对齐和 v2 签名通过。打包许可证。新二进制仍为 50129288 字节，SHA-256 `07fc29b8e6483ab9e853453ab43981e62315e995e84a6813c30880859a1b3052`。
- 机器人令牌由固定的官方 OAuth v3 接口获取，应用密钥沿用 Android Keystore 所有者；令牌只在内存和输入管道中，按 expires_in 提前刷新，支持 16 KiB 长令牌。响应有界、不跟随重定向、认证错误不输出服务端原文。此网络链路用隔离传输验证，未提交真实凭据或验收真实飞书业务。
- 工具帮助、Schema、Skill 归只读；业务命令根据官方 Risk 判定，未知或写入归 outsideWrite，走现有审批卡。当前身份与应用编号可见，旧工具在配置/凭据变化后失效；停用常驻会中断执行。超时、取消、崩溃均返回结果未确认，不自动重放。只有帮助明确声明 --yes 的命令在批准后预先附加；首次统一附加导致普通命令失败的证据保留，修正后设备重跑通过。
- 4 组 Go 测试、164 项默认并发核心测试、类型检查与 Windows 构建通过；确认参数修复后相应核心测试再次通过。8 组浏览器 UI 检查通过，验证独立开关、草稿与冲突、配对、旧宿主隐藏及四种宽度。日志均在 `.artifacts/android-feishu/office-*`；`office-ui.log` 对应 `.artifacts/android-feishu-ui/result.json`。
- 最终主 APK **8 组设备检查通过**：真实 Runtime 启动 ARM64 程序、禁止网页传命令、缺凭据不能开启、真实设置页独立开关、本机模型进入共享 Agent、实体触摸拒绝/批准、官方日历 POST dry-run 请求、文件越界拒绝和恢复原配置。使用临时假应用与本地模型服务，没有真实飞书读写；`office-device.json` 含最终包摘要和实际请求预览。首次失败及测试额外空会话的恢复记录保留，最终原会话列表逐项相同。
- 同一包 **6 组边缘停靠回归通过**，包含最近边角吸附、外滑收为 48dp 头像、点按/内拖展开、独立闲置开关、实际 10 秒等待、自由放置和精确恢复。证据 `.artifacts/android-device/office-docking-check.json`。截图已查看；吸附保持关闭，闲置延迟保持 30 秒。
- 本地交付 `release/android/Familiar-0.3.0-arm64-debug.apk`：**131755146 字节**，SHA-256 `a0ea6001d324ff80b89b5c8871826e337243d7c39ba7879bd9c66d88f266a909`。体积变化来自原生库压缩/安装时解包，不是移除离线模型；模型摘要检查仍通过。上一包保留为 `Familiar-0.3.0-arm64-debug-calendar-management.apk`。`office-final-boot.json` 证明设备与交付包一致、核心 ready、常驻/悬浮窗运行、无障碍 granted、测试凭据/会话已清理且原模型和宠物设置恢复。
- 雷电仍是 x86_64 + Houdini 转译。先前低概率 Go 子进程 139 未根治，本轮没有发生，不能据此宣布稳定性问题解决；进程故障被隔离并返回未知结果，主宠物不会因此自动重试业务。真实云端、用户 OAuth、软键盘、真 ARM/HyperOS 长时与全量 Windows 对齐继续进行。仅本地开发，没有提交、上传或发布。

依据：[Android 安装原生库目录](https://developer.android.com/reference/android/content/pm/ApplicationInfo#nativeLibraryDir)、[Android 可写目录执行限制](https://developer.android.com/about/versions/10/behavior-changes-10#execute-permission)、[飞书自建应用 OAuth v3 凭据](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/tenant_access_token)。

## 飞书个人账号设备授权与身份选择（2026-10-20，Codex）

- 新增独立 `feishu.auth` 插件，沿用官方 CLI v1.0.96 的设备授权、用户信息和刷新协议。用户在飞书设置页发起登录，在固定官方账号页面确认；原生通过 ACTION_VIEW 交接，网页不能指定地址或取得设备码、应用密钥、访问/刷新令牌。授权支持取消、拒绝、过期、pending/slow_down 与网络退避。最初只请求离线登录权限，业务缺少权限后展示明确 scope，由用户另行补授权。
- 个人凭据以一个记录写入现有 Keystore/AES-GCM 原子文件，绑定应用编号与密钥摘要；仅该记录扩至 64 KiB，总密文文件限制 256 KiB。刷新请求并发合并，先落盘刷新标记；若进程退出、刷新失败或结果不明确，要求重登，不复用结果未知的轮换令牌。调用者取消不重复刷新；登录取消与原生写入交错会补偿磁盘记录。清除失败显示错误并保留重试入口，不声称撤销飞书云端应用授权。
- 办公面板增加机器人/个人账号选择。个人未登录时不注册办公工具，也不回退机器人。共享审批绑定应用、身份、配置版本、用户与登录版本；换账号或清除登录使旧审批失效。正常刷新不打断同一账号正在进行的工具调用。缺 scope 时在个人面板展示“补充以上权限”，不让模型调用登录/配置工具绕过身份。
- 最终 **170 项核心测试**、类型检查通过，Windows 构建也通过。新增六组核心测试覆盖授权轮询、过期/取消/迟到结果、凭据隔离与重启、单次刷新、未知刷新不得重放、存储失败与重试、取消与原生写入交错、个人审批失效及无机器人回退。所有网络使用隔离传输，不包含真实账号。日志 `auth-all-tests.log`、`auth-typecheck.log`、`auth-windows-build.log`。
- **9 组浏览器 UI 检查通过**，包括官方授权入口、取消、补权限、身份草稿、清除确认和原有配对/配置行为。最初共用配对码选择器导致测试超时，已分离授权码区域后重跑通过；证据 `auth-ui.log` 与 `.artifacts/android-feishu-ui/result.json`。真实模拟器登录面板截图已查看。
- 最终 APK **10 组设备检查通过**：真实登录入口、无凭据禁用、任意授权 URL 拒绝、保存个人身份后明确要求登录、机器人离线组件、共享 Agent 调用、触摸批准/拒绝、日历 dry-run、工作区越界拒绝及完整恢复。报告 `.artifacts/android-feishu/auth-final-device/office-device.json` 与包摘要绑定。未发出真实飞书认证/业务请求；官方页面的实际账号授权、真实刷新和云业务仍待账号验收。
- 同一包 **6 组停靠回归通过**：最近边角吸附、外滑收成 48dp 小脑袋及缩小触摸窗口、点按/内拖展开、独立闲置开关与 10 秒等待、关闭吸附自由放置、原设置/位置/模型/会话恢复。记录 `.artifacts/android-device/auth-final-docking-check.json`，原有吸附关闭、闲置 30 秒偏好保持。
- 主包 `release/android/Familiar-0.3.0-arm64-debug.apk` 为 **131766598 字节**，SHA-256 **d1735ef134d223dab14e32738acd8dc839344eac4cb6abeb4da4215b2c3d0780**；七个 ARM64 原生库、依赖、ELF/ZIP 16 KiB 对齐与 v2 签名通过。上一包备份 `Familiar-0.3.0-arm64-debug-feishu-bot.apk`。最终状态记录 `auth-final-boot.json`，核对已安装/交付包一致、核心与常驻/悬浮运行、无障碍授权、无测试凭据或活动任务、原配置恢复。
- 本轮完成个人登录代码和隔离验证，未将其称为真实账号验收。真实云服务、键盘/中文组字、相机与识别引擎、复杂手机任务、真 ARM/HyperOS 长时及完整 Windows 功能对齐仍有待完成的验证或平台差异；Houdini 下既有偶发 Go 子进程故障未根治。本地文件交付，没有提交、推送或对外发布。

依据：[官方设备授权流程](https://github.com/larksuite/cli/blob/cb5a3d704379552dc61e37898e5f74798783190d/internal/auth/device_flow.go)、[官方用户令牌刷新](https://github.com/larksuite/cli/blob/cb5a3d704379552dc61e37898e5f74798783190d/internal/auth/uat_client.go)、[飞书刷新用户令牌](https://open.feishu.cn/document/authentication-management/access-token/refresh-user-access-token)、[Android 浏览器 Intent](https://developer.android.com/guide/components/intents-common#Browser)。

## 点击宠物直接气泡连续聊天（2026-10-20，Codex）

用户指出 Windows 点击宠物可以气泡对话，Android 却打开主应用，并明确要求直接输入、连续聊天；同时说明软键盘应使用设备自带输入法。本轮据此停止替换模拟器键盘的尝试，修复真实入口，而非继续处理自带键盘的零高度现象。

- `PetService` 轻点完整宠物改为打开 `PetBubbleChat`。小脑袋轻点仍只展开；有待办时优先重开审批卡。共享 `chat.open` 的 composer 表面映射为 `composer-visible`，原先打开 Activity 的映射移除；“打开应用”保留为明确菜单按钮。核心会话、Provider、历史、记忆和工具审批继续共用。
- 原生窗口提供多行输入、发送、流式回复、停止与收起，发送后保持连续聊天。只读取有界最近回复，不复制会话引擎。`pet.chat.state/send/cancel` 仅在私有运行进程通道使用，未加入网页公开白名单。发送绑定原会话，主应用切换/删除后拒绝旧窗口发送，明确切换前保留原草稿；临时草稿最多八份、每份 8000 字，未保证进程回收后的未发送文本恢复。
- 使用标准 EditText / InputMethodManager 连接现有系统输入法，等窗口获焦点后再请求输入，不使用强制键盘。返回或外部触摸可释放输入焦点，输入不直接触发发送，回车换行。API 30+ 根据 IME Insets 调整位置；短回复高度随内容收紧，长回复在有限区域滚动。没有新增权限或安装输入法。聊天打开时暂停闲置收成小脑袋；临时让开审批或手势时保留本进程草稿。
- 新增三组核心测试，通过真实共享 Conversation/Provider 和本机模型协议验证上下文连续、停止、主应用历史一致及旧会话拒绝；另检查 composer 不再打开 Activity、有界投影与异常参数。**173 项完整核心测试、类型检查、Windows 构建通过**，最终原生构建通过，日志 `bubble-chat-all-tests.log`、`bubble-chat-typecheck.log`、`bubble-chat-windows-build.log`、`bubble-chat-android-build-release.log`。
- 最终包 **8 组设备检查通过**：实体点击不打开主应用、真实输入和回车换行、发送/流式回复后保持窗口、第二轮包含上一轮上下文、实体停止、收起重开草稿、会话切换后明确接续且不串发、返回释放焦点、保留原输入法及清理恢复。使用本机模型协议服务，不代表云端模型质量。报告 `.artifacts/android-bubble-chat/result.json` 与最终包摘要绑定，实际截图已查看。
- 首次测试在切换会话后窗口放弃焦点，界面仍可见但活动窗口的可访问树只返回桌面，导致设备检查及原清理路径失败。现已保留切换提示卡的窗口焦点，同时暂停输入法；原始失败 `result-first-failure.json`、`failure.png`、`failure-ui.xml` 保留。仅移除了经内容核实的两个测试会话，`recovery-first.json` 证明原模型、会话列表与宠物设置恢复；最终完整重跑通过。清理改为先选择原会话再删除临时会话，避免自动生成额外空会话。
- 更新后检测到无障碍未连接，通过可见系统设置恢复此前已启用的服务；随后 **4 组审批回归通过**，证明待办重开、实体批准/拒绝、旧节点变更拒绝及取消仍有效，报告 `bubble-approval-smoke.json`。独立无网络靶场已移除。**6 组停靠回归通过**，记录 `bubble-docking-check.json`，原位置与开关精确恢复。
- 最终本地交付 `release/android/Familiar-0.3.0-arm64-debug.apk` 为 **131794122 字节**，SHA-256 **ffdc52cac6cf2b00a1c3d136215e1b6dae5096ce403f970d8a127a0c0e53b25b**，七个 ARM64 原生库、ELF/ZIP 16 KiB 对齐与 v2 签名通过。上一份个人登录包备份为 `Familiar-0.3.0-arm64-debug-feishu-user.apk`。最终状态见 `.artifacts/android-bubble-chat/final-boot.json`。
- 当前模拟器自带输入法仍是 `com.android.inputmethod.pinyin/.InputService`，没有切换键盘或添加键盘权限；实体输入、回车与焦点已验证，真实软键盘遮挡和中文候选需在真实设备自带输入法上实测。此前云端账号、真 ARM/HyperOS 长时和完整功能对齐边界继续保留；本轮完成气泡直接连续聊天的代码与模拟器验收，没有对外提交或发布。

依据：[Android 输入法可见性与悬浮窗标志](https://developer.android.com/develop/ui/views/touch-and-input/keyboard-input/visibility)、[窗口焦点标志](https://developer.android.com/reference/android/view/WindowManager.LayoutParams#FLAG_NOT_FOCUSABLE)、[系统键盘与 Insets](https://developer.android.com/develop/ui/views/layout/sw-keyboard)。

## 从气泡发起受控手机操作（2026-10-20，Codex）

- 新增 `scripts/smoke-android-bubble-tools.mjs`，在同一最终包上验证原生气泡、共享 Agent、无障碍观察、实体审批与操作后继续聊天。使用本机模型协议服务及无网络临时靶场，没有真实账号或外部业务调用。
- 三种场景通过：逐项批准后目标计数只增加一次；拒绝后不点击；用户改动目标后拒绝旧引用。每次审批期间聊天窗口实际让开，观察到的是目标应用；完成后主应用没有进入前台，回复与输入中的下一条草稿回到原气泡。截图 `allow.png`、`stale.png` 已查看。
- 报告 `.artifacts/android-bubble-tools/result.json` 包含三种场景与清理检查，绑定当前 SHA-256 `ffdc52cac6cf2b00a1c3d136215e1b6dae5096ce403f970d8a127a0c0e53b25b`。本轮仅新增验证与核对文档，产品代码和 APK 未改动。测试第一次把核心任务出现误当作原生窗口已移除，另两次遇到原生按钮大写标签的测试匹配问题；原始报告保留，改为等待真实窗口和规范化标签后完整重跑通过。
- 已移除临时靶场，恢复原模型、会话集合、宠物设置与原输入法。重新执行最终状态检查，确认核心 ready、常驻与悬浮窗运行、无障碍已连接、无活动任务/录音或测试凭据，见 `.artifacts/android-bubble-chat/final-boot.json`。新增验收核对文档区分当前包与历史组件证据，继续保留真实服务和设备验收缺口。

## Go 致命错误分类与执行器兼容性调查（2026-10-20，Codex）

- 本轮通过独立无网络 APK 完成 2016 次 CLI 调用对照，记录 68 个非预期结果；单核、禁原子指令、原 JSON、Go 1.26 与旧 GC 均未得到完整通过批次。输入诊断的长度、摘要一致且原 JSON 合法，因此不把解析错误归因于已证实的管道截断或某一个 JSON/GC 实现。详细矩阵、原始报告和范围见 [执行器兼容性调查](21_Familiar_Android执行器兼容性调查.md)。
- 实际 Go panic、fatal 和致命信号可退出 2，旧执行器只对信号/null/大于等于 128 的退出码标记中断，存在把 Go 崩溃当普通业务失败的问题。`runner.ts` 现识别退出 2 的这些标准错误格式，外层工具保持结果未知、提示核对目标内容、不自动重放。普通输入校验错误保持原分类；四次明确调用只启动四个进程的回归通过。
- **174 项核心测试、类型检查和 Windows 构建通过**，日志 `runtime-fix-all-tests.log`、`runtime-fix-typecheck.log`、`runtime-fix-windows-build.log`。Android 构建生成 APK，七个 ARM64 库、依赖与 ELF/ZIP 16 KiB 对齐、独立 v2 签名检查通过；检查实际构建子进程均已结束后，清理仅剩 conhost 的输出捕获。解包检查确认新错误分类进入实际核心资产，见 `.artifacts/android-runtime-fix/packaged-core.json`。
- 实验构建全部留在隔离目录；生产仍使用原 Go 1.27.2、CLI `07fc29b8e6483ab9e853453ab43981e62315e995e84a6813c30880859a1b3052`。新 APK **131794202 字节**，SHA-256 **ae4f0a85b4981eec31e196d9d41bc23d6897a945cf727618ff79624b4ed1a147**，已安装并交付。上一份气泡包保留为 `Familiar-0.3.0-arm64-debug-bubble.apk`。
- 新包办公回归在文档帮助步骤实际复现执行器中断，回复为 `interrupted: process-failed`、`outcome: unknown`，原凭据、模型、会话和宠物设置清理恢复成功。该回归没有完整通过，原始报告 `.artifacts/android-runtime-fix/office-device/office-device.json` 与日志均保留，没有把前五项入口检查及清理通过当作全部办公验收通过。
- 同包 **8 组气泡连续聊天通过**，实体点击不打开主应用、输入/换行、连续上下文、停止、草稿、会话切换与原输入法检查保持；报告 `.artifacts/android-runtime-fix/bubble-chat/result.json`，实际连续聊天截图已查看。旧审批/停靠/气泡操作矩阵保留，本轮没有全部重跑。
- 安装后，系统设置仍停留于此前打开的服务详情页，旧恢复脚本按列表入口查找失败；检查真实页面后，改为识别已打开的灵伴详情与主开关，保留此前授权。最终 `.artifacts/android-runtime-fix/final-boot.json` 确认摘要一致、核心 ready、常驻与悬浮窗运行、无障碍已连接、原会话/模型/宠物设置与设备输入法恢复，没有测试应用、凭据或活动任务。本轮完成异常处理修正与证据核对，执行器转译稳定性、真实服务与整体功能对齐继续进行；未提交、推送或发布。

## 原生对话气泡视觉调整（2026-10-20，Codex）

用户要求输出和输入都呈现自然气泡，去掉表单与边框感。本轮只改原生悬浮界面，继续沿用桌面版奶油色、鼠尾草绿和圆润角色风格。

- `PetBubbleChat` 改为透明根布局，上方奶油色回复气泡随文字宽高收紧，下方浅绿输入气泡承载原生多行 EditText。去掉外层描边、标题栏、重复的上一条输入、紫色输入下划线和整排大按钮；发送/停止共用末尾图标位置，关闭位于回复角上，“打开应用”保留在长按菜单。小图标仍有 48dp 点击范围和可访问标签。
- 新增 `PetBubbleStyle.kt`，用 Android Drawable / Path 绘制弯曲尾巴、纸面柔和阴影和矢量图标。尾巴随上下放置翻转并朝向宠物，轮廓合并后绘制，修复首轮看到的尾巴接缝。普通输出 `PetBubble` 使用相同样式；输入增加行数时重算窗口高度，长回复限定高度并可滚动。没有新增权限、远端接口或替换系统输入法。
- 发送、停止、会话绑定、迟到回执保护和进程内草稿继续使用原逻辑；私有通道与逐步审批没有改变。解包比较共享核心 `assets/runtime/main.cjs` 和官方 ARM64 CLI，摘要分别仍为 `4c8eec7914a038da5671680915f4baec410b77b4ecb4115f694cddd1929a8a7a`、`07fc29b8e6483ab9e853453ab43981e62315e995e84a6813c30880859a1b3052`。记录 `.artifacts/android-bubble-design/unchanged-core.json`；此前 174 项核心测试、类型检查与 Windows 构建证据保留，本轮未重复运行未改变的共享核心。
- 当前最终包 **8 组气泡聊天检查通过**，报告 `chat-final/result.json`；**7 组布局与清理检查通过**，报告 `layout-final/result.json`，覆盖短回复收紧、十八段长回复滚动、两行输入、48dp 点击区域、左上/右下宠物位置、尾巴翻转、普通输出以及原位置恢复。实际截图 `short-right.png`、`below-left.png`、`speech-only.png` 已查看。首次布局检查在拖动释放输入焦点后直接读取活动窗口可访问树，得到桌面树而非聊天树；截图确认草稿仍在，清理成功，首轮 `layout/result.json` 保留。改为重新轻点宠物后读取，最终全部通过。
- 同包 **三种气泡手机操作场景与清理通过**，报告 `tools-final/result.json`：批准后计数只增加一次、拒绝不执行、用户接管后拒绝旧目标；审批后回复和下一条草稿回到气泡，主应用保持后台。实际 `allow.png` 已查看。**6 组停靠回归通过**，报告 `.artifacts/android-device/bubble-design-docking-check.json`，原偏好和位置精确恢复。
- Android 原生编译生成最终 APK，七个 ARM64 库、依赖、ELF/ZIP 16 KiB 对齐与独立 v2 签名验证通过。主交付 `release/android/Familiar-0.3.0-arm64-debug.apk` 为 **132187543 字节**，SHA-256 **c65b3c5462fc6115d7d3ff585231d637f49f7d3aaf56abb022a21d0cf2050b18**，已覆盖安装到 emulator-5554，安装/构建/交付文件摘要一致。上一份执行器包保留为 `Familiar-0.3.0-arm64-debug-runtime-guard.apk`。
- 最终 `.artifacts/android-bubble-design/final-boot.json` 核对 **25 组当前包设备检查**，核心 ready、常驻与悬浮运行、无障碍已连接，原模型、会话集合、宠物设置和输入法恢复，无活动生成、录音、测试凭据或临时靶场，ADB 转发清理。最终回到桌面供继续使用。当前模拟器自带输入法仍为零高度，真实键盘遮挡/中文组字、真 ARM/HyperOS 和执行器稳定性等既有边界保留，本轮没有将视觉修改当作这些项目验收完成。没有提交、推送或对外发布。

本轮证据除停靠报告外均位于 `.artifacts/android-bubble-design/`。平台绘制与可访问性依据：[Android Drawable](https://developer.android.com/develop/ui/views/graphics/drawables)、[RippleDrawable](https://developer.android.com/reference/android/graphics/drawable/RippleDrawable)、[可访问标签和触摸目标](https://developer.android.com/guide/topics/ui/accessibility/apps)。

## Unicode 参数边界与气泡提示焦点（2026-10-20 至 21，Codex）

- 复现并修正 Android Go 校验按字节、桌面按 UTF-16 单位计数的差异。每项最多 32000 单位，非 BMP 字符计两个单位，总请求仍限制 128 KiB。共享语料同时驱动 Go/TypeScript，旧版本有五类合法 Unicode 边界被错误拒绝；修复后 6 组 Go 测试、176 项核心回归与类型检查通过。Windows 和无网络 ARM64 夹具各 15 次官方 CLI dry-run/拒绝检查通过，正文摘要匹配，未提供真实 Token 或向飞书写入。
- 主 APK 的实体审批场景确认 11000 单位 / 33000 UTF-8 字节中文被完整交给官方 CLI，随后在模型续答时触发共享容量检查。原气泡实际显示估算 72496 / 28416，未提高窗口或降低预算规则。主程序办公诊断还复现文档帮助的执行中断，返回结果未知且不自动重放；完整办公和超长对话场景没有标为通过。阶段报告、原始失败、轨迹及实际截图保留，详细范围见 [执行器兼容性调查](21_Familiar_Android执行器兼容性调查.md)。
- 诊断后回归发现：已切换会话的原生输入窗口再次被宠物唤出时，`focusRequested` 因 conflict 分支被跳过，提示虽可见但活动可访问树仍是桌面。原始 `.artifacts/android-unicode/chat-final/result.json`、`failure.png`、`failure-ui.xml` 保留。`PetBubbleChat.focusIfRequested` 现在对明确唤出的冲突提示取得窗口焦点并聚焦根节点；保留草稿和明确切换，不唤起输入法或自动改会话。
- 最终包 **9 组直接气泡聊天检查通过**，新增冲突后再次点宠物恢复提示焦点的真实触摸检查，报告 `chat-verified/result.json`。同包 **三种手机操作场景及清理通过**，报告 `tools-final/result.json`；批准后只点击一次、拒绝不执行、目标变化后拒绝旧引用，之后回复和草稿回到气泡。已有气泡形状、配色、输入图标和 48dp 点击区域保持。
- 发现并去除 Gradle 增量 APK 中未引用的旧压缩段。构建脚本仅删除目标生成 APK 后重新打包，原交付备份保留；通过正常 Android 构建得到退出码 0。七个 ARM64 库、依赖、ELF/ZIP 16 KiB 对齐与独立 v2 签名通过。本地构建/安装/交付文件一致：**131818714 字节**，SHA-256 **a272a12ea3125e1b19cea43072d086325a9ef8287b91cf741cedfc9b1e05f3cd**。
- CLI 为 **50129512 字节**，SHA-256 **9f8d92c9de42d307be9454dd3d1b5a232a9862e43eab6187766b89aaa52fce44**，与 15 次 ARM64 检查相同。最终包相对前一份 Unicode 包逐项读取 1338 个归档条目，只改变 `classes3.dex` 与构建时间标记；共享 JS 核心仍为 **4c8eec7914a038da5671680915f4baec410b77b4ecb4115f694cddd1929a8a7a**。记录 `final-package-content-proof.json`；没有把原样式包的 7 组布局和 6 组停靠当作本包重跑结果。
- 主交付仍为 `release/android/Familiar-0.3.0-arm64-debug.apk`。Unicode 中间包保留为 `Familiar-0.3.0-arm64-debug-unicode.apk`，上一份样式包保留为 `Familiar-0.3.0-arm64-debug-bubble-style.apk`。最终 `final-boot.json` 确认核心 ready、常驻/悬浮运行、无障碍已连接，原模型/会话集合/宠物偏好/输入法恢复，测试应用与凭据移除，无活动生成/录音及遗留转发，返回桌面继续使用。

本轮记录位于 `.artifacts/android-unicode/`。完整办公、真实账号服务、真实输入法与 ARM/HyperOS、以及 Windows 全功能对齐仍有待验证或平台差异；整体目标继续进行，没有提交、推送或对外发布。

## 常驻停止、权限撤回与无障碍恢复（2026-10-21，Codex）

- 实测 Android 系统停止应用后，自身无障碍开关可能仍开启，但服务未连接、系统显示“无法运行”。原状态仅依据服务实例而显示“未授权”，现区分“已断开”，能力卡片及详情提示用户先关闭再开启。只读取 `Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES` 并匹配自身 ComponentName；已连接仍以自身实际实例为准。没有新增权限或自动修改系统开关。
- 新增 `scripts/smoke-android-lifecycle.mjs`，支持完整检查与按阶段运行。同一新包的 **9 项完整回归通过**：实际通知栏“停止伙伴”取消未结束的流式请求并移除窗口；小窝手动重启不重放旧回复；可见系统设置撤回悬浮窗后窗口消失、状态更新，重新允许后手动恢复；Android 官方 `cmd activity stop-app` 停止整包，重新打开不重放回复或自动录音；已启用却断开的无障碍显示恢复提示；撤回再允许后旧观察拒绝、计数保持零，重新观察和逐项批准后仅点击一次；原配置与输入法恢复。证据 `.artifacts/android-lifecycle/final-verified/result.json`。
- 悬浮窗撤回时本机 `:runtime` 进程未改变，已开始的后台回复可以继续，符合应用允许不显示宠物仍保持常驻的既有设计；测试随后显式取消回复。没有把“窗口消失”写成整个后台被停止，也不承诺系统停止后自动复活。
- 首次报告和失败保持：早期 `result.json` 因系统停止后的无障碍尚未连接失败；`accessibility-verified/intervention.json` 标明后台控制 WebView 冻结时手动打开过一次 Main；新包 `final/result.json` 在审批调试端口刚创建时连接失败。测试改为权限切换后重新附加控制页、等待调试端口就绪，并先取消待批任务再恢复配置；随后 `final-verified` 在无人补操作的情况下通过全部 9 项。原始错误和独立恢复记录未覆盖。
- 本轮类型检查、正常 Android 构建与独立 v2 签名核验通过。新包 **131819226 字节**，SHA-256 **952e0ba07f9c737b77cc8acbe760c134d846692567445dbe0ad64636a7134711**，已安装至当前模拟器。七个 ARM64 原生库、依赖闭包与 ELF/ZIP 16 KiB 对齐通过；上一包保留为 `Familiar-0.3.0-arm64-debug-permission-baseline.apk`。
- 逐项读取 1338 个归档条目，只改变 `classes3.dex`、包含新界面资源的 `libfamiliar_mobile_lib.so` 与构建时间标记。共享 JS 核心仍为 **4c8eec7914a038da5671680915f4baec410b77b4ecb4115f694cddd1929a8a7a**，CLI 仍为 **9f8d92c9de42d307be9454dd3d1b5a232a9862e43eab6187766b89aaa52fce44**。上轮 176 项核心、6 组 Go 以及两端各 15 次 Unicode 组件证据据此保留，未称为本轮全量重跑。既有办公中断与超长结果上下文限制仍未根治。
- 同包 **9 项气泡聊天检查**再次通过，原生外层透明、纸色回复尾巴、浅绿输入、连续聊天与冲突后焦点保持；实际 `chat-verified/chat-continuous.png` 已查看。**三个气泡手机操作场景及清理通过**：批准、拒绝、目标改变，均回到原气泡并保留草稿，主应用保持后台。脚本此前依赖已安装靶场，生命周期测试清理靶场后导致 `tools-verified` 首次启动失败；现自建并卸载无网络靶场、等待审批调试端口，独立 `tools-final/result.json` 完整通过，原失败报告保留。
- 另外 **3 项单阶段检查通过**，含恢复详情文字与系统停止阶段自身清理，记录 `recovery-ui/result.json`。最终 `.artifacts/android-lifecycle/final-boot.json` 核对构建/安装/交付摘要一致、核心 ready、常驻与悬浮可见、无障碍连接；原 Provider、会话集合、宠物位置/偏好与输入法恢复，无活动回复、待批任务、录音或测试凭据，测试应用和转发端口已移除，返回桌面。未提交、推送或对外发布。

依据：[Android 用户停止前台服务应用](https://developer.android.com/develop/background-work/services/fgs/handle-user-stopping)、[运行时权限按实际状态检查](https://developer.android.com/training/permissions/requesting)、[悬浮窗授权入口](https://developer.android.com/reference/android/provider/Settings#ACTION_MANAGE_OVERLAY_PERMISSION)、[已启用无障碍服务列表](https://developer.android.com/reference/android/provider/Settings.Secure#ENABLED_ACCESSIBILITY_SERVICES)。当前检查使用现有模拟器和本机协议靶场；真实 ARM/HyperOS、手机自带输入法与真实账号验收边界继续保留。

## 长工具轮次的完整归档与续答（2026-10-21，Codex）

- 原先 11000 字中文参数的 CLI 预览已完整返回，但参数和结果同时进入下一请求，保守估算达到 72496 / 28416，最终停在上下文保护。本轮修改 Android 与 Windows 共用的 Agent：先沿用工具自身压缩和按需目录；仍超预算时，将完整、已执行完且无图片的工具轮次写入既有上下文原文索引，再给模型明确标记的历史摘录、SHA-256 和 `context_read` 引用。只改变后续请求，原调用参数、结果和原生签名仍留在审计轨迹；原生私有块不写进可回查原文。不完整调用、配对不符或图片轮次不进入该归档，原预算保护继续生效。
- 去掉共享工具层固定 32000 字符的文本截断，工具自身的执行/输出限制和既有会话轨迹长度保护保持。模型回查默认每页 4000 字符，可显式指定 1–16000；分页不拆 emoji。移动界面的原文读取仍沿用默认 16000 字符，未改变已有页面协议。原文索引写入与按会话删除统一串行，取消后不把迟到归档重新写回已删除会话。
- **181 项核心回归、类型检查及 Windows 构建通过**。新增检查覆盖 32K 模型循环下的长中文参数与大于 32000 字符的完整结果、目录检索/回查两端尾部、单次写审批与单次执行、原生块不泄漏、分页/重启/按会话清理、删除期间取消排队写入，以及写入失败/取消和未完成/图片轮次保护。初次全量发现移动端页长回归，已恢复原接口默认值；飞书测试另外修正为同时等待 waiting 和远端 WebSocket 实际关闭，保留零连接断言。原失败日志及最终日志均保存在 `.artifacts/android-tool-context/`。
- 当前模拟器的真实主程序及官方 ARM64 CLI 再验同一 **33000 字节中文**请求：实体批准后返回 **33839 字节**原始预览，正文摘要仍为 **83c6539826979d436fd963e95e39243f0f26c988177c15080bb8693de6a842b4**。模型通过按需目录找到 `context_read`，查询 `dry_run` 和结果尾部 `extra_param` 后完成可见续答；该过程后续请求消息与工具定义最大 **19051 字节**。报告 `office-unicode/office-device.json` 共 7 项通过，包含清理；这是本机模型协议与离线 dry-run，没有实际飞书云端写入，也没有对中断业务自动重试。
- 新 APK **131821158 字节**，SHA-256 **a183ed487230628c31fa994edb0e8a9dc9614709bf05d194f45f8379177063c6**，正常 Android 构建、七个 ARM64 库/依赖、ELF/ZIP 16 KiB 对齐及独立 v2 签名通过，已安装。上一包保留为 `Familiar-0.3.0-arm64-debug-tool-context-baseline.apk`。逐项比较 1338 个归档条目，仅共享核心与构建标记改变；原生库、原生窗口和界面资源均相同。新核心摘要 **77454a6355ef4ccb051ca61393f07b41f7d938661c25e3c26180859615270c88**；CLI 摘要仍为 **9f8d92c9de42d307be9454dd3d1b5a232a9862e43eab6187766b89aaa52fce44**，原两端各 15 次 Unicode 组件证据保留，未重复运行兼容性大矩阵。
- GitHub 登录差异已核查官方 [远程 MCP 接入指南](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md)：远程服务不提供动态客户端注册，宿主浏览器授权需要注册应用。当前产品仍只有 Token 接入，没有配置本应用的 OAuth 注册信息；这项缺口继续保留，未借用其他软件的应用身份或把 Token 表单当作浏览器登录完成。
- 同一最终包 **9 项气泡聊天与三个手机操作场景/清理再次通过**，保留纸色回复尾巴、浅绿输入和透明外层，完整宠物轻点直接聊天。`final-boot.json` 核对交付/构建/安装摘要一致、常驻与悬浮正常、无障碍已连接，原模型/会话/宠物/输入法恢复；临时凭据、会话和测试应用移除，工具归档在删除会话后已清空，转发端口清理。上一包 9 项常驻权限与 3 项恢复详情矩阵保留为历史分项，本轮未重复完整矩阵。仅本地开发，没有提交或推送。

本轮解决的是已完成长文本工具轮次导致的续答阻塞，未解决 Houdini 下 Go 执行器已有的致命退出，也未证明所有真实账号和手机端业务已验收。整体目标保持进行中。

## 自然气泡与输入布局（2026-10-21，Codex）

- 按用户要求继续调整原生悬浮聊天。透明根窗口保持，奶油色回复和浅绿输入均使用曲线尾巴、柔和纸面及轻阴影，无描边或外层表单卡片。输入从 184dp 随草稿伸展至最多 260dp，支持三行；短回复按文字收紧，长回复限高滚动，图标仍保留 48dp 点击区域。
- 回复排列在靠近宠物的一侧，输入错位放在外侧；移到宠物下方时翻转顺序与尾巴，调整 View 顺序保留输入连接。已在当前包实际验证短回复、十八段长回复、多行草稿、左上/右下位置、普通输出和配置恢复，共 **7 项布局检查**；截图和几何数据位于 `.artifacts/android-bubble-refine/layout/`。新增可复用脚本 `scripts/smoke-android-bubble-layout.mjs`。
- 同包 **9 项聊天**及**三个手机操作场景和清理**通过：连续输入/上下文、停止、收起重开、会话冲突、返回键、草稿恢复；批准仅执行一次、拒绝无执行、用户接管后旧操作拒绝，回复与草稿回到气泡，主应用保持后台。使用模拟器现有拼音 IME；真实手机软键盘/候选栏仍待验收。
- **191 项核心回归、类型检查、Windows/Android 构建、七个 ARM64 库/依赖、ELF/ZIP 16 KiB 对齐和 v2 签名通过**。包为 **131833686 字节**，SHA-256 **44e8ac18c6557b3ae542de1fcbe688e397fb0b7a7b0946f78ebf57a1e3d23e21**，已安装 emulator-5554；前包 a183 保留为 `Familiar-0.3.0-arm64-debug-bubble-refine-baseline.apk`。CLI 及其他原生依赖库摘要不变，未重复执行 Go 兼容性大矩阵或把前包 CLI 长文本记录算作本包重跑。
- 同包保留已开发的 GitHub 设备授权：可配置公开 Client ID、获取/打开验证码、取消、加密保存、刷新、绑定官方 MCP 或清除登录，Runtime 独立持有授权。13 项协议及 8 项 UI 检查通过；APK 验证未配置时不能授权或打开页面、拒绝额外 URL，保留原有高德/Exa 默认配置。没有提供注册 Client ID，真实 GitHub 登录及浏览器交接未验收，未向外部提交夹具凭据。交互与官方依据见 `android-ui/INTEGRATION.md`。
- `.artifacts/android-bubble-refine/final-boot.json` 核对构建/安装/交付文件一致、常驻和悬浮运行、无障碍已连接、原会话/模型/宠物偏好/输入法恢复，无活动生成或录音，测试应用与端口已清理，回到桌面。最终核对初次误把原有高德/Exa 停用配置当成应为空，修正检查后通过；首次日志保留，没有删除用户配置。

绘制和输入法依据：[Drawable](https://developer.android.com/reference/android/graphics/drawable/Drawable)、[系统输入法可见性与焦点](https://developer.android.com/develop/ui/views/touch-and-input/keyboard-input/visibility)。整体 Android 目标继续进行，真实服务、ARM/HyperOS 与执行器稳定性边界保持。

## Go/Wasm 办公执行与最终包复验（2026-10-21，Codex）

当前内置办公改用同一官方 CLI 的 Go/Wasm 构建，在 ARM64 Node 的独立 Worker 内执行。新增 `wasm-runner.ts`、`wasm/worker.cjs`、`filesystem.cjs` 与 `workspace.cpp`，Android Runtime 私有装配，不增加公开桥参数或页面设置。原生 `libfamiliar_lark.so` 不再进入 APK；打包的七个 ARM64 库中改为原生受限文件代理 `libfamiliar_workspace.so`。身份、加密凭据、共享 Agent 权限和结果未知语义保持，不在失败后切换另一条路线或重放操作。

- 构建固定 Go 1.27.2、官方 CLI 1.0.96 / `cb5a3d704379552dc61e37898e5f74798783190d`。新 `build-android-feishu-wasm.ps1` 复用已验证源码准备，再用独立模块副本和 Go 编译覆盖层补齐不支持的平台入口；默认密钥链、原生终端/剪贴板等拒绝执行。`build-android-runtime.mjs` 打包匹配的 Go 运行文件、Worker、文件封装与许可证；APK 验证逐项核对资源摘要，并拒绝旧原生 CLI 混入。业务 Wasm **86749369 字节**，SHA-256 **7d16f635be224646599b864b26afe4846c9fc092c9b29129be92afdabdb97398**。
- 原生文件代理逐层 `openat` 固定父目录、拒绝符号链接及多硬链接文件，先验证句柄再截断；Worker 只见工作区、私有配置和每次调用的临时目录。同步文件调用只发生在独立 Worker，Go 退出后不再回调。Node-API 环境清理负责强制结束时关闭所有原生句柄。网络由父 Runtime 持有和取消，令牌只发到指定官方来源，不跟随重定向；已尝试发送后失去响应会终止 VM 并返回结果未知。内置发行内容随 APK 更新，通过上游支持的两个 notifier 环境选项禁用 CLI 背景检查。
- 最终独立测试 APK 不申请 INTERNET 权限，与主应用数据隔离。产品执行器 **72 项检查**通过，其中 **54 次 VM 执行、18 次创建 Worker 前拒绝**；包括两种身份、受控 HTTP GET/POST、业务域帮助、Unicode 和重复调用。另有 **6 组 Go 测试无跳过、13 组原生文件检查、4 次真实 VM 网络等待时取消**通过。原生检查含 512 次并发目录/链接交换，以及八次强制停止各持有 65 个文件/目录句柄的 Worker。临时目录清空、请求只发一次、取消释放网络，句柄未累计；主 Runtime PID 与安装包在隔离检查期间保持不变。证据 `device-product-full-2024c689-2f47-4d8e-b8ca-7848f527ca61-report.json`，组件随后移除。
- **194 项核心回归、类型检查和 Windows 构建通过**。同一新主包的完整办公 **11 项含清理通过**：真实设置入口、缺凭据与身份边界、文档帮助、实体批准/拒绝、日历 POST 预览、工作区外文件拒绝和长中文续答。33000 字节中文保留 **33839 字节**官方预览，正文摘要 **83c6539826979d436fd963e95e39243f0f26c988177c15080bb8693de6a842b4**；模型查询归档头尾后完成续答，后续消息/工具定义最大 **21038 字节**，没有提高 32K 回退窗口。报告 `office-main-final/office-device.json` 使用本机模型协议与离线 dry-run，没有向飞书发送夹具凭据或云端写入。
- 同包 **7 项气泡布局、9 项连续聊天、三个手机操作场景及清理**重新通过，分别位于 `layout-final/`、`chat/`、`tools/`。奶油色回复、浅绿输入、透明外层、曲线尾巴及自适应排列保持；模型/会话/原设备输入法、宠物偏好和位置已恢复。批准执行一次、拒绝不执行、用户接管后旧操作拒绝，主应用保持后台，返回后仍在原气泡聊天。真实手机软键盘、候选条和组字仍待验收。
- 新 APK **135733079 字节**，SHA-256 **03639a2eb8fb5f136a29e5385064aed19f4821efd24ea00f1da6926da3e178cf**，共享核心 **4914770e16fb80d904c354dec5e5c0be17e1fb1b95441f6476e468debcc92f86**。正常构建、七个 ARM64 库/依赖闭包、ELF/ZIP 16 KiB 对齐及独立 v2 签名检查通过，已安装 emulator-5554；上一包 44e8 保留为 `Familiar-0.3.0-arm64-debug-office-native-baseline.apk`。`package-content-proof.json` 核对最终 Worker 与源码、全部办公资源与清单一致，旧 Go 原生文件未打包。
- `final-boot.json` 核对构建/交付/安装摘要一致、核心 ready、常驻/悬浮运行、无障碍已连接，原模型/会话/宠物/输入法恢复，无活动生成、任务或录音。测试凭据、会话、夹具和转发端口清理后回到桌面；GitHub 仍为未配置、未登录，原有高德/Exa 停用配置保留。没有提交、推送或外部发布。

原始失败同样保留于 `.artifacts/android-office-wasm/`：手工测试附加库误链接静态 libc 导致转译加载器崩溃，现使用动态库并由产品验证依赖；句柄测试按 Android 路径别名匹配失误，现按设备/节点标识核对；网络丢失保护曾中断 CLI 自带的背景更新，现使用官方禁用选项；主程序测试首次连接审批 WebView 过早，脚本现等待端口就绪；布局清理最初误把自动睡眠/触摸唤醒的瞬时 action 当成用户偏好，现只核对持久设置并另外记录动作。没有据失败轮宣称通过，修正后的报告单独保存。

完整路线、有限样本范围与依据见 [执行器调查](21_Familiar_Android执行器兼容性调查.md)。原生 Go/Houdini 的原始故障根因仍未定，产品已使用另一条执行路线；当前实际模型、真实账号与云端业务、真 ARM/HyperOS、真实键盘和长期功耗仍需验收。Android 整体目标继续进行。

## 可选登录设置损坏的启动隔离（2026-10-21，Codex）

本轮复现 `github-oauth-client.json` 保存无效 Client ID 时，`githubDeviceAuth.start` 抛出 `INVALID_INPUT`，导致整个 Kernel 启动失败。JSON 读取失败也没有局部处理；部分错误类型虽不触发该判断，却会给公开状态返回错误的字段类型。这属于可选集成影响常驻宠物和普通聊天的问题，不能用保持空白配置的正常启动检查替代验证。

- `githubDeviceAuth` 现在仅禁用该登录功能，保留损坏文件及旧登录。公开 Client ID 返回空字符串、未连接和 `configurationError: true`，界面提示重新保存；未确认前不自动覆盖文件、使用旧令牌或请求外部授权。移动桥仅投影布尔标记，错误内容和旧令牌不进入页面。UI 保留现有样式，在损坏状态允许重新保存空值；沿用确认弹窗告知会清理设备旧登录及断开相关工具，取消保留原文件。确认后即使内存 Client ID 仍为空，也清理/停用旧设备登录绑定；旧 revision/expectedKey 检查继续保护并发保存的新 Token。
- 核心新增两项完整启动/聊天回归，覆盖八种无效内容（URL、null、false、0、对象、数组、损坏 JSON、空文件）、原文保留、无自动网络请求、无效保存拒绝、显式空值修复及重启恢复；另一项保留旧登录并完成普通共享聊天，随后明确修复并核对旧 MCP 绑定停用/清除。`before-fix.log` 和 `binding-before-fix.log` 分别保留启动失败与旧绑定未停用的复现。最终 **196 项核心回归、类型检查、Windows 构建**通过，**9 项 GitHub 前端交互**通过，包含修复确认可取消和四种宽度；测试没有向 GitHub 发送夹具凭据。
- 最终主 APK 的 **5 项恢复检查**通过：无效 Client ID 冷启动仍有核心与宠物、实际共享 Agent 普通流式聊天、真实设置页取消/确认修复、损坏 JSON 冷启动不覆盖原文件且不重放旧聊天、逐字恢复原文件/模型/会话/宠物偏好。使用无登录、无模型密钥且无活动任务的开发模拟器；仅修改已备份的这一份公开设置，原文件不存在时最终恢复为不存在。模型服务仅在本机，整个过程只收到一次聊天请求。记录 `device-complete/result.json` 绑定最终 APK，两次受损启动的进程号独立记录。
- 同包 **11 项完整离线办公、9 项气泡聊天、三个手机操作场景及清理**再次通过。33000 字节中文仍生成 33839 字节预览，正文摘要不变；归档头尾查询后完成续答，后续消息与工具定义最大 21038 字节，未放宽 32K 回退窗口。气泡批准执行一次、拒绝不执行、接管后旧操作拒绝，返回原气泡与草稿，主应用保持后台。数据与截图位于 `office/`、`chat/`、`tools/`。
- 最终 APK **135733467 字节**，SHA-256 **641056e310a2c1b4974511cc57cffa7d32296fa687ce35dc4de1bb830f08b106**，共享核心 **e1a561e47db07b830cbebed71118a3d478c8d9405e18cb6b1c3e347e008bce49**，已安装 emulator-5554。七个 ARM64 库、依赖闭包、ELF/ZIP 16 KiB 对齐及独立 v2 签名通过。上一包 0363 保留为 `Familiar-0.3.0-arm64-debug-startup-baseline.apk`。六个原生运行依赖、办公 Wasm/封装资源保持摘要；包含更新后前端的 Tauri 应用宿主重新生成。另逐项核对 Manifest、DEX、原生资源及角色 SVG 与上一包一致，前包 7 项布局、72 项办公组件和原生句柄/取消证据保留，没有冒充本包重跑。
- `final-boot.json` 核对当前构建/交付/实际安装一致，常驻与悬浮运行、无障碍真实连接，原模型、会话、宠物位置和输入法恢复；公开 GitHub 文件逐字恢复，无活动生成、任务或录音，测试应用、凭据和转发清理。冷启动测试后的原无障碍连接经可见系统设置恢复，最后回到桌面。没有自动对抗系统停止，也没有因此把常驻语义扩大为强停后自动复活。

原始失败证据保留在 `.artifacts/android-startup-resilience/`：首轮设备夹具遗漏 `/v1/models`，其错误又阻止原清理等待；随后用原快照识别唯一测试会话并独立恢复，`first-run-restored.json` 核对完成。夹具补齐目录并让清理独立于测试服务错误，后续两个完整轮次单独记录，最终验收只引用最终包 `device-complete/`。首次包内容断言误将嵌入前端的 Tauri 宿主也视为应保持摘要，已核对 `generate_context!` / `frontendDist` 及 ELF 节差异，改为精确比较六个未改的运行依赖和原生界面表面；没有掩盖宿主库变化。中间包保留于本轮证据目录。

冷启动通过 ADB 强制停止后手动打开构造，用于检验损坏设置恢复，不代表所有后台回收策略。平台停止和权限边界仍依据 [Android 前台服务停止](https://developer.android.com/develop/background-work/services/fgs/handle-user-stopping) 与 [ADB 文档](https://developer.android.com/tools/adb)。本轮解决可选设置阻断核心的问题；实际模型、真实账号和云端业务、真实键盘、ARM/HyperOS 与长期功耗仍需验收，整体目标继续进行。

## 真实 Exa、停靠与控制页退出核对（2026-10-21，Codex）

本轮保持同一 **641056e310a2c1b4974511cc57cffa7d32296fa687ce35dc4de1bb830f08b106** ARM64 APK，没有修改产品代码、重建或发布。新增可复用的 `scripts/smoke-android-exa-live.mjs` 和 `scripts/smoke-android-controller-exit.mjs`，并在 emulator-5554 运行既有停靠检查。没有操作其他模拟器。

- 真实 Android Runtime 经共享 MCP 连接官方 `https://mcp.exa.ai/mcp`，读取 `web_search_exa` / `web_fetch_exa`，完成一次固定公开搜索。返回 **6561 字节**结果，含 [Android 后台启动限制](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start) 和 [前台服务故障排查](https://developer.android.com/develop/background-work/services/fgs/troubleshooting)。**3 项检查**通过，记录 `.artifacts/android-exa-live/verified/result.json`。无账号、无密钥；本机 SSE 模型夹具负责规划和续答，两次请求不代表真实 LLM。公开搜索沿用原参数与权限检查，批准卡次数为 **0**，不能称为用户批准过此搜索。
- 使用服务实际公布的参数 schema，不猜模型侧散列别名。当前搜索要求 `query` 和 `objective`，允许 `numResults`；脚本按实际 schema 提供固定公开检索目标。前两种夹具错误分别是工具别名不匹配和缺少 `objective`，后者被本地参数检查拒绝，未发出搜索；原始报告保留于 `final/`、`inspect/` 和根目录，成功证据单独在 `verified/`。官方 [Exa MCP 文档](https://exa.ai/docs/get-started/exa-mcp) 说明无密钥入口有基础能力与限额，当前结果不能覆盖 OAuth/账号 Agent 功能。临时 MCP 行、会话和本机服务清理，原模型与 MCP 设置恢复。
- 当前主包 **6 项停靠检查**通过：拖到最近边缘/角落、外滑收成 48dp 小脑袋、轻点或内拖展开、独立闲置开关的 10 秒自动收起、关闭吸附后的自由放置，以及原设置恢复。轻点小脑袋只展开，轻点完整宠物进入气泡聊天。报告 `.artifacts/android-device/current-arm64-docking-check.json` 与截图绑定同一 APK，吸附关闭、闲置 30 秒的原偏好和原位置均恢复。
- 只结束控制页 PID，不强停整个包；独立 Runtime **24363** 在 **120557ms** 的五次采样中未改变，控制页进程持续缺席，宠物窗口和前台服务保持。重开控制页后连接同一 Runtime，原模型、会话、宠物和输入法保持，**3 项检查**通过。记录 `.artifacts/android-controller-exit/result.json`。按 `/proc` 时钟和官方 `dumpsys meminfo` 读数，样本 PSS 为 **321.42–321.80 MiB**，相邻样本单核 CPU 约 **1.10–1.13%**；这是转译模拟器上两分钟空闲观察，不能当作真机功耗或长期常驻结论。未修改亮屏/供电设置，因设备报告安全锁屏，本轮没有主动锁屏、尝试解锁或测 Doze。[Android dumpsys](https://developer.android.com/tools/dumpsys#meminfo) 与 [Linux proc 文档](https://docs.kernel.org/filesystems/proc.html) 为读数依据。
- `.artifacts/android-acceptance-audit/final-boot.json` 再次核对构建/交付/实际安装摘要相同，原共享核心和办公资源保持，核心 ready、常驻/悬浮运行、无障碍已连接；原模型/会话/位置/输入法及公开 GitHub 文件恢复，无生成、任务、录音、测试凭据、夹具或转发残留。最后回到桌面。

Windows Familiar 的公开设置显示 DeepSeek `compatible` / `https://api.deepseek.com` / `deepseek-flash`；只投影公开字段，不读取、解密或复制密钥。仓库中的 MCP 开发配置与 Windows 已安装进程的实际来源区分记录，公开文件 `.artifacts/android-acceptance-audit/windows-public.json` 含 `credentialsRead: false` 与 `credentialsTransferred: false`。已询问用户允许复用 Familiar 自身 DeepSeek 密钥并少量测试，或由用户在 Android 自行配置，尚无答复，不进行依赖此许可的操作。

办公执行、启动恢复及本轮三个连续目标轮次均缺真实模型连接，而可独立完成的既定开发和模拟器检查已推进完毕。整体目标尚不能标记完成，结束本轮时转为等待配置（blocked）；后续依据用户的模型选择恢复真实服务验收。真实 ARM/HyperOS、软键盘、相机/真人语音及长期功耗保留为后续设备验证，不追加为首轮模拟器门槛。

## 授权复用 DeepSeek 与真实气泡/工具验收（2026-10-21，Codex）

用户随后明确回复“允许复用 Windows Familiar 的 DeepSeek 连接”，前节的等待条件由此解决。本轮使用同一 **6410** ARM64 主 APK，未修改产品代码或重建。新增 `scripts/smoke-android-deepseek-live.mjs` 与 `scripts/smoke-android-deepseek-tools-live.mjs`；前者的 Windows 迁移入口必须显式带 `--import-approved-windows-deepseek`，不把凭据发现/复制混入普通回归测试。

- 只读取 Windows Familiar 的选中 DeepSeek 凭据与自身 Runtime 的密文配置，以当前 Windows 用户的 DPAPI 解开所需主密钥，再按 Chromium 的 v10 AES-GCM 格式解密这一条凭据。没有启动另一个 Electron Runtime、改写 Windows 文件或读取其他应用凭据；源设置、密文和 Local State 的前后摘要相同。明文只经过内存和本机 CDP，由产品 `provider.save` 写入 Android `SecretVault`；加密文件不含该明文，内存字节随后清零，页面、命令参数、测试报告和 APK 不保存密钥。依据 [Chromium OSCrypt 实现](https://chromium.googlesource.com/chromium/src/+/e649194568cba439daa209c762442a6ad4534460/components/os_crypt/sync/os_crypt_win.cc)，只支持已识别的 v10 / DPAPI 格式，未知格式不猜测或回退。
- 保留 Windows 已选 `compatible` / `https://api.deepseek.com` / `deepseek-flash` 及已保存参数，没有替换供应商。实际 Android Runtime 从官方 HTTPS 获取两项模型目录，所选模型在列；固定短句真实流式连接 **1257ms** 完成。官方 [DeepSeek 思考模式文档](https://api-docs.deepseek.com/guides/thinking_mode/)要求带工具的后续轮次保留相关原生内容；本轮直接使用现有共享 Provider 路径，没有构造另一个专用请求层，也未把原生思考内容导出报告。
- 点击原生宠物，主应用留在后台。第一轮真实模型回复捕获 **4 个非空流式文本版本**；第二轮无需打开主应用，正确回忆上一轮生成的公开临时口令。两轮完成时间分别约 **5066ms** 与 **2415ms**。输入/输出保留自然气泡、曲线尾巴和设备原输入法，截图 `real-bubble-first.png` / `real-bubble-continuous.png`。**6 项迁移/连接/气泡/清理**检查通过，报告 `.artifacts/android-deepseek-live/result.json`。
- 清理气泡测试后，手动结束整个 Familiar 包并重新打开以验证持久化，不对抗用户停止。新 Runtime PID **27708** 从 Keystore 恢复同一连接，密文文件摘要未改变，真实短句再次在 **1994ms** 完成；七类 Provider 档案、原会话与宠物偏好保持。系统无障碍连接在这次测试强停后，经可见系统设置恢复原有授权，不改写系统 secure 值，最终状态为已连接。
- 新 Runtime 的真实 DeepSeek 经共享 Agent 调用一次官方 Exa `web_search_exa`，工具返回 **6557 字节**结果，随后模型根据实际结果续答。两次模型轮次、一个实际搜索调用，批准卡次数 **0**；结果含 Android 官方后台启动限制和启动前台服务页面。只投影工具名、结果长度、来源链接和可见答复，不保存原始请求或 `reasoning_content`。临时 Exa 行和会话删除，原 MCP 配置恢复。**4 项重启/联网工具/清理**检查通过，报告 `tools/result.json`。这次规划与续答使用真实模型，与前节本机模型夹具区分。
- `.artifacts/android-deepseek-live/final-boot.json` 核对当前交付/构建/实际安装摘要一致，共享核心和办公资源未变，常驻/悬浮正常、无障碍已连接，无生成/任务/录音或测试转发；保留授权 DeepSeek，原会话/宠物位置/输入法及其他配置恢复。此前归档压力测试仍为原 32K 夹具矩阵，未用本次沿用 Windows 的手工上下文参数替代其证据。其他账号业务、真 ARM/HyperOS、真实键盘和长期功耗的未验证范围继续保留。

真实模型配置缺口已解决，模拟器现在可直接使用气泡与 DeepSeek 连续聊天。本轮只迁移用户授权的这一项 Familiar 凭据，不因 Windows 仓库中存在 GitHub/高德等配置而自动复制其他账号；新设备安装 APK 仍须单独配置。


## 2026-10-21：1.0 正式签名、权限、日历时钟与迁移

当前正式交付为 `Familiar-1.0.0-arm64.apk`（`app.familiar.mobile`、独立发行证书、R8、调试关闭）。旧包另发 `Familiar-0.3.1-migration-arm64.apk`，保留原包名和证书、versionCode 3001；实际覆盖旧版成功，配置和加密凭据摘要未变。

四种工具模式与固定搜索/记忆白名单进入共享核心；会话选择扩展到该会话全部工具，仍隔离其他渠道。Android 设置和原生悬浮审批均接入。新增日历目录管理、参会人、提醒方式、忙闲/私密、文本筛选及分页；单次重复安排增加相同字段的回读验证。时钟使用官方 Intent 和无障碍交接，公开接口限制如实报告。

`settings-ui`、`permission-live`、`calendar-clock`、`migration-live`、`calendar-instance-final-verified.log` 与 `published-apk-actions` 保存本轮证据。核心类型检查/201 测试、Windows 五组发行目录回归及最终气泡文案回归通过。旧签名导出→正式签名导入→真实 DeepSeek→恢复点→原数据恢复实际通过。测试助手与备份口令不发布；测试闹钟/计时器通过清理本轮新增时钟实例数据移除。

具体用户操作见发行说明和文档 22。此前对 0.3.0 的“当前包”描述只代表对应历史轮次。
