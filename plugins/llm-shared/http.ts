import type {
  ProviderInput,
  Usage,
  ModelInfo,
} from "../../packages/contracts/index.ts";
export const positive = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
export const tokens = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.floor(v)
    : undefined;
export function usage(input: ProviderInput, value: Usage) {
  input.onUsage?.(
    Object.fromEntries(
      Object.entries(value).filter(([, v]) => v !== undefined),
    ),
  );
}
export function headers(key: string, kind = "bearer"): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(kind === "claude"
      ? { "anthropic-version": "2023-06-01", "x-api-key": key }
      : kind === "gemini"
        ? { "x-goog-api-key": key }
        : key
          ? { Authorization: `Bearer ${key}` }
          : {}),
  };
}
export async function request(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal, redirect: "error" });
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new Error("无法连接模型服务，请检查网络、服务地址及本地服务是否启动");
  }
  if (!response.ok) {
    await response.body?.cancel();
    const descriptions: Record<number, string> = {
      400: "模型拒绝请求，请检查模型名称、思考模式和参数范围",
      401: "模型鉴权失败，请检查 API Key",
      402: "模型账户余额不足",
      403: "没有访问该模型的权限",
      404: "模型或接口不存在，请检查模型 ID 与基础地址",
      413: "上下文过长，请降低上下文上限或清空会话",
      429: "模型请求受限，请稍后重试",
      503: "模型服务暂不可用或本地模型尚未加载",
    };
    throw new Error(
      `${descriptions[response.status] ?? "模型服务返回错误"}（${response.status}）`,
    );
  }
  return response;
}
export async function jsonRequest(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<any> {
  const response = await request(url, init, signal);
  if (!response.body) throw new Error("模型服务返回空响应");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8 * 1024 * 1024) throw new Error("模型服务响应过大");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("模型服务返回了无效 JSON");
  }
}
export async function* sse(
  url: string,
  body: unknown,
  auth: Record<string, string>,
  signal: AbortSignal,
): AsyncGenerator<{ event: string; data: string }> {
  const response = await request(
    url,
    { method: "POST", headers: auth, body: JSON.stringify(body) },
    signal,
  );
  if (
    !response.body ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  ) {
    await response.body?.cancel();
    throw new Error("模型服务没有返回 SSE 流式响应");
  }
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 2 * 1024 * 1024) throw new Error("模型事件过大");
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          if (line.startsWith("data:"))
            data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length) yield { event, data: data.join("\n") };
      }
    }
    if (buffer.trim()) throw new Error("模型连接提前结束，事件不完整");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function parseEvent(data: string): any {
  try {
    const v = JSON.parse(data);
    if (!v || typeof v !== "object") throw Error();
    return v;
  } catch {
    throw new Error("模型返回了无效流式数据");
  }
}
export function finishReason(reason: unknown, allowTools = false) {
  if (reason === "length" || reason === "max_tokens" || reason === "MAX_TOKENS")
    throw new Error(
      "回复达到输出上限，内容可能不完整；可提高输出上限或降低思考预算",
    );
  if (
    [
      "content_filter",
      "SAFETY",
      "RECITATION",
      "BLOCKLIST",
      "PROHIBITED_CONTENT",
      "SPII",
    ].includes(String(reason))
  )
    throw new Error("模型服务拦截了本次回复");
  if (!allowTools && ["tool_calls", "function_call", "tool_use"].includes(String(reason)))
    throw new Error("模型返回了工具请求，当前仅支持文字回复");
}
export async function chatModels(
  input: Pick<ProviderInput, "settings" | "signal" | "key">,
): Promise<ModelInfo[]> {
  const body = await jsonRequest(
    input.settings.baseUrl + "/models",
    { headers: headers(input.key) },
    input.signal,
  );
  if (!Array.isArray(body.data))
    throw new Error("模型列表格式无效，可手动填写模型 ID");
  return body.data
    .filter((m: any) => typeof m.id === "string")
    .map((m: any) => ({
      id: m.id,
      name: m.name ?? m.id,
      contextWindow: positive(m.context_length),
      outputLimit: positive(m.top_provider?.max_completion_tokens),
      supportedParameters: Array.isArray(m.supported_parameters)
        ? m.supported_parameters
        : undefined,
      ...(m.reasoning
        ? {
            thinking: {
              modes: [
                "auto",
                ...(!m.reasoning.mandatory ? ["off"] : []),
                ...(m.reasoning.supported_efforts !== undefined
                  ? ["effort"]
                  : []),
                ...(m.reasoning.supports_max_tokens ? ["budget"] : []),
              ],
              efforts: m.reasoning.supported_efforts ?? undefined,
              mandatory: !!m.reasoning.mandatory,
            },
          }
        : {}),
    }));
}
