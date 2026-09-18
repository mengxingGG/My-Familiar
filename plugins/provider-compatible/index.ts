import {
  profileDefaults,
  type ProviderInput,
} from "../../packages/contracts/index.ts";
import { providerPlugin } from "../llm-shared/plugin.ts";
import { baseOptions, chatStream } from "../llm-shared/chat-completions.ts";
import { chatModels } from "../llm-shared/http.ts";
export const compatibleDefinition = {
  id: "compatible",
  name: "OpenAI 兼容",
  baseUrl: "http://127.0.0.1:1234/v1",
  requiresKey: false,
  options: () => ({
    ...baseOptions,
    modes: ["auto", "off", "effort"] as const as ("auto" | "off" | "effort")[],
    efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
    hint: "思考强度依赖兼容服务是否实现 reasoning_effort；不确定时使用自动。",
  }),
  stream: (input: ProviderInput) =>
    chatStream(
      input,
      input.settings.thinking.mode === "auto"
        ? {}
        : {
            reasoning_effort:
              input.settings.thinking.mode === "off"
                ? "none"
                : input.settings.thinking.effort,
          },
    ),
  models: chatModels,
};
export const providerCompatible = providerPlugin(compatibleDefinition);
// 保持旧测试与兼容适配器入口；产品调用由 llm-router 统一管理。
export function streamChat(
  input: Omit<ProviderInput, "settings"> & {
    settings: ProviderInput["settings"];
    timeoutMs?: number;
  },
) {
  return compatibleDefinition.stream({
    ...input,
    settings: { ...profileDefaults, ...input.settings },
    signal: AbortSignal.any([
      input.signal,
      AbortSignal.timeout(input.timeoutMs ?? 180000),
    ]),
  });
}
