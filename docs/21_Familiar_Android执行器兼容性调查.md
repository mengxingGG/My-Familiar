# Android 办公执行器兼容性

Android 飞书办公使用固定版本的官方 CLI 编译成 Go/Wasm，由 ARM64 Node Runtime 中的独立 Worker 执行。构建版本与依赖摘要由准备脚本固定，详见 [办公插件](../plugins/feishu-android/README.md)。

## 路线选择

早期原生 Go 执行器在 x86_64 模拟器的 ARM64 转译环境中出现进程崩溃、请求解码及目录结果异常。工具链、调度和运行时选项的对照未形成稳定方案，不能将模拟器转译问题直接推断为真实 ARM 手机的相同行为。

当前发行路径使用 Go/Wasm，仍保持 ARM64 APK。旧原生 Go 路径不作为生产回退；失败后不换执行器重复调用可能产生副作用的命令。

## 执行边界

- 官方 CLI 固定为 1.0.96；Go、`wasm_exec.js`、封装与许可证随准备清单校验。
- 每次调用使用独立 Worker、临时目录和文件描述符所有权；取消或退出后释放句柄再清理文件。
- Wasm 只访问 `/workspace`、`/config` 与本次 `/tmp`。原生文件代理逐级固定目录并拒绝符号链接及不安全硬链接，写入在句柄检查后才截断。
- HTTP 由父 Runtime 转发，认证只发送到固定官方域名，不跟随重定向；凭据不进入环境变量或日志。
- 请求、响应和输出有大小上限。请求可能已发送但响应丢失时返回结果未知，不自动重放。
- 关闭 CLI 自带后台更新检查，发行内容随 Familiar APK 更新。

## 参数与上下文

TypeScript 与 Go 的参数限制统一按 UTF-16 单位计数，同时保留总 UTF-8 请求字节上限，覆盖中文、非 BMP 字符、组合字符和表情。禁止身份、端点覆盖及 NUL 等输入。

大段工具输出由共享上下文插件归档原文并分页回查；不通过扩大模型窗口或丢弃审批轨迹来绕开预算。

## 测试与限制

组件检查覆盖 CLI 帮助、业务域帮助、受控 HTTP、机器人/个人身份、Unicode、工作区边界、并发路径交换、取消和句柄回收。主程序检查覆盖审批、拒绝、离线预览与长工具结果续答。

本机夹具与离线预览不代表真实飞书云端写入成功。实际账号授权、复杂命令、真实 ARM 手机与长期功耗需要单独验证，平台矩阵见 [Android 兼容性与测试](20_Familiar_Android验收核对.md)。

## 依据

- [Go WebAssembly](https://go.dev/wiki/WebAssembly)
- [os.Root 平台限制](https://pkg.go.dev/os#Root)
- [Node Worker 生命周期](https://nodejs.org/api/worker_threads.html)
- [Node-API 环境清理](https://nodejs.org/api/n-api.html#napi_add_env_cleanup_hook)
