# Android ARM64 构建与签名

在仓库根目录使用 PowerShell。工具链：Node.js 24、JDK 17+、Android SDK Platform 36、Build Tools 36.0.0、NDK 27.0.12077973、CMake 3.22.1，以及 Rust stable 的 `aarch64-linux-android` 目标。

```powershell
npm ci
rustup target add aarch64-linux-android
$env:JAVA_HOME = '你的 JDK 目录'
$env:ANDROID_HOME = '你的 Android SDK 目录'
npm run android:build
```

`scripts/android-env.ps1` 优先使用开发者环境，也兼容 `.artifacts/android-toolchain` 下的独立工具链。首次构建需联网：脚本准备并校验 Android Node、离线唤醒和办公 Wasm 依赖，随后构建移动 UI、共享核心和原生插件。Tauri 会生成本机 Gradle 引用；`local.properties`、`tauri.properties`、`tauri.settings.gradle`、`tauri.build.gradle.kts` 和编译缓存不入库。

Android Node 使用社区 [fogtape/nodejs-mobile v24.22.0-0](https://github.com/fogtape/nodejs-mobile/releases/tag/v24.22.0-0)，不是 Node.js 官方 Android 稳定发行。`prepare-android-node.mjs` 固定下载地址、长度及 SHA-256；包内提供的 Node 头文件与 `libnode.so` 必须来自同一版本。其他依赖亦由各准备脚本固定并校验，生成物位于 `.artifacts`。

```powershell
# 正式版：独立包名和发行密钥，R8 开启，调试关闭。
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-android.ps1 -Release

# 一次性旧版迁移包：旧 debug 包名/签名，versionCode 3001。
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-android.ps1 -Migration
```

正式签名首次创建于 `.release-keys/`，之后始终复用同一密钥。维护者必须私下备份整个目录；不可提交、上传或重新生成替换现有发行密钥。旧版迁移包必须使用原旧包的 Android debug keystore，发布前比对证书摘要，不能使用一台新机器随机生成的 debug keystore 冒充兼容升级。

构建会验证 ARM64 原生库依赖闭包、ELF/ZIP 16 KiB 对齐；正式签名再核验 v2/v3。测试助手位于 `tests/android-release-probe`，只能以同证书安装到指定包，单独构建、安装、结束后卸载，绝不放进 Release。

## 运行验收

仅使用 `emulator-5554`，不要操作其他已连接设备。权限通过 Android 系统界面授予。`npm test` 验证共享核心和桥；`smoke-android-approval-ui.mjs` 验证四项审批布局。真实设备操作脚本必须在最后恢复模型、会话、权限策略并清理本轮创建的日历与测试会话。测试原生时钟需设备已安装支持 `AlarmClock` 标准 Intent 的应用；API 的 `handedOff` 只表示交接，需要观察应用验证结果。
