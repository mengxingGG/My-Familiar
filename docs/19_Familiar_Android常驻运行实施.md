# Android 常驻运行实现

适用版本：1.1.0。构建步骤见 [Android 构建与签名](android-ui/BUILD_ANDROID.md)，测试范围见 [兼容性与测试](20_Familiar_Android验收核对.md)。

## 进程与生命周期

控制器运行在主进程，`RuntimeService`、`PetService` 与 `FamiliarAccessibility` 运行在独立 `:runtime` 进程。嵌入式 ARM64 Node Runtime 装配现有 Kernel 与业务插件，会话、模型、记忆和审批各自只有一个所有者。

`RuntimeClient` 使用应用上下文连接运行服务；绑定失效后释放旧连接并重连。控制器重新打开时获取新快照，不依赖 WebView 定时器维持宠物或工具。系统强行停止应用后需手动重新打开，不使用循环重启对抗系统停止。

常驻通过 `specialUse` 前台服务提供可见通知与停止入口。悬浮窗、通知和厂商后台管理分别检查；熄屏时暂停宠物动画，不将服务存在等同于窗口可见。

## 产品桥

Tauri 命令进入 Kotlin 控制器，再通过未导出的绑定服务与同 UID 私有 socket 访问共享核心。UI 只消费版本化快照和命令，不直接写业务文件、请求模型或管理凭据。

请求超时不触发自动重放。消息、附件和迟到结果按会话归属处理；已取消或旧代次的回调不得改变当前界面。接口详见 [移动契约](../packages/mobile-contracts/index.ts) 与 [集成规范](android-ui/INTEGRATION.md)。

## 原生气泡与停靠

`PetBubbleChat` 使用设备输入法。回车和输入法发送动作提交消息，Shift＋回车保留换行；组合输入、重复按键、忙碌状态和会话冲突分别保护。

优先保持宠物、回复气泡、输入气泡从上到下排列。长回复内部滚动，气泡宽度稳定；空间不足时临时调整显示位置，关闭聊天后恢复已保存的宠物位置。

`PetDock` 管理四边吸附和闲置收起。向外手势在移动阶段识别，避免窗口越界后才处理取消事件；靠边手动收起不依赖自动吸附开关。收起时窗口与命中区域缩小到半头像，点按或向内拖动展开，未发送草稿保留。

## 无障碍

`FamiliarAccessibility` 从实际前台 `TYPE_APPLICATION` 窗口读取目标，忽略宠物、输入法和自有控制器窗口。工具动作检查观察有效期、节点指纹、窗口与遮挡；锁屏、密码字段和受保护页面保留平台限制。

服务绑定时启动所需核心，断开时清除连接状态。窗口事件与节点读取避免锁争用；系统缓存和节点刷新按平台能力处理。手势回调只报告触摸状态，业务结果需再次观察。

## 系统能力与存储

- 日历采用公开 `CalendarContract`；时钟采用标准 Intent，已有时钟项目的完整操作通过无障碍逐步观察。
- 附件使用系统选择器、受限 URI 和私有媒体库；图片、PDF、Word 按需导入和提取。
- 语音由音频所有者管理麦克风、采集、网络和播放；听写回到原会话，持续语音提供全局停止入口。
- `SecretVault` 使用 Android Keystore AES-GCM 与原子私有文件；密钥不回填 UI。
- 数据迁移通过设置页显式导出、预览和导入，文件与恢复点保持加密。
- 飞书办公采用受限 Go/Wasm 执行路径，见 [执行器兼容性](21_Familiar_Android执行器兼容性调查.md)。

## 版本更新

共享 `app.updates` 读取 GitHub 最新正式版，按平台选择安装文件。下载支持取消、重试和恢复，并核对大小及 SHA-256。更新命令由界面显式调用，不注册为模型工具。

Android 使用私有更新目录与 `FileProvider` 交给系统安装器。打开前核对包名、版本和签名；缺少安装来源许可时进入系统设置。宠物与控制器分别显示提醒，下载和检查不阻塞聊天命令。

## 平台依据

- [Android 前台服务](https://developer.android.com/develop/background-work/services/fgs)
- [AccessibilityService](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService)
- [InputConnection](https://developer.android.com/reference/android/view/inputmethod/InputConnection)
- [CalendarContract](https://developer.android.com/reference/android/provider/CalendarContract)
- [AlarmClock](https://developer.android.com/reference/android/provider/AlarmClock)
- [PackageManager](https://developer.android.com/reference/android/content/pm/PackageManager)
