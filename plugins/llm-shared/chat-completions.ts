import type {
  ParameterSupport,
  ProviderInput,
} from "../../packages/contracts/index.ts";
import {
  finishReason,
  headers,
  parseEvent,
  sse,
  tokens,
  usage,
} from "./http.ts";
import { visibleText } from "./visible-text.ts";
export const baseOptions: ParameterSupport = {
  modes: ["auto"],
  efforts: [],
  temperature: true,
  temperatureMax: 2,
  topP: true,
  topPMin: 0,
  budgetMin: 1,
  hint: "自动表示不发送思考参数，由模型服务决定。",
};
export async function* chatStream(
  input: ProviderInput,
  extra: Record<string, unknown> = {},
): AsyncGenerator<string> {
  const c = input.settings;
  const body = {
    model: c.model,
    messages: input.messages.map((m) =>
      m.role === "tool"
        ? { role: "tool", content: m.content, tool_call_id: m.toolCallId }
        : m.native?.scope === input.nativeScope && m.native
          ? m.native.items[0]
          : {
              role: m.role,
              content: m.content,
              ...(m.calls?.length
                ? {
                    tool_calls: m.calls.map((c) => ({
                      id: c.id,
                      type: "function",
                      function: { name: c.name, arguments: c.arguments },
                    })),
                  }
                : {}),
            },
    ),
    stream: true,
    ...(c.temperature !== null ? { temperature: c.temperature } : {}),
    ...(c.topP !== null ? { top_p: c.topP } : {}),
    max_tokens: c.maxOutputTokens,
    ...(input.tools?.length
      ? {
          tools: input.tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          })),
        }
      : {}),
    ...extra,
  };
  let done = false;
  const visible = visibleText();
  let content = "",
    reasoning = "";
  const calls = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  const reasoningDetails: unknown[] = [];
  for await (const event of sse(
    c.baseUrl + "/chat/completions",
    body,
    headers(input.key),
    input.signal,
  )) {
    if (event.data.trim() === "[DONE]") {
      done = true;
      break;
    }
    const value = parseEvent(event.data);
    if (value.error) throw new Error("模型服务报告生成失败");
    if (value.usage)
      usage(input, {
        inputTokens: tokens(value.usage.prompt_tokens),
        outputTokens: tokens(value.usage.completion_tokens),
        cachedInputTokens: tokens(
          value.usage.prompt_cache_hit_tokens ??
            value.usage.prompt_tokens_details?.cached_tokens,
        ),
        cacheWriteTokens: tokens(
          value.usage.prompt_tokens_details?.cache_write_tokens,
        ),
      });
    const choice = value.choices?.[0];
    finishReason(choice?.finish_reason, !!input.tools?.length);
    const delta = choice?.delta;
    if (typeof delta?.reasoning_content === "string")
      reasoning += delta.reasoning_content;
    if (Array.isArray(delta?.reasoning_details))
      reasoningDetails.push(...delta.reasoning_details);
    for (const call of delta?.tool_calls ?? []) {
      if (!Number.isInteger(call.index) || call.index < 0 || call.index >= 16)
        throw new Error("工具调用数量无效");
      const v = calls.get(call.index) ?? { id: "", name: "", arguments: "" };
      if (call.id) v.id = call.id;
      if (call.function?.name) v.name += call.function.name;
      if (call.function?.arguments) v.arguments += call.function.arguments;
      if (v.arguments.length > 65536) throw new Error("工具参数过大");
      calls.set(call.index, v);
    }
    if (typeof choice?.delta?.content === "string") {
      content += choice.delta.content;
      const text = visible.push(choice.delta.content);
      if (text) yield text;
    }
  }
  if (!done) throw new Error("模型连接提前结束，回复可能不完整");
  const tail = visible.finish();
  if (tail) yield tail;
  const list = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => c);
  if (list.length) {
    if (!input.tools?.length) throw new Error("模型意外返回工具请求");
    input.onTools?.(list);
  }
  if (input.nativeScope)
    input.onNative?.({
      scope: input.nativeScope,
      items: [
        {
          role: "assistant",
          content: content || null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(reasoningDetails.length
            ? { reasoning_details: reasoningDetails }
            : {}),
          ...(list.length
            ? {
                tool_calls: list.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : {}),
        },
      ],
    });
}
