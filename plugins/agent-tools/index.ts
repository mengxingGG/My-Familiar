import { createHash, randomUUID } from "node:crypto";
import { Ajv } from "ajv";
import { deferredToolCatalog } from "./catalog.ts";
import {
  definePlugin,
  type ToolEntry,
  type Approval,
  type ToolPolicy,
  type PermissionIntent,
  type ApprovalChoice,
  type ToolCall,
} from "../../packages/contracts/index.ts";
export const defaultPolicy: ToolPolicy = {
  mode: "limited",
  defaults: {
    read: "allow",
    search: "allow",
    write: "allow",
    outsideWrite: "ask",
    shell: "ask",
    install: "ask",
    mcp: "ask",
  },
  whitelist: [],
};
export function validatePolicy(value: ToolPolicy): ToolPolicy {
  if (
    !value ||
    !["custom", "limited", "approval", "deny", "auto"].includes(value.mode) ||
    !value.defaults ||
    !Array.isArray(value.whitelist) ||
    value.whitelist.length > 200
  )
    throw new Error("权限策略无效");
  for (const key of Object.keys(
    defaultPolicy.defaults,
  ) as (keyof ToolPolicy["defaults"])[])
    if (!["allow", "ask", "deny"].includes(value.defaults[key]))
      throw new Error("权限默认值无效");
  if (
    value.whitelist.some(
      (r) =>
        !/^[a-f0-9]{64}$/.test(r.key) ||
        typeof r.label !== "string" ||
        r.label.length > 10000,
    )
  )
    throw new Error("白名单规则无效");
  return { ...structuredClone(value), mode: value.mode === "custom" ? "limited" : value.mode };
}
export const createAgentTools = (options: { adaptiveCatalog?: boolean } = {}) => definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.agent-tools",
    version: "0.3.0",
    provides: ["agent.tools", "agent.approvals", "agent.policy"],
    requires: ["storage.local"],
  },
  async start(ctx) {
    const storage = ctx.use("storage.local");
    let policy = validatePolicy(
      await storage.read("tool-policy", defaultPolicy),
    );
    let sessionGeneration = 0;
    const sessionRules = new Set<string>();
    const tools = new Map<string, ToolEntry>();
    let compactCatalog: ReturnType<typeof deferredToolCatalog> | undefined;
    let compactEntries: ToolEntry[] = [];
    let disposeCompact: (() => void) | undefined;
    ctx.effect(() => disposeCompact?.());
    const pending = new Map<
      string,
      {
        view: Approval;
        intent?: PermissionIntent;
        generation: number;
        finish(allow: boolean): void;
      }
    >();
    const ajv = new Ajv({ strict: false, allErrors: false });
    let queue = Promise.resolve();
    const save = (update: () => ToolPolicy) => {
      const p = queue.then(async () => {
        const next = validatePolicy(update());
        await storage.write("tool-policy", next);
        policy = next;
        return structuredClone(policy);
      });
      queue = p.then(
        () => {},
        () => {},
      );
      return p;
    };
    const ruleKey = (intent: PermissionIntent) =>
      createHash("sha256")
        .update(JSON.stringify([intent.tool, intent.category, intent.scope]))
        .digest("hex");
    const sessionKey = (intent: PermissionIntent) =>
      intent.session ?? "desktop";
    const publish = () =>
      ctx.active &&
      ctx.emit(
        "agent.approvals",
        [...pending.values()].map((v) => v.view),
      );
    const request = async (
      title: string,
      detail: string,
      signal: AbortSignal,
      intent?: PermissionIntent,
    ) => {
      signal.throwIfAborted();
      if (policy.mode === "auto") return;
      if (!intent && policy.mode === "deny") throw new Error("全部拒绝模式已禁止此工具");
      if (intent) {
        // 固定白名单只来自注册工具的实现，不能由模型参数声明。
        if (intent.alwaysAllowed || intent.category === "search") return;
        if (policy.mode === "deny") throw new Error("全部拒绝模式已禁止此工具");
        const decision = policy.defaults[intent.category];
        if (policy.mode === "limited" && decision === "deny") throw new Error("此类工具已在权限设置中禁止");
        if (
          (policy.mode === "limited" && decision === "allow") ||
          sessionRules.has(sessionKey(intent)) ||
          policy.whitelist.some((r) => r.key === ruleKey(intent))
        )
          return;
      }
      await new Promise<void>((resolve, reject) => {
        const id = randomUUID();
        const clean = () => {
          pending.delete(id);
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          publish();
        };
        const abort = () => {
          clean();
          reject(new Error("操作已取消"));
        };
        const timer = setTimeout(() => {
          clean();
          reject(new Error("确认已超时，未执行操作"));
        }, 300000);
        pending.set(id, {
          view: {
            id,
            title,
            detail,
            time: Date.now(),
            category: intent?.category,
            rule: intent ? intent.scope : undefined,
            choices: intent ? ["once", "session", "whitelist"] : ["once"],
          },
          intent,
          generation: sessionGeneration,
          finish(allow) {
            clean();
            allow ? resolve() : reject(new Error("用户拒绝操作，未执行"));
          },
        });
        signal.addEventListener("abort", abort, { once: true });
        publish();
      });
    };
    const resetSession = () => {
      sessionRules.clear();
      sessionGeneration++;
    };
    ctx.on("conversation.session", resetSession);
    ctx.provide("agent.policy", {
      get: () => structuredClone(policy),
      async set(value) {
        const next = await save(() => value);
        resetSession();
        for (const item of [...pending.values()]) item.finish(false);
        ctx.emit("agent.policy", next);
        return next;
      },
      resetSession,
    });
    ctx.provide("agent.approvals", {
      list: () => [...pending.values()].map((v) => ({ ...v.view })),
      request,
      async decide(id, allow, choice: ApprovalChoice = "once") {
        if (!["once", "session", "whitelist"].includes(choice))
          throw new Error("允许范围无效");
        const item = pending.get(id);
        if (!item) throw new Error("确认已结束");
        if (allow && choice !== "once" && !item.intent)
          throw new Error("此操作仅支持本次确认");
        if (allow && choice === "whitelist") {
          const intent = item.intent!;
          await save(() => {
            if (pending.get(id) !== item || item.generation !== sessionGeneration) throw new Error("确认已结束");
            return ({
            ...policy,
            whitelist: [
              ...policy.whitelist.filter((r) => r.key !== ruleKey(intent)),
              {
                key: ruleKey(intent),
                label: (item.view.title + "：" + intent.scope).slice(0, 10000),
              },
            ],
          }); });
        }
        // 持久化期间若操作取消或会话切换，不再执行，也不扩大会话授权。
        if (pending.get(id) !== item) return;
        if (
          allow &&
          choice === "session" &&
          item.generation === sessionGeneration
        )
          sessionRules.add(sessionKey(item.intent!));
        item.finish(allow === true);
      },
    });
    ctx.provide("agent.tools", {
      register(tool) {
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) || tools.has(tool.name))
          throw new Error("工具名称无效或重复");
        ajv.compile(tool.parameters);
        tools.set(tool.name, tool);
        return () => {
          tools.delete(tool.name);
        };
      },
      list: () =>
        [...tools.values()].filter(t => t.advertised !== false).map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
      denialKey(call) {
        try {
          const key = tools.get(call.name)?.denialKey?.(JSON.parse(call.arguments || "{}"));
          return key || call.name;
        } catch { return call.name; }
      },
      ...(options.adaptiveCatalog ? { compactList() {
        const entries = [...tools.values()].filter(tool => !tool.catalogRoute);
        if (!compactCatalog) compactCatalog = deferredToolCatalog(ctx.use("agent.tools"), "familiar", false);
        if (!disposeCompact || entries.length !== compactEntries.length || entries.some((entry, i) => entry !== compactEntries[i])) {
          disposeCompact?.();
          disposeCompact = compactCatalog.add("available", "当前可用工具", entries.map(tool => ({ name: tool.name, tool })));
          compactEntries = entries;
        }
        return compactCatalog.names.map(name => {
          const { description, parameters } = tools.get(name)!;
          return { name, description, parameters };
        });
      } } : {}),
      compactResults(messages) {
        const calls = new Map(messages.flatMap(m => (m.calls ?? []).map(call => [call.id, call] as const)));
        const completed: ToolCall[] = [];
        // 只允许注册工具自己的策略替换文本。保留调用配对、附件和原始消息对象。
        return messages.toReversed().map(message => {
          if (message.role !== "tool" || !message.toolCallId) return message;
          const call = calls.get(message.toolCallId);
          if (!call || call.name !== message.toolName) return message;
          let content: string | undefined;
          if (!message.attachments?.length && !message.images?.length && !message.native) {
            try { content = tools.get(call.name)?.compactResult?.(call, message.content, completed); }
            catch { /* 查询资料不符合预期时保留原文。 */ }
          }
          completed.push(call);
          return typeof content === "string" && Buffer.byteLength(content) < Buffer.byteLength(message.content)
            ? { ...message, content } : message;
        }).reverse();
      },
      async run(call, signal, options) {
        return (await ctx.use("agent.tools").runRich!(call, signal, options))
          .text;
      },
      async runRich(call, signal, options) {
        signal.throwIfAborted();
        const tool = tools.get(call.name);
        if (!tool) throw new Error("工具未启用或不存在");
        if (options?.expectedTool && options.expectedTool !== tool) throw new Error("工具连接已变化，请重新检索目录");
        if (call.arguments.length > 65536) throw new Error("工具参数过大");
        const args = JSON.parse(call.arguments || "{}");
        if (!ajv.validate(tool.parameters, args))
          throw new Error("工具参数不符合规范");
        const intent = {
          tool: tool.name,
          session: options?.session,
          alwaysAllowed: tool.alwaysAllowed === true,
          ...(tool.permission
            ? await tool.permission(args)
            : {
                category: tool.category ?? (tool.approval ? "mcp" : "read"),
                scope: JSON.stringify(args),
              }),
        } as PermissionIntent;
        await request(
          (options?.label ? options.label.slice(0, 100) + " · " : "") + tool.description,
          JSON.stringify({ tool: tool.name, arguments: args }, null, 2),
          signal,
          intent,
        );
        signal.throwIfAborted();
        if (tools.get(call.name) !== tool) throw new Error("工具连接已变化，请重新检索目录");
        if (!options?.silent)
          ctx.emit(
            "agent.activity",
            "正在" + tool.description.slice(0, 60) + "…",
          );
        const value = await tool.execute(args, {
          signal,
          session: options?.session,
          label: options?.label,
        });
        if (
          value &&
          typeof value === "object" &&
          "type" in value &&
          value.type === "familiar.multimodal"
        ) {
          const rich =
            value as import("../../packages/contracts/media.ts").ToolResult;
          if (
            typeof rich.text !== "string" ||
            !Array.isArray(rich.attachments) ||
            rich.attachments.length > 8
          )
            throw new Error("图片工具结果格式无效");
          return {
            text: rich.text,
            attachments: rich.attachments,
          };
        }
        const text =
          typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
        return {
          text,
        };
      },
    });
    ctx.effect(async () => {
      for (const p of [...pending.values()]) p.finish(false);
      tools.clear();
      await queue;
    });
  },
});
export const agentTools = createAgentTools();
