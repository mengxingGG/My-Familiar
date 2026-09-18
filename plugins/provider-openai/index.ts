import type {
  ProviderDefinition,
  ProviderInput,
} from "../../packages/contracts/index.ts";
import { providerPlugin } from "../llm-shared/plugin.ts";
import { baseOptions } from "../llm-shared/chat-completions.ts";
import {
  chatModels,
  headers,
  jsonRequest,
  parseEvent,
  sse,
  tokens,
  usage,
} from "../llm-shared/http.ts";
function prompt(input: ProviderInput) {
  return {
    model: input.settings.model,
    input: input.messages.flatMap((m): any[] =>
      m.role === "tool"
        ? [
            {
              type: "function_call_output",
              call_id: m.toolCallId,
              output: m.content,
            },
          ]
        : m.native && m.native.scope === input.nativeScope
          ? m.native.items
          : [
              ...(m.content ? [{ role: m.role, content: m.content }] : []),
              ...(m.calls ?? []).map((c) => ({
                type: "function_call",
                call_id: c.id,
                name: c.name,
                arguments: c.arguments,
              })),
            ],
    ),
  };
}
export const openaiDefinition: ProviderDefinition = {
  id: "openai",
  name: "OpenAI 官方 · Responses",
  baseUrl: "https://api.openai.com/v1",
  requiresKey: true,
  options(c) {
    const reasoning = /^(o[134](?:-|$)|gpt-[5-9])/.test(c.model);
    const oldO = /^o[134](?:-|$)/.test(c.model);
    return {
      ...baseOptions,
      modes: reasoning
        ? oldO
          ? ["auto", "effort"]
          : ["auto", "off", "effort"]
        : ["auto"],
      efforts: oldO
        ? ["low", "medium", "high"]
        : ["minimal", "low", "medium", "high", "xhigh", "max"],
      temperature: !reasoning,
      topP: !reasoning,
      hint: reasoning
        ? "推理模型使用 effort，官方未提供独立 token 思考预算；不同模型接受的 effort 级别可能不同。温度和 Top P 保持服务默认。"
        : "Responses 原生接口；不支持推理参数的模型只发送采样设置。",
    };
  },
  async *stream(input) {
    const c = input.settings;
    let done = false;
    const body = {
      ...prompt(input),
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: c.maxOutputTokens,
      ...(input.tools?.length
        ? {
            tools: input.tools.map((t) => ({
              type: "function",
              name: t.name,
              description: t.description,
              parameters: t.parameters,
              strict: false,
            })),
          }
        : {}),
      ...(c.temperature !== null ? { temperature: c.temperature } : {}),
      ...(c.topP !== null ? { top_p: c.topP } : {}),
      ...(c.thinking.mode !== "auto"
        ? {
            reasoning: {
              effort: c.thinking.mode === "off" ? "none" : c.thinking.effort,
            },
          }
        : {}),
      ...(c.cache && input.sessionKey
        ? { prompt_cache_key: input.sessionKey }
        : {}),
    };
    for await (const event of sse(
      c.baseUrl + "/responses",
      body,
      headers(input.key),
      input.signal,
    )) {
      const v = parseEvent(event.data);
      if (
        v.type === "response.output_text.delta" ||
        v.type === "response.refusal.delta"
      ) {
        if (typeof v.delta === "string") yield v.delta;
      }
      if (["error", "response.failed", "response.incomplete"].includes(v.type))
        throw new Error(
          v.type === "response.incomplete"
            ? "回复达到上限或未完整完成，请调整输出/思考设置"
            : "OpenAI 生成失败",
        );
      if (v.type === "response.completed") {
        done = true;
        const u = v.response?.usage;
        if (u)
          usage(input, {
            inputTokens: tokens(u.input_tokens),
            outputTokens: tokens(u.output_tokens),
            cachedInputTokens: tokens(u.input_tokens_details?.cached_tokens),
            cacheWriteTokens: tokens(
              u.input_tokens_details?.cache_write_tokens,
            ),
          });
        const items = v.response?.output?.filter((i: any) =>
          ["message", "reasoning", "function_call"].includes(i.type),
        );
        const calls = (items ?? [])
          .filter((i: any) => i.type === "function_call")
          .map((i: any) => ({
            id: i.call_id,
            name: i.name,
            arguments: i.arguments,
          }));
        if (calls.length) {
          if (!input.tools?.length) throw new Error("模型意外返回工具请求");
          input.onTools?.(calls);
        }
        if (Array.isArray(items) && input.nativeScope)
          input.onNative?.({ scope: input.nativeScope, items });
        break;
      }
    }
    if (!done) throw new Error("OpenAI 连接提前结束，回复可能不完整");
  },
  models: chatModels,
  async countTokens(input) {
    const v = await jsonRequest(
      input.settings.baseUrl + "/responses/input_tokens",
      {
        method: "POST",
        headers: headers(input.key),
        body: JSON.stringify(prompt(input)),
      },
      input.signal,
    );
    if (tokens(v.input_tokens) === undefined) throw new Error("计数响应无效");
    return v.input_tokens;
  },
};
export const providerOpenai = providerPlugin(openaiDefinition);
