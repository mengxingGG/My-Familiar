# Familiar · 灵伴

## 运行

在 Windows 上安装 Node.js 24 与 npm，然后在项目根目录执行：

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

## 模型连接

在控制器“模型连接”中填写兼容 Chat Completions 的 Base URL、模型 ID 和可选 API Key，保存后测试连接。使用本地模型时，需要先自行启动模型服务。

## 文字交互

| 操作 | 用法 |
| --- | --- |
| 唤出文字输入 | 双击宠物、点击“说句话”，或按 `Ctrl+Alt+Space` |
| 换行 | `Enter` |
| 发送 | 点击发送按钮，或按 `Shift+Enter` |
| 收起输入 | `Esc`，保留未发送草稿 |
| 查看回复 | 宠物头顶气泡；长回复可滚动，生成时可停止 |
| 找回最近回复 | 托盘菜单 |

## 构建与检查

```powershell
npm run build           # 编译应用到 dist/
npm run typecheck       # 类型检查
npm test                # 单元与集成测试
npm run check           # 类型检查、测试与构建
npm run smoke           # 真实窗口测试，使用隔离数据和本地模拟模型
```

如需生成本地便携运行目录：

```powershell
npm run package:dir
npm run smoke:packaged
```

入口为 `release/win-unpacked/Familiar.exe`，运行时需要保留整个目录。首次安装依赖或打包需要下载 Electron，需保持网络可用。

## 文档

- [文档目录](docs/README.md)
- [继续开发与项目结构](docs/06_Familiar_继续开发指南.md)
- [架构与气泡交互](docs/04_Familiar_插件实现与气泡交互_v0.1.md)
- [验证记录](docs/05_Familiar_本地预览验收记录_v0.1.md)
