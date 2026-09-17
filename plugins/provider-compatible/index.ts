import { definePlugin, type Settings } from "../../packages/contracts/index.ts";
export async function* streamChat(input: {
  settings: Settings["provider"];
  messages: { role: string; content: string }[];
  signal: AbortSignal;
  key: string;
  timeoutMs?: number;
}): AsyncGenerator<string> {
  if (!input.settings.model) throw new Error("请先在控制器中填写模型名称");
  const signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(input.timeoutMs ?? 90000),
  ]);
  let response: Response;
  try {
    response = await fetch(
      input.settings.baseUrl.replace(/\/$/, "") + "/chat/completions",
      {
        method: "POST",
        signal,
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          ...(input.key ? { Authorization: `Bearer ${input.key}` } : {}),
        },
        body: JSON.stringify({
          model: input.settings.model,
          messages: input.messages,
          stream: true,
          temperature: input.settings.temperature,
        }),
      },
    );
  } catch (e) {
    if (signal.aborted) throw signal.reason;
    throw new Error("无法连接模型服务，请检查服务是否启动及 Base URL");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      response.status === 401
        ? "模型鉴权失败，请检查 API Key（401）"
        : response.status === 429
          ? "模型请求受限，请稍后手动重试（429）"
          : `模型服务返回错误（${response.status}）`,
    );
  }
  if (!response.body) throw new Error("模型返回空响应");
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    await response.body.cancel();
    throw new Error("模型服务没有返回 SSE 流式响应，请检查接口兼容性");
  }
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    total = 0,
    done = false;
  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("模型连接提前结束，回复可能不完整");
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 1024 * 1024) throw new Error("模型事件过大");
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        if (data.trim() === "[DONE]") {
          done = true;
          break;
        }
        let value: any;
        try {
          value = JSON.parse(data);
        } catch {
          throw new Error("模型返回了无效流式数据");
        }
        if (value.error) throw new Error("模型服务报告生成失败");
        const text = value.choices?.[0]?.delta?.content;
        if (typeof text === "string") {
          total += text.length;
          if (total > 64000) throw new Error("回复超过长度上限");
          yield text;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export const providerCompatible = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.provider-compatible",
    version: "0.1.0",
    provides: ["llm.chat"],
    requires: ["settings", "secrets.local"],
    permissions: ["network.model"],
  },
  start(ctx) {
    ctx.require("network.model");
    const config = ctx.use("settings"),
      secrets = ctx.use("secrets.local");
    ctx.provide("llm.chat", {
      stream(input) {
        return streamChat({
          ...input,
          key: secrets.get(),
          signal: AbortSignal.any([input.signal, ctx.abort.signal]),
        });
      },
      async test() {
        let text = "";
        for await (const chunk of streamChat({
          settings: config.get().provider,
          messages: [{ role: "user", content: "请只回复：连接成功" }],
          key: secrets.get(),
          signal: ctx.abort.signal,
          timeoutMs: 20000,
        }))
          text += chunk;
        if (!text.trim()) throw new Error("连接成功，但模型没有返回文字");
        return "连接成功，模型已返回文字";
      },
    });
  },
});
