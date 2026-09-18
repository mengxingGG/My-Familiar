# 日常陪伴、权限与会话管理

## 当前用法

“我的灵伴”的角色、大小、置顶、安静陪伴和气泡关闭时间修改后自动保存、实时生效。气泡默认在回复完成后 15 秒收起；鼠标停留时暂停，移开后重新计时。生成和等待确认期间不自动关闭。设置为 0 可保持显示。

“历史会话”可以查看、搜索完整正文、新建、重命名、删除和继续旧对话。Enter 换行，Shift+Enter 或按钮发送。当前正在操作控制器中的历史会话时，宠物不冒泡。关闭或离开控制器后不影响 Runtime。开始新会话会保留旧会话；明确删除只删除该会话，不删除已经形成的日记和记忆。

“工具权限”设置每类操作的允许、询问或禁止，也可开启全自动。默认读取、搜索、宠物之家内写入直接执行；目录外写入、Shell、扩展安装和其他 MCP 操作询问。工作目录不是围栏：文件工具支持绝对路径，Shell 默认从宠物自己的 workspace 开始。

气泡和控制器中的审批都可以选：

- 仅本次：只允许当前调用。
- 本会话同工具：允许同一工具的同一操作类别，切换、新建会话或 Runtime 重启后失效。
- 此操作加入白名单：写文件匹配规范化目标路径，Shell 匹配工作目录和完整命令，其他工具匹配具体参数；不是模糊命令前缀匹配。

白名单和会话授权都可撤销。“禁止”优先于白名单；全自动模式表示用户明确选择所有工具直接执行。Windows 位置授权独立于工具策略。

## 主动问候

用户界面只有一个“开启主动关怀”总开关。内置开机问候、工作询问、早中晚智能关心由插件安排，不在页面里逐条展示，也不要求用户设置一串时间和开关。措辞结合人格、核心记忆和最近几句对话生成，不声称看到了用户屏幕或实际工作情况。

用户可以自行添加名称、每天时间和提醒内容，再勾选启用；自定义列表只显示用户添加的项目。支持逐条启停和移除，最多 30 条。新增提醒默认未勾选，用户可以在添加时选择启用。总开关关闭后，内置和自定义都停止。

内部调度使用本机时间：启动后约 15 秒问候，20 分钟后询问近况；上午 08:30—11:00、午间 11:40—14:00、晚上 18:20—21:00 挑选可用时机。内置 22:00—08:00 安静，每类每天最多一次，最多五次；普通间隔至少一小时，启动后工作询问可间隔十五分钟。每次都调用模型，不是操作系统强提醒或精确闹钟。关闭程序、正在聊天、隐藏宠物、安静陪伴或近期刚交谈时会延后或跳过。

自定义提醒在指定时间后的 30 分钟窗口尝试一次，两条之间至少一分钟；用户指定的夜间时间不受内置安静时段限制，但仍尊重总开关、安静陪伴和忙碌状态。请求前持久化时间槽，模型失败也不循环重试消耗费用。生成期间用户开始聊天、切换会话或修改关怀设置，会中止本次问候。实际说出的话写入当前会话和当日日记，后续回复有上下文可接。

## 定位和高德

设备定位默认关闭。打开位置授权并点击“获取设备位置”后，独立 STA 窗口调用 Windows Geolocator 的系统授权。若系统拒绝，可通过页面入口打开 Windows 位置隐私设置。仅接受 Satellite、WiFi、Cellular 来源、十分钟以内且误差不超过两公里的位置。IPAddress、Unknown、系统默认位置和模糊位置都不用于周边建议；不查询 IP 定位。

坐标只保留在 Runtime 内存，撤销授权清除。另行启用“用高德查询附近餐馆”后，坐标会发送给高德进行 GPS 到高德坐标的官方转换，再通过 MCP 查询附近餐馆、详情和步行路线。精确坐标不加入 LLM 提示词。没有授权或定位失败时，继续普通问候。

在 MCP 工具中选择预置“高德地图”，保存 **Web 服务 Key** 并启用。配置保存不含密钥的 `https://mcp.amap.com/mcp`；选择 query 鉴权，字段为 `key`，真正连接时才注入解密后的值。Key 不出现在 servers.json、模型工具结果或界面回读中。最多选两家，路线分钟数来自实际 duration，人均来自实际 cost；缺失时显示暂缺，不用距离估算时间，不编造价格。不调用下单、打车或导航唤端工具。

官方依据：[高德 MCP 快速接入](https://developer.amap.com/api/mcp-server/gettingstarted)、[创建 Web 服务 Key](https://lbs.amap.com/api/mcp-server/create-project-and-key)、[坐标转换](https://developer.amap.com/api/webservice/guide/api/convert)、[Windows 定位](https://learn.microsoft.com/en-us/windows/apps/develop/maps-and-location/get-location)、[位置来源枚举](https://learn.microsoft.com/en-us/uwp/api/windows.devices.geolocation.positionsource)。

## 插件与数据契约

Kernel 未新增业务。新增 `companion-care`（调度与问候）、`amap-care`（固定只读周边查询）、`location-windows`（Windows 定位）、`experience-controls`（管理命令）。原会话插件提供 `conversation.history`，气泡插件提供 `companion.presentation`，工具注册器提供 `agent.policy`。所有消费关系通过 manifest 声明。

新持久化文件在 `%APPDATA%/Familiar/data`：

| 文件 | 内容 |
| --- | --- |
| `conversation.json` | 当前会话，保留旧版格式兼容副本 |
| `conversation-index.json` | 全部会话的名称、时间、消息数 |
| `conversation-session-<id>.json` | 各会话的完整正文、原生工具轨迹和上下文起点 |
| `tool-policy.json` | 分类默认策略、精确白名单；不保存临时会话授权 |
| `care-settings.json` | 总开关、自定义提醒、位置与高德授权 |
| `care-schedule.json` | 当天已尝试的时间槽，用于去重 |

旧 `conversation.json` 启动时迁移到独立会话文件与索引，原副本仍更新。上下文裁剪仅移动 `session.start`，不会裁掉历史文件。控制器只接收可见消息，不接收 native/trace 推理资料。历史按页读取，避免超过本地 IPC 包限制。

控制器活跃状态通过六秒租约同步，页面聚焦时续约，离开页面/失焦释放；崩溃最多等租约过期，不能永久把宠物设成静音。气泡时限属于 pet 配置，采用独立字段补丁，避免即时外观设置覆盖未保存的模型或人格输入。

`runtime.status.apiVersion` 标识控制器所需的接口版本，当前为 3。控制器发现版本不一致会明确提示重启两端，关怀页面也校验响应结构，避免初始化失败后继续读取空的 settings。修改接口时同步更新双方版本要求。构建不会替换已经载入内存的 Runtime；开发中重建后须正常退出后台和控制器再启动，不能只重开设置窗口。

MCP 的官方 Exa 搜索、高德固定只读工具，以及启用服务声明为 readOnlyHint 的工具归入只读类；其余归为需要确认的 MCP 类。这是对已启用服务的信任策略，不是恶意 MCP 的系统沙箱。服务地址变更会改变工具身份，旧白名单不沿用。

## Windows 登录启动与构建

Electron 44 写入会自行转义 args，源码目录作为原始参数传入。读取时须给可执行路径加命令行引号，并从 launchItems 匹配 `Familiar`、用户范围、参数和启用状态；`openAtLogin` 读取的是 AppUserModelID，不能直接判断自定义 name。参考 [Electron API](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows) 和 [44.0.0 Windows 实现](https://github.com/electron/electron/blob/v44.0.0/shell/browser/browser_win.cc)。

Windows 源码构建新增 Windows 10/11 SDK 要求，用系统 .NET Framework C# 编译器生成 `dist/native/Familiar.Location.exe`；运行用户不需要 SDK。未来打包时该 exe 必须放在 app.asar.unpacked，已配置 asarUnpack，本轮未重新打包。

验证入口：`npm run check`、`npm run smoke`、`npm run smoke:agent`、`npm run smoke:experience`。真实 API 仅在用户授权后运行 `node scripts/verify-live.mjs --saved-api`，使用隔离副本与普通进程启动，避免 Playwright mock-keychain 干扰。真实高德费用、餐馆数据、Windows 位置授权与重新登录体验需分别验收，不能从夹具推断。
