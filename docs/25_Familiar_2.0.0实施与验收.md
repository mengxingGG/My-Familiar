# Familiar 2.0.0 实施与验收

日期：2026-11-02 实施，2026-11-17 发布 [v2.0.0](releases/v2.0.0.md)。本文记录实际实现；产品和美术设计基线分别见文档 23、24。

## 实施范围

共享核心新增 `familiar.pet-life` 插件，提供吃饭、睡眠、玩耍、长期缺粮表现、灵石、签到、背包、商店、等级奖励和房间布置。Windows 和 Android 使用同一业务规则，通过 `life.get` / `life.act` 接口操作，UI 不直接修改存档。

| 内容 | 实际交付 |
| --- | --- |
| 小窝 | 房间、状态、喂食、玩耍、休息、背包、商店、成长；Windows 默认进入小窝 |
| 编辑 | 鼠标/触摸拖动、方向按钮、键盘微调、取回、取消、保存、冲突提示；1000×700 逻辑坐标 |
| 角色 | 七个原角色加 DeepSeek 鲸鱼娘、GPT 银发小龙娘、Claude 橙发读书少女，全部直接可选 |
| 动画 | 每角色十五类动作；旧角色 798 帧 SVG、新角色 204 帧透明 WebP；按真实帧时长与循环标记播放 |
| 家具 | 暖木小屋、苔光森林、月湾海居、星灯书房各 6 件，按单品出售；另有初始食盆/软垫和 20 级纪念摆件 |
| 食物/玩具 | 4 种食物、3 种玩具；34 个物品主图、4 个床前景 PNG |
| 数据 | 一设备一养成档案，十形象共享；换形象不改钱包、等级、房间、模型或性格 |

## 当前默认规则

| 项目 | 规则 |
| --- | --- |
| 初始物资 | 80 灵石、8 份基础口粮、食盆与休息软垫，只初始化一次 |
| 饱食 | 每小时降低 3；低于或等于 40 时自动吃启用自动食用的食物；基础口粮恢复 40，售价 4 |
| 特殊食物 | 果盘 6、便当 8、甜点 12 灵石；默认手动使用，可在背包单独启用自动食用 |
| 精力 | 清醒每小时降低 4，低于或等于 30 自动睡眠；睡眠每小时恢复 12，到 90 醒来 |
| 心情 | 每小时降低 1；已放置玩具每 6 小时恢复 15；手动玩耍每 30 分钟可恢复 20 |
| 缺粮 | 饱食低于或等于 20 且没有可自动食用的存粮时累计；12/36/72 小时逐步表现；吃饭减少 12 小时，饱食至少 50 时每小时减少 6 小时 |
| 离线 | 按时间顺序最多结算 72 小时的需求与自动照料；不补发离线货币和经验 |
| 签到 | 档案固定时区，每自然日一次，10 灵石、10 经验 |
| 在线 | Runtime 存活，Windows 未锁定、Android 亮屏且未锁定，连续采样间隔不超过 90 秒；每 15 分钟 2 灵石，每日最多 48；每 30 分钟 5 经验，每日最多 30 |
| 聊天 | 成功完成的有效用户对话每次 2 灵石、2 经验，每日最多 10 次；至少间隔 60 秒，10 分钟内相同规范化文本不重复计奖；取消、失败和主动消息不计奖 |
| 日常经验 | 有效喂食、睡满 30 分钟、玩耍各每日一次 10 经验；每日总经验最多 90 |
| 等级 | 1–20 级，升下一级需要 `60 + 20 × (当前等级−1)` 经验；每级奖励 10 灵石和 1 份基础口粮 |
| 里程碑 | 3 级小球、5 级叶片椅、8 级浪纹地毯、12 级星灯、20 级成长纪念摆件 |

养成状态只决定外观和日常动作。聊天、语音、工具、权限与模型能力不读取饱食或等级门槛。开始聊天时的思考动作优先于生活动作，回复结束后回到当前生活状态。

## 数据与协议

- `plugins/pet-life/state.ts` 为纯业务规则，`catalog.ts` 为商品和渲染元数据，`index.ts` 管理 Runtime 生命周期和事务。
- 所有关联状态统一保存到本地存储的 `pet-life` 文件（平台数据目录 `data/pet-life.json`）；串行事务先克隆、校验、原子落盘，成功后发布快照。落盘失败不公布消费结果。
- 命令带稳定 `requestId`，同一请求重试不重复扣费或领奖；相同 ID 配不同内容被拒绝。聊天按用户轮次身份去重，存档只记录必要身份与文本摘要，不另存聊天原文。
- `room.save` 带 `expectedRoomRevision`；过期编辑返回 `CONFLICT`，保留本地草稿供用户选择。服务端核对实例所有权、数量、边界和地面碰撞，地毯允许叠放。
- 桥接层投影公开 DTO、验证命令及资源路径，不暴露内部收据、密钥或文件路径。错误码保留 `INVALID_INPUT`、`CONFLICT`。
- 每个新档案记录固定时区；时钟倒退不重复结算。损坏或不支持的存档保留原文件并明确报错，不静默重建余额。
- 1.1.0 原有配置、凭据、记忆和会话格式不改，新增独立养成文件。Android 现有加密迁移尚未包含养成档案，不应当作养成备份或跨端同步。

## 显示与生命周期

Windows Renderer 和 Android 原生宠物均支持 SVG / WebP、完整帧序列、每帧时长及非循环动作。Android 缓存限制为 4 个动作并随原生组件释放；房间页面隐藏、弹层打开、减少动画或卸载时停止相应前端绘制。

家具的地面占地与视觉画布分别计算，避免把正方形原图压扁；睡床使用床面交互点和前景层。编辑取回正在使用的家具后，宠物安全回落到房间。位置过渡使用表现层步行动画，不写入业务数据。

## 验证记录

全部验收使用隔离数据，不修改用户日常存档。Windows 测试为了覆盖等级锁和床具使用 1000 灵石、5 级的独立夹具，发行包初始值仍为 80 灵石、1 级。

| 检查 | 结果与证据 |
| --- | --- |
| TypeScript、单元/集成与 Windows 构建 | `npm run check` 通过，218/218；`.artifacts/v2/check.log`。集成后的类型检查亦通过 |
| 业务边界 | 覆盖事务重放、并发、写失败、重启、跨午夜、回拨、72 小时上限、在线锁屏、缺粮恢复、日常上限、等级奖励、房间冲突、损坏存档和桥字段过滤 |
| Windows 养成 | `scripts/smoke-life.mjs` 通过：真实 Runtime/IPC/UI 的签到、购买、等级锁、取消/保存、十形象切换、睡眠/进食和持久化 |
| Windows 发行目录 | `scripts/smoke-life.mjs --packaged` 通过；床具睡眠截图在 `.artifacts/v2/windows-life-packaged/room-sleep.png` |
| Windows 既有功能 | `scripts/smoke.mjs` 通过：模型配置隔离、HTTP SSE 夹具、气泡输入、取消、控制器退出与 Runtime 重启恢复 |
| 移动界面 | `scripts/smoke-mobile-ui.mjs` 20 项通过；360/390/430/768 宽度、触摸尺寸、养成操作、输入法、流式取消、会话草稿、审批和无宿主错误；`.artifacts/v2/mobile-smoke.log` |
| Android 编译与打包 | Kotlin、ARM64 Rust、debug 和 release APK 均通过；7 个原生库完整且 ELF / ZIP 16 KB 对齐；1002 帧全部进入原生与 Runtime 资源目录 |
| Google Android 15 模拟器 | 9 项既有核心回归通过：真实 ARM64 核心、Keystore、HTTP SSE 夹具、睡眠不影响聊天、取消、后台回复、控制页销毁、强退恢复、停止常驻；`.artifacts/v2/android-15-regression/device-smoke.json` |
| Android 养成与原生动画 | 4 组检查通过：签到幂等/购买/喂食，三个新角色 WebP 原生睡眠和悬浮窗口，钱包/背包/睡眠强退恢复，息屏 32 秒不累计在线分钟；`.artifacts/v2/android-15-life/result.json`。三个角色截图已人工检查 |
| Android 正式包启动 | 已在隔离 Google 模拟器安装签名包并进入真实小窝，初始 80 灵石、1 级；无演示数据提示；`.artifacts/v2/android-release/first-launch.png` |
| 用户打开的雷电 Android 14 模拟器 | 独立 debug 和优化 release 测试包安装成功，但均没有启动核心 socket；同一 debug APK 在 Google 模拟器通过。进一步在同一个隔离包中测试 1.1.0 核心、两行最小脚本、参数终止及关闭 JIT，均卡在 `node::Start` 内，未进入 JavaScript；原生入口日志已到达，无退出日志。只能定位到该实例的原生初始化阶段，根因未确认，不能计为通过。证据：`.artifacts/v2/android-14-preview/native-startup.log`、`startup-diagnosis.json` |

复现 Windows 养成测试：

```powershell
node --experimental-transform-types --disable-warning=ExperimentalWarning scripts/smoke-life.mjs
node --experimental-transform-types --disable-warning=ExperimentalWarning scripts/smoke-life.mjs --packaged
```

设备验收使用专用、无用户凭据的 debug 安装。设置 `ANDROID_SERIAL` 指定设备，`FAMILIAR_ANDROID_SMOKE_OUTPUT` 可指定报告目录；运行 `node scripts/smoke-android-device.mjs` 和 `node scripts/smoke-android-life.mjs`。后者要求当天尚未签到且可进食的新夹具；不应对用户数据自动清空重试。WebView 连接使用 `noDefaults`，保留设备环境并兼容不支持浏览器上下文管理的 WebView。

雷电中原有 1.1.0 应用可以打开，并观察到其核心 socket；本轮没有覆盖、清除或迁移该应用的数据。隔离包使用 `app.familiar.mobile.debug` / `app.familiar.mobile.preview`，诊断结束后均已卸载。临时原生日志、启动参数及脚本探针全部撤回，源码与生成的正式核心已核对 SHA-256 恢复一致；诊断 APK 和临时包名配置已移除。正式签名包始终保留 Google Android 15 上验收通过的内容。

## 本地交付与边界

Windows 安装包与免安装包：`release/Familiar-2.0.0-Setup-x64.exe`、`release/Familiar-2.0.0-win-x64.zip`。使用本机 Electron 运行时打包。

Android 正式包：`release/android/Familiar-2.0.0-arm64.apk`，108,380,226 字节，包名 `app.familiar.mobile`，versionCode `2000000`，minSdk 28 / targetSdk 36，关闭调试。v2 / v3 签名通过，证书 SHA-256 与已有 1.1.0 APK 一致：`384610206b0ccad204d0572604d213d3a82cd0a0d356f3faaa398afc213989e0`。三个安装产物的摘要见 `release/SHA256SUMS-2.0.0.txt`。

本机 Java 访问依赖仓库发生 TLS 断连，本轮使用临时 localhost 缓存、校验过的 Gradle 既有缓存和官方仓库下载完成构建；大型 Kotlin 编译器额外核对官方 SHA-1。没有关闭证书校验或改动项目仓库配置，辅助进程在验收后停止。

尚未覆盖：物理 ARM 手机、厂商后台回收策略、长时间功耗、真实麦克风/云模型账号；模拟器与 HTTP 模型夹具结果不能代替这些检查。雷电 Android 14 实例启动问题仍待定位，不能据此概括全部 Android 14 设备。无跨设备实时同步。家具目前单朝向，不含旋转素材、桌面挂载、柜门/灯光动画或障碍物寻路。

