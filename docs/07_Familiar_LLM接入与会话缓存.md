# Familiar LLM 接入与会话缓存

日期：2026-09-17。实现范围为文字陪伴，不包含工具执行、语音或 Agent。

## 设置用法

1. 选择服务；官方服务预填官方地址，本地服务填写已启动服务器的地址。
2. 单独保存 API Key。保存后自动取模型列表，也可以刷新、搜索和手填模型 ID。兼容与本地服务允许空密钥。
3. 选择模型、温度/Top P、输出上限、超时和思考模式；“模型默认”不发送对应参数。思考模式依据目录能力或适配器规则展示，不支持的采样参数被禁用。上下文窗口留空自动。
4. 保存设置，再测试已保存的连接。测试会发送一条简短生成请求，模型列表与计数不执行推理。切换服务会恢复各自已保存的配置，未保存的草稿仅保留在当前控制器中。

密钥按“供应商类型 + 规范化基础地址”隔离。更换地址后需要为新地址单独保存密钥，不会自动把旧地址的密钥发送过去。HTTP 禁止自动跳转。错误提示不回显供应商响应正文或凭据。

## 插件与协议

`llm-registry` 提供注册表，各 `provider-*` 插件注册 `ProviderDefinition`；`llm-router` 提供 `llm.chat` 与 `llm.management`，统一取密钥、超时、目录、校验和计数。`conversation` 拥有历史与会话，`bubble-chat` 只负责展示和输入。内核未添加任何供应商业务。

| 服务 | 生成接口 | 模型发现与思考 |
| --- | --- | --- |
| OpenAI 兼容 | `/chat/completions` SSE | `/models`；自动或服务支持的 `reasoning_effort` |
| OpenAI 官方 | `/responses` SSE，`store:false` | `/models`；推理模型使用 effort，原生加密推理状态随历史重放 |
| DeepSeek 官方 | `/chat/completions` SSE | `/models`；thinking 开关与 effort，思考时不发送无效温度 |
| Gemini 官方 | `:streamGenerateContent?alt=sse` | 分页 `/models`，筛选支持 generateContent 的模型；2.5 使用 budget，3 系列使用 level |
| Claude 官方 | `/messages` SSE | 分页 `/models`；优先能力元数据，手动预算或 adaptive/effort；签名与原生块保留 |
| OpenRouter 官方 | `/chat/completions` SSE | `/models` 的 supported_parameters、reasoning 元数据与上下文上限 |
| 本地 llama.cpp | `/v1/chat/completions` SSE | `/v1/models`；单模型服务通过 `/props` 获取实际分配窗口；思考控制依赖模板/服务版本 |

没有设置默认云模型 ID。目录不会完全描述所有模型的参数约束；OpenAI、Gemini、Claude 缺少元数据时使用保守规则，未知别名优先“自动”。OpenAI 的不同推理模型可接受不同 effort，服务拒绝时需改用自动或该模型支持的级别。兼容服务可能不实现 reasoning_effort。llama.cpp 使用已运行的服务，不负责下载、加载或更换 GGUF。

温度和 Top P 可独立使用默认；Claude 不允许同时自定义两者。思考 token 预算计入单次输出预算，必须低于输出上限；Claude 手动预算至少 1024。服务端返回长度截断、错误、工具请求或流中断时不会记为完整回复。仅可见文字进入气泡，独立推理字段、原生 thought/签名和正文开头的 `<think>` 块不展示。

## 会话保持与上下文预算

缓存依赖可复用的输入前缀，不能靠维持相同 HTTP 请求头保证命中。当前策略：

- 系统人格固定置于最前；不在前缀注入时间、随机 ID 或每轮变化的状态。追加新消息，不逐轮改写历史、不自动摘要、不产生额外总结请求。
- 会话 ID 持久化，重启后复用。模型、供应商、地址、人格或生成配置变化时递增前缀版本；清空会话创建新 ID。缓存路由键不含聊天正文。
- 原生响应状态只在相同供应商、地址、凭据、模型及思考配置下重放；换服务或更换凭据后使用可见文字历史。作用域只保存散列，不保存凭据原文。原生块保存在本地会话文件，不进入窗口状态或历史页面。
- 目录有模型窗口时优先使用，手动填写不能越过已知窗口。Gemini 分别使用输入/输出上限；llama.cpp 的训练窗口不代表运行时已分配窗口。
- OpenAI/Claude/DeepSeek 的列表不一定提供完整窗口数据。无法发现时明确显示暂用 32768，可按官方模型说明手动设置；暂用值不声称是官方最大值。
- 从窗口中预留配置的输出上限和至少 256 token（或窗口的 0.5%）余量。OpenAI、Claude、Gemini 尝试原生计数；llama.cpp 自动思考模式尝试 `/apply-template` + `/tokenize`。不支持、超时或计数失败时回退到 UTF-8 字节与消息开销的保守估算，并在界面标明“估算”。估算可能早于实际上限裁剪。
- 未超预算保留全部有效历史；超预算后移除最旧完整用户/助手轮次，保留能放入预算的最长后缀，递增前缀版本。已移除原文不再重新加入，也不提供长期记忆归档。当前输入和人格仍过大时直接提示。
- 取消、失败与未完成的回复及其对应旧用户轮次不进入下一轮完整上下文。生成配置在轮次开始时快照化。停止/清空会取消生成，迟到分片不追加。

当前单次用户输入上限 8000 字符、可见回复 256000 字符；它们是输入输出安全边界，不是整个会话的固定长度。窗口只接收最近少量可见消息供气泡选择，模型仍使用全部保留的有效历史。

## 缓存策略和观察

| 服务 | 当前处理 |
| --- | --- |
| OpenAI | 稳定 `prompt_cache_key` 与前缀；读取 cached_tokens / cache_write_tokens，不创建显式缓存资源 |
| DeepSeek | 维持前缀，使用服务自身上下文缓存，读取 prompt_cache_hit_tokens |
| Claude | 开启优化时使用顶层 `cache_control: {type: ephemeral}` 的自动递进断点；不主动启用更长 TTL |
| Gemini | 维持前缀，使用隐式缓存；不创建收费显式缓存资源 |
| OpenRouter | 稳定 `session_id` 供粘性路由；明确选择 Anthropic 模型时附加自动 cache_control；其余使用上游隐式缓存 |
| llama.cpp | 开启优化时发送 `cache_prompt:true`；是否命中取决于模型、slot 和服务器状态 |
| 通用兼容 | 保持前缀，不盲发未声明的缓存扩展参数 |

控制器显示服务报告的输入/输出、缓存读写 token，不把缺失字段显示成零，不臆算节省金额。缓存写入可能收费，短会话、过期或切换模型不保证更便宜。关闭“缓存优化”只停用应用发送的缓存提示，不禁用供应商自身的隐式缓存。清空本地会话不等同于清除供应商缓存。

## 验证与后续开发

本地协议夹具覆盖七种供应商、请求字段、鉴权头、流式事件、隐藏推理、原生状态重放、分页目录、用量与断流错误。会话测试覆盖长于旧 12000 字符上限、固定前缀、重启恢复、整轮裁剪、清空及取消。Electron 测试使用隔离数据验证真实设置界面、系统加密密钥与旧格式迁移、头顶输入/输出互斥和独立进程。

尚未使用真实云服务凭据或实际 llama-server 做端到端验收。逐服务验收需记录：模型 ID/服务版本、模型列表、参数组合、短/长输出、取消和超时、多轮与重启、接近窗口时的裁剪、服务返回缓存读写 token。不要把目录可访问、编译成功或本地 fixture 通过写成真实推理及计费验证通过。具体本地结果见文档 05。

新增供应商：实现并注册 ProviderDefinition → 给宿主授予 network.model → 提供目录/能力/生成/可选计数 → 加请求与失败路径测试 → 更新本文矩阵。不要把供应商逻辑塞入内核或控制器页面。模型能力和字段会变化，先核对官方文档再修改适配器。

## 核对的官方资料

- OpenAI：[Responses 流式事件](https://developers.openai.com/api/docs/guides/streaming-responses)、[推理](https://developers.openai.com/api/docs/guides/reasoning)、[Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)、[输入计数](https://developers.openai.com/api/reference/typescript/resources/responses/subresources/input_tokens)。
- DeepSeek：[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)、[模型列表](https://api-docs.deepseek.com/api/list-models/)、[上下文缓存](https://api-docs.deepseek.com/guides/kv_cache/)。
- Google：[生成接口](https://ai.google.dev/api/generate-content)、[模型目录](https://ai.google.dev/api/models)、[思考](https://ai.google.dev/gemini-api/docs/generate-content/thinking)、[缓存](https://ai.google.dev/gemini-api/docs/generate-content/caching)。
- Anthropic：[Messages 流](https://platform.claude.com/docs/en/build-with-claude/streaming)、[Models](https://platform.claude.com/docs/en/api/models/list)、[思考](https://platform.claude.com/docs/en/build-with-claude/thinking)、[缓存](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)。
- OpenRouter：[目录](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)、[思考参数](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)、[缓存与 session_id](https://openrouter.ai/docs/guides/best-practices/prompt-caching)。
- llama.cpp：[server 文档](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)、[请求 schema](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-schema.cpp)（reasoning_budget_tokens）。
