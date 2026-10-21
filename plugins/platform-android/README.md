# Familiar Android 平台适配

UI 由 `apps/tauri/ui` 提供，原生适配不另建会话、模型或记忆业务。

- Rust：受限 Tauri 产品命令入口。
- Kotlin `FamiliarPlugin` / `RuntimeClient`：控制器与系统授权入口。
- Kotlin `RuntimeService` / `NativeRuntime`：独立 `:runtime` 进程、单个 Node Mobile 执行器、私有 socket 与同 UID 校验。
- `PetService`：specialUse 前台服务、通知停止、SVG 悬浮宠物；熄屏停止动画计时。
- `FamiliarAccessibility`：按工具请求读取节点和执行动作，快照匹配、锁屏/密码保护与系统授权操作限制。
- `NativeGesture`：逐步批准后的节点内点击/长按/滑动，校验短期观察、目标与遮挡；回调只报告触摸状态，业务效果须再次观察。
- `SecretVault`：Android Keystore AES-GCM 和私有原子文件；凭据不回填 UI。
- TypeScript 平台插件：将原生工具、媒体、音频、位置与宠物表面接入现有 Kernel；不复制共享业务。

支持 `arm64-v8a`、minSdk 28、target/compileSdk 36；已测 API 34 ARM 转译模拟器，真实 ARM 手机兼容性需单独验证。

使用项目根目录 `scripts/build-android.ps1` 构建，自动验证 APK ABI、依赖和 16 KB 对齐。环境脚本使用 `.artifacts/android-toolchain` 内 Rust 与 Node Mobile 缓存，不修改系统全局配置。构建版本、下载来源、运行库风险和完整缺口见 [实施文档](../../docs/19_Familiar_Android常驻运行实施.md)。
