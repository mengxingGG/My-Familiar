# Android 目标与验收核对

2026-10-21。目标仍是构建 Android 可运行程序、保持 Windows 主要功能、常驻宠物、受控手机操作与 Android 权限适配。本文汇总当前代码和证据；分项实现通过不自动代表全部目标完成。文档 19 保留各轮详细过程与历史失败。

## 1.0 正式交付（2026-10-21）

- 正式包：`release/android/Familiar-1.0.0-arm64.apk`，SHA-256 `392f0e5e2b7d6adf3dcc056f24c5f152b91332cb9a18a8e67913abfa4c5b8634`；ARM64，Android 9+，R8 开启、调试关闭，v2/v3 和原生库 16 KiB 对齐均验证。
- 过渡包：`release/android/Familiar-0.3.1-migration-arm64.apk`，旧包名/证书，code 3001。实际覆盖 0.3.0 保留设置/凭据，系统选择器加密导出；正式包导入、真实模型调用和恢复点均验证。
- 类型检查和 201 核心测试、Windows 五组发行目录回归通过；Android 真实审批四项选择、权限边界、日历目录/事件/参会人/提醒/忙闲隐私/筛选、重复实例改期取消与冲突、真实时钟闹钟/倒计时均有本轮证据。正式包通过真实 DeepSeek 气泡打开应用→无障碍点击→日程创建/回读，并包含拒绝分支。
- 新增能力与边界见 [文档 22](22_Familiar_权限与Android日历闹钟迁移.md)，用户升级见 [0.3.1 迁移说明](releases/v0.3.1-migration.md)。真 ARM/HyperOS/软键盘/长时功耗及真实第三方账号范围仍按下文区分，正式版本号不代替未进行的真机测试。

## 0.3.0 历史交付

- `release/android/Familiar-0.3.0-arm64-debug.apk`，135733467 字节，SHA-256 `641056e310a2c1b4974511cc57cffa7d32296fa687ce35dc4de1bb830f08b106`。上一包 0363 保留为 `Familiar-0.3.0-arm64-debug-startup-baseline.apk`，其他历史包继续保留。
- 当前 emulator-5554 已安装同一文件。上一轮隔离损坏的可选 GitHub 登录应用设置：错误只限制 GitHub，普通聊天和常驻宠物仍启动；原文件与旧登录保留，用户明确确认重新保存后才修复并清理旧设备登录绑定。既有 Go/Wasm 办公、受限文件代理及自然气泡保持。共享核心摘要 `e1a561e47db07b830cbebed71118a3d478c8d9405e18cb6b1c3e347e008bce49`；包内容与原生表面一致性见 `.artifacts/android-startup-resilience/` 中的 `package-content-proof.json`、`native-surface-proof.json`。本轮没有修改产品代码或重建 APK；用户授权复用的 DeepSeek 已仅保存在模拟器 Keystore，最终设备核对见 `.artifacts/android-deepseek-live/final-boot.json`。APK 本身不包含用户密钥。
- 首轮按用户要求在现有模拟器验收。设备实际为 x86_64 + Houdini ARM64 转译，APK 仅 arm64-v8a；不能把这里的通过记录当作 ARM 手机、16 KiB 页设备或 HyperOS 长时结果。
- 上一轮 **196 项核心回归、类型检查、Windows/Android 构建及 v2 签名**通过；**9 项 GitHub UI** 检查通过。当前主包已有 **5 项冷启动恢复、11 项办公、9 项聊天、三个气泡手机操作场景及清理**记录；随后增加 **3 项 Exa 基础搜索、6 项吸附/收起和 3 项控制页进程退出**检查。本轮在明确授权后另通过 **6 项真实 DeepSeek 迁移/聊天与 4 项重启/工具调用**检查。前包的 72 项办公组件、6 组 Go 测试、13 组原生文件和 4 次 VM 取消证据保留，相关 Wasm/封装及原生工作区代理摘要保持。前包 7 项气泡布局证据保留，当前 Manifest、DEX、原生资源和角色素材相同，未冒充重新运行该矩阵。其他账号服务、ARM 手机和长时功耗仍待验收。

## 按原目标核对

| 要求 | 当前实现和已查看的证据 | 结论与限制 |
| --- | --- | --- |
| ARM64 可构建、安装、运行 | ARM64-only 包、七个原生库与依赖闭包、ELF/ZIP 16 KiB 对齐、v2 签名；当前包安装/文件摘要与真实核心、原生窗口验证一致 | 当前模拟器通过；真机 ABI/系统与功耗另验 |
| Claude 风格与 Codex 核心分工 | `docs/android-ui/BRIEF.md`、`INTEGRATION.md`；现有 Claude 前端由产品桥接共享核心，额度不足后按用户授权由 Codex 接手；新原生气泡沿用纸色/绿色风格 | 已实现；没有把预览 fixture 当产品核心 |
| 独立常驻、关闭控制页、通知停止 | `RuntimeService` / `PetService` 同属 `:runtime`，Activity 私有 IPC；当前 `android-controller-exit/result.json` 3 项：只结束控制页进程，连续 120557ms 的五次采样保持同一 Runtime、前台服务和宠物，重开控制页后配置与会话保持；历史 `android-lifecycle/final-verified/result.json` 9 项含通知/系统停止、不重放及手动恢复 | 当前控制页退出通过；停止/恢复完整矩阵为历史证据，本轮保持亮屏策略，未测锁屏/Doze，不能承诺系统强行停止后自动复活 |
| 原创角色、动作、人格、配置和历史 | 共享 character-pack、renderer、behavior、settings、conversation；5 组 `parity-smoke.json` 含七角色、七 Provider 档案与文件工具；当前包气泡历史/上下文一致、配置恢复通过 | 主功能已实现；历史分项不是当前包全量重跑 |
| 点宠物直接输入、连续气泡聊天 | `PetBubbleChat` 连接共享会话；透明外层，两枚错位的曲线尾巴气泡，输入从 184dp 随草稿伸展；当前 `android-startup-resilience/chat/result.json` 9 组通过，`android-deepseek-live/result.json` 另验证真实模型两轮原生气泡、四个流式文本采样和临时口令回忆。前包 7 组布局证据保留，Manifest/DEX/原生资源/角色素材未改 | 真实模型连续聊天时主应用保持后台；真机键盘遮挡/候选条尚未实测 |
| 自动贴边、闲置/手动收成小脑袋、展开 | 独立吸附与闲置开关，原生位置持久化；当前 `android-device/current-arm64-docking-check.json` 6 组真实拖动/定时/恢复检查，绑定 6410 主包；原偏好与位置恢复 | 当前包矩阵通过；小脑袋轻点先展开，完整宠物轻点聊天 |
| 模型、流式、取消、上下文管理 | 共享七类 Provider、llm-router、agent-runner、context-compaction；32K 协议矩阵验证大型文本工具轮次归档与分页续答，原始轨迹保留、失败不重放，模型回查默认 4000 字符，界面原文页仍 16000。本轮真实 DeepSeek 官方目录、流式短句、两轮气泡和新 Runtime 的 Keystore 恢复通过 | 真实模型连接与上下文已验证；取消/长工具归档仍引用既有隔离协议矩阵，未冒充本轮真实模型长上下文压力测试；图片和未完成轮次不参与新归档 |
| 记忆、技能、本地文件工具 | 共享 memory-files、skills-local、受限工作区；6 组 `library-smoke.json` 含完整编辑、冲突、系统文件导入、重启与备份；核心回归仍通过 | 已实现与分项验证；没有重写独立手机记忆引擎 |
| 受控无障碍、截图、触摸和接管 | 按需观察、逐项审批、旧观察拒绝、密码过滤、安全窗口保护；当前 `android-startup-resilience/tools/result.json` 验证批准/拒绝/接管后继续气泡聊天；历史撤回再允许后旧操作拒绝及新观察记录保留 | 当前气泡交接矩阵通过，草稿保留且主应用保持后台；权限切换是历史证据，复杂真实应用任务仍需扩充 |
| 悬浮窗、日历、麦克风等权限 | Manifest 声明与 NativeCapabilities 实时检测、系统设置入口；历史 `android-lifecycle/` 含可见悬浮窗撤回/允许、无障碍断开恢复及详情提示，本轮未改权限逻辑，安装后的原权限已核对恢复 | 已实现且保留切换证据；系统开关启用不等于服务已连接，具体授权由用户控制 |
| 系统日历与笔记 | CalendarProvider 查询/创建/改删/重复/实例保护；7 组 `system-smoke.json`、12 组 `calendar-edit-smoke.json`；外部笔记标准 Intent 只报告交接 | 主功能已实现并有设备证据；未同步系列单次写入受限，真实邀请/云同步/响铃不由夹具证明 |
| 图片、文档、剪贴板和相机 | 系统选择器、共享媒体、PDF/DOCX 提取、前台粘贴；5 组媒体、6 组文档、7 组剪贴板分项报告 | 前三类有设备证据；相机接口已实现，模拟器无真实相机，确认拍照待设备验证 |
| 语音输入/朗读、连续语音、唤醒/Live | Android 音频所有者与共享语音编排；6 组 voice、9 组 TTS、7 组 wake、6 组 Live 分项报告；测试引擎在结束后移除 | 有真实音频/协议证据；真人识别质量、扬声器插话、真实云 Live 和功耗尚未验证 |
| 关怀、位置、天气 | 共享关怀与高德规则、一次前台大致定位；7 组 `care-smoke.json` 验证取消、时段防重、锁屏与位置缓存 | 本机模型/位置夹具通过；真实高德和天气服务未验收 |
| MCP、飞书办公/私聊、GitHub | HTTP MCP、GitHub Token 和设备授权/动态刷新；授权与 MCP 启用分别确认，独立 Runtime 持有令牌；可选 GitHub 设置损坏不阻断核心，明确确认后可重置并停用旧绑定。当前共享核心 196 项、主包 5 项恢复与 11 项离线办公通过；`android-deepseek-live/tools/result.json` 另验证真实 DeepSeek 规划一次官方 Exa 搜索并根据结果续答 | 真实模型到 Exa 的完整基础通路通过；Exa 登录能力、GitHub 本应用授权、真实办公/其他账号业务、长时稳定性和桌面进程型工具差异仍待验收 |
| 开机启动与厂商策略 | 默认关闭的开关、解锁后 BOOT_COMPLETED 检查；4 组 `startup-smoke.json` 含真实重启和恢复；Android/小米官方资料见下 | 模拟器主要分支通过；缺悬浮权限的开机分支受模拟器权限重置影响，HyperOS 策略未真机验收 |

报告默认位于 `.artifacts/android-device/`；历史气泡记录位于 `.artifacts/android-bubble-chat/`、`.artifacts/android-bubble-tools/`、`.artifacts/android-bubble-design/` 与 `.artifacts/android-bubble-refine/`，原生执行器中断记录位于 `.artifacts/android-runtime-fix/`，参数与焦点修正位于 `.artifacts/android-unicode/`，历史常驻/权限位于 `.artifacts/android-lifecycle/`。前包工具归档位于 `.artifacts/android-tool-context/`，Go/Wasm 组件与气泡布局位于 `.artifacts/android-office-wasm/`。当前包核心/恢复/UI/办公/气泡/手机操作、包内容和最终状态位于 `.artifacts/android-startup-resilience/`，原授权协议/UI 位于 `.artifacts/android-github-auth/`。首次失败及独立恢复证据保留。执行器路线见 [兼容性调查](21_Familiar_Android执行器兼容性调查.md)。早期报告的验证范围限于当时组件，不可直接合并成“当前包全部通过”。

## 本轮真实链路与配置边界

此前 `.artifacts/android-exa-live/verified/result.json` 使用本机模型夹具规划，真实 Exa 返回 6561 字节结果；其限制记录保留。本轮 `.artifacts/android-deepseek-live/tools/result.json` 则由用户授权的真实 `deepseek-flash` 规划，经共享 Agent / MCP 完成一次实际公开搜索，返回 6557 字节结果并续答，含 Android Developers 的后台启动限制和启动前台服务页面。模型端为两个真实轮次，未使用模型夹具；Exa 仍为无密钥基础入口，批准卡次数为 0，不能称为人工批准过搜索。临时 MCP 行与测试会话均移除。依据官方 [Exa MCP 文档](https://exa.ai/docs/get-started/exa-mcp)，无密钥入口仅覆盖受限基础能力，不能据此宣称已验证账号绑定的全部工具。

用户已明确回复“允许复用 Windows Familiar 的 DeepSeek 连接”。随后仅解密 Windows Familiar 所选 `compatible` / `https://api.deepseek.com` 这一凭据，连同 `deepseek-flash` 及已保存参数迁移到 emulator-5554；未读取其他应用凭据、未修改 Windows 的设置/密文/Local State。密钥仅在内存与本机 CDP 中传递，由产品 `provider.save` 写入 Android Keystore 加密的 no-backup 文件，页面不回填，测试日志和 APK 不包含密钥。两次固定短句测试、两轮原生气泡，以及一次真实模型工具往返均通过；新 Runtime 重启后再次连接成功。真实配置沿用 Windows 的参数，不把其手工上下文窗口当作此前 32K 归档压力矩阵的证据。迁移前只读公开字段的历史快照 `.artifacts/android-acceptance-audit/windows-public.json` 保留，不能据其早期 `false` 标记否认本轮已授权迁移。

## 尚不能判定全部完成的项目

1. 用户所选 DeepSeek 通路已实际验证，模拟器保留这一项授权连接。真实飞书/GitHub/高德/语音服务仍需各自账号与配置才能补业务验收；没有转移这些凭据或擅自开通替代服务，APK 中也没有嵌入 DeepSeek 密钥。
2. GitHub 已有登录应用设置、设备验证码、外部官方页面入口、取消、加密保存、刷新及 MCP 绑定，协议/UI 与 APK 未配置边界通过；尚无本应用注册 Client ID，实际浏览器交接、真实账号授权和远程 MCP 未验收。官方[远程 MCP 接入指南](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md)说明没有动态客户端注册，需要宿主注册应用。Android 上桌面进程型工具的完整等价路线也仍有差异。
3. 旧原生 Go/Houdini 路线在 2016 次对照中仍有异常，根因未定。当前包已切换到同一官方 CLI 的 Go/Wasm 路线，不再包含或回退旧原生执行文件；有限组件与主程序离线办公矩阵已通过，结果未知和不自动重放策略保留。真实账号业务、复杂命令和长时运行仍需扩展验证，不能从这一有限样本推导生产故障率。
4. 相机、真实系统识别引擎、复杂真实应用任务的完整使用流程仍缺充分验证。首轮已按用户要求使用模拟器；真 ARM/HyperOS、真实键盘、16 KiB 页运行和长时功耗保留为后续设备验收，不伪造通过。

此前因缺少真实模型配置而等待的条件现已解决。首轮真实模型、原生气泡连续聊天、Keystore 重启恢复和公开联网工具通路均已通过；其余缺口按上表保留，没有据此宣称完整 Windows 功能等价正式版。真实手机与厂商策略仍为后续设备验收范围，没有临时追加为首轮模拟器交付门槛。

## 平台依据复核

- [Android 前台服务后台启动限制](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)：可见用户交互/通知等豁免与使用中权限分别检查；Android 15+ 的悬浮窗豁免要求已有可见窗口。文档在本轮读取时标注 2026-10-16 更新。
- [Android 无障碍服务](https://developer.android.com/guide/topics/ui/accessibility/service)：服务声明、能力与系统启用入口按平台要求实现，系统权限与应用内逐步批准分别检查。
- [用户停止前台服务应用](https://developer.android.com/develop/background-work/services/fgs/handle-user-stopping)：系统停止会移除进程和前台服务通知，应用收不到停止回调；当前按官方 `cmd activity stop-app` 路线检查，不靠重启计时器对抗停止。[ENABLED_ACCESSIBILITY_SERVICES](https://developer.android.com/reference/android/provider/Settings.Secure#ENABLED_ACCESSIBILITY_SERVICES) 仅用于识别自身开关仍启用，实际连接另行检查。
- [小米自启动管理](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1624)、[后台弹出页面](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1625)：厂商权限与标准悬浮窗权限分开记录，不能根据模拟器或代码推断小米已允许后台运行。
