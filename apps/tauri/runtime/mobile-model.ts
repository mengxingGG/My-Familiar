import { createHash } from "node:crypto";
import type { Kernel } from "../../../packages/kernel/index.ts";
import type {
  ModelInfo,
  ProviderProfile,
} from "../../../packages/contracts/index.ts";
import { summaryFields } from "../../../packages/contracts/index.ts";
import type {
  MobileContext,
  MobileProviderAdvanced,
  MobileModelInfo,
} from "../../../packages/mobile-contracts/index.ts";
import { MOBILE_PROVIDER_KINDS } from "../../../packages/mobile-contracts/index.ts";
import { validateProfile } from "../../../plugins/llm-shared/config.ts";

const input: (value: unknown) => asserts value = (value) => {
  if (!value) throw Error("INVALID_INPUT");
};
export const advancedProfile = (
  p: ProviderProfile,
): MobileProviderAdvanced => ({
  temperature: p.temperature,
  topP: p.topP,
  maxOutputTokens: p.maxOutputTokens,
  contextTokens: p.contextTokens,
  timeoutSeconds: p.timeoutSeconds,
  autoCompactPercent: p.autoCompactPercent ?? 80,
  thinking: { ...p.thinking },
  cache: p.cache,
});
export function mergeAdvanced(
  profile: ProviderProfile,
  advanced: unknown,
): ProviderProfile {
  if (advanced === undefined) return profile;
  input(
    advanced &&
      typeof advanced === "object" &&
      !Array.isArray(advanced) &&
      Object.keys(advanced).every((k) =>
        Object.hasOwn(advancedProfile(profile), k),
      ),
  );
  return validateProfile({ ...profile, ...advanced });
}
const modelView = (m: ModelInfo): MobileModelInfo => ({
  id: m.id.slice(0, 200),
  name: m.name.slice(0, 200),
  ...Object.fromEntries(
    ["contextWindow", "inputLimit", "outputLimit"].flatMap((k) => {
      const n = m[k as keyof ModelInfo];
      return typeof n === "number" && Number.isSafeInteger(n) && n > 0
        ? [[k, n]]
        : [];
    }),
  ),
  ...(m.inputModalities
    ? {
        inputModalities: m.inputModalities
          .filter((v) => typeof v === "string")
          .slice(0, 20)
          .map((v) => v.slice(0, 40)),
      }
    : {}),
});

/** 管理操作复用模型路由与会话所有者；测试不进入聊天历史，也不携带记忆。 */
export function mobileModel(kernel: Kernel) {
  const settings = kernel.resolve("settings"),
    registry = kernel.resolve("llm.registry"),
    management = kernel.resolve("llm.management"),
    history = kernel.resolve("conversation.history");
  let testing: { id: string; abort: AbortController } | undefined;
  const profile = (p: Record<string, unknown>) => {
    input(
      typeof p.kind === "string" &&
        (MOBILE_PROVIDER_KINDS as readonly string[]).includes(p.kind),
    );
    input(
      typeof p.baseUrl === "string" &&
        p.baseUrl.length <= 2000 &&
        typeof p.model === "string" &&
        p.model.length <= 200,
    );
    const current = settings.get().provider;
    const defaults = registry.list().find((v) => v.id === p.kind)!.defaults;
    const saved =
      current.kind === p.kind
        ? current
        : (current.savedProfiles[p.kind] ?? defaults);
    try {
      return validateProfile(
        mergeAdvanced(
          {
            ...defaults,
            ...saved,
            kind: p.kind,
            baseUrl: p.baseUrl,
            model: p.model,
          },
          p.advanced,
        ),
      );
    } catch {
      throw Error("INVALID_INPUT");
    }
  };
  const context = async (conversationId: unknown): Promise<MobileContext> => {
    input(
      typeof conversationId === "string" &&
        /^[a-f0-9-]{36}$/.test(conversationId),
    );
    let saved;
    try {
      saved = await history.read(conversationId);
    } catch {
      throw Error("NOT_FOUND");
    }
    const status = kernel.resolve("conversation").state().session;
    const checkpoint = saved.context?.checkpoint;
    return {
      conversationId,
      active: saved.active,
      ...(saved.active && status?.id === conversationId
        ? {
            status: {
              id: status.id,
              epoch: status.epoch,
              retainedMessages: status.retainedMessages,
              inputTokens: status.inputTokens,
              exact: status.exact,
              inputBudget: status.inputBudget,
              limitSource: status.limitSource,
              trimmedMessages: status.trimmedMessages,
              compactions: status.compactions ?? 0,
              ...(status.compactThreshold === undefined
                ? {}
                : { compactThreshold: status.compactThreshold }),
              ...(status.usage ? { usage: { ...status.usage } } : {}),
            },
          }
        : {}),
      ...(checkpoint
        ? {
            checkpoint: {
              id: checkpoint.id,
              created: checkpoint.created,
              compactions: saved.context!.compactions,
              truncated: summaryFields.some(
                (key) =>
                  checkpoint.summary[key].length > 100 ||
                  checkpoint.summary[key].some((v) => v.length > 4000),
              ),
              summary: Object.fromEntries(
                summaryFields.map((key) => [
                  key,
                  checkpoint.summary[key]
                    .slice(0, 100)
                    .map((v) => v.slice(0, 4000)),
                ]),
              ) as NonNullable<MobileContext["checkpoint"]>["summary"],
            },
          }
        : {}),
    };
  };
  return async (method: string, p: Record<string, unknown> = {}) => {
    input(p && typeof p === "object" && !Array.isArray(p));
    if (method === "conversation.context") return context(p.conversationId);
    if (method === "context.archive") {
      await context(p.conversationId);
      const prefix = `context-${createHash("sha256").update(String(p.conversationId)).digest("hex").slice(0, 24)}-`;
      input(
        typeof p.checkpoint === "string" &&
          p.checkpoint.startsWith(prefix) &&
          /^context-[a-f0-9]{24}-[a-f0-9-]{36}$/.test(p.checkpoint),
      );
      input(
        p.offset === undefined ||
          (Number.isSafeInteger(p.offset) && Number(p.offset) >= 0),
      );
      input(
        p.query === undefined ||
          (typeof p.query === "string" && p.query.length <= 200),
      );
      try {
        return await kernel
          .resolve("context.compaction")
          .read(
            p.checkpoint,
            p.offset as number | undefined,
            p.query as string | undefined,
          );
      } catch {
        throw Error("NOT_FOUND");
      }
    }
    if (method === "provider.test.cancel") {
      input(typeof p.operationId === "string" && p.operationId.length <= 100);
      if (testing?.id === p.operationId) testing.abort.abort();
      return;
    }
    const config = profile(p);
    if (method === "provider.inspect") {
      const info = management.inspect(config);
      return {
        hasKey: info.hasKey,
        options: { ...info.options },
        ...(info.model ? { model: modelView(info.model) } : {}),
      };
    }
    if (method === "provider.models") {
      input(p.refresh === undefined || typeof p.refresh === "boolean");
      try {
        return {
          kind: config.kind,
          baseUrl: config.baseUrl,
          items: (
            await management.models(config, p.refresh as boolean | undefined)
          ).map(modelView),
        };
      } catch {
        throw Error("PROVIDER");
      }
    }
    if (method === "provider.test") {
      input(
        typeof p.operationId === "string" &&
          /^[a-zA-Z0-9:-]{1,100}$/.test(p.operationId),
      );
      const saved = validateProfile(settings.get().provider);
      if (JSON.stringify(saved) !== JSON.stringify(config))
        throw Error("CONFLICT");
      if (testing) throw Error("BUSY");
      const abort = new AbortController(),
        id = p.operationId;
      testing = { id, abort };
      const started = Date.now();
      try {
        await kernel
          .resolve("llm.chat")
          .test({ settings: config, signal: abort.signal, timeoutMs: 20000 });
        return { connected: true, elapsedMs: Date.now() - started };
      } catch {
        throw Error(abort.signal.aborted ? "CANCELLED" : "PROVIDER");
      } finally {
        if (testing?.id === id) testing = undefined;
      }
    }
    throw Error("UNAVAILABLE");
  };
}
