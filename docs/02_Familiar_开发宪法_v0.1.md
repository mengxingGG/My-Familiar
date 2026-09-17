# Familiar · 灵伴
## 开发宪法 v0.1

> 本文定义 Familiar 项目长期有效的工程原则。  
> 它不是具体技术方案，而是所有实现方案都必须服从的上层约束。

---

# 序言

Familiar 的目标不是快速堆积功能。

它要成为一个能够长期演化、跨平台运行、允许社区参与、可以自由替换模型与能力的 Companion Agent 平台。

因此项目最危险的问题并不是：

> “现在少一个功能。”

而是：

> “为了快速实现一个功能，把系统永久绑死在某种实现上。”

本宪法存在的目的，就是阻止这种情况。

具体技术可以改变：

- 编程语言可以改变；
- UI 框架可以改变；
- Renderer 可以改变；
- 模型可以改变；
- 数据库可以改变；
- Agent 可以改变。

但 Familiar 的核心工程原则不应随一次局部开发而轻易改变。

---

# 第一章：宪法优先级

## 第 1 条：架构原则高于功能便利

当某项功能的最快实现方式会破坏项目长期架构时：

> 优先维护架构。

不能因为：

```text
“这样写最快”
```

就绕过：

```text
Plugin
Capability
Permission
Lifecycle
Platform Abstraction
```

---

## 第 2 条：Core 的克制高于 Core 的便利

一个功能是否方便直接写进 Core，不是判断它是否应该进入 Core 的理由。

进入 Core 必须证明：

> 如果缺少它，插件系统本身无法正确运行。

否则默认：

> 放在插件中。

---

## 第 3 条：宪法修改必须显式进行

如果开发过程中发现某项需求确实必须违反本文原则：

不能默默违反。

必须：

1. 明确记录冲突；
2. 说明为什么现有原则无法满足；
3. 提出替代设计；
4. 记录影响范围；
5. 再决定是否修改本宪法。

建议未来使用：

```text
ADR — Architecture Decision Record
```

记录重大架构决定。

---

# 第二章：Plugin First

## 第 4 条：任何新功能首先尝试插件化

新增功能时，第一个问题必须是：

> **它能否作为插件实现？**

而不是：

> 应该往 Core 哪个文件加代码？

---

## 第 5 条：插件是主要架构单位，而不是附加功能

Familiar 的插件不是传统意义上的“扩展”。

核心能力同样可以由插件提供。

包括但不限于：

```text
Renderer
Character
LLM
Vision
ASR
TTS
Wake Word
Memory
Agent
Tools
Skills
Platform Capability
Storage
Integration
```

---

## 第 6 条：Agent Loop 也必须允许替换

Familiar 不应假设永远只有一种 Agent 实现。

未来允许：

```text
agent-basic
agent-tool-use
agent-reactive
agent-planner
agent-community
```

只要满足约定 Capability。

---

# 第三章：Thin Kernel

## 第 7 条：Kernel 只能拥有运行插件所需的基础设施

Kernel 原则上只包含：

```text
Plugin Manager
Service Context
Capability Registry
Event Bus
Lifecycle
Configuration
Permission
Logging
Diagnostics
```

---

## 第 8 条：业务能力不得因为“官方实现”而进入 Kernel

即使某插件由 Familiar 官方维护，也仍然是插件。

“官方”不等于“核心”。

---

## 第 9 条：Kernel 不得依赖具体 AI Provider

禁止 Kernel 直接依赖：

```text
OpenAI
Anthropic
Gemini
OpenRouter
Ollama
LM Studio
```

---

## 第 10 条：Kernel 不得依赖具体角色或 Renderer

禁止 Kernel 假设：

```text
一定是 Live2D
一定是 Sprite
一定是 3D
一定存在 wave 动作
一定存在 humanoid 骨骼
```

---

# 第四章：Capability over Implementation

## 第 11 条：依赖能力，而不是依赖实现

错误：

```text
chat → OpenAIProvider
```

正确：

```text
chat → llm.chat
```

---

## 第 12 条：公共依赖必须通过稳定 Service / Capability 暴露

插件需要其它能力时，应通过：

```text
Service Context
Capability Registry
Event
Protocol
```

访问。

---

## 第 13 条：禁止跨插件直接依赖内部实现

插件 A 不应该：

```text
import plugin_b.internal.xxx
```

除非该模块属于明确公开、版本化 SDK。

---

## 第 14 条：实现可以有多个 Provider

同一 Capability 应允许：

```text
0 个
1 个
多个
```

实现。

Runtime / Profile 决定实际激活哪个。

---

# 第五章：生命周期

## 第 15 条：所有插件必须拥有明确生命周期

最少：

```text
install
load
start
stop
unload
uninstall
```

可选：

```text
enable
disable
reload
```

---

## 第 16 条：插件产生的副作用必须可撤销

插件创建的：

```text
event listener
timer
worker
thread
service
overlay
file watcher
hook
temporary permission
```

必须在停止 / 卸载时正确撤销。

---

## 第 17 条：禁止幽灵状态

插件卸载以后：

- 不得继续处理事件；
- 不得继续占用线程；
- 不得留下 Service；
- 不得继续发送请求；
- 不得保留临时授权；
- 不得继续控制 UI。

---

# 第六章：Event Driven

## 第 18 条：跨模块协作优先使用事件

适合广播的状态变化优先使用：

```text
Event Bus
```

而不是复杂的互相调用。

---

## 第 19 条：事件名称必须属于稳定命名空间

例如：

```text
user.input.text
pet.clicked
window.changed
agent.completed
permission.revoked
```

避免：

```text
onThing
doX
tmpEvent2
```

这种无法长期维护的命名。

---

## 第 20 条：事件 Payload 必须版本化或稳定

公共事件一旦进入 SDK：

> 它就是生态协议的一部分。

不得随意修改字段含义。

---

# 第七章：Character First-Class

## 第 21 条：Character 是一等插件实体

角色不能被设计为：

> “官方素材目录中的几张图片”。

角色应具备：

```text
Manifest
Assets
Animation
Expression
Capability
Metadata
Optional Personality
Optional Voice
Optional Behavior
```

---

## 第 22 条：任何社区成员都可以制作 Character

角色制作不能要求：

> 修改 Familiar 源码。

必须能够通过独立 Package 完成。

---

## 第 23 条：角色与系统权限分离

角色内容本身不应因为：

```text
“这是一个 Character”
```

就自动拥有：

```text
screen
microphone
filesystem
network
```

系统能力必须经过独立插件 / 权限机制。

---

# 第八章：Renderer Independence

## 第 24 条：Agent 不得输出底层动画命令

Agent 输出：

```text
emotion
action
attention
intent
```

而不是：

```text
bone id
pixel coordinate
animation clip number
renderer-specific parameter
```

---

## 第 25 条：Renderer 负责解释表现语义

例如：

```text
wave
happy
sleep
look_at_user
```

如何表现，由 Renderer + Character 决定。

---

## 第 26 条：角色能力必须允许降级

如果角色不支持：

```text
wave
```

系统不能报致命错误。

应：

```text
wave
→ fallback action
→ fallback emotion
→ idle
```

---

# 第九章：Agent Boundary

## 第 27 条：LLM 负责推理，不负责运行时基础控制

LLM 可以决定：

```text
需要什么
想做什么
使用什么工具
如何回答
```

但不能成为：

```text
线程调度器
权限管理器
窗口管理器
动画驱动器
操作系统内核
```

---

## 第 28 条：所有高风险动作必须经过确定性 Runtime

例如：

```text
删除文件
发送邮件
执行程序
控制浏览器
访问摄像头
访问屏幕
```

必须经过：

```text
Tool
Permission
Policy
Approval
Runtime
```

---

## 第 29 条：模型输出永远是不可信输入

即使是官方模型，模型输出也必须：

- 校验；
- 解析；
- 限制；
- 必要时拒绝执行。

---

# 第十章：异步与响应性

## 第 30 条：AI 推理不得阻塞 Pet Runtime

任何网络请求或模型推理都不能冻结：

```text
Renderer
Input
Window
Audio UI
Animation
```

---

## 第 31 条：长任务必须与表现层解耦

模型思考期间，宠物仍可以：

```text
idle
think
blink
move
respond visually
```

---

## 第 32 条：插件不得假设同步响应

Capability API 应优先支持异步。

---

# 第十一章：平台抽象

## 第 33 条：业务插件不得直接绑定 Windows API

需要：

```text
screen capture
window info
notification
microphone
```

时，应依赖：

```text
platform Capability
```

---

## 第 34 条：Windows 和 Android 可以拥有不同实现

统一的是：

```text
Capability
Protocol
Manifest
Behavior Semantics
```

不要求统一：

```text
UI Framework
Overlay Implementation
System API
Rendering Backend
Background Service
```

---

## 第 35 条：禁止为了“代码共享率”牺牲平台体验

跨平台不是：

> 所有代码必须一样。

跨平台是：

> 上层语义和协议稳定，平台实现符合各自系统。

---

# 第十二章：Windows First

## 第 36 条：第一阶段优先解决 Windows

在协议尚未稳定时，不同步维护两个复杂平台实现。

先通过 Windows 验证：

```text
Plugin Runtime
Character
Renderer
Input
LLM
Voice
Vision
Memory
Tool
```

---

## 第 37 条：Android 在协议成熟后进入

Android 进入条件至少包括：

```text
Manifest 基本稳定
Capability 命名基本稳定
Character Protocol 基本稳定
Renderer Boundary 明确
Agent Boundary 明确
```

---

# 第十三章：Local / Cloud Equality

## 第 38 条：Familiar 不默认 AI 必须在云端

本地 Provider 必须是正式支持路线。

---

## 第 39 条：Familiar 也不强制本地化

云模型拥有同等地位。

---

## 第 40 条：Provider 差异必须由 Adapter 吸收

上层不应该到处出现：

```text
if openai
if anthropic
if gemini
```

Provider 特殊逻辑应尽量存在于 Provider 内部。

---

# 第十四章：权限

## 第 41 条：权限系统必须早于高风险能力

不能先做：

```text
screen
camera
filesystem
browser control
```

然后再想权限。

---

## 第 42 条：安装不等于授权

插件 Manifest 声明权限：

```text
requires permission
```

用户再授权。

---

## 第 43 条：敏感权限应支持临时授权

例如：

```text
screen.capture
camera.read
microphone.listen
```

未来应允许：

```text
once
current session
10 minutes
always
deny
```

---

## 第 44 条：最小权限原则

插件只应申请完成当前能力所需的最小权限集合。

---

# 第十五章：隐私

## 第 45 条：默认不持续上传屏幕

视觉应优先：

```text
on-demand
event-driven
permission-session
```

---

## 第 46 条：Wake Word 应优先支持本地

麦克风常驻监听不应等价于：

> 持续发送云端音频。

---

## 第 47 条：用户数据归用户

Familiar 不应设计成必须依赖官方云端才能读取自己的：

```text
角色
配置
记忆
日志
插件
```

本地优先应成为长期可选能力。

---

# 第十六章：故障隔离

## 第 48 条：单插件失败不得导致 Runtime 整体退出

至少需要隔离：

```text
Provider failure
Renderer failure
TTS failure
Vision failure
Tool failure
Community Plugin failure
```

---

## 第 49 条：能力不可用时优先降级

例如：

```text
TTS unavailable
→ text only

Vision unavailable
→ ask user / text mode

Memory unavailable
→ ephemeral session

Renderer unavailable
→ fallback renderer / safe UI
```

---

## 第 50 条：失败必须可诊断

禁止：

```text
catch everything
→ ignore
```

必须有：

```text
logging
error boundary
plugin identity
context
diagnostics
```

---

# 第十七章：配置

## 第 51 条：插件配置必须独立

不能形成一个无限膨胀的：

```text
global-config.json
```

每个插件应拥有自己的配置 Schema。

---

## 第 52 条：配置必须校验

坏配置应：

> 启动失败并给出明确错误。

而不是：

> 运行到一半出现不可预测行为。

---

## 第 53 条：Secret 与普通配置分离

API Key 等敏感信息不能被当作普通配置随意导出和共享。

---

# 第十八章：Profile

## 第 54 条：Familiar 必须支持能力组合

一个运行实例不需要加载所有插件。

可以存在：

```text
Minimal
Voice
Vision
Assistant
Full
Custom
```

---

## 第 55 条：Profile 是组合，不是分叉产品

不能因为需要 Minimal 版，就复制一套代码成为：

```text
familiar-lite
```

而应通过插件组合实现。

---

# 第十九章：SDK 与社区

## 第 56 条：公开 SDK 必须比内部 API 更稳定

内部重构不能随意破坏社区插件。

---

## 第 57 条：第三方开发不得要求理解整个仓库

官方应逐渐提供：

```text
SDK
Template
Examples
Test Harness
Docs
CLI
```

---

## 第 58 条：SDK 类型和 Runtime 行为必须一致

不能出现：

```text
TypeScript 说可以
Runtime 实际不支持
```

或者反过来。

---

# 第二十章：版本

## 第 59 条：公共协议必须版本化

至少包括：

```text
Manifest Version
SDK Version
Protocol Version
Character Schema Version
```

---

## 第 60 条：破坏性变化必须可识别

不能静默改变协议语义。

---

## 第 61 条：迁移优于强行兼容

早期项目可以发生破坏性变化。

但必须：

```text
说明变化
提供迁移文档
明确版本
```

而不是维持大量不可维护的隐式兼容。

---

# 第二十一章：安全边界

## 第 62 条：Community Plugin 默认不可信

即使插件来自社区热门项目，也不能默认拥有无限能力。

---

## 第 63 条：高风险操作必须有明确边界

包括：

```text
shell
process
filesystem.write
browser.control
email.send
credential
camera
screen
```

---

## 第 64 条：插件不能绕过 Permission Manager

任何“为了方便”直接调用底层 API 的路径，都应视为架构缺陷。

---

# 第二十二章：依赖

## 第 65 条：避免因为小功能引入巨大依赖

新增依赖时要考虑：

```text
体积
维护情况
许可证
平台支持
安全
Android 兼容
长期维护成本
```

---

## 第 66 条：第三方框架不能成为不可替换的项目定义

即使第一版选择某个：

```text
UI framework
plugin framework
renderer
database
```

上层架构也不应被彻底绑死。

---

# 第二十三章：开源合规

## 第 67 条：引入代码前必须检查许可证

特别是：

```text
角色资源
模型文件
动画资产
字体
声音
第三方插件代码
```

---

## 第 68 条：参考架构不等于复制代码

可以学习：

```text
DSH
OpenPets
VPet
其它桌宠
```

但具体使用代码必须遵守对应 License。

---

# 第二十四章：测试

## 第 69 条：Plugin Runtime 必须优先拥有测试

因为所有未来能力都建立在它上面。

优先测试：

```text
load
unload
dependency
service registration
event cleanup
permission
failure isolation
reload
```

---

## 第 70 条：每个公共 Capability 应有 Contract Test

不同 Provider 应运行同一套行为测试。

例如：

```text
LLM Provider Contract
Renderer Contract
Storage Contract
TTS Contract
```

---

## 第 71 条：第三方插件应有 Test Harness

插件作者应能在不启动完整 Familiar 的情况下测试主要 API。

---

# 第二十五章：可观测性

## 第 72 条：系统必须知道“谁做了什么”

日志至少能关联：

```text
Plugin ID
Service
Event
Tool
Permission
Agent Turn
Error
```

---

## 第 73 条：调试信息和用户 UI 分离

普通用户不需要看到内部运行噪声。

开发者模式可以提供完整 Trace。

---

# 第二十六章：性能

## 第 74 条：桌宠表现层必须长期低负载

常驻软件不能长期：

```text
高 CPU
高 GPU
高网络
高磁盘
```

否则 Companion 的价值会被资源消耗抵消。

---

## 第 75 条：视觉必须避免无意义高频调用

默认禁止：

```text
持续高频截图
→ 持续 VLM 推理
```

除非用户明确配置。

---

## 第 76 条：Idle 状态应该真正 Idle

没有事件时，系统应尽量减少工作。

---

# 第二十七章：数据边界

## 第 77 条：Character、Memory、Config、Cache 分离

禁止把所有状态塞进一个不可理解的数据库对象。

---

## 第 78 条：可删除的数据必须能够真正删除

用户删除：

```text
Memory
Character
Plugin
Profile
```

时，应有清晰语义。

---

## 第 79 条：缓存不是记忆

Cache 可以重建。

Memory 是用户数据。

二者必须明确区分。

---

# 第二十八章：文档

## 第 80 条：公开协议必须有文档

不能只有源码。

至少需要：

```text
Manifest
Capability
Lifecycle
Event
Permission
Character Protocol
Renderer Protocol
SDK
```

---

## 第 81 条：架构变更必须同步更新文档

代码和文档长期不一致等价于没有架构。

---

# 第二十九章：逐步开发

## 第 82 条：任何阶段都应该有可运行软件

禁止：

> 开发数月后第一次完整运行。

---

## 第 83 条：优先完成垂直最小闭环

例如第一阶段：

```text
Kernel
→ Plugin
→ Renderer
→ Character
→ Window
```

先形成闭环，再扩展。

---

## 第 84 条：没有真实需求时不提前造未来系统

暂时不建设：

```text
Plugin Marketplace
Cloud Account
Social System
Huge Multi-Agent Platform
Enterprise Backend
```

只留下合理扩展接口。

---

# 第三十章：社区优先，但 Runtime 优先

## 第 85 条：第三方扩展体验很重要

但不能为了让插件“什么都能干”而牺牲：

```text
安全
稳定
隔离
权限
```

---

## 第 86 条：Host 保持最终控制权

插件可以提出：

```text
请求
意图
UI 描述
动作
```

最终执行权属于 Runtime / Host。

---

# 第三十一章：架构争议决策顺序

遇到两种实现方案时，依次询问：

1. 哪个方案让 Core 更小？
2. 哪个方案更容易插件化？
3. 哪个方案依赖 Capability 而非 Implementation？
4. 哪个方案更容易卸载和回滚？
5. 哪个方案权限边界更清楚？
6. 哪个方案更容易故障隔离？
7. 哪个方案更适合社区？
8. 哪个方案更容易跨平台？
9. 哪个方案更容易测试？
10. 当前真的需要做这件事吗？

---

# 第三十二章：禁止事项

以下模式默认视为架构警告：

```text
God Object
Global Mutable State
Plugin Internal Cross-Import
Provider-specific Logic Everywhere
Unmanaged Thread
Unmanaged Timer
Permanent Permission by Default
AI Direct OS Control
Renderer-specific Agent Output
Hard-coded Character
Hard-coded Model
One Giant Config
One Giant Prompt
Catch-and-ignore Error
Platform API in Business Plugin
```

如果必须使用，需要明确说明原因。

---

# 第三十三章：第一阶段宪法测试

第一阶段完成时，系统至少应该能够回答“是”：

- [ ] Core 不知道 OpenAI 是什么。
- [ ] Core 不知道 Live2D 是什么。
- [ ] Core 不知道角色具体是什么。
- [ ] Character 可以替换。
- [ ] Renderer 可以替换。
- [ ] 插件可以加载。
- [ ] 插件可以卸载。
- [ ] Service 可以注册和撤销。
- [ ] Event Listener 会随插件卸载清理。
- [ ] 一个插件失败不会拖垮 Host。
- [ ] 插件权限可以被 Runtime 拒绝。
- [ ] Windows 平台能力通过抽象暴露。
- [ ] 不需要修改 Core 就能新增一个简单插件。

如果多数答案为否：

> 不应继续堆积高级功能。

应先修正基础架构。

---

# 第三十四章：长期原则

无论 Familiar 最后发展成：

```text
桌面宠物
语音助手
AI Companion
Personal Agent
Automation Platform
```

都必须保留以下核心：

> **Plugin First**

> **Thin Kernel**

> **Capability over Implementation**

> **Permission First**

> **Failure Isolation**

> **Character First-Class**

> **Platform Abstraction**

> **Local / Cloud Equality**

> **Incremental Development**

> **Community Extensibility**

---

# 结语

Familiar 的长期竞争力不会来自：

> 内置了多少功能。

而会来自：

> **能否在不破坏系统的情况下不断获得新能力。**

因此 Familiar 的开发目标不是把所有东西做进程序。

而是建立一个足够稳定的基础，让：

- 官方可以继续开发；
- 社区可以自由创造；
- 用户可以自由组合；
- 模型可以自由替换；
- 角色可以自由变化；
- 平台可以继续扩展。

如果未来某一天 Familiar 已经拥有上百种插件、几十种角色、多个 Agent 和大量能力，而 Kernel 仍然保持简单稳定：

> 那么这份宪法才算真正成功。
