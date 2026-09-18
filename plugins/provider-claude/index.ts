import type {
  ProviderDefinition,
  ProviderInput,
  ModelInfo,
  ThinkingMode,
} from "../../packages/contracts/index.ts";
import { providerPlugin } from "../llm-shared/plugin.ts";
import { baseOptions } from "../llm-shared/chat-completions.ts";
import {
  headers,
  jsonRequest,
  positive,
  parseEvent,
  sse,
  tokens,
  usage,
  finishReason,
} from "../llm-shared/http.ts";
function prompt(input: ProviderInput) {
  return {
    model: input.settings.model,
    system: input.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n"),
    messages: input.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "tool" ? "user" : m.role,
        content:
          m.role === "tool"
            ? [
                {
                  type: "tool_result",
                  tool_use_id: m.toolCallId,
                  content: m.content,
                },
              ]
            : m.native && m.native.scope === input.nativeScope
              ? m.native.items
              : [
                  ...(m.content ? [{ type: "text", text: m.content }] : []),
                  ...(m.calls ?? []).map((c) => ({
                    type: "tool_use",
                    id: c.id,
                    name: c.name,
                    input: JSON.parse(c.arguments),
                  })),
                ],
      })),
  };
}
export const claudeDefinition: ProviderDefinition = {
  id: "claude",
  name: "Claude 官方",
  baseUrl: "https://api.anthropic.com/v1",
  requiresKey: true,
  options(c, m) {
    const adaptive =
      /claude-(?:(?:opus|sonnet)-4-[6-9]|(?:opus|sonnet|fable|mythos)-[5-9]|mythos)/.test(
        c.model,
      );
    const modes: ThinkingMode[] =
      m?.thinking?.modes ??
      (adaptive ? ["auto", "adaptive"] : ["auto", "off", "budget"]);
    const thinking =
      c.thinking.mode === "budget" ||
      c.thinking.mode === "adaptive" ||
      (c.thinking.mode === "auto" && adaptive);
    return {
      ...baseOptions,
      modes,
      efforts: m?.thinking?.efforts ?? [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ],
      temperature: !thinking,
      temperatureMax: 1,
      topP: !thinking,
      budgetMin: 1024,
      hint: adaptive
        ? "优先使用模型目录中的能力；自适应思考使用 effort，不设置独立 token 预算。"
        : "手动思考预算至少 1024，且必须小于输出上限；启用思考时不发送温度和 Top P。",
    };
  },
  async *stream(input) {
    const c = input.settings,
      blocks: any[] = [];
    let done = false;
    const thinking =
      c.thinking.mode === "budget"
        ? { type: "enabled", budget_tokens: c.thinking.budgetTokens }
        : c.thinking.mode === "adaptive"
          ? { type: "adaptive" }
          : c.thinking.mode === "off"
            ? { type: "disabled" }
            : undefined;
    const body = {
      ...prompt(input),
      max_tokens: c.maxOutputTokens,
      stream: true,
      ...(input.tools?.length
        ? {
            tools: input.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          }
        : {}),
      ...(thinking ? { thinking } : {}),
      ...(c.thinking.mode === "adaptive"
        ? { output_config: { effort: c.thinking.effort } }
        : {}),
      ...(c.temperature !== null ? { temperature: c.temperature } : {}),
      ...(c.topP !== null ? { top_p: c.topP } : {}),
      ...(c.cache ? { cache_control: { type: "ephemeral" } } : {}),
    };
    for await (const event of sse(
      c.baseUrl + "/messages",
      body,
      headers(input.key, "claude"),
      input.signal,
    )) {
      const v = parseEvent(event.data);
      if (v.type === "error") throw new Error("Claude 生成失败，请稍后重试");
      if (v.type === "message_start" && v.message?.usage) {
        const u = v.message.usage;
        usage(input, {
          inputTokens:
            (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0),
          cachedInputTokens: tokens(u.cache_read_input_tokens),
          cacheWriteTokens: tokens(u.cache_creation_input_tokens),
        });
      }
      if (v.type === "content_block_start" && Number.isInteger(v.index)) {
        blocks[v.index] = { ...v.content_block };
        if (v.content_block?.type === "text" && v.content_block.text)
          yield v.content_block.text;
      }
      if (v.type === "content_block_delta") {
        const d = v.delta,
          b = blocks[v.index];
        if (d?.type === "text_delta" && typeof d.text === "string") {
          if (b) b.text = (b.text ?? "") + d.text;
          yield d.text;
        } else if (d?.type === "thinking_delta" && b)
          b.thinking = (b.thinking ?? "") + (d.thinking ?? "");
        else if (d?.type === "signature_delta" && b)
          b.signature = (b.signature ?? "") + (d.signature ?? "");
        else if (d?.type === "input_json_delta" && b) {
          b.partial = (b.partial ?? "") + (d.partial_json ?? "");
          if (b.partial.length > 65536) throw new Error("工具参数过大");
        }
      }
      if (v.type === "message_delta") {
        finishReason(v.delta?.stop_reason, !!input.tools?.length);
        if (v.usage)
          usage(input, { outputTokens: tokens(v.usage.output_tokens) });
      }
      if (v.type === "message_stop") {
        done = true;
        break;
      }
    }
    if (!done) throw new Error("Claude 连接提前结束，回复可能不完整");
    for (const b of blocks) {
      if (b?.type === "tool_use" && b.partial !== undefined) {
        b.input = JSON.parse(b.partial);
        delete b.partial;
      }
    }
    const calls = blocks
      .filter((b) => b?.type === "tool_use")
      .map((b) => ({
        id: b.id,
        name: b.name,
        arguments: JSON.stringify(b.input),
      }));
    if (calls.length) {
      if (!input.tools?.length) throw new Error("模型意外返回工具请求");
      input.onTools?.(calls);
    }
    if (input.nativeScope)
      input.onNative?.({
        scope: input.nativeScope,
        items: blocks.filter(
          (b) =>
            b &&
            ["text", "thinking", "redacted_thinking", "tool_use"].includes(
              b.type,
            ),
        ),
      });
  },
  async models(input) {
    const result: ModelInfo[] = [];
    let after = "";
    const seen = new Set<string>();
    do {
      if (seen.has(after) || seen.size >= 100)
        throw new Error("模型列表分页异常");
      seen.add(after);
      const url = new URL(input.settings.baseUrl + "/models");
      url.searchParams.set("limit", "1000");
      if (after) url.searchParams.set("after_id", after);
      const data = await jsonRequest(
        url.href,
        { headers: headers(input.key, "claude") },
        input.signal,
      );
      if (!Array.isArray(data.data)) throw new Error("Claude 模型列表格式无效");
      for (const m of data.data) {
        if (typeof m.id !== "string") continue;
        const t = m.capabilities?.thinking,
          e = m.capabilities?.effort;
        const modes: ThinkingMode[] = ["auto"];
        if (t?.supported) {
          if (t.types?.disabled?.supported) modes.push("off");
          if (t.types?.enabled?.supported) modes.push("budget");
          if (t.types?.adaptive?.supported) modes.push("adaptive");
        }
        result.push({
          id: m.id,
          name: m.display_name ?? m.id,
          contextWindow: positive(m.max_input_tokens),
          outputLimit: positive(m.max_tokens),
          ...(t
            ? {
                thinking: {
                  modes,
                  efforts: e
                    ? Object.keys(e).filter(
                        (k) => k !== "supported" && e[k]?.supported,
                      )
                    : undefined,
                },
              }
            : {}),
        });
      }
      if (data.has_more && !data.last_id)
        throw new Error("模型列表缺少分页游标");
      after = data.has_more ? data.last_id : "";
    } while (after);
    return result;
  },
  async countTokens(input) {
    const v = await jsonRequest(
      input.settings.baseUrl + "/messages/count_tokens",
      {
        method: "POST",
        headers: headers(input.key, "claude"),
        body: JSON.stringify(prompt(input)),
      },
      input.signal,
    );
    if (tokens(v.input_tokens) === undefined) throw new Error("计数响应无效");
    return v.input_tokens;
  },
};
export const providerClaude = providerPlugin(claudeDefinition);
