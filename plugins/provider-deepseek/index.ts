import type { ProviderDefinition } from "../../packages/contracts/index.ts";
import { providerPlugin } from "../llm-shared/plugin.ts";
import { baseOptions, chatStream } from "../llm-shared/chat-completions.ts";
import { chatModels } from "../llm-shared/http.ts";
export const deepseekDefinition: ProviderDefinition = {
  id: "deepseek",
  name: "DeepSeek 官方",
  baseUrl: "https://api.deepseek.com",
  requiresKey: true,
  options(c) {
    const thinking = c.thinking.mode !== "off" && c.model !== "deepseek-chat";
    return {
      ...baseOptions,
      modes: ["auto", "off", "effort"],
      efforts: ["low", "high", "max"],
      temperature: !thinking,
      topP: thinking,
      topPMin: 0.95,
      hint: "DeepSeek 思考模式使用强度，不支持 token 思考预算；思考时温度不生效，Top P 最低 0.95。",
    };
  },
  stream: (input) =>
    chatStream(input, {
      stream_options: { include_usage: true },
      ...(input.settings.thinking.mode === "off"
        ? { thinking: { type: "disabled" } }
        : input.settings.thinking.mode === "effort"
          ? {
              thinking: { type: "enabled" },
              reasoning_effort: input.settings.thinking.effort,
            }
          : {}),
    }),
  models: chatModels,
};
export const providerDeepseek = providerPlugin(deepseekDefinition);
