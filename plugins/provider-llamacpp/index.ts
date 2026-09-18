import type { ProviderDefinition } from "../../packages/contracts/index.ts";
import { providerPlugin } from "../llm-shared/plugin.ts";
import { baseOptions, chatStream } from "../llm-shared/chat-completions.ts";
import {
  chatModels,
  headers,
  jsonRequest,
  positive,
} from "../llm-shared/http.ts";
export const llamacppDefinition: ProviderDefinition = {
  id: "llamacpp",
  name: "本地 llama.cpp",
  baseUrl: "http://127.0.0.1:8080/v1",
  requiresKey: false,
  options: () => ({
    ...baseOptions,
    modes: ["auto", "off", "effort", "budget"],
    efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
    hint: "连接已启动的 llama-server；思考控制依赖服务版本及模型聊天模板。这里不会自动下载或加载 GGUF。",
  }),
  stream(input) {
    const c = input.settings;
    return chatStream(input, {
      cache_prompt: c.cache,
      stream_options: { include_usage: true },
      ...(c.thinking.mode === "budget"
        ? { reasoning_budget_tokens: c.thinking.budgetTokens }
        : c.thinking.mode === "off"
          ? {
              reasoning_budget_tokens: 0,
              chat_template_kwargs: { enable_thinking: false },
            }
          : c.thinking.mode === "effort"
            ? { reasoning_effort: c.thinking.effort }
            : {}),
    });
  },
  async models(input) {
    const models = await chatModels(input);
    try {
      const props = await jsonRequest(
        input.settings.baseUrl.replace(/\/v1$/, "") + "/props",
        { headers: headers(input.key) },
        input.signal,
      );
      const n = positive(props.default_generation_settings?.n_ctx);
      if (n && models.length === 1) models[0].contextWindow = n;
    } catch {
      /* 旧服务或反向代理可不暴露 props，模型列表仍可使用。 */
    }
    return models;
  },
  async countTokens(input) {
    if (input.settings.thinking.mode !== "auto")
      throw new Error("自定义思考模板使用保守估算");
    const base = input.settings.baseUrl.replace(/\/v1$/, ""),
      auth = headers(input.key);
    const formatted = await jsonRequest(
      base + "/apply-template",
      {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          model: input.settings.model,
          messages: input.messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      },
      input.signal,
    );
    if (typeof formatted.prompt !== "string")
      throw new Error("聊天模板响应无效");
    const result = await jsonRequest(
      base + "/tokenize",
      {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          model: input.settings.model,
          content: formatted.prompt,
          add_special: false,
          parse_special: true,
        }),
      },
      input.signal,
    );
    if (!Array.isArray(result.tokens)) throw new Error("分词响应无效");
    return result.tokens.length;
  },
};
export const providerLlamacpp = providerPlugin(llamacppDefinition);
