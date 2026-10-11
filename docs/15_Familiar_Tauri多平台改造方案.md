# Familiar 基于 Tauri 的多平台改造方案

日期：2026-10-11。版本：v0.1。架构决策编号：`ADR-2026-10-11-01`。

状态：**已确定采用 Tauri 2 作为多平台改造的目标宿主，保留 Familiar 现有插件架构；本次仅落文档，尚未开始宿主迁移或移动端验证。** 当前可运行基线仍是 Electron/TypeScript Windows 版。本文中的新目录、能力名和桥接协议均为待实现设计，不代表已有 API。

上层约束见 [开发宪法](02_Familiar_开发宪法_v0.1.md)，当前实现见 [文档 04](04_Familiar_插件实现与气泡交互_v0.1.md)，实施入口见 [继续开发指南](06_Familiar_继续开发指南.md)。本文定义后续路线，不把历史规划或当前缺口写成已交付功能。

## 1. 决策范围与不变条件

本次确定：

1. Tauri 2 负责应用宿主、WebView 和原生能力桥接；Familiar 自己的 `Kernel / Context / Manifest / Capability / Plugin / Profile` 继续负责业务组织。
2. 先抽取共享边界、完成 Android 前台最小闭环，再验证移动端系统能力和 Windows Tauri 宿主。迁移期间保持现有 Windows 版可运行。
3. 共享角色与表现语义、业务协议、可移植 TypeScript 逻辑；Rust/Kotlin/Swift 负责需要原生执行的能力。不能把全部业务塞进 Rust 入口，也不要求所有插件原样运行于所有平台。
4. 桌面保留 Controller 与 Pet Runtime 的独立生命周期。Android 使用适合 Activity/Service 的生命周期，不机械复制两个桌面程序。
5. 模型、声音、角色和 Renderer 继续可替换；不强制某个云服务，不把手机运行建立在电脑在线之上。
6. 新旧宿主通过同一能力契约逐步替换。没有完成真实平台验收之前，不删除 Electron 基线、不共用可写的正常用户数据目录。

本次没有确定：桌面替换的发布时间、资源节省比例、最低系统版本、额外 JS 引擎、后台常驻业务执行器、具体安全存储插件、3D 引擎、账号和跨设备同步。相应决策须在所属阶段留下验证记录，不能由后续开发者默认为已选型。

## 2. 现状与复用边界

以下来自 2026-10-11 本地源码检查，属于迁移输入，不是新平台运行结果。

| 当前位置 | 已有职责或依赖 | 改造方法 |
| --- | --- | --- |
| `packages/kernel` | TypeScript 的 Context、生命周期、能力选择、清理、权限声明检查 | 保留；保持无 Electron/Tauri/Node/DOM 依赖，增加真实目标运行环境的契约验证 |
| `packages/contracts` | 业务服务、角色、LLM、媒体、语音等契约；部分服务仍同步或偏桌面 | 保留语义；拆出可序列化消息类型，异步/能力差异通过版本化迁移处理 |
| `packages/protocol/index.ts` | 同时包含协议常量与 `node:net/fs/path/crypto` 客户端 | 提取纯协议；命名管道、socket、Tauri 消息分别放传输适配器 |
| `apps/shared/bootstrap.ts` | Electron 启动退出、独立锁、插件列表和授予权限 | 保留当前宿主；后续独立增加 Tauri 装配入口，不能让共享装配代码导入 Electron |
| `apps/shared/preload.cjs` | `window.familiar.request/on` 窄桥 | 保留界面可用的请求/订阅语义，增加 Tauri 桥适配，不把任意 `invoke` 暴露成产品 API |
| `plugins/platform-windows` | Electron 窗口、托盘、拖动、命中、快捷键 | 保留旧实现；新增 Tauri 桌面和 Android 表面适配，逐项验证而非改名冒充兼容 |
| `plugins/renderer-sprite/ui`、`plugins/bubble-chat/ui`、`plugins/control-center/ui` | HTML/CSS/JS、Canvas 与桥调用 | 复用表现和交互逻辑；移动端重排布局、软键盘、安全区、返回行为与触摸操作 |
| `plugins/conversation`、`plugins/llm-router`、`plugins/provider-*`、`plugins/llm-shared` | 业务状态/协议与部分 Node 加密、`Buffer`、网络实现混用 | 分离纯状态机、协议解析与 I/O；不能因为代码是 TypeScript 或使用 `fetch` 就认定可在 WebView 直接运行 |
| `plugins/storage-local`、`plugins/home-files`、`plugins/memory-files`、`plugins/character-pack`、`plugins/media-assets` | 文件、路径、角色资源、附件和记忆读写 | 通过受限存储/资源能力替换 Node 访问；保留各业务域的校验、事务和数据语义。2026-10-11 新增的 `memory-files/entries.ts`、`memory-judge`、`memory-trace` 不含 Node 依赖，`memory-files` 主体仍经 `FileStore` 访问文件 |
| `plugins/secrets-local` | Electron `safeStorage` | 接平台安全存储；旧密文不能直接作为 Android/iOS 密钥格式 |
| `plugins/voice-api`、`plugins/voice-session` | 网络语音、缓存、PCM、播放/录音协调 | 拆分音频采集、播放、文件缓存与业务编排，保留取消和固定声音身份 |
| `plugins/voice-windows`、`plugins/location-windows`、`plugins/platform-media` | Windows C#、系统定位、Electron 截图等 | 提供平台替代插件；Windows 可执行文件不能随 APK 直接运行 |
| `plugins/mcp-client`、`plugins/tools-basic`、`plugins/cli-dependencies`、飞书/GitHub 集成 | HTTP/stdio 混合、子进程、外部 CLI | 分离网络与进程传输；移动 Profile 初期不装配依赖桌面 CLI/stdio/shell 的插件 |

目前 `Surface` 契约仍带有窗口类型、位置和气泡高度等桌面语义，不能宣布平台层已经完全抽象。当前 `Kernel.startAll()` 遇到启动失败会抛出；移动可选能力的缺失必须在 Profile/宿主装配中处理，不能只删掉 Windows 插件而保留对它的必需依赖。

## 3. 目标分层与两套插件的关系

```text
产品界面：宠物 / 聊天 / 设置 / 历史
                    │ 产品命令、状态快照、事件
Familiar Runtime：Kernel + Context + Profile + 业务插件
                    │ Familiar 公共 Capability
平台适配插件：存储 / 网络 / 表面 / 音频 / 通知 / 系统能力
          ┌─────────┴──────────┐
Electron 兼容宿主             Tauri 2 宿主与受限原生桥
现有 Node/Electron 实现      Rust 公共实现 + Kotlin/Swift 平台实现
```

上图表示职责，不保证模块处于同一进程或同一语言运行环境。

| 概念 | Familiar 业务插件 | Tauri 原生插件 |
| --- | --- | --- |
| 目的 | 组织角色、聊天、记忆、Provider、工具和可替换业务能力 | 将原生系统能力提供给宿主/适配器 |
| 组织者 | Familiar Kernel、Context 和 Profile | Tauri 应用构建与原生注册 |
| 生命周期 | 依赖检查、启动、停止、资源清理、服务撤销 | 平台回调及原生资源管理，与 Familiar 生命周期显式衔接 |
| 替换方式 | 同一 Capability 可选择不同 Provider | 不同平台实现同一适配契约 |

Familiar 的 `Capability` 是业务服务契约；Tauri 的 capabilities 配置控制窗口/WebView 可调用的原生命令。两者名称相似但不能互相替代。Tauri 的 Rust 插件通常随构建注册；Familiar 的 `stop/unload` 要求释放资源、撤销服务，不承诺运行时卸载原生动态库或在线安装任意 Kotlin/Swift 代码。[Tauri 插件机制](https://v2.tauri.app/develop/plugins/)、[Tauri capabilities](https://v2.tauri.app/security/capabilities/)

### 3.1 允许和禁止的依赖

- `kernel` 仅拥有插件运行基础设施；不能依赖产品 contracts 或具体宿主。
- 共享业务插件通过 Familiar contracts/Context 使用能力；不得新增 `electron`、`@tauri-apps/*`、`node:*`、Windows API 或平台路径依赖。
- Web 表现模块可以使用 DOM/Canvas，但不能直接使用原生系统权限；通过产品桥请求操作。
- 平台适配器可使用对应宿主 SDK，必须把 SDK 对象转换为 Familiar 数据和错误；禁止把 `BrowserWindow`、Tauri Window、Android Context 等对象泄漏到公共契约。
- Host 负责装配、授予权限、选择实现和启动退出；Provider 解析、人格、记忆精炼、Agent Loop 仍属于业务插件。
- 跨插件只依赖公开契约或明确的共享模块，不因迁移扩大内部文件互引。

现有不满足边界的地方按迁移清单逐项处理，不能以“旧代码也这样写”为理由增加新的绑定。

### 3.2 TypeScript 运行在哪里

Tauri 使用 Rust 原生进程与系统 WebView，并不自带 Electron 的 Node 运行时。官方提供的 Node sidecar 是另外打包进程的做法，不能据此认定手机已具备 Node/CLI 兼容性。[进程模型](https://v2.tauri.app/concept/process-model/)、[Node sidecar](https://v2.tauri.app/learn/sidecar-nodejs/)

实施基线：

1. **Android 前台原型**：纯 TypeScript Kernel 和最小业务插件在前台应用 WebView 中运行；原生 I/O 经适配器执行。该阶段 UI 与 Runtime 是逻辑分层，不宣称已经完成安全进程隔离或后台常驻。
2. **Android 后台能力阶段**：持续采集、播放、唤醒、悬浮窗及必要的持久化任务由平台服务/原生任务模块拥有。前台 WebView 可以附着或离开；它被暂停时不能仍承担必须继续执行的 JS 回调。Tauri 官方明确提及 WebView 暂停时原生插件调用共享 Rust 的路径。[移动插件文档](https://v2.tauri.app/develop/plugins/develop-mobile/#calling-rust-from-mobile-plugins)
3. **完整后台对话仍有决策门槛**：若要求后台继续 `STT → 模型 → TTS`，须先明确业务执行器、状态所有者及恢复协议。候选是可复用的原生业务插件实现，或经目标平台验证的独立脚本执行器；不默认引入 JS 引擎、不把整套 Kernel 静默重写成 Rust。在方案和实机验证完成前，只交付已证明的前台对话/原生子任务，不宣称完整后台 Agent 可用。
4. **Tauri 桌面宿主**：Runtime 与 Controller 必须是独立应用生命周期，且业务执行器归 Runtime。可评估 Runtime 自有执行环境；它不能由设置页面创建或销毁。具体执行器须在桌面切换前用强退 Controller、隐藏窗口和待机恢复测试确定。多个 WebView 不自动等于两个独立应用。

保留插件架构意味着保留契约、组合、可替换性和清理语义，不等于保留所有插件的原语言实现或当前二进制兼容性。

## 4. 公共协议与桥接规则

### 4.1 协议与传输分开

当前 `packages/protocol` 中的消息定义应与 Node IPC 分离。公共线协议只传可序列化 DTO，不传函数、闭包、Context、Proxy、`AbortSignal` 或 `AsyncIterable` 对象。业务侧可继续使用这些抽象，由适配器转换成请求/事件。

新增桥协议至少明确：协议版本、请求 ID、Runtime 实例代次、配置版本、方法与参数 Schema、事件序号、结构化结果和错误。以下是拟议字段语义，进入代码时再确定正式类型与版本：

| 信息 | 约束 |
| --- | --- |
| `requestId` / `streamId` | 标识单次调用/流；重试必须说明是否幂等，不能重复执行工具 |
| `runtimeEpoch` / `sequence` | 重启后旧回调不能覆盖新状态；断线重新获取快照，不能仅靠重放事件恢复 |
| `configVersion` | 修改发生冲突时拒绝旧版本，不能最后一次写入静默覆盖 |
| `cancel` / deadline | UI 超时不等于原生任务取消；适配器必须传播取消并释放资源 |
| stream chunk / end / error | 有顺序、有大小上限、有结束状态；消费者过慢时限流/背压，取消后丢弃迟到片段 |
| 可用性结果 | 区分 `available`、`unsupported`、`permission-required`、`temporarily-unavailable`，附原因与恢复方式 |

设置继续区分 `applied / requiresRestart / rejected` 的业务语义，是否即时生效必须来自 Runtime 实际结果；不能把“请求已送达原生桥”当作保存成功。现有 v1 IPC 不静默改字段含义；新协议先提供显式兼容映射，拒绝未知版本。

### 4.2 能力拆分方向

保留现有业务能力名及语义，只有必要的破坏性变化才版本化。下表新增名称是设计候选，尚未注册进 Kernel。

| 领域 | 契约方向 | 必须保留的差异 |
| --- | --- | --- |
| 表现承载 | 从 `platform.surface` 拆出应用内呈现与桌面/移动 Overlay 的扩展能力 | 手机不需要实现托盘、多显示器或全局快捷键；不支持的操作不得假报成功 |
| 存储与资源 | `storage.local` 保留业务读写语义；增加受限资源导入/读取能力 | Android 文档 URI、沙箱路径和桌面文件不是同一种标识，公共数据优先用资源 ID |
| 网络 | 候选 `platform.http`、`platform.websocket` | 支持流、超时、取消、请求范围和证书错误；不承诺直接 WebView fetch 能覆盖任意 Provider |
| 凭据 | `secrets.local` 演进为异步、受控使用；调用端使用凭据引用 | 原生存储不应把已保存密钥回传普通页面；同步旧 API 需要明确迁移 |
| 音频 | 采集、播放、音频焦点、唤醒分别提供能力 | 同一时刻只有一个采集所有者；原生与 Web 录音不能抢麦 |
| 生命周期 | 候选 `platform.lifecycle`、任务状态查询 | 活动、后台、暂停、被回收、权限撤回都可观察，不用一个 `running` 布尔值掩盖差异 |
| 工具与集成 | 网络工具与 `process`/stdio 能力分开 | 不支持进程的平台不装配依赖进程的插件，也不能暗中转发到电脑执行 |

现有内部命令允许保留兼容入口；新增平台检查集中在适配器/Profile，不能向每个业务插件散布 `if android / if windows / if tauri`。

## 5. 状态、生命周期与权限

### 5.1 唯一权威状态

- 每个本地 Profile 的配置、会话和任务有唯一逻辑写入者。界面通过命令提交；平台存储实现负责落盘，不能另建一条 UI 直写业务文件的路径。
- Android 前台原型由前台 Runtime 拥有业务状态；转入后台任务模式前必须设计所有权交接。原生服务接管后，WebView 只发命令和读快照，不能同时运行第二套会话循环。
- 应用恢复时先对齐 Runtime 代次、任务 ID 和持久化版本，再订阅新事件。被系统杀死的任务标为中断/待用户处理；未经幂等确认，不自动重放发送消息、文件修改等副作用。
- 桌面关闭/强退 Controller 不影响宠物和已开始的模型请求；退出 Runtime 则取消任务、停止音频、释放表面和服务。Android 的 Activity 关闭、用户停用后台能力、系统回收分别记录，不能混为“已退出”。
- 插件 stop、权限撤回和请求取消要到达原生资源所有者。停止后旧服务引用失效；后台服务断连时不能保留“正在监听”的假状态。

### 5.2 权限链

执行权限取决于 Familiar 授权/工具策略、宿主允许的命令范围以及操作系统实际授权共同满足。Tauri capabilities 是 WebView 调用原生命令的边界，不能自动替代 Familiar 的插件身份、会话授权和工具确认；原生服务直接发起的调用仍要经过等效策略检查。[Tauri 权限模型](https://v2.tauri.app/security/capabilities/)

具体要求：

- UI 桥只开放所需产品命令；原生命令校验参数、路径/资源范围、目标地址和当前授权。禁止用一个无限制 `invoke(name, args)` 映射任意系统调用。
- 请求中自报的 `pluginId` 不是可信身份；身份与授权由 Runtime/宿主绑定，不能让调用者自行扩大范围。
- 同一 JS 上下文内的官方插件仍不是彼此隔离的安全沙箱。原型仅装配可信随包代码和不执行代码的角色资源，不能宣称 Tauri ACL 已让第三方 JS 安全。
- 原生插件安装或平台注册成功不代表用户授予麦克风、位置、悬浮窗等权限。拒绝/撤回时释放资源并显示实际状态，不循环弹出授权。
- Provider 凭据优先由原生受限网络适配器绑定并使用。普通 UI 仅接收是否已配置等信息；用户输入密钥的表单不持久保留明文，不把密钥放日志、事件、URL 或导出数据。

## 6. 各平台交付边界

| 平台 | 第一项可验收体验 | 后续专项 | 当前状态 |
| --- | --- | --- | --- |
| Windows | 保留当前 Electron 宠物；Tauri 后续达到独立 Runtime/Controller 和文字交互等价 | 透明命中、置顶、托盘、快捷键、DPI、截图、语音、CLI 与安装升级 | 已有 Electron 实现；Tauri 未验证 |
| Android | 应用内角色、文字流式对话、模型设置和本地历史 | Overlay、前台服务、语音、文件/相机、通知和恢复 | 未实现 |
| macOS | 应用内/桌面角色与基础对话 | 窗口行为、系统权限、签名、原生音频 | 未验证，不能由 Windows 构建通过推定支持 |
| Linux | 应用内/桌面角色与基础对话 | WebKitGTK、X11/Wayland 的窗口和托盘差异、音频 | 未验证，按显示协议分别记录 |
| iOS | 应用内伙伴、聊天与设置 | Swift 能力、允许的后台场景、设备签名与分发 | 未验证，不承诺桌面式全局悬浮与无限后台执行 |

Tauri 2 官方支持五个平台，但具体插件与 Web API 支持必须分别检查。[支持平台](https://v2.tauri.app/)、[插件平台支持](https://v2.tauri.app/develop/plugins/#declaring-platform-support)。使用系统 WebView 意味着不同系统和设备的浏览器能力不同，Canvas、音频、流式读取与以后 3D 都需要目标设备验证。[WebView 版本](https://v2.tauri.app/reference/webview-versions/)

### 6.1 Android

- Overlay 使用 Android 原生窗口/授权路径；Tauri 应用窗口不能直接视为跨应用悬浮窗。需要验证交互命中、软键盘、边缘拖动、服务退出与权限撤回。[Android Overlay](https://developer.android.com/reference/android/view/WindowManager.LayoutParams#TYPE_APPLICATION_OVERLAY)
- 麦克风前台服务、启动时机和后台启动限制由目标 Android 版本决定；“已经有悬浮窗权限”不等于可以随时从后台开始录音。具体 SDK/系统版本在 M0 锁定，并在升级时复核。[服务类型](https://developer.android.com/develop/background-work/services/fgs/service-types#microphone)、[后台启动限制](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
- 语音先完成前台 `STT → 主模型 → TTS`、取消、插话和耳机/音频焦点切换，再增加本地唤醒。保持模型和固定宠物声音独立；当前按停顿提交整段音频的 STT 不能标成增量识别。
- 锁屏、切应用、省电、进程回收和用户强制停止分别验收；不承诺平台允许范围之外的永久保活。未授权 Overlay 时仍可使用应用内宠物。
- 手机 `localhost` 指手机本身，不是用户电脑。远程 llama.cpp 地址由用户配置；不自动更换为云服务，不默认开放电脑端口或增加远程控制。

### 6.2 iOS 与构建平台

Android 工具链需要 Rust 目标、Android Studio/SDK/NDK/JDK；iOS 构建需要 macOS 与 Xcode。Windows 环境不能作为五个平台均已构建的证据。[Tauri 开发依赖](https://v2.tauri.app/start/prerequisites/)

iOS 前后台行为按系统生命周期设计；UI 进入后台可能被暂停，不能照搬 Windows 常驻进程。[Apple 后台生命周期](https://developer.apple.com/documentation/uikit/preparing-your-ui-to-run-in-the-background)。具体后台功能、最低系统和发布要求在对应阶段决定；本方案不提前引入账号、同步服务或应用商店发布流程。

## 7. 数据与兼容迁移

1. M0 建立隔离的迁移样本；保留设置、角色、人格、完整历史、会话压缩交接、日记、附件和声音配置的格式/语义清单。原始正常数据只读，旧程序可继续使用自己的目录。
2. 用 Schema 版本和明确迁移函数转换数据，先写新目录、校验可读和引用完整，再切换入口；保存迁移日志和可恢复备份。失败回到旧宿主和原目录。
3. 同一数据目录不得由 Electron 与 Tauri 两个 Runtime 同时可写；跨宿主切换须检测活动写入者。原型测试始终使用独立目录与 Profile 标识。
4. 角色、附件、音频引用转换为稳定资源 ID 与资源解析器；不把 `%APPDATA%`、盘符、`file://`、Android 文档 URI 的细节塞进共享业务状态。
5. Electron `safeStorage` 密文不视为跨平台格式。迁移时由原宿主在原用户环境下受控读取并交给新安全存储，或让用户重新输入；不可用时明确提示，不能改为明文保存。只复制 `model-secret.json` 不足以保证解密。
6. 跨设备数据同步后置。Tauri 只提供宿主能力，不自动实现手机/电脑同步；不能把手工导入误称为双向同步。

## 8. 增量目录方案

以下路径为拟议组织方式，随所属阶段创建，不在文档阶段建立空框架。已存在的 `apps/runtime`、`apps/controller` 和 `plugins/*` 不先批量搬家。

```text
packages/kernel/            现有薄内核
packages/contracts/         业务接口与可序列化 DTO
packages/protocol/          逐步提取纯协议；旧客户端迁到适配层
packages/ui-bridge/         拟议：界面 request/on 的宿主无关入口
packages/runtime-profile/   拟议：插件组合与平台能力选择
apps/tauri/                 拟议：Tauri 装配和前端入口
apps/tauri/src-tauri/        Rust 宿主、配置、原生权限声明
plugins/platform-tauri/     拟议：桌面表面适配
plugins/platform-android/   拟议：Android 表面与生命周期适配
plugins/transport-tauri/    拟议：请求、事件与流的桥适配
native/                     拟议：可复用原生插件源码，按能力/平台组织
```

生成的 Android/iOS 工程遵循所选 Tauri 版本的工具链；具体可编辑源目录在 M0 记录，避免把可再生输出当作唯一实现来源。编译产物、密钥和个人配置不进入业务源码目录。

## 9. 实施阶段与准入条件

所有阶段当前均为**未开始**。依次交付可运行切片；跨阶段共用逻辑改动必须回归现有 Windows 行为。

| 阶段 | 交付内容 | 进入下一阶段所需证据 | 失败时的处理 |
| --- | --- | --- | --- |
| M0：基线与契约 | 固定版本/工具链/目标设备；记录 Node/Electron 依赖；确认最小 Profile；列出共享契约和测试基线 | 现有 Windows 核心流程可回放；纯模块构建检查；风险和兼容映射有记录 | 先修边界，继续使用现有版 |
| M1：Android 前台闭环 | Tauri APK；应用内现有角色；设置保存；一个已配置 Provider 的流式对话/取消；本地历史 | 真机启动、触摸/中文输入/键盘、断网重试、取消、进程重启恢复；原生流桥和凭据路径实测；业务模块未复制分叉 | 保留隔离原型；不能宣布完成 Android 移植 |
| M2：Android 系统能力 | 分别验证 Overlay、前台音频/语音、权限/恢复；有后台目标才实现其原生任务所有者 | 真实悬浮窗、麦克风、TTS、切后台/锁屏/权限撤回；后台执行器决策与所有权交接证明 | 回退为应用内/前台模式；标明不支持项 |
| M3：Windows Tauri 对照 | 独立 Runtime/Controller、桌宠和已选业务插件；保留 Electron 启动入口 | 强退 Controller 不影响 Runtime；双宿主同场景资源对比；数据迁移、真实窗口、安装升级可恢复 | 原目录继续用 Electron，不删除旧构建流程 |
| M4：其他平台 | 按实际需求逐个平台补原生适配和 Profile | 各平台构建、设备运行、能力差异和发布限制独立记录 | 保留未支持状态，不通过空实现伪装兼容 |
| M5：默认宿主切换 | 已验收的平台选择 Tauri 默认入口，提供迁移和回退说明 | 核心能力清单无未说明退化；用户数据恢复演练通过；发布范围明确 | 回退旧宿主；删除旧路径需单独变更与影响说明 |

M1 只先选一个 Provider 跑通链路，不删除其它 Provider 或永久缩小其支持范围。每增加一个迁移完成的 Provider，运行同一套接口/参数/取消/原生状态保留测试，并补真实服务证据。

阶段开始前记录计划采用的 Tauri/Rust/SDK/NDK/JDK 版本及目标 OS/WebView 版本；不给未测的最低版本承诺。iOS/macOS 所需机器和签名条件不具备时，状态保持未验证。

## 10. 验证与后续开发检查表

| 检查层 | 必须验证的行为 |
| --- | --- |
| 依赖边界 | 已迁共享模块的 import 图和浏览器目标构建不含 Node/Electron/Tauri SDK；同时检查 `Buffer/process/require` 等隐式全局 |
| Kernel/能力契约 | 启动依赖、缺失/歧义、失败归属、逆序清理、停止后引用失效、可选能力降级 |
| 原生桥 | 参数/版本拒绝、身份和授权、流分片、取消/超时、背压、重连快照、旧代次事件丢弃 |
| 数据 | 配置冲突与保存失败；历史/交接/附件迁移；唯一写入者；密钥不入日志；回退后原数据可用 |
| 移动运行 | 前后台、锁屏、回收恢复、旋转/重建、中文输入、触摸、权限拒绝/撤回、耳机与音频焦点 |
| 桌面运行 | Controller 强退、托盘退出、透明命中、混合 DPI、多屏边缘、快捷键及独立生命周期 |
| 资源 | 同机器/角色/功能/Provider 的冷启动、安装与运行体积、总进程内存、CPU/GPU、待机及长时交互；手机另外记录耗电/温度 |

WebView 子进程、原生服务及 sidecar 都计入资源测量，不能只比较主进程。无实测前不写“更省内存”“后台已稳定”“语音已修复”等结论。

开发前逐项确认：

- [ ] 本次属于 M0–M5 哪个阶段，目标平台和 Profile 是什么？
- [ ] 每个新增服务的提供者、消费者、权限、状态所有者和清理路径是否明确？
- [ ] 跨桥数据是否可序列化、可取消、可拒绝并能报告真实结果？
- [ ] 不支持的能力是否有降级，且没有假成功或绕过用户选择？
- [ ] 新的业务逻辑是否仍为插件，是否避免复制移动端专用会话/记忆实现？
- [ ] 数据隔离、迁移和回退方案是否在执行前可用？
- [ ] 修改共享逻辑后是否完成现有 Windows 回归，并记录目标平台实测与未验证项？

现有 Windows 源码改动按指南运行 `npm run check` 及受影响 smoke；Tauri 构建和实机命令在 M0 建立并记录，不把尚不存在的脚本写成可执行步骤。纯文档更新只需检查内容、引用、链接和 Markdown 结构，不为此启动真实麦克风或改动用户配置。

## 11. 决策记录与待验证项

| 项目 | 本次决策/下一步 |
| --- | --- |
| Tauri 2 目标宿主、保留 Familiar 插件架构 | 已确定；与宪法 2026-10-11 增补共同约束后续开发 |
| Android 前台最小闭环优先，现有 Windows 继续可用 | 已确定；下一项实施工作从 M0 开始 |
| Rust/TS/移动原生的职责分层 | 已确定边界；具体后台业务执行器在 M2/M3 决策，不能默认 WebView 常驻 |
| 新能力名称、DTO、异步密钥接口、Profile 元数据 | 设计候选；代码实现前版本化并建立契约测试，不直接扩展当前 Manifest v1 的含义 |
| UI 框架 | 保留现有 Web UI 作为起点；没有批准顺带全面更换框架 |
| 安全存储、后台服务类型、最低系统、构建依赖 | M0/M2 按官方文档和真实设备选型记录；不从平台支持宣传推定具体功能可用 |
| 桌面默认切换、删除 Electron、商店上架 | 尚未实施；分别由 M3/M5 证据和明确发布任务驱动 |
| 3D、远程电脑代理、账号同步、插件市场 | 本次范围外；不作为 Tauri 改造的隐藏前置条件 |

## 12. 资料与证据边界

本文引用的 Tauri、Android、Apple 文档在 2026-10-11 核对，用于确认框架机制和系统限制；具体实现与阶段顺序是 Familiar 的架构决策。官方支持列表不等于 Familiar 验收记录。

本次仅检查当前源码、文档一致性和官方资料，未安装 Tauri 工具链、未创建 APK、未测试新宿主的音频/窗口/后台行为。后续每阶段结果写入 [验收记录](05_Familiar_本地预览验收记录_v0.1.md)，同时更新本方案的阶段状态。
