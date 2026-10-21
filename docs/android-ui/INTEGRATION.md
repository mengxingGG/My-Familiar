# Android 前端集成边界

2026-10-19。前端由实际 Claude Code CLI 编写，Codex 负责本页、公共契约、传输适配、隔离预览与构建验收。

## 源码与运行

- `apps/tauri/ui/`：Claude 的完整前端源码，入口导出 `mountApp(bridge)`。
- `packages/mobile-contracts/index.ts`：版本 1 数据与命令契约，不依赖 Node、Electron 或 Android SDK。
- `packages/mobile-bridge/index.ts`：宿主传输适配；请求关联、超时、事件订阅/清理、快照版本保护、边界错误脱敏。
- `apps/tauri/entry.ts`：生产启动入口，优先使用注入适配器，否则在 Tauri 内使用 `native-transport.ts`；普通浏览器缺少连接即显示不可用。
- `apps/tauri/preview-entry.ts` 与 `preview/fixture.ts`：独立的内存示例数据。没有真实模型、磁盘数据或系统操作，不保存用户输入的密钥。

运行 `npm run mobile:preview` 会构建并仅在 `127.0.0.1:4173` 提供前端预览；构建目录是 `dist/mobile-preview/`。`npm run mobile:build` 输出真实入口至 `dist/mobile-ui/`。`node scripts/preview-mobile-ui.mjs --production` 可检查未注入宿主时的实际错误状态。

预览中的模型配置可以填写示例地址 `https://example.com/v1` 和任意模型名，无需真实密钥；所有回复仍是本地示例。`npm run smoke:mobile` 使用已安装的 Edge 无头运行完整 UI 验收，生成 `.artifacts/android-frontend/screenshots/` 和 `smoke-result.json`。

预览服务只开放构建后的 HTML/CSS/JS/图片/字体文件，不开放源码根目录；拒绝路径越界。通过 `FAMILIAR_MOBILE_PORT` 选择其它端口。桌面构建会重建 `dist`，之后重新运行移动构建或预览即可。

## 原生宿主接线

`MobileTransport.invoke()` 接收 `{ protocolVersion, id, method, params }`，返回带相同 `id` 和版本的响应。`listen()` 发送完整快照并返回注销函数。每个宿主连接中的 `revision` 必须单调递增；重建宿主时也需重建连接。UI 先订阅再读取初始快照。

真实适配已接通：Tauri invoke → Kotlin 控制器 → 未导出的绑定服务及同 UID 私有 socket → 独立 `:runtime` 进程的共享核心。原生服务提供 Keystore、常驻 Overlay 和无障碍工具。`window.familiarMobileTransport` 仍可用于隔离集成测试；生产不回退到预览。

所有变更必须由 Familiar 插件/能力拥有并产生新快照；不得将预览实现注册成真实核心，也不得另复制一套 Conversation/Provider 引擎。密钥仅作为一次性保存参数，原生侧负责加密及原子配置提交，快照只返回 `keyConfigured`。共享会话/Provider 已在 ARM64 APK 中运行，完整功能对齐与真实服务验收见文档 19。

超时只说明结果尚未收到；桥不重试变更命令，避免重复消息或重复创建日程。宿主需要执行前权限复检、幂等请求记录和结果查验。页面销毁注销前端连接，后台任务是否继续由原生任务所有者决定，不能依靠 WebView 定时器。

`message.send` 必须携带点击时的 `conversationId`；宿主按该 ID 处理，不能改为执行时当前选中的会话。`null` 必须原子创建、选中新会话并发送，在同一次快照中发布，不能先发布未选中的新会话。UI 用内存保存各会话草稿，迟到失败只恢复原会话的空草稿，不覆盖其它会话或用户新写的内容。若未来宿主无法满足该原子边界，需扩展发送结果返回新会话 ID，再调整 UI，不能依赖推断接线。

## 验收层次

单元测试验证传输边界与预览生命周期；浏览器测试验证前端交互。APK 的 ARM64 启动、流式/取消、凭据/历史恢复、后台服务和基础无障碍已完成分项设备验收；新增七类 Provider/七角色、本地笔记文件/记忆/Skill 工具、系统日历查询和定时日程创建也有设备证据。软键盘、真实云 Provider、外部笔记交接和完整手机任务体验仍需补齐。设备结果见 [常驻运行实施](../19_Familiar_Android常驻运行实施.md)，不能由浏览器截图替代。

本轮已检查 360 / 390 / 430 / 768 宽度下的首页、聊天、角色和模型表单、任务卡与弹层；短视口下输入区可见。浏览器事件验证中文组字和 Enter 不误发，不等于 Android 输入法实测。延迟宿主测试覆盖草稿隔离、请求会话绑定、迟到发送失败和保存结果不确定。生产构建没有预览模块；未注入宿主时明确显示未连接。

## 七类模型与完整伙伴接口

`provider.kind` 与 `providers` 是协议 v1 的可选扩展；新 Android 宿主返回全部七类，旧宿主仍按兼容 API 降级。每类 profile 返回地址、模型和 keyConfigured，并在模型管理扩展中投影明确的 advanced 参数；不返回凭据或私有数据。`provider.save` 保存并启用所选类型，保留其他类型档案；密钥以类型和规范化 URL 的哈希隔离，地址或类型变化不转移旧密钥。有回复时核心返回 BUSY。高级参数沿用共享 ProviderProfile 校验，缺少 advanced 时保留既有参数。

`capability.request` 对已授权的日历/麦克风/位置打开应用详情页，对其他系统能力打开对应设置；未授权时走系统申请。UI 不把跳转当成权限变化。`notes/files` 不显示无效授权按钮。

本轮 Claude Code 2.1.303 通过本机已登录 CLI 完成 UI 源码，61 轮工具交互、无权限拒绝；只读取已授权接口/任务书与自身四个 UI 文件。未向它发送新增角色素材或 Hermes 源码。19 项浏览器场景通过，新增供应商切换时密钥草稿清空、恢复独立配置和七个角色图片加载。

## 独立悬浮审批表面

Claude 另以 18 轮完成 `mountApproval(MobileApprovalBridge)`。核心仅传递 `MobileApprovalSnapshot`，不含配置、凭据和聊天记录。Codex 的 `approval-entry.ts` 提供订阅、单次回应和收起传输；打包使用原 UI 的 HTML/CSS 与独立入口。窗口在运行进程中、不夺取键盘焦点；真正批准由共享 agent.approvals 决定。收起只隐藏，点击宠物重开；取消回复会清除任务。

四项浏览器边界与四项实际设备触摸场景通过，见 `.artifacts/android-approval-ui/result.json` 和 `.artifacts/android-device/approval-smoke.json`。原有 19 项 UI 回归通过。此验收不包含媒体、语音和复杂手机任务全流程。

## 图片与文本附件

协议 v1 可选扩展：`snapshot.media` 表示实际选择能力和限制；`media.choose` 经系统选择器返回已导入的元数据，取消返回空数组；`media.preview` 返回受限的本地 data URL 或文本。`message.send.attachments` 只包含引用 ID，允许无文字发送；消息历史的可选 attachments 同样只包含元数据，不含 URI/路径。旧宿主缺少 media 时没有虚假的选择入口。

Claude 用 56 轮完成 UI，Codex 实现桥、预览 fixture、原生和核心。五项媒体浏览器检查及原有 19 项检查通过；独立审批四项也回归通过。真实系统选择器、大图缩略图、完整原件哈希、附件单独发送和重启通过设备验收。文件选择器中的返回可能先退目录，测试只有确认页面真正关闭才计为取消。未发送附件的回收、相机、截图和语音后续补齐。

## 相机与窗口截图

- `media.camera(undefined)` 与 media.choose 返回同种已导入附件引用；取消为 []，启动/导入错误用原错误码。snapshot.media.camera 只在预装相机处理器可用时为 true，缺失时按不可用。camera 能力 granted 表示存在处理器，不是本应用已取得 CAMERA 权限。
- 相机与文件共用选择锁、会话绑定和总数限制；系统相机确认只导入本地，消息发送才上传。FileProvider 只共享本次 cache/camera-capture 文件，确认/取消后撤销与清理。旧宿主或无系统相机不显示可用按钮。
- 无障碍披露包含“批准后采集当前应用画面交给所选模型”；截图由 android_screenshot 工具经原审批接口进行，不存在新的公开截图桥命令。工具需最近 android_screen 返回的 snapshotId，Android 14+ 才可用，锁屏/旧窗口引用/系统安全窗口失败。

## 宠物表现与 Android 停靠

`snapshot.pet` 可选投影共享宠物设置和 behavior.pet 动作；`pet.settings.save` 保存大小、可见、安静和回复气泡秒数，使用原 settings 插件。`pet.interact` 只允许 click/sleep/recall/reset-position。原生手势 `pet.host` 只可经私有运行通道发送，公开 WebView 白名单拒绝它。

`pet.docking.save` 独立保存 snapToEdge、hideWhenIdle、delaySeconds（10–300 秒）；snapshot.pet.docking 另有只读 tucked。停靠和归一化位置存原生 SharedPreferences，不改变 Windows Settings，不存于网页。默认自由拖动；开启吸附后再拖动生效，闲置收起默认 30 秒，可单独关闭，向外滑仍可手动收起。设置保存失败保留表单草稿，不声称已经生效。

飞书页现为“飞书”，保留私聊与配对并增加独立办公面板。`feishu.status` 可选 `office` 状态包含开关、绑定应用、机器人/个人身份、内置组件可用性、版本引用、执行数、待补 scope 和固定说明；无令牌。`feishu.office.save` 要求办公 revision 和当前 channelRevision，可带 identity，旧草稿冲突保留；`feishu.office.check` 没有参数，只执行本地帮助，不验证云账号。页面没有任意 CLI 命令接口，业务调用从共享 Agent 进入审批。

个人账号面板读取可选 `auth`，仅包含阶段、连接状态、应用、用户名称/编号、权限、版本、官方授权 URL/用户码/期限。`feishu.auth.begin` 接受 revision、channelRevision、scopes；`open/cancel/forget` 只接受 revision。设备码、访问/刷新令牌、密钥和自定义端点不通过公开桥。官方页面由原生 ACTION_VIEW 打开，仅允许 HTTPS accounts.feishu.cn。登录、轮询和刷新归 Runtime；页面关闭不撤销已经发起的用户授权，明确取消停止本轮等待。清除本机登录有确认，不声称撤销云端应用授权；存储失败仍显示重试入口。登录后需自行选择个人办公身份，失效账号不降级到机器人。真实账号完成授权和云业务仍待验收。

原生 PetService 绘制既有 SVG 动作与头像裁切；共享 renderer-sprite / behavior-basic / bubble-chat 持有动作和气泡业务。PetBubble 使用纯文本原生组件；审批优先，主 Activity 在前台时按原插件抑制重复气泡。窗口收起成 48dp，点击或向内拖动展开；锁屏/熄屏移除窗口并暂停动画。设置页“查看对话”进入应用内聊天；悬浮菜单“上次回复”调用原 speech.recall。

2026-10-20 气泡输入修正：轻点完整宠物打开 `FamiliarChat` 原生悬浮输入窗口，保留“小脑袋轻点只展开”和“有审批时先重开审批卡”。“打开应用”保留在长按菜单。共享 `chat.open` 的 composer 表面改为 `composer-visible`，不再隐式打开 Activity。`PetBubbleChat` 使用标准 EditText / InputMethodManager 接设备现有输入法，没有自建或替换输入法，也不新增权限。

按用户后续要求，原生聊天改为透明背景上的奶油色回复气泡和浅绿输入气泡。没有外层卡片、标题栏、输入下划线或底部按钮排；回复宽高随内容收紧，弯曲尾巴按实际上下位置翻转。发送/停止共用输入末尾的位置，关闭位于回复气泡角上，视觉图标较小但点击区域保持 48dp，并保留可访问标签。输入背景不使用 EditText 默认边框，仍保留原生选字、光标、多行与系统输入法；输入增加行数时重新计算窗口高度。普通输出气泡使用同一绘制样式；长按菜单仍承担应用入口和低频操作。

原生窗口通过私有 `pet.chat.state/send/cancel` 读取有界最新回复、向当前共享会话发送和停止；这些方法没有加入 WebView 公开白名单。发送绑定窗口打开时的会话编号，主应用切换/删除会话后拒绝旧窗口发送，原草稿保留；明确点击切换才进入新会话。会话、Provider、记忆、生成及工具审批继续由原插件持有。气泡按原状态流式更新，发送后保持可继续聊天，不受普通回复气泡的自动消失计时影响；打开聊天时不闲置收成小脑袋。

短期草稿只在当前运行进程内按会话保存，最多八份，每份 8000 字；收起、拖动、暂时让开审批或返回后可恢复，进程回收后未发送草稿不保证保留。发送确认前继续编辑的下一份草稿不会被迟到回执清空；失败或结果未确认时保留文字，不自动重发。回复在气泡中显示末尾最多 12000 字，超出时明确提示到应用查看全文。短回复按内容收紧窗口，长回复在有限区域滚动。

输入窗口只在明确进入输入时获取焦点，等窗口已获焦点后唤起系统输入法；返回/点击外部可释放焦点，收起会隐藏窗口和输入法。API 30+ 按 IME Insets 调整位置，兼容设置保留 adjustResize。当前模拟器自带输入法窗口高度为 0；实体输入事件和回车换行可验证，真机键盘遮挡与中文候选仍需系统输入法实测。按用户说明不再安装临时输入法来替代此环境差异。

2026-10-21 补充焦点恢复：会话已切换且输入窗口失焦后，再次轻点宠物会为切换提示获取窗口焦点，仅聚焦提示根节点，不调用输入法或自动切换会话。原草稿继续保留，只有明确点击“切换到当前对话”才接续新会话。该分支加入最终 9 组真实气泡检查，避免提示可见但活动窗口可访问树仍是桌面的情况。
- 本机 Claude 完成 UI，浏览器验证含相机显隐、共用选择锁和迟到照片的会话隔离。当前模拟器无预装相机，拍照确认链路尚未设备验收；窗口截图已在实际设备测试应用中验证。

## 语音增量（Codex 接手）

Claude Code 达到额度后，用户授权 Codex 接手 UI。快照新增 voice.settings/state/dictation，命令增加 voice.save/start/finish/stop/read；仅通过既有桥调用。录音转写回填原会话，连续语音锁定会话，密钥与聊天服务独立。全局状态条在所有页面提供停止，设置折叠面板沿用纸片风格。共享 voice.api/voice.session 与 Android 音频前台服务的联调和六项设备证据见 docs/19_Familiar_Android常驻运行实施.md。旧宿主缺少 voice 时隐藏入口，不宣称可录音。

### Android 系统本地朗读

`voice.localTts` 表示宿主支持查询系统音色，不等于设备已有可用引擎。`voice.local.catalog` 返回最多 500 个已安装本地音色的 id/name 与说明；公开桥不返回文件路径、原生任务编号或音频数据。只在朗读服务提供 `system`，识别仍用 compatible/openrouter。系统模式隐藏云地址、模型、密钥和流式选项，保留速度；切换时清除未提交朗读密钥，保存不写或清除云密钥。

音色目录按按钮刷新，不随快照轮询反复绑定引擎；选择草稿和原云音色独立保留。不可用的旧音色明确显示，不自动选成其他语言。系统默认音色必须是引擎当前实际默认且可本地合成，否则要求重新选择。缺引擎或数据时给出说明，不回退云服务。设备验收包含中英文真实 WAV、播放停止、取消、重启及卸载引擎后缓存失效；不代表唤醒或系统识别已完成。

## 记忆与技能管理（Codex 接手）

`snapshot.library` 可选提供 memory/skills；缺少则隐藏设置入口。独立 `LibraryView` 只保存内存中的编辑草稿，正文不进入主快照。`library.memory.list/read/search/write` 复用 memory.files，写入必须带 SHA256 revision；新文件明确 create，已有文件冲突不覆盖。每文件草稿、保存期间继续输入、页面返回、显式对照合并均保留编辑内容；截断预览只读。CORE.md 限额来自共享核心，普通文档最多 100000 Unicode 字符。

`library.skills.list/read/install/toggle/remove` 复用 skills.catalog，隐藏源路径与原始宿主错误。安装支持粘贴、单个系统选择器文本文件、HTTPS 文档地址；URL 先标准化，禁止地址携带凭据。选择文件先经 media.choose，再由 library.skills.source 读取完整文本（64 KiB 上限），不使用 12000 字预览。选择只填草稿，安装需点击按钮；已有草稿替换需确认。移除复用原确认弹层，默认焦点在取消，核心移动至 .removed 备份。平台不支持的内置技能不能启用，技能正文不授予权限。

资料请求由各共享服务持有写队列，不占用语音停止/会话取消的公用队列。公开原生桥只增加十个命令，控制请求限额升至 1 MiB，足以容纳 100000 字符编辑；响应仍受限。7 组浏览器和 6 组模拟器验证通过，证据见 android-library-ui/result.json 与 android-device/library-smoke.json。

## 模型与上下文管理

snapshot.modelManagement/contextManagement 是可选能力；profile.advanced 为公开参数投影，旧宿主不显示新入口。ModelTools 持有当前页面按类型的内存草稿，provider.save 统一提交；核心复用 ProviderProfile 校验。provider.inspect 返回当前类型/地址的凭据存在性与参数支持，不返回密钥；目录请求不会使用未保存密钥。保存或清除凭据后废弃旧列表，secrets.changed 使共享目录缓存失效。

provider.test 必须与当前已保存配置完全相符，只发送固定句，20 秒上限，operationId 对应取消。测试不走聊天历史，离页取消，停止不占全局管理队列。目录、测试、上下文均投影返回字段，拒绝跨地址模型结果和越界数据。

conversation.context 按会话返回实时状态与持久检查点摘要；历史会话尚未激活时不冒充实时统计。context.archive 先确认会话存在，再校验 checkpoint 中的会话哈希，最多返回 16000 字符；搜索和 previous 回查沿用共享 context.compaction。摘要单字段最多 100 条、每条 4000 字符，截断会明确提示；原文保留。ContextView 刷新和离页使用代次，旧读取不覆盖新会话或锁住按钮。

输入估算包含系统、记忆和会话，不包含另行预留的工具说明；请求输入预算包含工具，压缩触发点已扣除工具预留。服务 usage 独立展示，不当作当前输入估算。自动压缩仍由共享核心触发。

## 系统日历与笔记工具

日历详情、修改、删除、提醒替换和变更前快照读取继续使用共享 agent.tools / agent.approvals；公开 WebView 没有任意原生调用入口。变更参数同时包含可读的原标题、起点和 revision，审批仍呈现完整参数。原生执行时重新读取并校验，批处理的快照断言先于写入，完成后回读。CONFLICT / INVALID_INPUT / NOT_FOUND 等固定码可以穿过私有桥，其他异常正文继续屏蔽。

普通事件可改标题/正文/地点/时间、删除和设置提醒，全天保持 UTC 午夜边界。重复系列支持整组删除；没有例外和外部排除规则时，可同时替换首次时间、时区、时长和结构化重复计划。单次改期/取消只对具有同步标识的系列开放，未同步系列在写入前拒绝并返回原因；恢复取消及重排已有例外仍交给日历应用。operationId 防重与原子账本覆盖未知结果，恢复资料含主记录和例外字段/提醒，不是完整日历备份或自动撤销。

2026-10-20 补充创建：`android_calendar_create` 支持 allDay 与结构化 recurrence（天/周/月/年、间隔、星期、次数或截止日期）。原生生成规则并回读，旧操作号摘要保持兼容；没有新增 WebView 可直接写系统日历的入口。创建审批由 `calendarCreatePreview` 转成中文计划，保留现有卡片布局、完整备注和飞书来源；结束日期、无限重复与通知边界明确显示。创建路径的 12 组设备检查含真实 Instances、夏令时/闰日/跨年和重启防重。

后续改删增量另有 12 组设备检查。管理工具改为按需目录，原工具审批与参数验证保持；`calendarChangePreview` 区分整个系列和仅这一次，显示原定/当前时间、例外数量与删除影响。真实卡片仍由既有 UI 承载。原生 revision/批处理包含例外及提醒，外部变化拒绝；单次例外通过官方 CONTENT_EXCEPTION_URI。无同步标识的 AOSP 展开缺陷在本机复现，产品据此禁止该写入；同步标识仅在独立测试日历中模拟，不代表云服务通过。详见实施记录，不作实际通知响铃承诺。

笔记任务单独标为 notes。`android_notes_targets` 返回声明标准 Intent 的接收界面；`android_notes_compose` 在批准后精确核对组件、名称和模式。Google NoteIntents 的 text/plain 入口可预填标题/正文；Android CREATE_NOTE 入口只打开空白界面，禁止把正文交给不支持预填的入口。结果固定为 handoff / saved=false，提示用户核对并保存；没有兼容入口时本地 files 笔记仍可用。没有新增 Android 运行时权限、任意分享目标或私有数据库访问。

## HTTP MCP 管理（Codex 接手）

`snapshot.mcpManagement` 表示核心支持管理；设置页新增“网络工具 · MCP”。`mcp.list/save/connect/connect.cancel/disconnect/remove` 经公开协议白名单调用共享 `mcp.manager`。Android 装配 `createMcpClient({stdio:false,trustReadOnlyHints:false,githubWritesRequireApproval:true})`，复用 HTTP SDK、工具注册、审批和媒体；不装配 npm 安装与 stdio 子进程。Windows 默认装配保留。

列表只返回 HTTP 公开配置、revision、连接状态、密钥是否存在、工具名与固定错误文案。连接接受 operationId，可独立取消，不占用聊天取消/快照队列。保存/移除携带配置 revision；冲突保留草稿。界面按服务保存草稿，保存期间的新编辑不会被迟到响应覆盖；离开页面清空未保存密钥并取消正在进行的连接。

地址要求 HTTPS 或本机回环 HTTP，不接受 URL 内嵌鉴权/查询参数。密钥通过专用密码输入保存到现有 Android 加密秘密存储，支持请求头或查询参数鉴权，界面不回填。凭据按服务、地址和鉴权配置隔离；切换配置不会把旧密钥发往新地址。“清除此地址已保存的密钥”和移除仅清理当前凭据范围，历史地址的加密凭据仍保留，切回原配置后可单独清除。

停用、保存、清钥、移除或断开会取消连接并撤销已注册工具；旧审批执行前再次核对连接、配置和凭据。未知服务的 readOnlyHint 不能直接跳过审批，沿用当前工具权限策略；已知高德/Exa 只读工具及 GitHub 业务权限规则与桌面共用。工具名只作纯文本显示。连接目录限制 256 个工具、32 页及 45 秒总期限；不宣称对 SDK HTTP 响应体有独立字节上限。

断开仅影响本次会话，启用服务在核心重启时自动连接。连接状态在打开页面、重新读取及管理操作后刷新。默认高德和 Exa 预置项停用。设备验收使用本机 HTTP/模型夹具，已检查真实鉴权、工具批准/拒绝、图片回传、慢连接取消及加密凭据重启恢复；真实云 MCP、OAuth、stdio 和完整网络业务集成未在此增量完成。

GitHub 专用 Token 入口使用 `mcp.github.save`，仅接受 enabled、readOnly、revision、apiKey、clearApiKey。固定官方地址和 Authorization/Bearer 鉴权，不接受外部 URL；初始只读且停用。共享 MCP 串行队列复核旧配置及 revision，只有官方两种模式间保留 Token，切换后删除旧模式的凭据副本；清除时同时停用，移除清理两种模式凭据。同名非官方配置不会被接管。其余保存/连接/取消/工具列表 UI 沿用 MCP 流程，Token 不回填，离页清空未保存输入。GitHub 写工具在 Android 使用 outsideWrite 分类逐项确认；Windows 的现有分类保持原样。官方工具名及账户管理过滤规则仍共用，未知工具不自动开放。浏览器设备授权现已实现，见下方专节；仍需本应用注册的 Client ID，真实账号及完整 GitHub 工具目录对模型上下文的影响尚待验收。

## 日常关怀与一次定位（Codex 接手）

`snapshot.careManagement` 启用“日常关怀”设置页。`care.get/save/preview/stop/locate/locate.cancel` 是公开命令，保存带配置 revision。核心装配共享 companion-care、amap-care 和 Android 位置适配；提醒槽、模型生成、历史写入、宠物气泡仍由现有插件拥有。预览立即返回 busy，由状态轮询反馈完成；停止、修改关怀设置、切换会话/模型会取消旧生成。语音活动时不能预览，自动关怀也暂停。

关怀总开关控制内置时段和自定义提醒。普通关怀遵循桌面 22:00–08:00 安静时段；自定义提醒有 30 分钟触发窗口、每日槽防重和至少一分钟间隔，最多 30 条。不使用精确闹钟或后台定时定位，系统休眠/回收可能导致延迟或错过，不能作为准点闹钟。自动触发还要求常驻宠物可见、屏幕交互且未锁定、非安静模式、主页面不在前台、没有对话或语音任务；模型请求前记下已使用时段，失败/重启不自动重试扣费。

位置是独立前台动作：先开启使用位置并保存，再按需授权 ACCESS_COARSE_LOCATION，手动刷新。NativeLocation 使用 AndroidX LocationManagerCompat 单次获取，15 秒期限，支持操作编号取消、提前取消、失焦/锁屏/超时释放全部 CancellationSignal。权限、系统定位开关、来源、时效与精度再次核验；系统开关关闭时可跳转定位设置。不申请精确/后台位置，不引入 Google Play Services 依赖。

原生回调通过不在公开白名单的 care.location.check/import 交接给共享核心，页面不能自行注入坐标；导入需匹配原关怀配置 revision。原坐标只在运行进程内存缓存 10 分钟，重启、关掉位置或撤权后清除。公开状态只返回更新时间、精度和模拟标记；后台关怀不重新请求定位，缓存失效则普通问候。

“附近建议”说明会向已启用的高德服务发送最近位置；沿用既有高德 Key、坐标转换与只读 MCP 工具。根据误差扩大查询范围；误差超过 500 米不生成步行时间，模拟位置不发送真实高德请求。真实高德/天气数据仍需用户配置后验收；天气没有额外独立自动播报规则。

页面保留未保存草稿，轮询不覆盖编辑；迟到保存保留后续修改，冲突提示重新读取，移除提醒需确认并保存。离开页面取消定位；已经明确发起的问候继续由独立核心完成。新接口不会让控制器成为关怀业务所有者。

## 自绘控件手势（Codex）

共享工具新增 `android_gesture`，沿用 `MobileTask.kind=accessibility` 与已有批准卡片，没有公开的 WebView 手势调用接口。`android_screen` 返回的节点增加 enabled/password/scrollable，以及节点相对坐标与引用寿命说明。tap/longPress/swipe 的坐标都相对指定 nodeId，范围 0–1；滑动 100–1500ms，点击 80ms、长按 700ms。

原生消费不超过 120 秒的观察引用，重新核对应用、窗口、所枚举的可访问内容、目标节点指纹/边界，以及路径上方的其他窗口；只支持主显示屏当前应用。注入前短暂移除自身宠物、气泡与审批窗口，完成/拒绝/取消/超时后恢复，不改用户的停靠设置。输入引用一次消费，之后必须重新观察。系统权限与安装界面继续由用户操作。

结果包含 dispatched、status（completed/cancelled/rejected/unknown）和 requiresObservation。completed 仅证明系统报告触摸结束，不证明页面任务成功。取消回复会阻止尚未发出的手势；已经发出的触摸不能撤回，最多持续本次有界时长，不通过另一笔假触摸打断，不自动重试。设备验收使用真实触摸自绘画布，批准与拒绝通过卡片实体按钮；锁屏拒绝场景经产品命令提交批准以检验原生拒绝。

Android 媒体装配关闭无法执行的 desktop_snapshot 工具，仍使用逐步批准的 android_screenshot；Windows 的 mediaInput 默认装配不变。日历/截图工具元数据精简重复说明，参数限制和审批语义不变；默认 32768 估算窗口下的图片原件发送回归通过，未放宽上下文预算检查。

## PDF / DOCX 文字附件（Codex）

`snapshot.media.documents` 是可选布尔能力；新宿主开启“添加图片、文本或文档”，旧宿主维持原入口。仍使用 `media.choose`，没有公开文件路径、私有导入或解析线程调用。PDF/DOCX 进入既有 `MobileAttachment.kind=text`、`mimeType=text/plain`，名称标明“（提取文字）”；bytes 是提取文本字节数，预览和模型都使用这份文字，不表示原文档版式/图片已读取。

新增脱敏错误 `DOCUMENT_EMPTY`、`DOCUMENT_PASSWORD`、`DOCUMENT_TIMEOUT`；附件选择场景单独解释 `INVALID_DOCUMENT` 和 `LIMIT`，不沿用技能文档的 YAML 提示。解析失败保留会话草稿与已选附件，选择不发送模型请求。每份文件 12 MiB，PDF 100 页，提取文字 400000 字节；无 OCR，扫描件提示改用图片。
## 离线关键词引擎准备（尚无新 UI 接口）

2026-10-20 已接入 `voice.wake`，设置 → 语音连接中单独提供允许唤醒、关键词、灵敏度、保存和开启待机。`snapshot.voice.wake` 返回配置及 armed/listening/message；旧宿主缺少该字段时隐藏入口。未保存草稿不会被轮询覆盖，也不能直接启动。保存、首次授权和进程重启都不打开麦克风，必须再次在前台点击开启；全局状态条与通知均提供停止。

`voice.wake.save/start` 经公开白名单；Activity 校验窗口焦点、亮屏和解锁并写入前台时间，网页不能伪造该时间。`voice.wake.host` 仅在原生私有 IPC 使用。会话租约和监听操作号只保存在内存，旧操作的 PCM 不会进入新会话。停止常驻、全局停止、通知停止或音频错误同时撤销待机；焦点归还和重新打开控制器不自动恢复录音。

自定义词在本机编码：支持 1–8 个中文/常见英文短语，每个最多 40 字符；未填时使用伙伴名称。中文使用固定版本 pinyin-pro，英文查随包的官方 en.phone，全部音素再检查模型词表。未收录英文或不支持字符提示修改。灵敏度调整检测阈值，不展示未经校准的置信度。

NativeAudio 是唯一麦克风所有者，24kHz PCM 在待机时交给本机关键词引擎。未命中不上传音频；命中后保留最多两秒前文、整段最多八秒，交给所配置 STT，再复用共享 voice.session、会话与朗读。超长片段停止并提示，不提交截断指令。后续连续对话按既有语音配置执行；“离线”仅指唤醒检测，转写、模型和云朗读仍会使用配置的服务。系统本地朗读可作为已有 TTS 选项。

设备证据：`wake-device-smoke.json` 验证真实麦克风/前台服务生命周期；`wake-replay-smoke.json` 在 targetSdk 36 的隔离测试 APK 内验证真实 ARM64 模型、Node 私有 IPC、共享对话和原生播放。回放输入为固定录音，转写/模型/TTS 使用本机 HTTP 夹具；不能据此宣称真人唤醒准确率、真实云服务或手机功耗已经验收。


## 系统听写入口（2026-10-20，Codex）

聊天输入区根据 `snapshot.voice.systemInput` 显示“系统语音输入”。能力来自设备实际可解析的 ACTION_RECOGNIZE_SPEECH Activity；不是根据麦克风权限或 Android 版本推断。系统没有接收界面时隐藏，卸载后随快照刷新关闭。

公开命令 `voice.system.input` 由原生 Activity 桥处理。调用前检查前台焦点、解锁状态、已有选择器、共享语音与唤醒状态，以及目标会话仍存在。随后通过 Android 系统 Activity 结果机制交接；识别应用拥有录音及取消界面。灵伴不同时启动 AudioRecord，不向接收端发送会话内容、模型配置或密钥，不自动申请额外权限。

结果只取第一候选，按纯文本回填开始时的会话草稿，不自动发送到模型。取消/空结果不改草稿，超过 8000 UTF-16 字符或格式错误拒绝，桥也再次校验并剔除附加字段。切换会话后的结果仍回原草稿；目标会话已删除则不重新创建。界面说明识别应用可能联网，不能把此入口称为“本地离线转写”。完成或取消应在识别应用的界面进行。

该入口与配置的 STT、连续语音和离线关键词待机分别提供；不会自动替换转写服务。桥等待系统交接最多五分钟，超时后的迟到结果不回填。尚未验证识别界面打开时应用进程被系统杀死后的结果恢复；普通未发送草稿仍为控制器内存状态。

## 实时语音配置与原生生命周期（2026-10-20，Codex）

`snapshot.voice.live` 是可选能力，返回 mode、公开 profile、密钥是否配置以及 readiness 摘要；旧宿主隐藏此表单。`voice.live.save` 单独保存常规/实时模式、OpenAI Realtime 或 Gemini Live 协议、HTTP(S) 基础地址、模型、音色和可选密钥。凭据仍在原生加密存储中，按协议和地址隔离，快照不含密钥。编辑草稿不会被轮询覆盖；保存不启动连接或麦克风，活动期间不能换配置。原 STT/TTS 保存不再强制切回常规模式。

“连续语音”按保存的模式启动；实时模式要求主聊天模型和 Live 配置就绪，不要求额外 STT/TTS。录音转文字仍独立使用 STT；消息朗读仍使用 TTS。唤醒待机命中后的有界 PCM 交给当前语音模式，实时模式直接交给 Live。Live 服务只负责听取和发声，`ask_familiar` 复用原主模型、会话、记忆和工具审批，不另建一套手机 Agent。

原生 Activity 对普通语音与唤醒启动均核对前台焦点、亮屏/解锁、选择器占用。连接阶段在前台建立 microphone 类型服务，握手成功后才开始 AudioRecord；连接期间退到桌面可继续。私有 `audio.state` 带 epoch，停止后旧状态不能重新保活；语音会话期间保留麦克风前台类型，停止、断线、通知停止与服务失败释放设备。进程重启仅恢复配置。

本轮沿用桌面已有 [OpenAI Realtime 事件](https://developers.openai.com/api/reference/resources/realtime/client-events) 与 [Gemini Live WebSocket 协议](https://ai.google.dev/api/live)，原生服务遵循 [Android 后台启动限制](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)。没有迁移为其他实时产品或硬编码新的推荐模型；账号可用模型/音色需用户按服务填写。设备验收使用本机协议夹具和真实 AudioRecord/AudioTrack，不能作为真实云识别质量或端到端通话时延证据。

## 应用查找与打开审批（2026-10-20，Codex）

手机 Agent 新增 `android_apps` / `android_open_app`，沿用原有任务卡、逐项批准与拒绝。列表查询前说明匹配应用名称/包名将交给模型；打开时显示具体名称和包名。短期引用、操作编号和 Intent 细节不进入用户决策文案。应用标签仅作为纯文本，不能执行 HTML 或成为系统指令。

target 必须来自刚完成的查询，120 秒内单次有效；打开前原生核验当前入口与解锁状态。系统提交不代表业务完成，工具要求再 `android_screen` 观察；系统拦截或未看到窗口时返回 unconfirmed，不自动重复打开。后续读屏、点击、输入和手势仍分别审批，保留 Claude 已完成的跨应用卡片样式。

应用查询/打开不是新的网页命令，也不向 UI 提供任意 Intent 接口；仅可信平台插件可调用原生私有能力。新增 Intent 查询不等于申请全部应用可见性权限。

## 剪贴板图片入口（2026-10-20，Codex）

可选 `snapshot.media.paste === true` 显示“粘贴图片”，缺失时隐藏。`media.paste` 无参数，返回与系统文件选择相同的附件数组；桥剔除宿主附加字段，校验数组与附件元数据。按钮只在点击时请求，不通过轮询判断剪贴板是否有图。

用户点击时固定目标会话，与文件/相机共用选择锁。结果仅加入原会话待发送托盘，可预览、移除后再发送；目标会话消失时不重建。空剪贴板、非图片或读取失败保留原稿与附件，文字粘贴继续使用输入框的系统菜单。三种来源共享原有贴纸样式，并各自保留 48dp 触摸区域。

原生 Activity 核对前台焦点与解锁，单次读取 ClipboardManager，再走既有 content URI 暂存、图片校验、共享媒体库与预览流程。不能从网页提交 URI 或在后台调用该能力；来源由原生标记 clipboard。每次最多 8 张，单张 12 MiB，支持 PNG/JPEG/WebP/GIF。添加不等于上传。

## 大型工具目录与上下文预算（2026-10-20，Codex）

Android 装配启用 `createMcpClient({deferLargeCatalogs:true})`：单服务超过 12 个工具或定义合计超过 6000 字节时，保留全部实际工具实现，但模型通过共享的 `mcp_tools_search` / `mcp_tool_schema` / `mcp_tool_invoke` 获取和调用。管理页仍显示完整目录数量；检索每页 6 项，参数 JSON Schema 每页 1800 字符，不丢参数约束。服务断开或配置变化使旧引用失效。

`createAgentTools({adaptiveCatalog:true})` 同时提供按需的全体可用工具目录。Agent 每轮重新核对定义与预算；仅当完整定义放不下时切换为 `familiar_tools_search` / `familiar_tool_schema` / `familiar_tool_invoke`。会话压缩按实际可用的最小目录预留空间，发送前仍计算本轮完整输入和实际工具定义，不提高模型窗口或降低图片估算。Windows 默认装配保持原模式。

目录代理回到同一个 `agent.tools.runRich`，执行时校验注册对象身份、参数和原权限。等待批准时注销/重连不能让旧引用执行；拒绝按实际工具名记录，跨目录入口不会重新请求同一被拒工具。图片仍经过共享媒体层交给模型。

预算不足时，工具可通过可信注册的 `compactResult` 策略缩短已经用于后续调用的参数页。只改变本次模型请求副本，保留 ref/重新读取方式、调用配对、实际操作结果、图片及持久化的完整执行记录。目录查询和参数阅读不引入新的 UI 权限开关，也没有绕过原有审批。

本轮使用本机 HTTP MCP 与模型协议夹具，在固定 32768 窗口验证 80 个工具（138801 字节目录）、图片和图片后的继续调用；这不是对真实 GitHub 模型选择能力或全部云业务的验收。

## Android 飞书私聊（2026-10-20，Codex）

`snapshot.feishuChannel === true` 时，在设置中显示“飞书私聊”。沿用纸色、鼠尾草按钮与既有确认层。`feishu.status/save/pair/stop` 返回经过白名单投影的公开状态；表单仅持有未提交草稿，不回填应用密钥。旧宿主隐藏入口，不提供修改飞书端点或代理的 UI 参数。

默认关闭。保存 App ID/App Secret 后可启用；App ID 与官方 SDK 一致，为 `cli_` 加 16 位十六进制。密钥经 Android 原生 Keystore 加密保存。更换应用清除旧密钥与配对；清除密钥同时停用。保存核对 revision，冲突保留草稿；保存期间锁定输入，迟到轮询不能覆盖新配置。重新读取、移除配对使用既有确认框。

长连接和配对属于 `feishu.channel` 插件；收到配对码后仅处理配对用户的私聊文字，群聊、机器人和未配对消息不进入模型。单次配对码有效 10 分钟，最多 20 个配对。官方 SDK 的事件确认立即返回，回复进入有界队列，并在执行前持久化消息去重。停止私聊关闭连接、取消回复与待批；停止常驻立即暂停通道，保留开启偏好，重新开启常驻恢复连接。控制页面关闭不承担或终止连接生命周期。

私聊复用 `channel.chat`、当前 Provider、记忆/技能、上下文压缩与共享 Agent，按应用、发送用户和会话隔离历史。工具审批标题标注“飞书私聊”，目录代理继续传递来源和原权限；`/new` 重置私聊上下文，记忆保留。飞书业务 API、浏览器 OAuth、文件/语音消息及群聊不是本轮范围。

实现依据：[飞书官方 Node SDK](https://github.com/larksuite/node-sdk/blob/main/README.md)。同一应用在多个端点建立长连接时，消息可能由其中一个连接消费，不保证同时送达桌面和手机。当前本机 HTTP/WebSocket 协议测试通过实际 SDK、模型请求及工具批准/拒绝；实际 APK 验证停用配置、原生密钥、冲突和重启，不向飞书发送夹具密钥。真实应用凭据与飞书收信仍待用户配置后验收。
## 开机启动伙伴增量（2026-10-20，Codex）

小窝的常驻卡片新增“开机启动伙伴”，默认关闭。通过可选 `snapshot.startup` 和 `runtime.startup.save({enabled})` 接入原生所有者，旧宿主隐藏入口；不把它作为可检测的 OEM 自启动授权。保存期间锁定，快照确认前不显示成功；权限撤回时仍允许关闭偏好，缺少悬浮窗权限不能开启。

设置只影响以后开机，当前陪伴仍由常驻按钮管理。首次解锁后的系统 BOOT_COMPLETED 经未导出的接收器，在 `:runtime` 内检查偏好、权限与只读 BOOT_COUNT，启动现有 specialUse 宠物服务。不会启动 Activity、录音或唤醒；没有解锁前启动、更新安装后启动或反复定时拉起。界面区分尚无记录、提交请求和服务实际启动等结果，并提示小米额外的系统自启动设置。共享 Kernel 不承担原生权限或开机生命周期。

六组 UI 检查覆盖异步保存/失败、缺失权限、旧宿主与四种屏幕宽度；核心及设备证据见 [常驻运行实施](../19_Familiar_Android常驻运行实施.md)。测试脚本：`scripts/smoke-android-startup-ui.mjs`、`scripts/smoke-android-startup.mjs`。

## 无障碍已启用但断开（2026-10-21，Codex）

复用既有 `MobileCapability.state = disconnected`，不增加桥接命令。原生状态先看自身服务是否已连接；未连接时，只读取系统的 [ENABLED_ACCESSIBILITY_SERVICES](https://developer.android.com/reference/android/provider/Settings.Secure#ENABLED_ACCESSIBILITY_SERVICES) 并匹配自身 ComponentName。自身开关仍启用时显示“已断开”，尚未启用显示“未授权”；读取受限时不据此宣称已连接。

能力卡片与详情提示：如果系统显示“无法运行”，先关闭“灵伴手机操作”再开启，回到应用后刷新真实状态。只提供用户操作入口，不自动改系统设置。恢复连接不复用旧观察，操作仍须重新观察和逐项批准。独立 Controller/Runtime 的进程边界保持不变。

## 工具归档与原文分页（2026-10-21，Codex）

共享核心可将已完成的大型文本工具轮次完整落入当前会话的原文索引，只缩短后续模型请求。模型通过现有工具 `context_read` 回查，默认页长为 4000，可指定 limit；大目录下先通过按需目录检索。普通移动界面的 `context.archive` 默认页长仍为 16000，沿用原会话绑定与读取协议。原气泡输入、草稿、回复和手机操作审批保持原接口；本轮同包 9 项气泡聊天及三个手机操作场景/清理通过。归档失败或取消时保留原执行轨迹，删除会话同时清除归档。

## 自然对话气泡（2026-10-21，Codex）

`PetBubbleChat` 的根窗口透明。奶油色回复和浅绿输入各自使用 `PetSpeechDrawable` 绘制圆润纸面、曲线尾巴及轻阴影，无描边、标题栏、外层卡片或系统输入下划线。输入气泡从 184dp 随草稿伸展至最多 260dp，支持三行；回复按文字收紧，长内容在有限高度内滚动。发送/停止、关闭保留 48dp 可访问点击范围。

回复始终靠近宠物，输入错位放在外侧。宠物上方空间不足时，气泡移动到下方，排列与尾巴同步翻转；改变排列使用原 View 的顺序调整，保留系统输入连接。会话、流式生成、冲突提示和按会话草稿仍走同一共享核心。输入法沿用设备当前 IME，窗口依据 IME insets 避让；真机键盘与候选条仍需设备验证。

绘制与输入法依据：[Drawable](https://developer.android.com/reference/android/graphics/drawable/Drawable)、[系统输入法可见性与焦点](https://developer.android.com/develop/ui/views/touch-and-input/keyboard-input/visibility)。设备脚本 `scripts/smoke-android-bubble-layout.mjs` 保存短长回复、多行、上下方排列和草稿截图；结果见本轮实施记录。

## GitHub 浏览器设备授权（2026-10-21，Codex）

`snapshot.githubAuth` 为真时，GitHub MCP 设置提供独立的登录应用设置、获取验证码、复制验证码并打开 GitHub、取消、保存登录到服务和清除本机登录。需要 Familiar 自己注册且启用 Device Flow 的公开 Client ID，不使用其他软件的应用身份，也不要求 Client Secret。登录和启用 MCP 分别确认，保留原只读/启用偏好和未提交 Token 草稿。关闭控制页只停止界面轮询，授权由独立 Runtime 继续持有。

请求地址固定为 GitHub 官方设备授权、令牌和用户端点。凭据仅经本机 Keystore 所有者保存，公开桥只返回验证码、账号和状态；MCP 保存不透明绑定，每次请求由 Runtime 获取有效令牌。刷新单次执行，取消单个消费者不打断轮换；刷新结果未知时要求重新登录，不重放刷新。应用、账号或 MCP 凭据变化会拒绝旧状态提交，保护同时保存的新 Token。

可选的公开 Client ID 设置无法读取、类型错误或 JSON 损坏时，核心继续启动并保留原文件和旧登录。`github.auth.status` 可附加 `configurationError: true`，返回空 Client ID、未连接及错误说明，不发送授权请求。UI 允许在此状态重新保存，包括保存为空；沿用更换应用的确认，明确告知会清理旧设备登录和断开相关工具，取消不改文件。确认成功后解除错误，并在同一 Client ID 仍为空的情况下也停用/清理旧设备登录绑定；并发保存的新 Token 由原 revision/expectedKey 检查保护。此标记为可选字段，旧宿主仍可返回原状态结构。

13 项授权/HTTP/MCP 聚焦协议检查及 8 项 UI 检查通过，包含四种宽度、关闭重开、取消、重启、并发刷新和提交冲突。测试使用本机协议夹具，没有向 GitHub 提交假 Client ID 或 Token。真实账号授权、系统浏览器实际交接和真实远程 MCP 仍需注册应用后验证。依据：[GitHub 官方设备授权与刷新](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)、[远程 MCP 宿主接入](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md)。

## 内置办公执行路径（2026-10-21，Codex）

Android 的办公命令改由官方 Go CLI 的 Wasm 构建在独立 Worker 中执行，仍运行于 ARM64 Node Runtime。公开的 `feishu.office.*` 状态/检查/保存、身份授权、共享 Agent 审批与 `feishu_cli` 工具协议保持；页面不需要新增执行器选择、Wasm 设置或命令输入。运行文件、网络转发、私有配置与原生工作区代理只由可信 Runtime 装配，网页不能提供程序路径、任意地址或模块。

取消、超时和结果未知沿用原状态语义；执行中断不切换另一执行路径或自动重放。缺个人授权时不回退机器人，关闭控制页不终止 Runtime 所有的任务或授权。新封装禁用独立 CLI 的后台更新检查，发行内容随 APK 更新。完整组件和主程序证据见 `../21_Familiar_Android执行器兼容性调查.md`，真实账号与云端办公仍需另行验收。
