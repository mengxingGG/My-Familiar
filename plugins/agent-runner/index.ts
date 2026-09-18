import {
  definePlugin,
  type PromptMessage,
  type ToolCall,
  type NativeTurn,
} from "../../packages/contracts/index.ts";
export const agentRunner = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.agent-runner",
    version: "0.2.0",
    provides: ["agent.chat"],
    requires: ["llm.chat", "llm.management", "agent.tools", "skills.catalog"],
  },
  start(ctx) {
    const llm = ctx.use("llm.chat"),
      tools = ctx.use("agent.tools"),
      management = ctx.use("llm.management");
    ctx.provide("agent.chat", {
      async *stream(input) {
        const signal = AbortSignal.any([input.signal, ctx.abort.signal]);
        const messages = structuredClone(input.messages),
          trace: PromptMessage[] = [];
        const specs = tools.list();
        const toolOverhead = Buffer.byteLength(JSON.stringify(specs));
        const denied = new Set<string>();
        let total = 0;
        for (let round = 0; round < 8; round++) {
          signal.throwIfAborted();
          const plan = await management.plan(input.settings, signal),
            count = await management.count({ ...input, messages, signal });
          if (count.tokens + toolOverhead > plan.inputBudget)
            throw new Error(
              "工具与上下文已接近窗口上限，请开始新会话或提高已确认的窗口预算",
            );
          let calls: ToolCall[] = [],
            native: NativeTurn | undefined,
            text = "";
          ctx.emit("agent.activity", round ? "正在整理结果…" : "正在回复…");
          for await (const delta of llm.stream({
            ...input,
            messages,
            tools: specs,
            signal,
            onTools: (v) => {
              calls = v;
            },
            onNative: (v) => {
              native = v;
            },
          })) {
            text += delta;
            total += delta.length;
            if (total > 256000) throw new Error("回复长度超限");
            yield delta;
          }
          const answer: PromptMessage = {
            role: "assistant",
            content: text,
            ...(native ? { native } : {}),
            ...(calls.length ? { calls } : {}),
          };
          trace.push(answer);
          messages.push(answer);
          input.onTrace?.(trace);
          if (!calls.length) {
            if (native) input.onNative?.(native);
            return;
          }
          if (calls.length > 16) throw new Error("单轮工具请求过多");
          if (text) yield "\n";
          for (const call of calls) {
            signal.throwIfAborted();
            let result: string;
            try {
              if (denied.has(call.name))
                throw new Error("此工具本轮已被拒绝，不再请求确认");
              result = await tools.run(call, signal);
            } catch (e) {
              if (signal.aborted) throw e;
              const message = e instanceof Error ? e.message : "工具失败";
              if (message.includes("拒绝") || message.includes("超时"))
                denied.add(call.name);
              result = JSON.stringify({ error: message });
            }
            const response: PromptMessage = {
              role: "tool",
              toolCallId: call.id,
              toolName: call.name,
              content: result,
            };
            messages.push(response);
            trace.push(response);
            input.onTrace?.(trace);
          }
        }
        throw new Error("本轮已达到 8 次工具往返上限，已停止；可以继续发消息");
      },
    });
  },
});
