import { createHash } from "node:crypto";
import {
  definePlugin,
  type ProviderProfile,
  type ModelInfo,
  type ProviderInput,
} from "../../packages/contracts/index.ts";
import { credentialScope, validateProfile } from "../llm-shared/config.ts";
export const estimateTokens = (messages: ProviderInput["messages"]) =>
  messages.reduce(
    (n, m) =>
      n +
      Buffer.byteLength(
        m.native
          ? JSON.stringify(m.native.items)
          : JSON.stringify({
              content: m.content,
              calls: m.calls,
              toolCallId: m.toolCallId,
              toolName: m.toolName,
            }),
        "utf8",
      ) +
      16,
    32,
  );
export const nativeScope = (c: ProviderProfile, key = "") =>
  createHash("sha256")
    .update(JSON.stringify([c.kind, c.baseUrl, c.model, c.thinking, key]))
    .digest("hex");
async function abortable<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
export const llmRouter = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.llm-router",
    version: "0.1.0",
    provides: ["llm.chat", "llm.management"],
    requires: ["llm.registry", "settings", "secrets.local", "storage.local"],
  },
  async start(ctx) {
    const registry = ctx.use("llm.registry"),
      settings = ctx.use("settings"),
      secrets = ctx.use("secrets.local"),
      storage = ctx.use("storage.local");
    type Cached = { time: number; models: ModelInfo[] };
    const cache = new Map<string, Cached>();
    const inflight = new Map<string, Promise<ModelInfo[]>>();
    const generations = new Map<string, number>();
    const persisted = await storage.read<Record<string, Cached>>(
      "model-catalog",
      {},
    );
    if (persisted && typeof persisted === "object")
      for (const [key, v] of Object.entries(persisted)) {
        if (
          /^[a-f0-9]{64}$/.test(key) &&
          v &&
          Array.isArray(v.models) &&
          v.models.length <= 5000
        )
          cache.set(key, v);
      }
    let writes = Promise.resolve();
    const persist = () => {
      const snapshot = Object.fromEntries([...cache].slice(-32));
      writes = writes
        .catch(() => {})
        .then(() => storage.write("model-catalog", snapshot));
      void writes.catch((e) => ctx.report(e));
    };
    ctx.effect(() => writes.catch(() => {}));
    const modelFor = (c: ProviderProfile) =>
      cache.get(credentialScope(c))?.models.find((m) => m.id === c.model);
    const inspect = (input: ProviderProfile) => {
      const c = validateProfile(input),
        model = modelFor(c);
      return {
        options: registry.get(c.kind).options(c, model),
        model,
        hasKey: secrets.has(credentialScope(c)),
      };
    };
    function validate(input: ProviderProfile) {
      const c = validateProfile(input),
        p = registry.get(c.kind),
        m = modelFor(c),
        o = p.options(c, m);
      if (!o.modes.includes(c.thinking.mode))
        throw new Error("当前模型不支持此思考模式，请选择自动或受支持的模式");
      if (
        ["effort", "adaptive"].includes(c.thinking.mode) &&
        !o.efforts.includes(c.thinking.effort)
      )
        throw new Error("当前模型不支持此思考强度");
      if (
        c.temperature !== null &&
        (!o.temperature || c.temperature > o.temperatureMax)
      )
        throw new Error("当前模型或思考模式不支持该温度，请使用模型默认");
      if (c.topP !== null && (!o.topP || c.topP < o.topPMin))
        throw new Error("当前模型或思考模式不支持该 Top P，请使用模型默认");
      if (c.kind === "claude" && c.temperature !== null && c.topP !== null)
        throw new Error("Claude 请只设置温度或 Top P 其中一项");
      if (
        c.thinking.mode === "budget" &&
        (c.thinking.budgetTokens < o.budgetMin ||
          c.thinking.budgetTokens > (o.budgetMax ?? 262144) ||
          c.thinking.budgetTokens >= c.maxOutputTokens)
      )
        throw new Error(
          `思考预算需至少 ${o.budgetMin}，在模型限制内，且小于输出上限`,
        );
      if (m?.outputLimit && c.maxOutputTokens > m.outputLimit)
        throw new Error(`当前模型输出上限为 ${m.outputLimit} token`);
      return c;
    }
    const makeInput = (
      input: Omit<ProviderInput, "key">,
      timeout?: number,
    ): ProviderInput => {
      const c = validate(input.settings),
        provider = registry.get(c.kind),
        key = secrets.get(credentialScope(c));
      if (provider.requiresKey && !key)
        throw new Error("请先为当前供应商和地址保存 API Key");
      return {
        ...input,
        settings: c,
        key,
        modelInfo: modelFor(c),
        nativeScope: nativeScope(c, key),
        signal: AbortSignal.any([
          ctx.abort.signal,
          input.signal,
          AbortSignal.timeout(timeout ?? c.timeoutSeconds * 1000),
        ]),
      };
    };
    const models = async (
      input: ProviderProfile,
      refresh = false,
    ): Promise<ModelInfo[]> => {
      const c = validateProfile(input),
        provider = registry.get(c.kind),
        scope = credentialScope(c),
        cached = cache.get(scope);
      if (!refresh && cached && Date.now() - cached.time < 600000)
        return structuredClone(cached.models);
      const pending = inflight.get(scope);
      if (pending) return structuredClone(await pending);
      const key = secrets.get(scope);
      if (provider.requiresKey && !key)
        throw new Error("请先保存当前供应商的 API Key，再获取模型列表");
      const generation = generations.get(scope) ?? 0;
      const operation = (async () => {
        const list = await provider.models({
          settings: c,
          key,
          signal: AbortSignal.any([
            ctx.abort.signal,
            AbortSignal.timeout(20000),
          ]),
        });
        const unique = new Map<string, ModelInfo>();
        for (const m of list) {
          if (
            typeof m.id !== "string" ||
            m.id.length > 200 ||
            typeof m.name !== "string"
          )
            continue;
          unique.set(m.id, { ...m, name: m.name.slice(0, 200) });
          if (unique.size >= 5000) break;
        }
        const result = [...unique.values()].sort((a, b) =>
          a.id.localeCompare(b.id),
        );
        if (ctx.active && generation === (generations.get(scope) ?? 0)) {
          cache.set(scope, { time: Date.now(), models: result });
          persist();
        }
        return result;
      })();
      inflight.set(scope, operation);
      try {
        return structuredClone(await operation);
      } finally {
        if (inflight.get(scope) === operation) inflight.delete(scope);
      }
    };
    ctx.on<string>("secrets.changed", (scope) => {
      generations.set(scope, (generations.get(scope) ?? 0) + 1);
      inflight.delete(scope);
      cache.delete(scope);
      persist();
    });
    const plan = async (input: ProviderProfile, signal?: AbortSignal) => {
      const c = validateProfile(input);
      if (
        !modelFor(c) ||
        Date.now() - (cache.get(credentialScope(c))?.time ?? 0) >= 600000
      )
        await abortable(
          models(c).catch(() => {}),
          signal,
        );
      signal?.throwIfAborted();
      validate(c);
      const model = modelFor(c);
      const discovered =
        model?.contextWindow ??
        (model?.inputLimit ? model.inputLimit + c.maxOutputTokens : undefined);
      const contextWindow =
        c.contextTokens !== null
          ? Math.min(c.contextTokens, discovered ?? Infinity)
          : (discovered ?? 32768);
      const source =
        c.contextTokens !== null
          ? ("manual" as const)
          : discovered
            ? ("model" as const)
            : ("fallback" as const);
      const inputBudget =
        Math.min(
          contextWindow - c.maxOutputTokens,
          model?.inputLimit ?? Infinity,
        ) - Math.max(256, Math.ceil(contextWindow * 0.005));
      if (inputBudget < 512)
        throw new Error("上下文窗口不足以容纳当前输出预算，请调整上限");
      return { inputBudget, contextWindow, source, model };
    };
    ctx.provide("llm.management", {
      models,
      inspect,
      plan,
      validate,
      async count(input) {
        input.signal.throwIfAborted();
        const provider = registry.get(input.settings.kind),
          scope = nativeScope(
            input.settings,
            secrets.get(credentialScope(input.settings)),
          ),
          estimate = estimateTokens(
            input.messages.map((m) =>
              m.native?.scope === scope ? m : { ...m, native: undefined },
            ),
          );
        if (!provider.countTokens) return { tokens: estimate, exact: false };
        try {
          const value = await provider.countTokens(makeInput(input, 15000));
          return { tokens: value, exact: true };
        } catch (e) {
          if (input.signal.aborted || ctx.abort.signal.aborted) throw e;
          return { tokens: estimate, exact: false };
        }
      },
    });
    ctx.provide("llm.chat", {
      async *stream(input) {
        const request = makeInput(input);
        if (!request.settings.model) throw new Error("请先选择模型");
        let total = 0;
        for await (const text of registry
          .get(request.settings.kind)
          .stream(request)) {
          total += text.length;
          if (total > 256000) throw new Error("回复超过应用长度上限");
          yield text;
        }
      },
      async test() {
        const c = settings.get().provider;
        let text = "";
        const input = makeInput(
          {
            settings: c,
            messages: [{ role: "user", content: "请只回复：连接成功" }],
            signal: ctx.abort.signal,
          },
          Math.min(c.timeoutSeconds * 1000, 60000),
        );
        for await (const chunk of registry.get(c.kind).stream(input)) {
          text += chunk;
          if (text.length > 256000) throw new Error("测试回复过长");
        }
        if (!text.trim()) throw new Error("连接成功，但模型没有返回文字");
        return "连接成功，模型已返回文字";
      },
    });
  },
});
