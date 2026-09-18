# Familiar · 灵伴

## 下载使用

从 [GitHub Releases](https://github.com/mengxingGG/My-Familiar/releases) 下载 Windows x64 发行版：

- 安装程序：运行 `Familiar-0.1.0-Setup-x64.exe`，完成后从开始菜单启动 Familiar。
- 免安装版：解压 `Familiar-0.1.0-win-x64.zip`，运行其中的 `Familiar.exe`，保留整个文件夹。

发行版已包含运行环境，不需要安装 Node.js 或 Windows SDK。首次使用从宠物的“设置”打开控制器，配置模型和 API Key。双击宠物即可输入文字。

当前为 v0.1.0 预览版，发行包未代码签名。安装版与免安装版的数据位置、迁移和验证范围见 [首版说明](docs/releases/v0.1.0.md)。

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

上下文窗口留空时使用模型目录提供的上限；目录未提供时界面会提示暂用值，可按模型说明手动填写。会话会保留到接近预算上限，控制器显示服务返回的缓存命中 token。详细设置见 [模型与会话说明](docs/07_Familiar_LLM接入与会话缓存.md)。

## 文字交互

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

控制器新增“记忆与日记”“Skills”“MCP 工具”三个页面。核心记忆最多 3000 字符，超限自动精炼；日记按年月日追加，教训单独保存。可以搜索、查看和编辑记忆文件。

Skills 支持导入本地目录、HTTPS 的 SKILL.md 或粘贴完整文本，安装到宠物自己的目录。MCP 支持 HTTP、stdio 和固定版本 npm 包安装；Exa 和高德已预置，在配置中填入 API Key（如需）并启用。密钥单独加密保存。

也可以让宠物安装 Skill/MCP、读写文件或执行命令。读取、搜索和宠物目录内写入默认允许；Shell、安装和外部写入默认询问。可以选仅本次、本会话同工具或精确白名单，也可在“工具权限”设置默认规则或全自动。“记忆与日记”页面显示实际数据路径。详见 [记忆与扩展用法](docs/08_Familiar_记忆与Agent扩展.md)。

## 日常陪伴

角色和大小修改后实时生效并自动保存。“运行与插件”可开启登录后自动醒来。

“主动关怀”只有一个总开关，内置问候由宠物自己安排；用户可以添加自定义提醒并勾选启用。位置与高德查询需单独授权；未授权时仅作普通问候，不按 IP 猜测位置。高德需要先在 MCP 页面保存 Web 服务 Key 并启用。详见 [陪伴、权限与会话用法](docs/09_Familiar_日常陪伴与权限会话.md)。

## 构建与检查

```powershell
npm run build           # 编译应用到 dist/
npm run typecheck       # 类型检查
npm test                # 单元与集成测试
npm run check           # 类型检查、测试与构建
npm run smoke           # 真实窗口测试，使用隔离数据和本地模拟模型
npm run smoke:agent     # 记忆、Skill、MCP 和工具确认的真实窗口测试
npm run smoke:experience # 即时设置、历史、审批、气泡计时与主动关怀
npm run smoke:agent:packaged # 打包后记忆、Skill 与 MCP 验证
npm run smoke:experience:packaged # 打包后权限、历史与关怀验证
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
