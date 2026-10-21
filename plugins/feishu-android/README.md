# Android 飞书办公执行器

状态：**已装配到 Android 主 APK、共享 Agent 和“设置 → 飞书 → 办公能力”。** 可选机器人或个人身份，默认关闭，与私聊独立；应用密钥及个人令牌由 Android Keystore 加密保存。个人设备授权、刷新与补授权已实现，真实账号登录、云端业务与真 ARM 手机验收尚未完成。

Windows 的 `feishu-cli` 通过官方 CLI 提供多个办公域。Android 在同一官方 v1.0.96 基础上使用 Go/NDK 构建 Android ARM64 PIE，复用官方命令、参数目录、Skill 和请求实现。它是可执行文件，APK 打包名为 `libfamiliar_lark.so`；应从安装器提供的 `nativeLibraryDir` 创建子进程，**不是 JNI 共享库，不能 System.loadLibrary**。不从可写的数据目录下载并执行代码。

`cli/` 是官方公开扩展接口的宿主，不改上游源代码。一次调用只接收一个不超过 128 KiB 的 JSON 输入，含 args、appId、identity、临时 token、授权 workspace 和可选 stdin。凭据仅从输入管道进入该进程，凭据提供者拒绝跨应用/身份与空令牌，默认文件密钥链被禁止；后续账号连接和刷新必须由 Android Keystore 的现有所有者提供。CLI 登录、配置、事件总线及身份/服务地址覆盖不开放。办公命令边界沿用桌面策略，仍需外层共享 Agent 执行真实工具授权，不能把入口校验当作审批。

单个参数最多 32000 个 UTF-16 单位，与桌面 `String.length` 一致；中文不会按 UTF-8 字节提前拒绝，非 BMP 表情仍计两个单位。总输入继续限制实际 UTF-8 字节，组合多个合法长参数也不能超过 128 KiB。共享 `policy_cases_test.json` 覆盖 ASCII、中文、emoji、混合、重音组合、连接表情、NUL 和身份覆盖。

官方 FileIO 扩展由 `os.Root` 实现，文件读取与原子提交限于授权工作区；拒绝目录穿越、符号链接逃逸和非普通文件，单文件上限 32 MiB。覆盖提交使用临时文件再 rename，不覆盖提交使用排他 hard link；失败清理临时文件。路径预检也检查现存父级，但真实读写仍使用根句柄。

`runner.ts` 为可信 Runtime 提供排队、独立配置目录、stdin 传参、有界输出、30 秒超时与取消。正常参数不进入 shell。取消/超时/崩溃/输出超限返回 interrupted，不自动重试，也不声称外部写入一定没发生。宿主通过启动参数传入 `nativeLibraryDir`；网页桥只管理配置和固定的离线组件检查，不接受命令、可执行文件、环境或文件根。

`index.ts` 注册共享 `feishu_cli` 工具：纯帮助/模式/Skill 读取归 read，业务命令用官方帮助的 Risk 判定，未确认只读的操作归 outsideWrite，沿用 Android 审批表面。只有官方帮助实际声明 `--yes` 的命令才在批准后预先附加该标志；不在执行后重放确认请求。换应用/密钥或停用会使旧工具失效，并取消正在执行的任务。已发起的外部操作不能保证撤回。

`token.ts` 按[飞书 OAuth v3 自建应用凭据接口](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/tenant_access_token)获得机器人临时令牌，按返回期限提前更新；禁止重定向、有界响应、固定错误信息。机器人令牌只在内存及 CLI 输入管道中，支持至 16 KiB JWT。用户提供的应用密钥不随 APK 打包，不回填页面。

`auth.ts` / `auth-http.ts` 实现个人设备授权，采用同一官方 CLI 的 [device flow](https://github.com/larksuite/cli/blob/cb5a3d704379552dc61e37898e5f74798783190d/internal/auth/device_flow.go) 和 [令牌刷新](https://github.com/larksuite/cli/blob/cb5a3d704379552dc61e37898e5f74798783190d/internal/auth/uat_client.go)协议。用户发起后在飞书官方页面确认；无自建回调，网页不能传入端点或令牌。轮询处理 pending、slow_down、网络退避、取消与过期。个人凭据按应用编号和密钥摘要绑定，整体写入加密原子记录；刷新并发合并，先落盘刷新标记，进程中断或结果未知时要求重新登录，不重放轮换令牌。取消与原生写入交错会恢复之前的记录，清除失败保留重试入口。

“办公身份”选择个人后必须完成登录；缺少权限只展示官方明确报告的 scope，由用户确认补授权，不回退机器人。审批范围绑定应用、身份、配置、账号和登录版本；换号、清除或更换凭据使旧任务失效。正常令牌刷新不重建当前工具。清除本机登录不等于撤销飞书端应用授权。

## 本地构建和验证

在仓库根目录执行：

```powershell
./scripts/build-android-feishu.ps1 -Test
node --experimental-transform-types --disable-warning=ExperimentalWarning --test tests/android-feishu-runner.test.ts
node scripts/build-android-feishu-fixture.mjs
node scripts/smoke-android-feishu-cli.mjs
node --experimental-transform-types --disable-warning=ExperimentalWarning --test tests/android-feishu-office.test.ts
node --experimental-transform-types --disable-warning=ExperimentalWarning --test tests/android-feishu-auth.test.ts
node scripts/smoke-android-feishu-ui.mjs
node scripts/smoke-android-feishu-office.mjs
```

Unicode 设备对照先运行 `./scripts/build-android-feishu.ps1 -Test -HostProbe`，将同一托管模块的 Windows 版本构建到 `.artifacts/android-unicode/host-cli.exe`，再执行 `node scripts/smoke-android-feishu-unicode.mjs --prepare`、`node scripts/build-android-feishu-fixture.mjs`、`node scripts/smoke-android-feishu-unicode.mjs`。准备步骤生成共享语料和实际 Windows dry-run 结果；设备步骤验证 ARM64 请求体摘要，不重试，并移除测试 APK。完整记录见执行器调查中的参数边界章节。

工具链与依赖只位于 `.artifacts/android-toolchain/`。脚本锁定 Go 1.27.2、NDK 27.0.12077973、官方提交 `cb5a3d704379552dc61e37898e5f74798783190d` 及两份下载归档 SHA-256，生成 `.artifacts/android-feishu/libfamiliar_lark.so`、`managed-build.json` 和 jniLibs。二进制为 AArch64、Android linker64、最低 API 28、LOAD 段至少 16 KiB 对齐。`android:build` 自动构建并打包，使用安装器解包的原生目录；APK 校验器核对七个库及办公程序摘要，禁止遗漏或旧文件混入。许可证一并打包。

设备脚本针对 emulator-5554 安装独立无 INTERNET 权限夹具，验证 96 次帮助、参数模式、Skill、日历/文档 dry-run、工作区输入、越界/符号链接、无凭据和账号覆盖拒绝。每轮带 runId，报告包含设备内实际二进制摘要，不能把旧报告当成功；结束卸载夹具。dry-run 是官方请求预览，没有真实飞书读写。临时账号 ID 是固定假值，不提供任何真实 Token。

## 已知未通过项

此前扩大为 2016 次隔离设备调用，默认调度、单核、原子指令、原 JSON、Go 1.26 和旧 GC 对照均出现异常；完整记录见 [执行器兼容性调查](../../docs/21_Familiar_Android执行器兼容性调查.md)。实验选项没有进入产品。后续只修正 UTF-16 参数边界，生产 CLI 为 `9f8d92c9de42d307be9454dd3d1b5a232a9862e43eab6187766b89aaa52fce44`，Windows 与 ARM64 夹具各 15 次边界检查通过；主程序仍复现过执行中断，不能宣称稳定性已根治。长参数及长预览也继续受模型上下文预算限制，完整对话场景没有据此标记通过。

`runner.ts` 已补齐退出码 2 的 Go panic、fatal 和致命信号识别，统一标记执行中断，办公工具返回结果未知并禁止自动重放。174 项核心测试、类型检查和 Windows 构建通过；新包 8 组气泡聊天通过。新包办公回归在文档帮助处实际中断并恢复原状态，没有完整通过。主包摘要与最终运行状态见 [验收核对](../../docs/20_Familiar_Android验收核对.md)。以下保留早期局部验证记录。

当前雷电 x86_64 + Houdini 环境出现低概率 Go 子进程崩溃（139，libhoudini.so / Go 调度状态切换附近），不是主 Familiar 常驻进程崩溃。初次和后续默认模式均复现；关闭异步抢占仍复现，已从执行器删除该无效兼容选项。仅在夹具中关闭 ARM 原子指令优化的 96 次对照无 139，但有一次输入解码失败，不能作为问题已修复的证据；没有把该选项加入产品。

保留原始证据 `probe-initial.json`、`probe-crash.log`、`managed-probe-matrix.json`、`managed-native-final.json`、`managed-atomics-probe.json`。输入解析失败已拆成读取、大小、JSON、尾随数据阶段码，只记录阶段，不记录输入正文或令牌。后续仍需确认转译稳定性、真实账号 OAuth、真实云业务和真 ARM 手机行为。

上一阶段独立夹具默认配置的 96 次检查全部通过，二进制 SHA-256 `8a59bcae0513ef74fc6aef897851c2464e7b491571cecba765b1da136fe315ec`；该历史记录不证明崩溃已根治。本轮扩大令牌长度后的二进制摘要为 `07fc29b8e6483ab9e853453ab43981e62315e995e84a6813c30880859a1b3052`，50129288 字节。4 组 Go 测试、164 项核心测试、类型检查、Windows 构建、8 组 UI 检查及主 APK 的 8 组设备检查通过。

设备证据 `.artifacts/android-feishu/office-device.json` 对应 APK `a0ea6001d324ff80b89b5c8871826e337243d7c39ba7879bd9c66d88f266a909`：真实 Runtime 执行、设置开关、本机模型驱动共享 Agent、实体触摸批准/拒绝、官方日历 dry-run、工作区越界拒绝与配置恢复。使用临时假应用和本机模型，未向真实飞书发送凭据或业务请求。首次普通命令多附加 `--yes` 的失败证据保留为 `office-device-first-failure.*`，修复后重跑通过。测试额外产生的空会话经核实清理，原模型/会话/宠物配置已恢复；真账号能力不能由这些离线检查推断。

依据：[官方宿主扩展接口](https://github.com/larksuite/cli/blob/v1.0.96/extension/platform/README.md)、[凭据扩展接口](https://github.com/larksuite/cli/blob/v1.0.96/extension/credential/types.go)、[文件扩展接口](https://github.com/larksuite/cli/blob/v1.0.96/extension/fileio/types.go)、[Android NDK 其他构建系统](https://developer.android.com/ndk/guides/other_build_systems)、[Android 可写目录执行限制](https://developer.android.com/about/versions/10/behavior-changes-10#execute-permission)。
