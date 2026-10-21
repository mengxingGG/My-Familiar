# Android 架构与系统能力

Android 版沿用 Familiar 的插件架构与共享核心，以常驻悬浮宠物、原生气泡和移动控制器为入口。当前发行范围见 [1.1.0](releases/v1.1.0.md)，早期多平台迁移目标见 [Tauri 方案](15_Familiar_Tauri多平台改造方案.md)。

## 分层

| 层 | 职责 |
| --- | --- |
| `apps/tauri/ui` | 移动界面、草稿与表单交互，只通过产品桥发出请求 |
| `packages/mobile-contracts` / `mobile-bridge` | 快照、版本化命令、请求关联与错误处理 |
| 共享 Familiar 插件 | 模型、会话、记忆、Skills、Agent、工具审批和更新逻辑 |
| `plugins/platform-android` | 原生窗口、独立 Runtime、系统权限、设备工具、媒体与安全存储 |
| Android 系统 | 无障碍绑定、前台服务、输入法、系统选择器和安装确认 |

UI 不持有业务权威状态。控制器退出不结束宠物与无障碍的生命周期；系统停止应用、权限撤回和服务重连需要单独处理。

## 系统工具选择

优先使用公开结构化 API，其次使用应用提供的 Intent；没有可用接口的场景才通过无障碍观察和操作。工具结果应区分已完成、已交接、被拒绝、不可用和结果未知。

| 场景 | 接入方式 | 边界 |
| --- | --- | --- |
| 日历 | `CalendarContract` / `ContentResolver` | 系统权限与应用内授权分别检查，写入后返回 ID 并回读 |
| 闹钟与计时器 | `AlarmClock` 标准 Intent | 依赖接收应用；交接后观察结果，不支持的操作明确报告 |
| 笔记 | Familiar 本地笔记、兼容应用入口 | 不假定存在跨厂商统一笔记数据库 |
| 文件与附件 | 系统文件选择器及受限 URI | 选择不等于发送；按会话绑定附件 |
| 应用操作 | 应用入口查询与无障碍服务 | 检查目标有效期、窗口、节点和系统保护 |
| 语音与位置 | 麦克风、音频和位置平台接口 | 按需授权，活动状态与停止入口明确可见 |

## 权限与数据

全自动、有限执行、审批制度和全部拒绝由共享 `agent.policy` 管理。应用内审批不替代 Android 系统授权，也不绕过受保护页面、锁屏或密码字段。

模型与第三方凭据通过 Android Keystore 加密；UI 只读取是否已配置。跨签名数据迁移使用显式的加密导出和预览导入，不复制 Keystore 原文件。

## 开发入口

- [移动界面规范](android-ui/BRIEF.md)
- [前端集成](android-ui/INTEGRATION.md)
- [Android 构建](android-ui/BUILD_ANDROID.md)
- [常驻运行实现](19_Familiar_Android常驻运行实施.md)
- [兼容性与测试](20_Familiar_Android验收核对.md)
- [权限、日历、时钟与迁移](22_Familiar_权限与Android日历闹钟迁移.md)
