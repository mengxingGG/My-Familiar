# Android 飞书执行器兼容性调查

2026-10-20。范围：当前 emulator-5554 上的独立 ARM64 飞书 CLI 子进程。设备实际使用 x86_64 + Houdini 转译；这些结果不能证明真实 ARM 手机也有同样问题。

## 已确认的现象

- 异常不只有退出码 139。实际报告还出现 Go `panic`、`fatal error`、信号堆栈以退出码 2 结束；若只把信号和大于等于 128 的退出码视为崩溃，会把这部分异常误当普通业务失败。
- 三次输入诊断中，发送端与 Go 读取端的字节长度、SHA-256 一致，Go 对原数据的 `json.Valid` 为 true，但请求解码仍返回语法错误。不能归因为已证实的管道截断，也不能单凭此结果认定 JSON 实现本身有缺陷。
- Go 1.26 与 1.27、原 JSON 实现、旧 GC、单核及原子指令选项的对照均有异常。曾短批未出现 139 的配置，扩大检查后仍出现其他 Go 状态错误、嵌入目录解析异常或 panic。因此没有把这些实验选项加入产品。

## 隔离对照结果

全部使用无 INTERNET 权限的临时 APK、假应用编号、官方 CLI dry-run 和受限文件靶场。没有真实飞书账号或外部写入。每轮报告包含 runId、实际设备二进制与测试 APK 摘要；测试结束卸载夹具。下表“异常”只统计偏离预期的结果，正常的越界/缺凭据拒绝不算异常。

| 报告标签 | 调用数 | 异常数 |
| --- | ---: | ---: |
| scheduler-default-a | 96 | 4 |
| scheduler-single-a | 96 | 1 |
| scheduler-serial-no-lse-a | 192 | 8 |
| input-diagnostic-a | 96 | 2 |
| input-buffer-diagnostic-a | 96 | 3 |
| nojsonv2-default-a | 96 | 6 |
| nojsonv2-single-a | 192 | 8 |
| nojsonv2-no-lse-a | 192 | 15 |
| go1.26.10-default-a | 192 | 3 |
| go1.26.10-no-lse-a | 192 | 6 |
| go1.26.10-legacy-gc-a | 384 | 11 |
| go1.26.10-single-a | 192 | 1 |

共 2016 次调用、68 个非预期结果：28 个退出 139、20 个退出 2 的 Go 致命错误、15 个请求 JSON 错误、5 个目录完整性错误。这些是不同配置的有限样本，生产故障率和根因尚未确定。没有一个对照批次完整通过，不能挑选其中的成功命令宣称修复。

汇总 `.artifacts/android-feishu/runtime-investigation-summary.json`；原始报告为同目录下的 `smoke-<标签>.json`，诊断构建与编译日志一并保留。实验副本没有覆盖当时的生产二进制；该轮生产为 Go 1.27.2 构建，CLI SHA-256 `07fc29b8e6483ab9e853453ab43981e62315e995e84a6813c30880859a1b3052`。后续参数边界修正仍使用同一工具链，见下节。

## 本轮产品修正

`plugins/feishu-android/runner.ts` 在退出码 2 时识别标准错误中的 Go panic、fatal 与致命信号格式，统一返回 `interrupted: process-failed`。外层办公工具沿用 `outcome: unknown`，提示核对目标内容，不自动重放可能已发生的写入，也不把原始 Go 堆栈当作普通业务错误交给用户。

普通 `INPUT_JSON_INVALID` 等参数失败保留原分类。新增核心检查分别模拟实际观察到的 panic、fatal、信号退出和普通参数错误，确认四次明确调用只启动四次，没有隐式重试。完整核心回归 174 项、类型检查和 Windows 构建通过。

新主 APK 的办公回归在文档帮助步骤复现执行中断，实际回复为 `interrupted: process-failed`、`outcome: unknown`；该办公回归没有完整通过，原始失败报告和配置清理通过记录保留于 `.artifacts/android-runtime-fix/office-device/office-device.json`。同包 8 组气泡聊天回归通过，最终状态检查确认常驻、悬浮窗和无障碍连接，原模型、会话与设备输入法恢复，测试应用和凭据已清理。APK 摘要和范围见 [验收核对](20_Familiar_Android验收核对.md)。

该修正完善异常结果的处理，没有根治当前转译环境下的执行器故障。下一步需要继续用更小的复现程序核对运行时/转译行为，并与真实 ARM 设备结果对照；不能把单核、关闭指令或换工具链本身当作根因结论。

## 中文与表情参数边界修正（2026-10-20 至 21）

后续检查已复现并修正上述参数边界。TypeScript `validateOfficeArgs` 按 `String.length` 限制每个参数最多 32000 个 UTF-16 单位，而旧 Go 校验按 UTF-8 字节长度拒绝。共享 15 组语料中，32000 单位的中文、emoji、混合文本、组合重音与连接表情在旧 Go 中被错误拒绝，桌面校验和管道均接受；原始失败保留于 `.artifacts/android-unicode/policy-before.log`。

- `policy.go` 现在按 UTF-16 单位遍历计数，非 BMP 码位计两个单位，超限提前返回，不额外分配大数组。每项 32000 单位、最多 60 项、NUL/身份/端点等原有拒绝规则保留。整个输入仍按实际 UTF-8 字节限制 128 KiB，没有提高数据包上限。共享语料 `policy_cases_test.json` 同时由 Go 和 TypeScript 读取。
- 6 组 Go 测试及参数矩阵通过，覆盖请求解码不改字、总字节超限、凭据与文件根；176 项核心测试通过，类型检查及最后两组 Unicode 管道复查通过。日志位于 `.artifacts/android-unicode/`。构建仍固定 Go 1.27.2 / NDK 27.0.12077973 / 官方 CLI 提交，新的 CLI 为 **50129512 字节**，SHA-256 **9f8d92c9de42d307be9454dd3d1b5a232a9862e43eab6187766b89aaa52fce44**。
- Windows 对照程序与无 INTERNET 权限的 ARM64 测试 APK 各完成 **15 次真实官方 CLI 检查**，单次执行、不重试：六类边界文本完整进入官方文档 POST 预览，其余超限、NUL、身份覆盖和总请求超限被拒绝。请求体 SHA-256 与预期全文一致。报告 `host-result.json`、`device-result.json` 包含实际二进制与语料摘要，夹具已移除；使用固定假应用、无 Token、仅 dry-run。
- 主 APK `529519fcaebcca92b73ac725bcf997086cb0eac4506549694f338d12575248b4` 中，实体批准后的 **11000 单位 / 33000 UTF-8 字节**中文已由共享 Agent 交给同一执行器，持久化工具轨迹保留完整官方文档请求体。该场景随后没有完成模型续答：实际气泡显示预算估算 **72496 / 28416**，触发共享 32K 回退窗口的原有容量检查。没有提高窗口或放宽检查，也没有把完整对话场景标为通过。记录 `main-unicode-proof.json`、`office-unicode-focus/failed-scenario.json`、`failure-ui.xml` 与实际截图。
- 常规主程序办公检查曾通过启动、登录禁用、设置、帮助、批准/拒绝与日历预览，后续诊断又复现文档帮助的 `process-failed` / `outcome: unknown`。原始 `office-device`、`office-diagnostic`、`office-diagnostic-2` 与 `office-unicode-focus` 报告均保留；实际变更过配置的轮次已恢复原凭据、模型、会话和宠物状态。完整办公矩阵仍未通过，参数修正没有根治既有执行器中断。

另核对到 Gradle 增量替换原生库后，APK 中留下未引用的旧压缩段：该增量包 148027326 字节，中央目录没有重复条目，实际新库摘要正确。`build-android.ps1` 只清理目标生成 APK 后重新打包，紧凑包回到约 126 MiB；没有删除源码或交付备份。原始归档与逐项比较保留在 `incremental-with-hole.apk`、`package-entry-differences.json`。七个原生库、16 KiB 对齐和签名继续单独核对。

## 长工具续答修正与执行器范围（2026-10-21）

后续主包 `a183ed487230628c31fa994edb0e8a9dc9614709bf05d194f45f8379177063c6` 只更新共享 JS 核心与构建标记，全部原生库及 CLI 摘要保持。共享 Agent 在窗口不足时，完整归档已完成、无图片的工具轮次，保留审计原文并通过 `context_read` 分页回查。

同一 11000 字中文 / 33000 字节请求经实体批准后，真实官方 CLI 返回 33839 字节预览，正文摘要与之前一致；模型回查预览头部与尾部后已完成续答。后续请求的消息和工具定义最大 19051 字节，原窗口预算未放宽。该场景的 7 项入口/执行/清理检查、181 项核心回归及同包气泡检查通过，见 `.artifacts/android-tool-context/` 与 [验收核对](20_Familiar_Android验收核对.md)。

这解决了前述工具已返回但因大段记录无法续答的阻塞；没有改变 Go/NDK/CLI 或转译环境，不能据一次成功推翻本页 2016 次对照发现的稳定性问题。退出 2/139 的结果未知与不自动重放策略继续保持，完整真实办公仍待验收。

## 依据

- [Go Runtime 环境与错误回溯](https://pkg.go.dev/runtime#hdr-Environment_Variables)。本地 SDK 的 `runtime/panic.go`、`runtime/signal_unix.go` 及实际报告也确认致命错误可退出 2。
- [Go 1.27 JSON 实现与官方兼容选项](https://go.dev/doc/go1.27#standard-library)。本轮使用该选项作隔离对照，没有据此判定根因或加入产品。
- [Go 1.26 Runtime 与旧 GC 选项](https://go.dev/doc/go1.26#runtime)、[受支持版本及补丁记录](https://go.dev/doc/devel/release)。工具链来自官方归档并核对 SHA-256，未改官方 CLI 源码或用户全局 Go 配置。
- [Go 字符串与字节长度](https://go.dev/ref/spec#String_types)、[ECMAScript 字符串长度](https://tc39.es/ecma262/multipage/text-processing.html#sec-properties-of-string-instances-length)。两种长度度量不同；本次按桌面接口既有的 UTF-16 单位对齐，没有改成可见字形计数。

## Android 内置执行路径改为 Go/Wasm（2026-10-21）

当前产品改为用同一固定版本的官方 Go CLI 编译成 `GOOS=js GOARCH=wasm`，每次由 ARM64 Node Runtime 的独立 Worker 执行。APK 仍只含 ARM64 原生库，没有增加 x86 包或把办公能力替换为少数手写接口。旧 `libfamiliar_lark.so` 已从新 APK 移除，不在失败后回退或重复调用；旧包 44e8 保留为 `Familiar-0.3.0-arm64-debug-office-native-baseline.apk`。这条路线避开已观察到的原生 Go/Houdini 组合，没有据此宣称其原始故障根因已解决。

- 构建仍固定官方 CLI 1.0.96 / 提交 `cb5a3d704379552dc61e37898e5f74798783190d` 和 Go 1.27.2。Wasm 为 **86749369 字节**，SHA-256 **7d16f635be224646599b864b26afe4846c9fc092c9b29129be92afdabdb97398**；匹配的 `wasm_exec.js`、平台封装和许可证一起打包，清单逐个验证大小和摘要。平台编译覆盖层只补充不支持的终端、剪贴板、系统锁及密钥链等入口，默认拒绝；Android Keystore、凭据生命周期和受限工作区继续由宿主持有。
- Go 的 JS `os.Root` 本身不能提供原子路径保护。因此新增 `libfamiliar_workspace.so`，逐级 `openat` 固定父目录并拒绝符号链接；读写拒绝多硬链接文件，在确认句柄后才截断。Wasm 只见 `/workspace`、`/config`、每次调用独有的 `/tmp`，文件描述符按调用持有。Worker 正常退出或强制停止均释放句柄，取消后才清理本次临时目录。
- HTTP 经父 Runtime 转发，认证头只可携带本次身份的令牌发送到 `https://open.feishu.cn`；不跟随重定向。请求、响应和输出有限额，令牌不进环境变量或日志。已尝试发送后若丢失响应，立即终止本次 VM、标记结果未知；不让 SDK 因传输异常重放本次请求。内置发行内容随 APK 更新，通过上游 `LARKSUITE_CLI_NO_UPDATE_NOTIFIER` / `LARKSUITE_CLI_NO_SKILLS_NOTIFIER` 关闭独立 CLI 的后台检查。
- 最终隔离 ARM64 测试包无 INTERNET 权限。实际产品执行器完成 **72 项检查（54 次 VM 执行、18 次 Worker 前拒绝）**，含帮助、20 个业务域帮助、机器人/个人身份的受控 HTTP、中文 POST、Unicode 与重复调用。另有 **6 组 Go 测试无跳过、13 组原生文件检查、4 次真实 VM 待发响应时取消**通过。原生检查含 512 次并发目录/符号链接交换，以及 8 次强制结束各持有 65 个句柄的 Worker；取消不会重发，临时目录清空，文件句柄未累计。最终记录 `device-product-full-result.json` / `device-product-full-2024c689-2f47-4d8e-b8ca-7848f527ca61-report.json` 位于 `.artifacts/android-office-wasm/`。
- 首次切换的主包 **03639a2eb8fb5f136a29e5385064aed19f4821efd24ea00f1da6926da3e178cf** 完成主程序办公矩阵：真实设置入口、缺凭据拒绝、身份不回退、帮助、实体批准/拒绝、日历 POST 预览、文件越界拒绝和长中文续答。33000 字节中文生成 33839 字节完整预览，正文摘要仍为 `83c6539826979d436fd963e95e39243f0f26c988177c15080bb8693de6a842b4`；模型回查 `dry_run` / `extra_param` 后完成续答，后续请求消息与工具定义最大 21038 字节，未提高 32K 回退窗口。共 11 项含清理通过，记录 `office-main-final/office-device.json`。使用本机模型协议与离线预览，没有真实云端写入。

本轮失败证据也保留：手工原生测试链接时误将 NDK 的通用库目录置前，导致静态 libc 被带入附加库并在转译加载器中崩溃，已改为明确的动态 libc++ 路径，产品 APK 检查还要求依赖 `libc.so` 和 `libnode.so`；新增句柄测试最初按私有目录字符串匹配，未处理 Android 路径别名，已改为文件设备/节点标识检查；网络失败保护曾将后台 npm 更新检查的失败一起终止，已按上游支持选项禁用背景检查。主程序首次审批测试在 WebView 调试端口刚出现时连接过早，脚本现等待端口就绪；前轮配置清理通过，未把失败轮算作成功。上述修正都没有删除原始报告。

该路径通过的是有限组件矩阵和主程序离线链路；真实飞书授权、云端 API、复杂命令组合、实际 ARM 手机与长期功耗仍待验收，旧原生 Go 的 2016 次异常调查继续保留为历史证据。

依据：[Go WebAssembly 与配套运行文件](https://go.dev/wiki/WebAssembly)、[os.Root 的平台限制](https://pkg.go.dev/os#Root)、[Node Worker 生命周期](https://nodejs.org/api/worker_threads.html)、[Node-API 环境清理](https://nodejs.org/api/n-api.html#napi_add_env_cleanup_hook)。禁用后台检查的选项取自本地已固定提交的上游 `internal/update/update.go` 和 `internal/skillscheck/skip.go`。
