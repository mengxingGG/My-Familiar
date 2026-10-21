import {
  MobileBridgeError,
  MOBILE_PROVIDER_KINDS,
  type MobileProviderAdvanced,
  type MobileModelInfo,
} from "../mobile-contracts/index.ts";
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const number = (v: unknown, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const text = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length <= max;
const strings = (v: unknown, max: number, length: number): v is string[] =>
  Array.isArray(v) && v.length <= max && v.every((s) => text(s, length));
const modes = ["auto", "off", "effort", "budget", "adaptive"];
const assert: (v: unknown) => asserts v = (v) => {
  if (!v)
    throw new MobileBridgeError(
      "UNAVAILABLE",
      "模型管理返回格式不兼容，请重新打开。",
    );
};
export const validAdvanced = (v: unknown): v is MobileProviderAdvanced =>
  object(v) &&
  (v.temperature === null || number(v.temperature, 0, 2)) &&
  (v.topP === null || number(v.topP, Number.MIN_VALUE, 1)) &&
  integer(v.maxOutputTokens, 128, 262144) &&
  (v.contextTokens === null || integer(v.contextTokens, 1024, 2097152)) &&
  integer(v.timeoutSeconds, 10, 900) &&
  integer(v.autoCompactPercent, 10, 95) &&
  object(v.thinking) &&
  modes.includes(String(v.thinking.mode)) &&
  text(v.thinking.effort, 30) &&
  integer(v.thinking.budgetTokens, 1, 262144) &&
  typeof v.cache === "boolean";
export const projectAdvanced = (
  v: MobileProviderAdvanced,
): MobileProviderAdvanced => ({
  temperature: v.temperature,
  topP: v.topP,
  maxOutputTokens: v.maxOutputTokens,
  contextTokens: v.contextTokens,
  timeoutSeconds: v.timeoutSeconds,
  autoCompactPercent: v.autoCompactPercent,
  thinking: {
    mode: v.thinking.mode,
    effort: v.thinking.effort,
    budgetTokens: v.thinking.budgetTokens,
  },
  cache: v.cache,
});
const model = (v: unknown): MobileModelInfo => {
  assert(object(v) && text(v.id, 200) && text(v.name, 200));
  for (const key of ["contextWindow", "inputLimit", "outputLimit"])
    assert(v[key] === undefined || integer(v[key], 1));
  assert(v.inputModalities === undefined || strings(v.inputModalities, 20, 40));
  return {
    id: v.id,
    name: v.name,
    ...(v.contextWindow === undefined
      ? {}
      : { contextWindow: v.contextWindow as number }),
    ...(v.inputLimit === undefined
      ? {}
      : { inputLimit: v.inputLimit as number }),
    ...(v.outputLimit === undefined
      ? {}
      : { outputLimit: v.outputLimit as number }),
    ...(v.inputModalities
      ? { inputModalities: [...(v.inputModalities as string[])] }
      : {}),
  };
};
const summaryFields = [
  "goals",
  "constraints",
  "facts",
  "decisions",
  "progress",
  "pending",
  "uncertainties",
  "artifacts",
];
export function projectModelResult(
  method: string,
  value: unknown,
  params: unknown,
): unknown {
  const p = object(params) ? params : {};
  if (method === "provider.test.cancel") return undefined;
  assert(object(value));
  if (method === "provider.models") {
    assert(
      value.kind === p.kind &&
        text(value.baseUrl, 2000) &&
        Array.isArray(value.items) &&
        value.items.length <= 5000,
    );
    let expected;
    try {
      expected = new URL(String(p.baseUrl)).href.replace(/\/$/, "");
    } catch {
      assert(false);
    }
    assert(value.baseUrl === expected);
    return {
      kind: value.kind,
      baseUrl: value.baseUrl,
      items: value.items.map(model),
    };
  }
  if (method === "provider.inspect") {
    const o = value.options;
    assert(
      typeof value.hasKey === "boolean" &&
        object(o) &&
        strings(o.modes, 5, 20) &&
        o.modes.every((m) => modes.includes(m)) &&
        strings(o.efforts, 20, 30) &&
        typeof o.temperature === "boolean" &&
        number(o.temperatureMax, 0, 2) &&
        typeof o.topP === "boolean" &&
        number(o.topPMin, 0, 1) &&
        integer(o.budgetMin) &&
        (o.budgetMax === undefined || integer(o.budgetMax)) &&
        text(o.hint, 4000),
    );
    return {
      hasKey: value.hasKey,
      options: {
        modes: [...o.modes],
        efforts: [...o.efforts],
        temperature: o.temperature,
        temperatureMax: o.temperatureMax,
        topP: o.topP,
        topPMin: o.topPMin,
        budgetMin: o.budgetMin,
        ...(o.budgetMax === undefined ? {} : { budgetMax: o.budgetMax }),
        hint: o.hint,
      },
      ...(value.model ? { model: model(value.model) } : {}),
    };
  }
  if (method === "provider.test") {
    assert(value.connected === true && integer(value.elapsedMs));
    return { connected: true, elapsedMs: value.elapsedMs };
  }
  if (method === "conversation.context") {
    assert(
      value.conversationId === p.conversationId &&
        typeof value.active === "boolean",
    );
    let status, checkpoint;
    if (value.status !== undefined) {
      const s = value.status;
      assert(
        object(s) &&
          s.id === p.conversationId &&
          typeof s.exact === "boolean" &&
          ["model", "manual", "fallback"].includes(String(s.limitSource)),
      );
      for (const key of [
        "epoch",
        "retainedMessages",
        "inputTokens",
        "inputBudget",
        "trimmedMessages",
        "compactions",
      ])
        assert(integer(s[key]));
      assert(s.compactThreshold === undefined || integer(s.compactThreshold));
      let usage;
      if (s.usage !== undefined) {
        assert(object(s.usage));
        usage = Object.fromEntries(
          [
            "inputTokens",
            "outputTokens",
            "cachedInputTokens",
            "cacheWriteTokens",
          ].flatMap((k) => {
            if (s.usage && object(s.usage) && s.usage[k] !== undefined) {
              assert(integer(s.usage[k]));
              return [[k, s.usage[k]]];
            }
            return [];
          }),
        );
      }
      status = {
        id: s.id,
        epoch: s.epoch,
        retainedMessages: s.retainedMessages,
        inputTokens: s.inputTokens,
        exact: s.exact,
        inputBudget: s.inputBudget,
        limitSource: s.limitSource,
        trimmedMessages: s.trimmedMessages,
        compactions: s.compactions,
        ...(s.compactThreshold === undefined
          ? {}
          : { compactThreshold: s.compactThreshold }),
        ...(usage ? { usage } : {}),
      };
    }
    if (value.checkpoint !== undefined) {
      const c = value.checkpoint;
      assert(
        object(c) &&
          text(c.id, 100) &&
          /^context-[a-f0-9]{24}-[a-f0-9-]{36}$/.test(c.id) &&
          integer(c.created) &&
          integer(c.compactions) &&
          typeof c.truncated === "boolean" &&
          object(c.summary),
      );
      const summary = Object.fromEntries(
        summaryFields.map((k) => {
          const items = (c.summary as Record<string, unknown>)[k];
          assert(strings(items, 100, 4000));
          return [k, [...items]];
        }),
      );
      checkpoint = {
        id: c.id,
        created: c.created,
        compactions: c.compactions,
        truncated: c.truncated,
        summary,
      };
    }
    return {
      conversationId: value.conversationId,
      active: value.active,
      ...(status ? { status } : {}),
      ...(checkpoint ? { checkpoint } : {}),
    };
  }
  if (method === "context.archive") {
    assert(
      text(value.text, 16000) &&
        integer(value.totalCharacters) &&
        (value.nextOffset === null || integer(value.nextOffset)) &&
        (value.previous === undefined ||
          (text(value.previous, 100) &&
            /^context-[a-f0-9]{24}-[a-f0-9-]{36}$/.test(value.previous))),
    );
    return {
      text: value.text,
      nextOffset: value.nextOffset,
      totalCharacters: value.totalCharacters,
      ...(value.previous ? { previous: value.previous } : {}),
    };
  }
  throw new MobileBridgeError("UNAVAILABLE", "模型管理操作尚未接入。");
}
