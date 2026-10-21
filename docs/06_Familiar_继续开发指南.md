# Familiar 开发指南

当前发行版为 [1.1.0](releases/v1.1.0.md)，支持 Windows x64 与 Android ARM64。Windows 使用 Electron；Android 使用 Tauri 2、原生平台适配和独立 `:runtime`。长期迁移目标与当前可用能力分别记录。

## 阅读顺序

1. [开发宪法](02_Familiar_开发宪法_v0.1.md)：内核、插件、权限和生命周期约束。
2. [总体设计](01_Familiar_项目理念与总体设计_v0.1.md) 与 [多平台方案](15_Familiar_Tauri多平台改造方案.md)：产品方向及平台分层。
3. 受影响模块的契约与实现；Android 参见 [架构](18_Familiar_Android开工与系统能力方案.md)、[常驻运行](19_Familiar_Android常驻运行实施.md) 和 [前端集成](android-ui/INTEGRATION.md)。
4. [回归测试](05_Familiar_本地预览验收记录_v0.1.md) 与 [Android 测试矩阵](20_Familiar_Android验收核对.md)。

## 代码入口

| 路径 | 职责 |
| --- | --- |
| `apps/shared/bootstrap.ts` | Windows Runtime / Controller 插件装配与生命周期 |
| `apps/tauri` | Android 控制器、产品桥与独立预览 |
| `packages/kernel` | 作用域 Context、插件生命周期、能力依赖与权限门 |
| `packages/contracts` / `mobile-contracts` | 产品能力与移动命令、快照契约 |
| `packages/protocol` | 桌面本地 IPC；不能直接当作跨端传输 |
| `plugins/platform-windows` / `platform-android` | 平台窗口、输入、系统 API 与资源所有权 |
| `plugins/renderer-sprite` / `characters` | 角色资源与语义动作表现 |
| `plugins/bubble-chat` / `control-center` | 桌面交互与控制器，不拥有模型请求生命周期 |
| `plugins/conversation` / `context-*` | 会话、取消、上下文预算与原文归档 |
| `plugins/provider-*` / `llm-*` | 模型协议、注册、路由与能力目录 |
| `plugins/home-files` / `memory-*` | 数据之家、记忆文件、索引、判断与诊断 |
| `plugins/skills-local` / `mcp-client` | Skills 与 MCP 生命周期 |
| `plugins/agent-*` / `tools-basic` | 工具注册、授权、执行与模型往返 |
| `plugins/app-updates` | 正式版查询、平台安装包选择、校验与下载 |
| `tests` / `scripts` | 核心检查、平台夹具、构建和界面回归 |

Kernel 不包含具体 Provider、角色、UI 或 Android 分支。共享业务只维护一份；原生资源通过平台适配并注册清理，UI 不成为配置与会话的第二写入者。

## 修改与测试

先确认能力的提供者、消费者和公共契约，再修改插件。新增共享逻辑应检查间接宿主依赖；平台 I/O、密钥与原生调用留在适配边界。

业务代码变更运行 `npm run check`，并选择受影响的界面、设备或真实服务测试。输入、窗口和生命周期变更需验证实际运行行为；测试夹具不等于真实设备或云服务验收。纯文档变更检查内容、链接和 Markdown 结构即可。

窗口回归使用隔离数据，真实服务测试使用显式配置的测试凭据。原始日志、截图和报告只保存在本地忽略目录，公开文档描述可复现的方法及已知限制。测试结束后释放资源并清理临时数据。

语音改动参见 [语音方案](16_Familiar_Live语音改造调研与实施方案.md)；记忆改动参见 [记忆方案](17_Familiar_记忆系统改造方案.md)。不同模块通过公共契约协作，不复制会话、记忆或审批权威。

## 数据与调试

Windows 默认数据目录为 `%APPDATA%/Familiar`，`FAMILIAR_DATA_DIR` 可指定隔离目录。Runtime 与 Controller 使用不同 Electron userData，Runtime 是配置与会话的唯一写入者。

- `data/settings.json`：配置事务快照，各域 Schema 归所属插件。
- `data/conversation.json` 及独立会话文件：完整历史，可能包含供应商私有块，应按个人数据处理。
- `data/model-secret.json`：按供应商和地址隔离的系统加密凭据，不进入日志或普通配置。
- `data/model-catalog.json`：带时效的模型与能力目录。
- `runtime/Local State`：Windows 加密材料；只复制凭据密文不足以完成迁移，应在原系统用户下备份和恢复完整数据目录。
- `.familiar/`：源码版数据之家；安装版默认位于 `%APPDATA%/Familiar/home`，免安装版优先使用程序旁目录。可通过 `FAMILIAR_HOME` 显式覆盖。

Android 使用应用私有目录和 Keystore，跨签名迁移按 [迁移说明](releases/v0.3.1-migration.md) 执行，不复制平台加密原文件。

## 构建与发布

Windows 构建要求 Node.js 24、npm 和 Windows 10/11 SDK；Android 工具链见 [构建文档](android-ui/BUILD_ANDROID.md)。构建缓存、运行数据、私钥和本机配置由 `.gitignore` 排除，锁文件随源码管理。

`npm run package:release` 生成本地 Windows 安装包和 ZIP。发布前检查实际安装资产、升级兼容性、许可证和校验和；发行说明面向使用者，仅包含变化、安装步骤与已知限制。研发交接、个人授权、密钥来源和本机验收轨迹不进入公开说明。
