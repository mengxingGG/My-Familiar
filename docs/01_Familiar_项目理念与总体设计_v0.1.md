# Familiar · 灵伴
## 项目理念与总体设计 v0.1

> **A pluggable multimodal companion platform.**  
> 一个插件化、多模态、可长期陪伴并持续成长的个人智能伙伴平台。

---

## 0. 文档信息

- **项目名称**：Familiar
- **中文名**：灵伴
- **文档类型**：项目理念 / 产品定位 / 总体架构 / 演进路线
- **版本**：v0.1
- **状态**：初始基调
- **目标平台**：Windows 优先，Android 后续
- **核心方向**：多模态、桌面常驻、角色化、插件化、社区生态、个人 Agent

本文不是最终技术实现说明，也不是详细 API 规范。

它的作用是回答三个问题：

1. **Familiar 到底是什么？**
2. **Familiar 最终希望变成什么？**
3. **我们为什么要采用现在这套架构方向？**

后续具体技术栈、插件协议、运行时 API、数据结构、SDK、进程模型等，可以在本理念不变的前提下单独设计。

---

# 1. 项目起点

Familiar 最初来自一个很简单的想法：

> 做一个真正“活在桌面上”的 AI 宠物。

它不是传统意义上的桌宠，也不是给聊天机器人套上一张动态立绘。

它应该能够：

- 长期常驻桌面；
- 拥有动态形象；
- 具有可持续的人格；
- 可以通过文字与用户交流；
- 可以听见用户说话；
- 可以被语音唤醒；
- 可以用语音回应；
- 能够看到屏幕、图片以及未来更多视觉输入；
- 知道当前用户正在做什么；
- 能够记住过去发生过的事情；
- 可以主动或被动地使用工具；
- 可以随着插件不断获得新能力；
- 最终成为用户设备中的长期个人 Companion Agent。

因此 Familiar 的发展路径不是：

> 桌宠 → 加几个 AI 功能

而是：

> **桌面宠物 → 多模态数字伙伴 → 个人智能助手 → 可扩展的个人 Agent 平台**

桌宠是 Familiar 的第一种交互形态，但不是它的能力上限。

---

# 2. 核心定位

Familiar 定义为：

> **一个以角色化交互为入口，以插件系统为基础，以多模态 Agent 为智能核心的个人数字伙伴平台。**

这里有四个关键词。

## 2.1 角色化

Familiar 不是无形的后台服务。

用户应该看到它、听到它、与它互动，并逐渐形成稳定的“角色认知”。

角色可以是：

- 猫；
- 狗；
- 狐狸；
- 龙；
- 史莱姆；
- 机器人；
- 人形角色；
- 像素角色；
- Live2D 角色；
- 3D 角色；
- 纯抽象图形；
- 社区自己创造的任何形态。

Familiar 本身不规定“官方宠物必须是什么”。

---

## 2.2 多模态

Familiar 不应该局限于文字输入。

未来可以同时拥有：

- Text；
- Voice；
- Audio；
- Screen Vision；
- Camera Vision；
- Image；
- Notification；
- Application Context；
- System Events；
- File Context；
- Tool Results。

输出同样不局限于文字：

- Text；
- Speech；
- Expression；
- Animation；
- Movement；
- Notification；
- Tool Action；
- UI；
- Avatar Behavior。

因此它更像一个长期存在于设备上的数字生命界面。

---

## 2.3 Agent

Familiar 最终不是单纯的聊天机器人。

它应当能够在明确权限范围内：

- 理解任务；
- 判断是否需要视觉；
- 判断是否需要调用工具；
- 使用文件；
- 调用搜索；
- 读取日历；
- 查看邮件；
- 创建提醒；
- 调用系统能力；
- 执行可审批操作；
- 组合多个能力完成任务。

但 Agent 不直接成为“整个应用的控制器”。

软件运行时、权限、状态机和平台能力仍然由确定性程序负责。

---

## 2.4 平台

Familiar 最重要的长期定位是“平台”。

它不绑定：

- 某一家模型厂商；
- 某一种桌宠；
- 某一种渲染引擎；
- 某一个 TTS；
- 某一个 ASR；
- 某一种记忆系统；
- 某一种 Agent Loop；
- 某一个操作系统能力实现。

用户和社区可以不断替换、组合和扩展这些部件。

---

# 3. Familiar 的基本体验

Familiar 第一阶段最希望做到的，不是“功能数量最多”，而是让用户产生一种明确感受：

> **它真的一直在这里。**

例如：

```text
用户打开电脑
    ↓
Familiar 从睡眠状态醒来
    ↓
角色做一个自然的起身动作

用户开始工作
    ↓
Familiar 在屏幕边缘待机、散步或做自己的事情

用户：
“帮我看看这个报错。”
    ↓
Familiar 获得一次视觉授权
    ↓
读取当前屏幕 / 窗口
    ↓
视觉模型理解内容
    ↓
给出回答

用户：
“算了，我自己解决。”
    ↓
角色回应并恢复待机

一段时间后
    ↓
Familiar 仍然知道刚刚用户在处理什么项目
```

这里真正重要的并不是某个单独功能，而是：

- 状态连续；
- 角色连续；
- 记忆连续；
- 动作连续；
- 上下文连续。

这也是 Familiar 与“一问一答 AI 窗口”的核心区别。

---

# 4. 产品原则

## 4.1 不做一个披着桌宠皮肤的聊天框

如果整个产品最终只是：

```text
角色立绘
+
输入框
+
LLM API
```

那么 Familiar 就没有成立。

桌宠的存在必须影响交互方式。

它要有：

- 待机；
- 睡眠；
- 唤醒；
- 注意力；
- 情绪；
- 动作；
- 主动行为；
- 环境感知；
- 长期状态。

---

## 4.2 不追求第一版做完所有能力

Familiar 必须采用增量开发。

第一版甚至不必连接 AI。

项目可以这样成长：

```text
Kernel
  ↓
Plugin Runtime
  ↓
Windows Host
  ↓
Basic Pet
  ↓
Text
  ↓
LLM
  ↓
Voice
  ↓
Vision
  ↓
Memory
  ↓
Tools
  ↓
Automation
```

每加入一个模块，项目仍然应该是完整、可运行、可测试的。

---

## 4.3 任何复杂能力都应允许替换

系统不应该出现这样的结构：

```text
Chat → OpenAI
```

而应该是：

```text
Chat → LLM Capability → Provider
```

实现可以是：

```text
OpenAI
Anthropic
Gemini
OpenRouter
LM Studio
Ollama
Custom OpenAI Compatible
```

上层不需要知道实际是谁。

---

# 5. DSH 式插件思想

Familiar 借鉴 DeepSeek Harness / Cordis 的核心思想：

> **Everything is a Plugin.**

但 Familiar 不要求直接依赖 DSH。

我们要继承的是它的架构哲学：

- 服务通过共享 Context 暴露；
- 插件声明自己的依赖；
- 插件通过稳定能力接口协作；
- 生命周期受到 Runtime 管理；
- 注册行为应当可以撤销；
- 具体实现可以替换；
- 产品由插件组合而成。

因此 Familiar 不把插件理解成传统软件里的：

> “可选附加小功能”。

在 Familiar 中，插件是**主要软件组织形式**。

---

# 6. Thin Kernel

Familiar Core 必须保持尽可能小。

建议 Core 只拥有真正不可缺少的运行基础：

```text
Familiar Kernel
├─ Plugin Manager
├─ Service Context
├─ Capability Registry
├─ Event Bus
├─ Lifecycle Manager
├─ Configuration
├─ Permission Manager
├─ Logging
└─ Runtime Diagnostics
```

Core 不应该知道：

- OpenAI 是什么；
- Live2D 是什么；
- Whisper 是什么；
- Kokoro 是什么；
- SQLite 是什么；
- Windows 截屏如何实现；
- Android Overlay 如何实现；
- 某个角色有哪些动作；
- Agent Loop 具体怎么跑。

这些全部属于 Core 之外。

---

# 7. 插件世界

Familiar 的功能可以按照能力划分插件类别。

```text
Plugin World
│
├─ Platform
├─ Renderer
├─ Character
├─ Behavior
├─ Input
├─ Audio
├─ Vision
├─ Model
├─ Agent
├─ Memory
├─ Tool
├─ Skill
├─ UI
├─ Storage
├─ Integration
└─ Sync
```

插件类别不是硬编码限制。

它们更多用于：

- 文档组织；
- 生态分类；
- 权限描述；
- SDK 设计；
- 插件商店未来的展示。

---

# 8. Character 本身就是插件

这是 Familiar 最重要的设计之一。

角色不是程序内置皮肤。

角色应该是一个可以独立制作、安装、升级、分享和删除的实体。

例如：

```text
characters/
├─ neko/
├─ slime/
├─ robot/
├─ dragon/
└─ community-character/
```

一个 Character Package 可以包含：

```text
manifest
metadata
avatar
models
sprites
textures
animations
expressions
personality
voice-profile
behavior-profile
default-settings
assets
localization
```

社区开发者应该能够制作：

> **My Familiar**

而不需要修改 Familiar Core。

---

# 9. Character 与 Renderer 必须分离

角色与底层渲染实现不能强绑定。

Renderer 也应该插件化：

```text
renderer-sprite
renderer-live2d
renderer-spine
renderer-vrm
renderer-3d
```

Agent 和 Behavior 层只表达高级语义。

例如：

```json
{
  "emotion": "happy",
  "action": "wave",
  "attention": "user"
}
```

而不是：

```text
bone_17 = 0.46
animation_clip = 31
move_x = 17
```

角色或 Renderer 再决定：

```text
happy
   ↓
具体表情参数

wave
   ↓
具体动作资源

attention:user
   ↓
头部 / 眼睛 / 身体朝向
```

这种结构可以保证：

- 更换渲染技术不用修改 Agent；
- 不同角色可以解释相同动作；
- 社区角色开发更简单；
- 后续 2D → 3D 不需要重写上层。

---

# 10. 角色能力声明

不同角色并不一定拥有同样动作。

例如角色 A 可能支持：

```text
idle
sleep
walk
run
wave
happy
sad
angry
look_at
```

角色 B 可能只有：

```text
idle
sleep
bounce
happy
sad
```

因此 Character Manifest 应声明 Capability。

Agent 请求的是：

```text
action.wave
```

如果角色不支持：

```text
action.wave
```

Behavior / Renderer 应进行能力降级。

例如：

```text
wave
→ fallback: happy
→ fallback: idle
```

Agent 不应该因为一个角色缺少动作而失败。

---

# 11. 多模态输入

Familiar 的感知层最终可以处理：

```text
Text
Voice
Microphone
Screen
Window
Image
Camera
Notification
Clipboard
File
Application
Time
System State
Device State
```

但并不是所有输入都应该持续送给大模型。

---

# 12. 视觉设计

Familiar 优先支持具有视觉能力的模型。

视觉是项目与普通 AI 助手产生差异的重要能力。

但必须避免：

> 每秒截图 → 每秒调用视觉模型。

这种做法会造成：

- API 成本极高；
- 本地算力浪费；
- 延迟；
- 隐私风险；
- Token 快速膨胀。

因此推荐：

> **事件驱动视觉 + 分级感知**

基础层只收集低成本事件：

```text
active_application
active_window_title
screen_change_ratio
mouse_activity
keyboard_activity
user_idle_time
fullscreen_state
media_state
```

只有在：

- 用户主动要求；
- Agent 明确需要；
- 屏幕出现关键变化；
- 某个规则触发；
- 用户授予临时视觉访问；

时才真正捕获并提交屏幕图像。

---

# 13. Visual Permission Session

未来推荐引入：

> **视觉权限会话**

例如：

```text
用户：
“你看看我现在这个错误。”

↓
创建 60 秒 Visual Session

↓
允许读取当前窗口

↓
任务完成

↓
权限自动撤销
```

这样视觉能力不是永久默认开启。

用户可以配置：

```text
Always Ask
Current Window Only
Current App
Timed Session
Always Allow
Never Allow
```

这是未来社区生态非常重要的安全基础。

---

# 14. 语音系统

语音建议采用可拆分流水线：

```text
Wake Word
    ↓
VAD
    ↓
ASR
    ↓
Agent
    ↓
TTS
```

所有部分都可以替换。

例如：

```text
wakeword-local
vad-local
asr-whisper
tts-kokoro
```

或者：

```text
wakeword-local
vad-local
asr-cloud
tts-cloud
```

语音唤醒层应尽量支持本地运行。

不应该为了等待唤醒词而持续向云端传输麦克风音频。

---

# 15. 动画与 AI 必须异步

Familiar 的 UI 和动画不能被 AI 推理阻塞。

错误：

```text
点击宠物
↓
停止动画
↓
等待模型 8 秒
↓
继续动画
```

正确：

```text
UI Runtime ───────────────持续运行
      │
      ├─ Audio Runtime
      │
      ├─ Agent Runtime
      │
      └─ Renderer Runtime
```

模型推理时，角色仍然可以：

- 思考动画；
- 呼吸；
- 眨眼；
- 看向用户；
- 播放等待动作。

这对“活着”的感觉非常重要。

---

# 16. Agent 的职责

Agent 负责：

- 理解用户；
- 综合上下文；
- 判断是否调用模型；
- 判断是否使用视觉；
- 判断是否使用工具；
- 形成高层行为意图；
- 生成回复；
- 产生结构化行动计划。

Agent 不应该：

- 操纵底层骨骼；
- 直接移动窗口坐标；
- 管理线程；
- 直接控制操作系统权限；
- 直接操作设备私有 API。

Agent 输出：

```text
Intent
Emotion
Action
Speech
Tool Call
Attention
Memory Candidate
```

Runtime 再执行。

---

# 17. Behavior Layer

Familiar 需要一个独立 Behavior Layer。

例如 Agent 输出：

```text
emotion = happy
action = greet
```

Behavior 可以决定：

```text
角色正在睡觉？
→ 先 wake

当前正在播放不可中断动作？
→ 排队

用户正在全屏游戏？
→ 不弹出

角色离用户鼠标太远？
→ 先移动

greet 无对应动画？
→ 使用 wave
```

因此：

> LLM 决定“想做什么”，Behavior 决定“现在怎么做最合适”。

---

# 18. Event Driven

系统应尽量采用事件驱动。

例如：

```text
user.input.text
user.input.voice
user.idle
user.returned

pet.clicked
pet.dragged
pet.hovered

window.changed
screen.changed
application.changed

agent.started
agent.completed

vision.requested
vision.completed

memory.updated

permission.granted
permission.revoked
```

事件总线让插件之间不需要建立复杂的直接依赖链。

---

# 19. Capability over Implementation

插件之间依赖能力，而不是实现。

错误：

```text
Chat Plugin
    ↓
OpenAI Plugin
```

正确：

```text
Chat Plugin
    ↓
llm.chat
    ↓
Provider
```

Manifest 示例：

```json
{
  "id": "familiar.chat.basic",
  "requires": [
    "llm.chat"
  ]
}
```

Provider：

```json
{
  "id": "familiar.provider.openai",
  "provides": [
    "llm.chat",
    "vision.image"
  ]
}
```

于是 Provider 可以随时更换。

---

# 20. Model Provider

模型层预计至少支持：

```text
model-openai
model-anthropic
model-gemini
model-openrouter
model-lmstudio
model-ollama
model-openai-compatible
```

统一上层接口可以逐步设计为：

```text
chat()
vision()
embedding()
rerank()
speech_to_text()
text_to_speech()
```

实际 API 差异由 Provider Adapter 处理。

---

# 21. Local / Cloud / Hybrid

Familiar 不应该选择“本地派”或“云端派”。

它们应该是平等选项。

## Local

优点：

- 隐私；
- 无 API 成本；
- 离线；
- 可控。

## Cloud

优点：

- 模型能力；
- 维护成本低；
- 硬件要求低；
- 多模态能力成熟。

## Hybrid

可能成为 Familiar 最自然的模式：

```text
Wake Word  → Local
VAD        → Local
ASR        → Local
Small Task → Local Model
Vision     → Cloud VLM
Hard Task  → Cloud LLM
TTS        → Local
Memory     → Local
```

用户可自行选择。

---

# 22. Memory

记忆不是第一阶段必须完成的能力，但它对 Familiar 的长期定位极其重要。

未来可以拆为：

```text
Conversation Memory
Event Memory
Relationship Memory
Preference Memory
Character Memory
Semantic Memory
Task Memory
```

存储实现则可独立：

```text
memory-sqlite
memory-vector
memory-files
memory-cloud
```

角色人格与用户长期记忆也必须分开。

不能把“角色设定”和“用户事实”混成一个巨大 Prompt。

---

# 23. Skill 与 Tool

建议区分：

## Tool

原子能力。

例如：

```text
file.read
file.write
browser.open
calendar.list
notification.send
process.launch
```

## Skill

组合能力。

例如：

```text
summarize-current-work
prepare-daily-brief
organize-download-folder
debug-current-screen
```

Skill 可以依赖多个 Tool。

这样社区开发生态会更加清晰。

---

# 24. Platform Abstraction

平台相关能力必须抽象。

例如：

```text
platform.overlay
platform.screen_capture
platform.window_info
platform.notification
platform.microphone
platform.camera
platform.filesystem
platform.launch_app
```

然后：

```text
platform-windows
platform-android
```

分别实现。

业务插件只依赖能力。

---

# 25. Windows 优先

Windows 是 Familiar 的第一目标平台。

原因：

- 桌面场景天然；
- Overlay 自由度高；
- 系统 API 丰富；
- 屏幕视觉更容易形成完整体验；
- 本地模型部署方便；
- 文件与应用工具能力更完整；
- 更适合作为 Agent 平台实验环境。

Windows 第一阶段重点：

```text
透明窗口
Always-on-top
点击与拖动
Click-through
系统托盘
开机启动
多显示器
活动窗口
屏幕捕获
全局快捷键
本地模型连接
```

---

# 26. Android 定位

Android 不应该机械复制 Windows。

Android 更适合：

> **移动版 Companion**

重点可以是：

```text
Overlay Companion
Voice
Camera Vision
Notifications
Chat
Memory Sync
Mobile Tools
Agent
```

Android 的：

- Overlay；
- Accessibility；
- Screen Capture；
- Background Service；

都受系统权限与平台政策影响。

因此 Android 应遵循相同核心协议，但拥有适合移动平台的交互体验。

---

# 27. 插件 Manifest

推荐所有插件使用统一 Manifest。

概念示例：

```json
{
  "manifestVersion": 1,
  "id": "community.example.screen-vision",
  "name": "Screen Vision",
  "version": "0.1.0",
  "author": "Example",

  "platforms": [
    "windows"
  ],

  "requires": [
    "platform.screen_capture",
    "vision.image"
  ],

  "provides": [
    "vision.screen"
  ],

  "permissions": [
    "screen.capture"
  ]
}
```

后续可以增加：

```text
entrypoints
configSchema
optionalDependencies
conflicts
minHostVersion
maxHostVersion
localization
license
homepage
repository
```

---

# 28. 插件生命周期

建议统一：

```text
install
load
start
stop
unload
uninstall
```

并支持：

```text
enable
disable
reload
```

插件停止或卸载时：

- Listener 必须移除；
- Timer 必须取消；
- Service 必须撤销；
- Worker 必须结束；
- 文件句柄必须释放；
- Overlay 必须销毁；
- 权限 Session 必须结束。

原则：

> **插件的副作用必须和生命周期绑定。**

---

# 29. 故障隔离

一个插件坏掉不能拖垮 Familiar。

例如：

```text
TTS Plugin crashed
```

系统应该降级：

```text
语音不可用
但文字仍可使用
```

而不是：

```text
整个 Familiar 退出
```

类似地：

```text
Vision unavailable
→ Text Chat 继续

LLM Provider unavailable
→ Pet Renderer 继续

Memory unavailable
→ 临时无长期记忆

Character Plugin error
→ fallback character
```

---

# 30. Permission First

随着插件生态扩大，权限必须成为基础设计。

可能的权限：

```text
screen.capture
camera.read
microphone.read
clipboard.read
clipboard.write
filesystem.read
filesystem.write
network.access
process.launch
process.execute
notification.read
notification.send
calendar.read
calendar.write
email.read
email.send
browser.control
accessibility.control
```

安装插件不等于自动授权全部能力。

未来社区插件必须经过显式权限声明。

---

# 31. Profile / Bundle

Familiar 可以借鉴组合式 Profile。

例如：

## Minimal

```text
Kernel
Windows Host
Basic Renderer
Character
Text
```

## Voice

```text
Minimal
+ Wake Word
+ VAD
+ ASR
+ TTS
```

## Vision

```text
Voice
+ Screen Capture
+ Vision Provider
```

## Assistant

```text
Vision
+ Memory
+ Tools
+ Scheduler
```

## Full Agent

```text
Assistant
+ Browser
+ Files
+ Calendar
+ Email
+ Automation
```

这不仅是用户预设，也可以成为调试工具。

---

# 32. 社区生态

Familiar 从第一天开始就应该假设：

> 未来的大部分有趣内容可能来自社区。

社区可以创建：

- Character；
- Renderer；
- Voice；
- Behavior；
- Model Provider；
- Tool；
- Skill；
- Integration；
- Theme；
- Profile。

因此官方 SDK 需要做到：

```text
clone template
    ↓
implement
    ↓
run test
    ↓
load locally
    ↓
package
    ↓
share
```

开发第三方插件不应该要求阅读整个 Familiar 源码。

---

# 33. 社区角色生态

Character 是最容易形成社区传播的部分。

理想状态下，社区用户可以制作：

```text
Familiar Character Pack
```

角色包可以拥有：

- 原创形象；
- 动画；
- 声音；
- 性格预设；
- 行为；
- 自定义动作；
- 特定 Skill 推荐配置。

但角色包不能获得超出声明范围的系统权限。

“角色内容”和“系统能力”必须有边界。

---

# 34. 未来插件市场

插件市场不是第一阶段任务。

但协议应考虑未来：

```text
Package ID
Version
Signature
Author
Permissions
Compatibility
Dependencies
Update Channel
Source
License
```

未来可以出现：

```text
Familiar Hub
```

用于发现：

- 角色；
- 插件；
- Skill；
- Renderer；
- Provider；
- Profile。

现在不实现，只保留兼容空间。

---

# 35. 推荐代码仓库布局（概念）

```text
familiar/
│
├─ apps/
│  ├─ desktop-windows/
│  └─ android/
│
├─ packages/
│  ├─ kernel/
│  ├─ plugin-runtime/
│  ├─ sdk/
│  ├─ protocol/
│  └─ shared/
│
├─ plugins/
│  ├─ official/
│  └─ examples/
│
├─ characters/
│  └─ sample/
│
├─ profiles/
│
├─ docs/
│
├─ examples/
│
└─ tests/
```

这只是概念结构。

具体语言和构建系统确定后再最终决定。

---

# 36. 第一阶段：让插件驱动一只宠物

第一阶段目标：

```text
Familiar Kernel
+
Plugin Runtime
+
Windows Host
+
Basic Renderer
+
Sample Character
```

成功标准：

1. Familiar 可以启动；
2. Runtime 可以发现插件；
3. 可以加载插件；
4. 可以卸载插件；
5. 插件可以注册 Service；
6. 插件可以发送 Event；
7. Character 可以通过插件加载；
8. Windows 可以显示角色；
9. 关闭角色插件后资源完整释放；
10. 某插件崩溃不导致 Runtime 整体崩溃。

这一阶段：

> **不需要 LLM。**

先证明架构。

---

# 37. 第二阶段：宠物可以聊天

加入：

```text
input-text
llm-capability
provider-openai-compatible
agent-basic
chat-basic
```

成功标准：

> 用户可以输入文字并得到来自角色的回复。

同时验证：

> 更换模型 Provider 不修改 Chat Plugin。

---

# 38. 第三阶段：宠物拥有声音

加入：

```text
wakeword
vad
asr
tts
audio-session
```

成功标准：

```text
用户唤醒
→ Familiar 进入聆听状态
→ ASR
→ Agent
→ TTS
→ 角色嘴型 / 动作同步
```

---

# 39. 第四阶段：宠物拥有视觉

加入：

```text
platform.screen_capture
vision-provider
screen-context
visual-session
```

成功标准：

```text
用户：
“看看这个。”

→ Familiar 获取授权
→ 查看当前窗口
→ 理解屏幕
→ 回答
→ 权限结束
```

---

# 40. 第五阶段：长期 Companion

加入：

```text
memory
behavior
tools
skills
scheduler
notification
```

此时 Familiar 开始从：

> AI Desktop Pet

成长为：

> Personal Companion Agent

---

# 41. 第六阶段：Android

当：

- 插件协议稳定；
- Character 协议稳定；
- Capability 命名稳定；
- Agent 与表现层解耦完成；

后，再正式推进 Android。

共享：

```text
Protocol
Plugin Manifest
Character Schema
Agent Concepts
Memory Schema
Capability Definitions
```

不强制共享：

```text
Window Runtime
Overlay Implementation
Platform APIs
UI Shell
Rendering Backend
```

---

# 42. 开源项目参考

Familiar 不需要复制任何单一项目。

我们应该“拆开学习”。

## DeepSeek Harness / Cordis

重点参考：

- Everything is a Plugin；
- Context Service；
- 依赖注入；
- 生命周期；
- 可撤销副作用；
- Event；
- Profile / Bundle。

项目：

https://github.com/deepseek-ai/deepseek-harness

---

## OpenPets

重点参考：

- 桌面 Companion 平台定位；
- Plugin SDK；
- Manifest；
- 权限；
- 插件沙箱；
- Host-rendered UI；
- 第三方插件开发体验。

项目：

https://github.com/OpenPetsHQ/openpets

---

## VPet

重点参考：

- Windows 桌宠；
- MOD；
- 角色切换；
- 动画；
- Window Controller；
- 桌宠社区生态。

项目：

https://github.com/LorisYounger/VPet

---

# 43. 参考项目的使用原则

任何开源项目都只回答：

> “别人如何处理这个问题？”

而不能自动变成：

> “Familiar 也必须这样实现。”

评估时至少考虑：

```text
是否跨平台？
是否适合插件架构？
是否维护活跃？
许可证是否兼容？
是否引入过多依赖？
是否绑定某技术栈？
是否会限制未来 Android？
是否会污染 Thin Kernel？
```

---

# 44. 非目标

Familiar v0.x 阶段不追求：

- 完整插件商店；
- 商业化账户系统；
- 云端用户平台；
- 大规模多人社交；
- 多 Agent 集群；
- 官方角色商城；
- 复杂 Web 后台；
- 全自动电脑控制；
- 大而全的工作流平台。

这些可能未来有意义。

但现在它们只会增加项目负担。

---

# 45. Familiar 的最终形态

理想情况下，未来用户拥有的并不是：

> “一个安装好的 AI 软件”。

而是：

> **属于自己的 Familiar。**

用户决定：

```text
它长什么样
它叫什么
它是什么性格
它使用什么模型
它使用什么声音
它记住什么
它拥有什么能力
它可以访问什么
它如何陪伴自己
```

社区决定：

```text
还能创造什么角色
还能创造什么能力
还能连接什么服务
还能发明什么交互
```

Familiar Core 则保持克制，只提供一个稳定的平台：

> **让这些能力安全、可替换、可组合地共同运行。**

---

# 46. 项目一句话

> **Familiar 是一个由插件组成、拥有角色形态、支持多模态感知与长期记忆，并可以逐渐成长为个人 Agent 的数字伙伴平台。**

---

# 47. 当前最高优先级

当前阶段不要先做：

```text
LLM
Vision
Voice
Memory
Tools
```

而应该优先回答：

> **Familiar 的插件到底如何存在？**

第一批技术设计文档建议依次为：

```text
01 Plugin Runtime
02 Capability & Service
03 Event System
04 Plugin Manifest
05 Permission Model
06 Character Protocol
07 Renderer Protocol
08 Windows Host
```

这些基础稳定后，再向上建设智能能力。

---

# 48. 名称体系

推荐：

```text
Familiar
Familiar Core
Familiar Runtime
Familiar SDK
Familiar Desktop
Familiar Android
Familiar Character SDK
Familiar Plugin SDK
Familiar Hub
```

中文统一使用：

> **Familiar · 灵伴**

---

# 49. 结语

Familiar 不需要一开始就强大。

它首先应该：

> **架构正确。**

然后：

> **一点一点获得能力。**

第一天，它可能只是桌面上的一个小角色。

后来它会说话。

再后来它会看见。

再后来它会记住。

再后来它会使用工具。

最终，它可能成为真正长期生活在用户设备里的个人智能伙伴。

而无论它成长到什么程度，都应该保持最初的设计：

> **一切能力可插拔。**

> **用户决定自己的 Familiar 是什么。**
