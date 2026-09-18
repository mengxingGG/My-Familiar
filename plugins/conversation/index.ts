import { createHash, randomUUID } from "node:crypto";
import {
  definePlugin,
  type Message,
  type ChatState,
  type NativeTurn,
  type SessionStatus,
  type PromptMessage,
  type ConversationSummary,
} from "../../packages/contracts/index.ts";
import { fitContext } from "./context.ts";
type StoredMessage = Message & {
  native?: NativeTurn;
  trace?: PromptMessage[];
  proactive?: boolean;
};
type Session = {
  id: string;
  epoch: number;
  fingerprint: string;
  start?: string;
  trimmed: number;
  status?: SessionStatus;
};
export const conversation = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.conversation",
    version: "0.1.0",
    provides: ["conversation", "conversation.history"],
    requires: [
      "agent.chat",
      "agent.tools",
      "memory.files",
      "skills.catalog",
      "llm.management",
      "settings",
      "storage.local",
    ],
  },
  async start(ctx) {
    const provider = ctx.use("agent.chat"),
      management = ctx.use("llm.management"),
      settings = ctx.use("settings"),
      storage = ctx.use("storage.local");
    const saved = await storage.read<
      | StoredMessage[]
      | { version: number; messages: StoredMessage[]; session: Session }
    >("conversation", []);
    let messages = Array.isArray(saved) ? saved : saved.messages;
    if (
      !Array.isArray(messages) ||
      messages.some(
        (m) =>
          !m ||
          !["user", "assistant"].includes(m.role) ||
          typeof m.text !== "string" ||
          m.text.length > 256000,
      )
    )
      throw new Error("聊天记录损坏");
    messages = messages.map((m) => ({
      ...m,
      id: m.id ?? randomUUID(),
      status: m.status === "streaming" ? "cancelled" : m.status,
    }));
    let session: Session =
      !Array.isArray(saved) && saved.session?.id
        ? saved.session
        : { id: randomUUID(), epoch: 0, fingerprint: "", trimmed: 0 };
    let active: { abort: AbortController; task: Promise<void> } | undefined,
      error: string | undefined;
    let changing = false;
    const index = new Map(
      (await storage.read<ConversationSummary[]>("conversation-index", [])).map(
        (item) => [item.id, item],
      ),
    );
    const summary = (): ConversationSummary => ({
      id: session.id,
      title:
        (index.get(session.id)?.title !== "新的相处"
          ? index.get(session.id)?.title
          : "") ||
        messages.find((m) => m.role === "user")?.text.slice(0, 60) ||
        "新的相处",
      updated: messages.at(-1)?.time ?? Date.now(),
      count: messages.length,
    });
    const state = (): ChatState =>
      structuredClone({
        messages: messages.slice(-10).map(({ native, trace, ...m }) => m),
        busy: !!active,
        error,
        session: session.status,
      });
    const publish = () => {
      if (ctx.active) ctx.emit("conversation.changed", state());
    };
    const persist = async () => {
      const snapshot = structuredClone({ version: 2, messages, session });
      index.set(session.id, summary());
      const entries = [...index.values()];
      // 先写独立会话和索引，再更新当前指针；旧版 conversation 仍保留可读副本。
      await storage.write(
        "conversation-session-" + snapshot.session.id,
        snapshot,
      );
      await storage.write("conversation-index", entries);
      await storage.write("conversation", snapshot);
    };
    await persist();
    ctx.emit("conversation.session", session.id);
    const cancel = async () => {
      active?.abort.abort();
      await active?.task;
    };
    ctx.provide("conversation", {
      state,
      async send(text) {
        if (changing) throw new Error("正在切换会话，请稍候");
        if (active) throw new Error("正在回复，请先停止当前生成");
        if (typeof text !== "string" || !text.trim() || text.length > 8000)
          throw new Error("请输入 1—8000 个字符");
        const config = settings.get();
        if (!config.provider.model)
          throw new Error("请先打开控制器，填写并测试模型连接");
        const user: StoredMessage = {
            id: randomUUID(),
            role: "user",
            text: text.trim(),
            status: "complete",
            time: Date.now(),
          },
          assistant: StoredMessage = {
            id: randomUUID(),
            role: "assistant",
            text: "",
            status: "streaming",
            time: Date.now(),
          };
        messages.push(user, assistant);
        error = undefined;
        const abort = new AbortController();
        const task = Promise.resolve().then(async () => {
          try {
            await persist();
            abort.signal.throwIfAborted();
            const system = {
              role: "system",
              content: `你的名字是${config.persona.name}。\n${config.persona.instruction}\n你可以调用当前提供的工具。只有实际工具结果才能证明完成操作；没有执行过就不能声称做过。普通陪伴不必调用工具。用户提及过去时先检索记忆，明确要求记住的长期信息写入核心记忆；可复用的错误和经验写入教训。不要展示思考过程。\n${await ctx.use("memory.files").context()}\n${await ctx.use("skills.catalog").prompt()}`,
            };
            const fingerprint = createHash("sha256")
              .update(
                JSON.stringify([
                  config.provider.kind,
                  config.provider.baseUrl,
                  config.provider.model,
                  config.provider.thinking,
                  config.provider.temperature,
                  config.provider.topP,
                  config.provider.maxOutputTokens,
                  system,
                  ctx.use("agent.tools").list(),
                ]),
              )
              .digest("hex");
            if (session.fingerprint && session.fingerprint !== fingerprint)
              session.epoch++;
            session.fingerprint = fingerprint;
            const plan = await management.plan(config.provider, abort.signal);
            abort.signal.throwIfAborted();
            const start = session.start
              ? Math.max(
                  0,
                  messages.findIndex((m) => m.id === session.start),
                )
              : 0;
            const history: (PromptMessage & { id: string })[] = [];
            for (let i = start; i < messages.length; i++) {
              const m = messages[i];
              if (m.id === user.id) {
                history.push({ id: m.id, role: m.role, content: m.text });
                break;
              }
              if (m.role === "assistant" && m.proactive) {
                history.push(
                  { id: m.id, role: "user", content: "[桌面伙伴的主动关怀]" },
                  { id: m.id + ":care", role: "assistant", content: m.text },
                );
                continue;
              }
              if (
                m.role === "user" &&
                m.status === "complete" &&
                messages[i + 1]?.role === "assistant" &&
                messages[i + 1].status === "complete"
              ) {
                const answer = messages[++i];
                history.push({ id: m.id, role: m.role, content: m.text });
                if (answer.trace?.length)
                  history.push(
                    ...answer.trace.map((part, n) => ({
                      ...part,
                      id: `${answer.id}:${n}`,
                    })),
                  );
                else
                  history.push({
                    id: answer.id,
                    role: answer.role,
                    content: answer.text,
                    native: answer.native,
                  });
              }
            }
            const fitted = await fitContext(
              system,
              history,
              plan.inputBudget -
                (ctx.use("agent.tools").list().length
                  ? Buffer.byteLength(
                      JSON.stringify(ctx.use("agent.tools").list()),
                      "utf8",
                    ) + 1024
                  : 0),
              (prompt) =>
                management.count({
                  settings: config.provider,
                  messages: prompt,
                  signal: abort.signal,
                }),
            );
            abort.signal.throwIfAborted();
            if (fitted.dropped) {
              session.epoch++;
              session.trimmed += fitted.dropped;
              session.start = fitted.messages[0].id;
              // 只移动模型上下文起点，完整会话始终留给历史管理器。
            }
            session.status = {
              id: session.id,
              epoch: session.epoch,
              retainedMessages: fitted.messages.length,
              inputTokens: fitted.tokens,
              exact: fitted.exact,
              inputBudget: plan.inputBudget,
              limitSource: plan.source,
              trimmedMessages: session.trimmed,
            };
            await persist();
            publish();
            const sessionKey = createHash("sha256")
              .update(`${session.id}:${session.epoch}:${fingerprint}`)
              .digest("hex");
            for await (const delta of provider.stream({
              settings: config.provider,
              messages: [system, ...fitted.messages],
              signal: abort.signal,
              sessionKey,
              onUsage(value) {
                if (session.status)
                  session.status.usage = { ...session.status.usage, ...value };
              },
              onNative(value) {
                if (JSON.stringify(value).length <= 4 * 1024 * 1024)
                  assistant.native = value;
              },
              onTrace(value) {
                if (JSON.stringify(value).length > 4 * 1024 * 1024)
                  throw new Error("工具会话过长，请开启新会话");
                assistant.trace = structuredClone(value);
                // 工具已经发生的结果及时落盘；取消轮次保留审计资料但不回放给模型。
                void persist().catch((e) => ctx.report(e));
              },
            })) {
              if (abort.signal.aborted) break;
              assistant.text += delta;
              publish();
            }
            assistant.status = abort.signal.aborted ? "cancelled" : "complete";
            if (!assistant.text && assistant.status === "complete")
              throw new Error("模型没有返回文字，请检查输出/思考预算");
            if (assistant.status === "complete") {
              try {
                await ctx.use("memory.files").record({
                  id: user.id,
                  user: user.text,
                  assistant: assistant.text,
                  time: user.time,
                });
              } catch (e) {
                ctx.report(e);
              }
            }
          } catch (e) {
            assistant.status = abort.signal.aborted ? "cancelled" : "error";
            delete assistant.native;
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
      clear: () => history.create().then(() => {}),
    });
    const find = async (id: string) => {
      if (!index.has(id) || !/^[a-zA-Z0-9-]+$/.test(id))
        throw new Error("会话不存在");
      if (id === session.id) return { messages, session };
      const data = await storage.read<{
        messages: StoredMessage[];
        session: Session;
      } | null>("conversation-session-" + id, null);
      if (!data || !Array.isArray(data.messages) || data.session?.id !== id)
        throw new Error("会话文件损坏");
      return data;
    };
    const change = async <T>(operation: () => Promise<T>): Promise<T> => {
      if (changing) throw new Error("正在切换会话");
      changing = true;
      try {
        await cancel();
        return await operation();
      } finally {
        changing = false;
      }
    };
    const activate = async (data: {
      messages: StoredMessage[];
      session: Session;
    }) => {
      await storage.write("conversation", { version: 2, ...data });
      messages = data.messages;
      session = data.session;
      error = undefined;
      ctx.emit("conversation.session", session.id);
      publish();
    };
    const fresh = () => ({
      messages: [] as StoredMessage[],
      session: { id: randomUUID(), epoch: 0, fingerprint: "", trimmed: 0 },
    });
    const history = {
      current: () => session.id,
      async note(text: string) {
        if (active || changing) throw new Error("正在对话或切换会话");
        if (typeof text !== "string" || !text.trim() || text.length > 8000)
          throw new Error("问候内容无效");
        const message: StoredMessage = {
          id: randomUUID(),
          role: "assistant",
          text,
          status: "complete",
          time: Date.now(),
          proactive: true,
        };
        messages.push(message);
        await persist();
        publish();
        await ctx
          .use("memory.files")
          .record({
            id: message.id,
            user: "[主动关怀]",
            assistant: text,
            time: message.time,
          })
          .catch((e) => ctx.report(e));
      },
      async list(query = "") {
        if (typeof query !== "string" || query.length > 200)
          throw new Error("检索词无效");
        index.set(session.id, summary());
        const sorted = [...index.values()].sort(
          (a, b) => b.updated - a.updated,
        );
        if (!query.trim()) return sorted;
        const q = query.trim().toLocaleLowerCase(),
          result: ConversationSummary[] = [];
        for (const item of sorted) {
          if (
            item.title.toLocaleLowerCase().includes(q) ||
            (await find(item.id)).messages.some((m) =>
              m.text.toLocaleLowerCase().includes(q),
            )
          )
            result.push(item);
        }
        return result;
      },
      async read(id: string, offset = 0) {
        if (!Number.isInteger(offset) || offset < 0)
          throw new Error("分页参数无效");
        const data = await find(id),
          page: Message[] = [];
        let size = 0;
        for (const { native, trace, ...message } of data.messages.slice(
          offset,
          offset + 30,
        )) {
          if (page.length && size + message.text.length > 300000) break;
          page.push(message);
          size += message.text.length;
        }
        const next = offset + page.length;
        return structuredClone({
          session: id === session.id ? summary() : index.get(id)!,
          messages: page,
          next: next < data.messages.length ? next : null,
          active: id === session.id,
        });
      },
      create: () =>
        change(async () => {
          await persist();
          await activate(fresh());
          await persist();
          return session.id;
        }),
      select: (id: string) =>
        change(async () => {
          const data = await find(id);
          if (id === session.id) return;
          await persist();
          await activate(data);
        }),
      rename: (id: string, title: string) =>
        change(async () => {
          await find(id);
          if (typeof title !== "string" || !title.trim() || title.length > 100)
            throw new Error("名称需要 1—100 个字符");
          const next = { ...index.get(id)!, title: title.trim() };
          await storage.write(
            "conversation-index",
            [...index.values()].map((v) => (v.id === id ? next : v)),
          );
          index.set(id, next);
        }),
      remove: (id: string) =>
        change(async () => {
          await find(id);
          if (id === session.id) await activate(fresh());
          const entries = [...index.values()].filter((v) => v.id !== id);
          await storage.write("conversation-index", entries);
          index.delete(id);
          await storage.write("conversation-session-" + id, null);
          await persist();
        }),
    };
    ctx.provide("conversation.history", history);
    ctx.effect(cancel);
  },
});
