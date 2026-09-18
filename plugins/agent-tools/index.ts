import { createHash, randomUUID } from "node:crypto";
import { Ajv } from "ajv";
import {
  definePlugin,
  type ToolEntry,
  type Approval,
  type ToolPolicy,
  type PermissionIntent,
  type ApprovalChoice,
} from "../../packages/contracts/index.ts";
export const defaultPolicy: ToolPolicy = {
  mode: "custom",
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
    !["custom", "auto"].includes(value.mode) ||
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
  return structuredClone(value);
}
export const agentTools = definePlugin({
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
      intent.tool + ":" + intent.category;
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
      if (intent) {
        const decision = policy.defaults[intent.category];
        if (policy.mode === "auto") return;
        if (decision === "deny") throw new Error("此类工具已在权限设置中禁止");
        if (
          decision === "allow" ||
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
      set: (value) => save(() => value),
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
          await save(() => ({
            ...policy,
            whitelist: [
              ...policy.whitelist.filter((r) => r.key !== ruleKey(intent)),
              {
                key: ruleKey(intent),
                label: (item.view.title + "：" + intent.scope).slice(0, 10000),
              },
            ],
          }));
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
        [...tools.values()].map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
      async run(call, signal) {
        signal.throwIfAborted();
        const tool = tools.get(call.name);
        if (!tool) throw new Error("工具未启用或不存在");
        if (call.arguments.length > 65536) throw new Error("工具参数过大");
        const args = JSON.parse(call.arguments || "{}");
        if (!ajv.validate(tool.parameters, args))
          throw new Error("工具参数不符合规范");
        const intent = {
          tool: tool.name,
          ...(tool.permission
            ? await tool.permission(args)
            : {
                category: tool.category ?? (tool.approval ? "mcp" : "read"),
                scope: JSON.stringify(args),
              }),
        } as PermissionIntent;
        await request(
          tool.description,
          JSON.stringify({ tool: tool.name, arguments: args }, null, 2),
          signal,
          intent,
        );
        signal.throwIfAborted();
        ctx.emit(
          "agent.activity",
          "正在" + tool.description.slice(0, 60) + "…",
        );
        const value = await tool.execute(args, { signal });
        const text =
          typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
        return text.length > 32000
          ? text.slice(0, 32000) + "\n[结果已截断]"
          : text;
      },
    });
    ctx.effect(async () => {
      for (const p of [...pending.values()]) p.finish(false);
      tools.clear();
      await queue;
    });
  },
});
