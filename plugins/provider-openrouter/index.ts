import type { ProviderDefinition } from "../../packages/contracts/index.ts";
import { providerPlugin } from "../llm-shared/plugin.ts";
import { baseOptions, chatStream } from "../llm-shared/chat-completions.ts";
import { chatModels } from "../llm-shared/http.ts";
export const openrouterDefinition: ProviderDefinition = {
  id: "openrouter",
  name: "OpenRouter 官方",
  baseUrl: "https://openrouter.ai/api/v1",
  requiresKey: true,
  options(_c, m) {
    const parameters = m?.supportedParameters;
    return {
      ...baseOptions,
      modes:
        m?.thinking?.modes ??
        (parameters &&
        !parameters.includes("reasoning") &&
        !parameters.includes("reasoning_effort")
          ? ["auto"]
          : ["auto", "off", "effort", "budget"]),
      efforts: m?.thinking?.efforts ?? [
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ],
      temperature: !parameters || parameters.includes("temperature"),
      topP: !parameters || parameters.includes("top_p"),
      hint: "优先使用模型目录返回的参数能力；预算和强度最终取决于所选上游模型。",
    };
  },
  stream(input) {
    const c = input.settings;
    const reasoning =
      c.thinking.mode === "budget"
        ? { max_tokens: c.thinking.budgetTokens }
        : c.thinking.mode === "effort"
          ? { effort: c.thinking.effort }
          : c.thinking.mode === "off"
            ? { enabled: false }
            : {};
    const supportsReasoning =
      openrouterDefinition.options(c, input.modelInfo).modes.length > 1;
    return chatStream(input, {
      stream_options: { include_usage: true },
      ...(supportsReasoning
        ? { reasoning: { ...reasoning, exclude: true } }
        : {}),
      ...(c.cache
        ? {
            session_id: input.sessionKey,
            ...(/^~?anthropic\//.test(c.model)
              ? { cache_control: { type: "ephemeral" } }
              : {}),
          }
        : {}),
      provider: { require_parameters: true },
    });
  },
  models: chatModels,
};
export const providerOpenrouter = providerPlugin(openrouterDefinition);
