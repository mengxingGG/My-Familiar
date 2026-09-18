import type {
  ProviderDefinition,
  ProviderInput,
  ModelInfo,
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
const modelPath = (input: Pick<ProviderInput, "settings">) =>
  input.settings.baseUrl +
  "/models/" +
  encodeURIComponent(input.settings.model.replace(/^models\//, ""));
function prompt(input: ProviderInput) {
  return {
    systemInstruction: {
      parts: input.messages
        .filter((m) => m.role === "system")
        .map((m) => ({ text: m.content })),
    },
    contents: input.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts:
          m.role === "tool"
            ? [
                {
                  functionResponse: {
                    name: m.toolName,
                    response: { result: m.content },
                    ...(!m.toolCallId?.startsWith("gemini-")
                      ? { id: m.toolCallId }
                      : {}),
                  },
                },
              ]
            : m.native && m.native.scope === input.nativeScope
              ? m.native.items
              : [
                  ...(m.content ? [{ text: m.content }] : []),
                  ...(m.calls ?? []).map((c) => ({
                    functionCall: {
                      name: c.name,
                      args: JSON.parse(c.arguments),
                    },
                  })),
                ],
      })),
  };
}
export const geminiDefinition: ProviderDefinition = {
  id: "gemini",
  name: "Gemini 官方",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  requiresKey: true,
  options(c) {
    const v3 = /^gemini-[3-9]/.test(c.model),
      v25 = /^gemini-2\.5/.test(c.model);
    return {
      ...baseOptions,
      modes: v3
        ? ["auto", "effort"]
        : v25
          ? /pro/.test(c.model)
            ? ["auto", "budget"]
            : ["auto", "off", "budget"]
          : ["auto"],
      efforts: v3
        ? [
            /flash/.test(c.model) ? "minimal" : "low",
            "low",
            "medium",
            "high",
          ].filter((v, i, a) => a.indexOf(v) === i)
        : [],
      budgetMin: /pro/.test(c.model) ? 128 : 1,
      budgetMax: /pro/.test(c.model) ? 32768 : 24576,
      hint: v3
        ? "Gemini 3 系列使用 thinkingLevel，不支持完全关闭思考；具体可用级别由模型决定。"
        : "Gemini 2.5 使用 thinkingBudget；Pro 不能关闭思考。非思考模型使用自动。",
    };
  },
  async *stream(input) {
    const c = input.settings,
      parts: any[] = [];
    let done = false;
    const generationConfig = {
      maxOutputTokens: c.maxOutputTokens,
      ...(c.temperature !== null ? { temperature: c.temperature } : {}),
      ...(c.topP !== null ? { topP: c.topP } : {}),
      ...(c.thinking.mode === "effort"
        ? {
            thinkingConfig: {
              thinkingLevel: c.thinking.effort,
              includeThoughts: false,
            },
          }
        : c.thinking.mode === "budget" || c.thinking.mode === "off"
          ? {
              thinkingConfig: {
                thinkingBudget:
                  c.thinking.mode === "off" ? 0 : c.thinking.budgetTokens,
                includeThoughts: false,
              },
            }
          : {}),
    };
    for await (const event of sse(
      modelPath(input) + ":streamGenerateContent?alt=sse",
      {
        ...prompt(input),
        generationConfig,
        ...(input.tools?.length
          ? {
              tools: [
                {
                  functionDeclarations: input.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parametersJsonSchema: t.parameters,
                  })),
                },
              ],
            }
          : {}),
      },
      headers(input.key, "gemini"),
      input.signal,
    )) {
      const v = parseEvent(event.data);
      if (v.error) throw new Error("Gemini 生成失败");
      if (v.promptFeedback?.blockReason)
        throw new Error("Gemini 拦截了本次输入");
      const candidate = v.candidates?.[0];
      finishReason(candidate?.finishReason);
      for (const part of candidate?.content?.parts ?? []) {
        parts.push(part);
        if (typeof part.text === "string" && !part.thought) yield part.text;
      }
      if (v.usageMetadata)
        usage(input, {
          inputTokens: tokens(v.usageMetadata.promptTokenCount),
          outputTokens: tokens(
            (v.usageMetadata.candidatesTokenCount ?? 0) +
              (v.usageMetadata.thoughtsTokenCount ?? 0),
          ),
          cachedInputTokens: tokens(v.usageMetadata.cachedContentTokenCount),
        });
      if (candidate?.finishReason === "STOP") done = true;
      else if (candidate?.finishReason)
        throw new Error("Gemini 回复未正常结束");
    }
    if (!done) throw new Error("Gemini 连接提前结束，回复可能不完整");
    const calls = parts
      .filter((p) => p.functionCall)
      .map((p, i) => ({
        id: p.functionCall.id ?? `gemini-${i}-${Date.now()}`,
        name: p.functionCall.name,
        arguments: JSON.stringify(p.functionCall.args ?? {}),
      }));
    if (calls.length) {
      if (!input.tools?.length) throw new Error("模型意外返回工具请求");
      input.onTools?.(calls);
    }
    if (input.nativeScope)
      input.onNative?.({ scope: input.nativeScope, items: parts });
  },
  async models(input) {
    const result: ModelInfo[] = [];
    let page = "";
    const seen = new Set<string>();
    do {
      if (seen.has(page) || seen.size >= 100)
        throw new Error("模型列表分页异常");
      seen.add(page);
      const url = new URL(input.settings.baseUrl + "/models");
      url.searchParams.set("pageSize", "1000");
      if (page) url.searchParams.set("pageToken", page);
      const data = await jsonRequest(
        url.href,
        { headers: headers(input.key, "gemini") },
        input.signal,
      );
      if (!Array.isArray(data.models))
        throw new Error("Gemini 模型列表格式无效");
      for (const m of data.models) {
        if (
          typeof m.name === "string" &&
          m.supportedGenerationMethods?.includes("generateContent")
        )
          result.push({
            id: m.name.replace(/^models\//, ""),
            name: m.displayName ?? m.name,
            inputLimit: positive(m.inputTokenLimit),
            outputLimit: positive(m.outputTokenLimit),
          });
      }
      page = data.nextPageToken ?? "";
    } while (page);
    return result;
  },
  async countTokens(input) {
    const v = await jsonRequest(
      modelPath(input) + ":countTokens",
      {
        method: "POST",
        headers: headers(input.key, "gemini"),
        body: JSON.stringify({
          generateContentRequest: {
            model: "models/" + input.settings.model.replace(/^models\//, ""),
            ...prompt(input),
          },
        }),
      },
      input.signal,
    );
    if (tokens(v.totalTokens) === undefined) throw new Error("计数响应无效");
    return v.totalTokens;
  },
};
export const providerGemini = providerPlugin(geminiDefinition);
