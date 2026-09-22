# Familiar · 灵伴

![Familiar 灵伴：桌面小狐狸用头顶气泡陪你聊天](docs/images/cover.png)

一个住在桌面上的小伙伴。双击就能说话，回复在头顶冒泡；选一个喜欢的形象和性格，接上自己的模型，慢慢积累共同的记忆。

[下载使用](#下载使用) · [文字交互](#文字交互) · [从源码运行](#运行) · [构建与检查](#构建与检查) · [开发文档](docs/README.md)

> 图片来自 v0.2.0 的真实应用窗口，使用演示对话与记忆；组合图的背景为展示排版。

## 下载使用

从 [GitHub Releases](https://github.com/mengxingGG/My-Familiar/releases) 下载 Windows x64 发行版：

- 安装程序：运行 `Familiar-0.2.0-Setup-x64.exe`，完成后从开始菜单启动 Familiar。
- 免安装版：解压 `Familiar-0.2.0-win-x64.zip`，运行其中的 `Familiar.exe`，保留整个文件夹。

发行版已包含运行环境，不需要安装 Node.js 或 Windows SDK。首次使用从宠物的“设置”打开控制器，配置模型和 API Key。双击宠物即可输入文字。

当前为 v0.2.0 预览版，发行包未代码签名。新增飞书、GitHub、独立性格与会话压缩，改进重要日记；完整变更和升级步骤见 [本版说明](docs/releases/v0.2.0.md)。

## 运行

在 Windows 上安装 Node.js 24、npm 与 Windows 10/11 SDK（编译设备定位组件需要），然后在项目根目录执行：

```powershell
npm ci
npm run build
npm start
```

单独打开控制器：

```powershell
npm run controller
```

也可以通过宠物旁的“设置”或托盘菜单打开控制器。关闭控制器后，宠物继续运行；退出宠物使用托盘菜单中的“退出 Familiar”。

更新源码并重新构建后，请退出宠物和控制器，再重新启动两者，让后台与界面使用同一版本。已有配置、密钥、记忆和会话会继续保留。

## 模型连接

在控制器“模型连接”中选择 OpenAI 兼容、OpenAI 官方、DeepSeek、Gemini、Claude、OpenRouter 或本地 llama.cpp。填写服务地址并单独保存 API Key 后，自动获取模型列表；可以搜索选择，也可以直接填写模型 ID。

按需设置温度、Top P、输出上限、思考强度或预算，再保存并测试连接。每种服务分别保留已保存的设置，密钥按服务和地址隔离。本地 llama.cpp 需要先自行启动 `llama-server`。

上下文窗口留空默认上限 256K，并适配模型报告的较小窗口；未知窗口会提示保守暂用值，可手动填写。默认达到 80% 时生成交接摘要，阈值可以修改。历史会话保留完整正文并可查看摘要。详见 [模型设置](docs/07_Familiar_LLM接入与会话缓存.md) 和 [日记与会话压缩](docs/11_Familiar_重要日记与会话压缩.md)。

<details>
<summary>查看模型连接界面</summary>

![真实模型连接界面：获取与搜索模型列表，也可以手动填写模型名称](docs/images/models.png)

图中服务由本地演示程序提供，模型名称仅用于展示操作。

</details>

## 文字交互

![文字交互步骤：在宠物头顶输入，发送后在同一位置显示回复](docs/images/conversation.png)

| 操作 | 用法 |
| --- | --- |
| 唤出文字输入 | 双击宠物、点击“说句话”，或按 `Ctrl+Alt+Space`；输入在头顶替换回复气泡 |
| 换行 | `Enter` |
| 发送 | 点击发送按钮，或按 `Shift+Enter` |
| 收起输入 | `Esc`，保留未发送草稿并恢复最近回复 |
| 查看回复 | 宠物头顶气泡；长回复可滚动，生成时可停止；默认 15 秒收起，设置可修改 |
| 查看和继续旧对话 | 控制器“历史会话”；在这里聊天时宠物不冒泡 |
| 找回最近回复 | 托盘菜单 |

## 记忆与工具

控制器提供“记忆与日记”“Skills”“MCP 工具”页面。核心记忆最多 3000 字符，超限自动精炼；日记由模型挑选重要经历按年月日追加，不自动抄录聊天，教训单独保存。可以搜索、查看和编辑记忆文件。

<details>
<summary>查看记忆与日记界面</summary>

![记忆编辑区域：核心记忆、每日记忆与教训分别保存，可直接查看和编辑](docs/images/memory.png)

</details>

Skills 支持导入本地目录、HTTPS 的 SKILL.md 或粘贴完整文本，安装到宠物自己的目录。MCP 支持 HTTP、stdio 和固定版本 npm 包安装；Exa 和高德已预置，在配置中填入 API Key（如需）并启用。密钥单独加密保存。

也可以让宠物安装 Skill/MCP、读写文件或执行命令。读取、搜索和宠物目录内写入默认允许；Shell、安装和外部写入默认询问。可以选仅本次、本会话同工具或精确白名单，也可在“工具权限”设置默认规则或全自动。“记忆与日记”页面显示实际数据路径。详见 [记忆与扩展用法](docs/08_Familiar_记忆与Agent扩展.md)。

## 日常陪伴

![七种原创角色：小森、月团、绵绵、栗栗、方方、柚子与点点；性格可自由搭配](docs/images/characters.png)

角色和大小修改后实时生效并自动保存。“运行与插件”可开启登录后自动醒来。

本版新增绵绵、栗栗、方方、柚子、点点五种形象。在“名字与性格”选择温柔、细致、直白、热情、简洁，或跟随形象推荐；固定选择性格后，换形象不会覆盖它。

“主动关怀”只有一个总开关，内置问候由宠物自己安排；用户可以添加自定义提醒并勾选启用。位置与高德查询需单独授权；未授权时仅作普通问候，不按 IP 猜测位置。高德需要先在 MCP 页面保存 Web 服务 Key 并启用。详见 [陪伴、权限与会话用法](docs/09_Familiar_日常陪伴与权限会话.md)。

<details>
<summary>查看控制器：调整形象、大小和气泡停留时间</summary>

![Familiar 控制器：角色和大小即时生效，关闭控制器后宠物继续运行](docs/images/controller.png)

</details>

## 构建与检查

“飞书与 GitHub”页面支持飞书官方登录 / 机器人接入，以及 GitHub 浏览器登录或 Token。所需 CLI 由用户点击安装到宠物目录。飞书可启用办公工具和配对私聊；GitHub 新配置默认开放业务读写，也可选择只读，账户管理操作仍受限制。详细步骤见 [插件与性格用法](docs/10_Familiar_飞书GitHub与角色性格.md)。

```powershell
npm run build           # 编译应用到 dist/
npm run typecheck       # 类型检查
npm test                # 单元与集成测试
npm run check           # 类型检查、测试与构建
npm run smoke           # 真实窗口测试，使用隔离数据和本地模拟模型
npm run smoke:agent     # 记忆、Skill、MCP 和工具确认的真实窗口测试
npm run smoke:experience # 即时设置、历史、审批、气泡计时与主动关怀
npm run smoke:integrations # 角色性格、插件设置、凭据与重启恢复
npm run smoke:context   # 会话压缩、摘要和历史原文保留
npm run smoke:agent:packaged # 打包后记忆、Skill 与 MCP 验证
npm run smoke:experience:packaged # 打包后权限、历史与关怀验证
npm run smoke:integrations:packaged # 打包后角色、性格和插件设置验证
npm run smoke:context:packaged # 打包后会话压缩验证
```

如需生成本地便携运行目录：

```powershell
npm run package:dir
npm run smoke:packaged
```

入口为 `release/win-unpacked/Familiar.exe`，运行时需要保留整个目录。首次安装依赖或打包需要下载 Electron，需保持网络可用。

构建 Windows x64 安装程序与免安装 ZIP（仅构建，不自动上传）：

```powershell
npm run package:release
```

## 文档

- [文档目录](docs/README.md)
- [继续开发与项目结构](docs/06_Familiar_继续开发指南.md)
- [架构与气泡交互](docs/04_Familiar_插件实现与气泡交互_v0.1.md)
- [验证记录](docs/05_Familiar_本地预览验收记录_v0.1.md)
- [记忆、Skill 与 MCP 开发说明](docs/08_Familiar_记忆与Agent扩展.md)
- [飞书、GitHub 与角色性格](docs/10_Familiar_飞书GitHub与角色性格.md)
- [展示图片与重新拍摄](docs/12_Familiar_展示素材.md)
