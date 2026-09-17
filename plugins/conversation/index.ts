import { randomUUID } from "node:crypto";
import {
  definePlugin,
  type Message,
  type ChatState,
} from "../../packages/contracts/index.ts";
export const conversation = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.conversation",
    version: "0.1.0",
    provides: ["conversation"],
    requires: ["llm.chat", "settings", "storage.local"],
  },
  async start(ctx) {
    const provider = ctx.use("llm.chat"),
      settings = ctx.use("settings"),
      storage = ctx.use("storage.local");
    const saved = await storage.read<Message[]>("conversation", []);
    if (
      !Array.isArray(saved) ||
      saved.some(
        (m) =>
          !m ||
          !["user", "assistant"].includes(m.role) ||
          typeof m.text !== "string" ||
          m.text.length > 64000,
      )
    )
      throw new Error("聊天记录损坏");
    let messages: Message[] = saved.slice(-200).map((m) => ({
      ...m,
      status: m.status === "streaming" ? ("cancelled" as const) : m.status,
    }));
    let active: { abort: AbortController; task: Promise<void> } | undefined,
      error: string | undefined;
    const state = (): ChatState =>
      structuredClone({ messages, busy: !!active, error });
    const publish = () => {
      if (ctx.active) ctx.emit("conversation.changed", state());
    };
    const persist = () => storage.write("conversation", messages.slice(-200));
    const cancel = async () => {
      active?.abort.abort();
      await active?.task;
    };
    ctx.provide("conversation", {
      state,
      async send(text) {
        if (active) throw new Error("正在回复，请先停止当前生成");
        if (typeof text !== "string" || !text.trim() || text.length > 8000)
          throw new Error("请输入 1—8000 个字符");
        const config = settings.get();
        if (!config.provider.model)
          throw new Error("请先打开控制器，填写并测试模型连接");
        messages = [
          ...messages.slice(-198),
          {
            id: randomUUID(),
            role: "user",
            text: text.trim(),
            status: "complete",
            time: Date.now(),
          },
        ];
        const context: { role: string; content: string }[] = [];
        let budget = 12000;
        for (const m of [...messages].reverse()) {
          if (m.status !== "complete") continue;
          if (m.text.length > budget) break;
          context.unshift({ role: m.role, content: m.text });
          budget -= m.text.length;
        }
        const assistant: Message = {
          id: randomUUID(),
          role: "assistant",
          text: "",
          status: "streaming",
          time: Date.now(),
        };
        messages.push(assistant);
        error = undefined;
        const abort = new AbortController();
        const task = Promise.resolve().then(async () => {
          try {
            await persist();
            if (abort.signal.aborted) {
              assistant.status = "cancelled";
              return;
            }
            for await (const delta of provider.stream({
              settings: config.provider,
              messages: [
                {
                  role: "system",
                  content: `你的名字是${config.persona.name}。\n${config.persona.instruction}`,
                },
                ...context,
              ],
              signal: abort.signal,
            })) {
              if (abort.signal.aborted) break;
              assistant.text += delta;
              publish();
            }
            assistant.status = abort.signal.aborted ? "cancelled" : "complete";
            if (!assistant.text && assistant.status === "complete")
              throw new Error("模型没有返回文字");
          } catch (e) {
            assistant.status = abort.signal.aborted ? "cancelled" : "error";
            if (!abort.signal.aborted)
              error = e instanceof Error ? e.message : "模型请求失败";
          } finally {
            try {
              await persist();
            } catch {
              error = "对话保存失败，请检查本地存储";
            }
            active = undefined;
            publish();
          }
        });
        active = { abort, task };
        publish();
      },
      cancel,
      async clear() {
        await cancel();
        await storage.write("conversation", []);
        messages = [];
        error = undefined;
        publish();
      },
    });
    ctx.effect(cancel);
  },
});
