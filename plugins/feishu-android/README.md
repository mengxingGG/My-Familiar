# Android 飞书办公执行器

Android 在官方飞书 CLI v1.0.96 的基础上采用 Go/Wasm，由 ARM64 Node Runtime 的独立 Worker 执行，复用官方命令、参数、Skills 和请求实现。办公能力位于“设置 → 飞书 → 办公能力”，默认关闭，支持机器人或个人身份，与私聊独立。

## 身份与凭据

应用密钥、个人访问与刷新令牌由 Android Keystore 加密保存，不随 APK 打包、不回填页面。机器人令牌按官方期限更新，个人身份采用官方设备授权与刷新协议。

个人办公必须完成登录；缺少权限时显示官方报告的范围，不回退为机器人。审批绑定应用、身份、配置和登录版本，换账号、停用或更换凭据会使旧任务失效。清除本机登录不等于撤销云端授权。

## 执行与权限

共享 `feishu_cli` 工具继续使用 Familiar 的授权与审批。参数按数组传递，禁止 CLI 登录、独立配置、身份和服务端点覆盖；网页桥不接受可执行文件路径、文件根或任意环境变量。

每次调用使用独立 Worker 和受限临时目录。Wasm 文件操作由原生工作区代理控制，拒绝路径穿越、符号链接和不安全硬链接；网络由父 Runtime 转发到固定官方域名。凭据不进入日志或环境变量。

单个参数最多 32000 个 UTF-16 单位，总请求最多 128 KiB。中文和表情按与 TypeScript 一致的长度规则处理，同时检查真实 UTF-8 总字节数。

取消、超时或传输中断时区分未执行与结果未知，不自动重放可能已发生的写入。CLI 内置后台更新检查关闭，执行内容随 Familiar APK 更新。旧原生 Go 路径不作为失败回退。

## 构建与验证

产品构建随 `scripts/build-android.ps1` 准备固定版本 Wasm、配套运行文件、原生工作区模块和许可证。组件准备见 `scripts/prepare-android-feishu-wasm.mjs`，构建见 `scripts/build-android-feishu-wasm.ps1`。

核心边界检查：

```powershell
node --experimental-transform-types --disable-warning=ExperimentalWarning --test tests/android-feishu-policy.test.ts tests/android-feishu-runner.test.ts tests/android-feishu-office.test.ts tests/android-feishu-auth.test.ts tests/android-feishu-wasm.test.ts
```

平台检查需专用测试设备，覆盖帮助、离线预览、受控 HTTP、Unicode、工作区边界、取消与资源回收。离线预览不是云端写入；真实账号登录、完整业务与真 ARM 手机仍需分别验证。

执行器路线与系统边界见 [兼容性说明](../../docs/21_Familiar_Android执行器兼容性调查.md)。

## 参考

- [官方平台扩展](https://github.com/larksuite/cli/blob/v1.0.96/extension/platform/README.md)
- [官方设备授权](https://github.com/larksuite/cli/blob/cb5a3d704379552dc61e37898e5f74798783190d/internal/auth/device_flow.go)
- [官方令牌刷新](https://github.com/larksuite/cli/blob/cb5a3d704379552dc61e37898e5f74798783190d/internal/auth/uat_client.go)
