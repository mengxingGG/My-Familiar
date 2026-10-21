import {
  definePlugin,
  type PromptMessage,
  type ToolCall,
  type NativeTurn,
} from "../../packages/contracts/index.ts";
import { randomUUID } from "node:crypto";
import { compactToolHistory } from "./tool-context.ts";
export const agentRunner = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.agent-runner",
    version: "0.2.0",
    provides: ["agent.chat"],
    requires: ["llm.chat", "llm.management", "agent.tools", "skills.catalog", "context.compaction"],
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
        const denied = new Set<string>();
        const archive = ctx.use("context.compaction").archiveTools;
        const archiveSession = input.archiveSession ?? input.permissionSession ?? input.sessionKey ?? randomUUID();
        const archiveCache = new WeakMap();
        let total = 0;
        // 由模型完成回复或用户取消结束，不按工具轮数截断正常任务。
        for (let round = 0; ; round++) {
          signal.throwIfAborted();
          let specs = tools.list();
          let toolOverhead = Buffer.byteLength(JSON.stringify(specs));
          const plan = await management.plan(input.settings, signal);
          let requestMessages = messages;
          let count = await management.count({ ...input, messages: requestMessages, signal });
          if (count.tokens + toolOverhead > plan.inputBudget && tools.compactResults) {
            requestMessages = tools.compactResults(messages);
            count = await management.count({ ...input, messages: requestMessages, signal });
          }
          if (count.tokens + toolOverhead > plan.inputBudget && tools.compactList) {
            specs = tools.compactList();
            toolOverhead = Buffer.byteLength(JSON.stringify(specs));
          }
          if (count.tokens + toolOverhead > plan.inputBudget && archive) {
            requestMessages = await compactToolHistory(requestMessages, messages, {
              cache: archiveCache, signal,
              archive: parts => archive({ sessionId: archiveSession, messages: parts, signal }),
              async fits(parts) {
                count = await management.count({ ...input, messages: parts, signal });
                return count.tokens + toolOverhead <= plan.inputBudget;
              },
            });
          }
          if (count.tokens + toolOverhead > plan.inputBudget)
            throw new Error(
              `工具与上下文已接近窗口上限（预算估算 ${count.tokens + toolOverhead} / ${plan.inputBudget}），请开始新会话或提高已确认的窗口预算`,
            );
          let calls: ToolCall[] = [],
            native: NativeTurn | undefined,
            text = "";
          if (!input.silent)
            ctx.emit("agent.activity", round ? "正在整理结果…" : "正在回复…");
          for await (const delta of llm.stream({
            ...input,
            messages: requestMessages,
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
          if (text) yield "\n";
          for (const call of calls) {
            signal.throwIfAborted();
            const denialKey = tools.denialKey?.(call) ?? call.name;
            let result: string;
            let attachments:
              | import("../../packages/contracts/media.ts").Attachment[]
              | undefined;
            try {
              if (denied.has(denialKey))
                throw new Error("此工具本轮已被拒绝，不再请求确认");
              const options = {
                silent: input.silent,
                session: input.permissionSession,
                label: input.permissionLabel,
              };
              if (tools.runRich) {
                const rich = await tools.runRich(call, signal, options);
                result = rich.text;
                attachments = rich.attachments;
              } else result = await tools.run(call, signal, options);
            } catch (e) {
              if (signal.aborted) throw e;
              const message = e instanceof Error ? e.message : "工具失败";
              if (message.includes("拒绝") || message.includes("超时"))
                denied.add(denialKey);
              result = JSON.stringify({ error: message });
            }
            const response: PromptMessage = {
              role: "tool",
              toolCallId: call.id,
              toolName: call.name,
              content: result,
              ...(attachments?.length ? { attachments } : {}),
            };
            messages.push(response);
            trace.push(response);
            input.onTrace?.(trace);
          }
        }
      },
    });
  },
});
