# Familiar 继续开发指南

## 当前边界

Windows 本地开发预览；独立宠物 Runtime、独立 Controller、2D 占位角色、文字 LLM 接入。用户已确定宠物用气泡说话，不设聊天页面。文字输入按需出现，Enter 换行，Shift+Enter 或按钮发送。语音未来是并列输入方式，不替代文字。

当前优先把陪伴体验、真实模型接入和桌面稳定性做好。暂不扩展语音、视觉、工具执行和 Agent。未来 3D 通过渲染器和角色表示扩展，不把骨骼、镜头或具体模型格式塞入内核。当前只上传源码，安装包构建与发布暂缓。

## 代码入口与职责

| 路径 | 职责 |
| --- | --- |
| `apps/shared/bootstrap.ts` | Electron 引导、Runtime/Controller 插件装配、启动退出 |
| `packages/kernel` | 作用域 Context、插件生命周期、能力依赖、清理和权限门 |
| `packages/contracts` | 产品能力公共契约，内核不得反向引用 |
| `packages/protocol` | 本地 IPC 客户端与版本协议 |
| `plugins/platform-windows` | 原生窗口、透明命中、拖动、气泡定位、托盘、快捷键 |
| `plugins/renderer-sprite`、`characters` | 语义动作对应的 2D 表现、角色清单和资源 |
| `plugins/bubble-chat` | 气泡、临时输入条和输入交互，不持有供应商逻辑 |
| `plugins/conversation` | 上下文、取消、持久化和单轮互斥 |
| `plugins/provider-compatible` | 兼容流式接口、鉴权、超时和错误 |
| `plugins/control-center` | 设置界面与运行状态，不拥有宠物或模型请求生命周期 |
| `plugins/settings` 与配置域插件 | 三个首版配置域的校验、版本冲突和事务保存 |
| `tests`、`scripts/smoke.mjs` | 逻辑验证、真实窗口与本地 SSE 夹具 |

参考 DSH 的作用域、服务声明和插件装配思想，Familiar 没有 DSH 运行时依赖。核心外的能力通过插件实现；不得为单个 Provider、角色或 UI 需求向内核添加业务分支。具体能力声明、生命周期与清理约定见文档 04。

## 修改与验证规则

1. 先读受影响插件的清单和公共契约，确定能力提供者与消费者。
2. 副作用归插件作用域，注册清理；窗口等原生操作留在平台插件。
3. 调整交互时同步界面提示、README 用法和文档 04；补充能覆盖实际行为的现有烟雾测试。
4. 运行 `npm run check`。窗口、输入和生命周期改动还需运行 `npm run smoke`，不能只看编译结果。
5. 把结果及未验证项记入文档 05。烟雾测试使用本地模型夹具，不等价于真实供应商和实际中文输入法测试。

构建输出、测试数据、运行数据与本机快捷方式均由 `.gitignore` 排除。`package-lock.json` 随源码管理。安装包、正式发布和 Release 上传留待后续。

## 数据和调试

默认数据目录 `%APPDATA%/Familiar`，用 `FAMILIAR_DATA_DIR` 可以隔离开发或测试数据。Runtime 和 Controller 使用不同 Electron userData。Runtime 是配置与会话唯一写入者。

- `data/settings.json`：首版配置事务快照；各配置域的 Schema 归其插件。
- `data/conversation.json`：近期会话，用于下一轮上下文；不是长期记忆系统。
- `data/model-secret.json`：系统加密后的 API Key，不应进入普通配置或日志。
- `.artifacts/*/result.json` 与截图：本地测试结果，不提交仓库。

当前只装配可信官方插件。Context 的权限声明检查不构成任意第三方 JavaScript 的安全沙箱。现有角色是原创占位美术，不代表正式角色方向。

## 下一步顺序

1. 用真实兼容模型验证流式回复、取消、错误反馈和多轮体验。
2. 手工验证中文输入法、多显示器、混合 DPI、透明区命中与全屏使用。
3. 做至少 2 小时的待机和重复交互资源趋势测试，再确定资源预算。
4. 确认角色美术方向，替换占位资源；保持角色包与 Renderer 分离。
5. 功能稳定后再做安装、升级、卸载及登录自启动验证。

完成这些后再讨论语音与 Agent 插件，不把长期设计中尚未交付的功能写成已实现能力。
