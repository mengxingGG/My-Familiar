import test from "node:test";
import assert from "node:assert/strict";
import { Kernel } from "../packages/kernel/index.ts";
import {
  definePlugin,
  profileDefaults,
  type ContextInput,
  type ContextSummary,
} from "../packages/contracts/index.ts";
import {
  contextCompaction,
  parseSummary,
} from "../plugins/context-compaction/index.ts";
import { validateProfile } from "../plugins/llm-shared/config.ts";

const summary: ContextSummary = {
  goals: ["森林行程"],
  constraints: ["预算 300 元，不能更改日期"],
  facts: ["9 月 22 日"],
  decisions: ["先确认交通"],
  progress: ["已查时刻表"],
  pending: ["尚未订票"],
  uncertainties: ["午餐待确认"],
  artifacts: ["plan.md；用户消息 u0"],
};
async function fixture(
  store = new Map<string, any>(),
  output = JSON.stringify(summary),
  pause = false,
) {
  const k = new Kernel(),
    calls: any[] = [];
  k.install(
    definePlugin({
      manifest: {
        manifestVersion: 1,
        id: "test.context",
        version: "1",
        provides: ["llm.chat", "llm.management", "storage.local"],
        requires: [],
      },
      start(ctx) {
        ctx.provide("storage.local", {
          read: async (key, fallback) =>
            structuredClone(store.get(key) ?? fallback),
          write: async (key, value) => {
            store.set(key, structuredClone(value));
          },
        });
        ctx.provide("llm.management", {
          count: async ({ messages }) => ({
            tokens: messages.reduce((n, m) => n + m.content.length, 0),
            exact: true,
          }),
          plan: async () => ({
            contextWindow: 12000,
            inputBudget: 10000,
            source: "manual",
          }),
          models: async () => [],
          validate: (v) => v,
          inspect: () => ({ options: {} as any, hasKey: true }),
        });
        ctx.provide("llm.chat", {
          test: async () => "ok",
          async *stream(input) {
            calls.push(structuredClone(input.messages));
            if (pause)
              await new Promise((_, reject) => {
                if (input.signal.aborted) reject(input.signal.reason);
                else
                  input.signal.addEventListener(
                    "abort",
                    () => reject(input.signal.reason),
                    { once: true },
                  );
              });
            yield output;
          },
        });
      },
    }),
  );
  k.install(contextCompaction);
  await k.startAll();
  return { k, calls, store, service: k.resolve("context.compaction") };
}
function input(overrides: Partial<ContextInput> = {}): ContextInput {
  const history = Array.from({ length: 5 }, (_, n) => [
    {
      id: `u${n}`,
      role: "user",
      content: `第 ${n} 次：预算 300 元。` + "x".repeat(1800),
    },
    {
      id: `a${n}`,
      role: "assistant",
      content: "已查时刻表，尚未订票。",
      native: { scope: "private", items: ["不要出现在摘要中的隐藏思考"] },
    },
  ]).flat();
  return {
    sessionId: "desktop-one",
    system: { role: "system", content: "陪伴助手" },
    history: [
      ...history,
      { id: "now", role: "user", content: "继续，先别买票" },
    ],
    settings: { ...profileDefaults, maxOutputTokens: 1024 },
    plan: { contextWindow: 12000, inputBudget: 10500, source: "manual" },
    toolTokens: 1000,
    signal: new AbortController().signal,
    ...overrides,
  };
}
test("默认阈值与校验兼容旧配置", () => {
  assert.equal(validateProfile(profileDefaults).autoCompactPercent, 80);
  assert.equal(
    validateProfile({ ...profileDefaults, autoCompactPercent: undefined })
      .autoCompactPercent,
    80,
  );
  assert.throws(
    () => validateProfile({ ...profileDefaults, autoCompactPercent: 100 }),
    /百分比/,
  );
  assert.throws(() => parseSummary('{"goals":["缺少状态"]}'), /完整/);
});
test("模型交接保留近期整轮、工具配对、原文回查和上一份摘要；重启可读取", async () => {
  const h = await fixture();
  try {
    const source = input();
    source.history.splice(
      3,
      0,
      {
        id: "call",
        role: "assistant",
        content: "",
        calls: [
          { id: "t1", name: "files_read", arguments: '{"path":"plan.md"}' },
        ],
      },
      {
        id: "result",
        role: "tool",
        content: "plan.md: 预算 300 元",
        toolCallId: "t1",
      },
    );
    const original = structuredClone(source.history),
      result = await h.service.prepare(source);
    assert.ok(result.checkpoint);
    assert.equal(result.threshold, 8600);
    assert.equal(source.history[result.dropped].role, "user");
    assert.equal(result.messages.at(-1)?.content, "继续，先别买票");
    assert.ok(result.tokens < result.threshold);
    assert.deepEqual(source.history, original);
    assert.deepEqual(result.checkpoint!.summary, summary);
    assert.doesNotMatch(JSON.stringify(h.calls), /隐藏思考/);
    let ref: string | undefined = result.checkpoint!.id,
      raw = "";
    while (ref) {
      const part = await h.service.read(ref);
      raw += part.text;
      ref = part.previous;
    }
    assert.match(raw, /plan.md/);
    assert.match(raw, /toolCallId/);
    const resumed = input({
      checkpoint: result.checkpoint,
      history: source.history.slice(result.dropped),
    });
    const count = h.calls.length;
    const kept = await h.service.prepare(resumed);
    assert.equal(h.calls.length, count);
    assert.equal(kept.dropped, 0);
    assert.equal(kept.checkpoint?.id, result.checkpoint!.id);
    const again = await h.service.prepare(
      input({ checkpoint: result.checkpoint }),
    );
    assert.equal(again.checkpoint?.previous, result.checkpoint!.id);
    assert.ok(h.calls.at(-1)[1].content.includes("不能更改日期"));
    await h.k.dispose();
    const restart = await fixture(h.store);
    assert.ok(
      (await restart.service.read(result.checkpoint!.id)).totalCharacters > 0,
    );
    await restart.service.forget(source.sessionId);
    await assert.rejects(restart.service.read(result.checkpoint!.id), /不存在/);
    await restart.k.dispose();
  } finally {
    await h.k.dispose();
  }
});
test("兼容服务拒绝思考参数时仅回退一次，后续分块不重复试错", async () => {
  const h = await fixture();
  const modes: string[] = [];
  h.k.resolve("llm.management").inspect = () => ({
    options: { modes: ["auto", "off"] } as any,
    hasKey: true,
  });
  h.k.resolve("llm.chat").stream = async function* (request) {
    modes.push(request.settings.thinking.mode);
    if (request.settings.thinking.mode === "off")
      throw new Error("模型拒绝参数（400）");
    yield JSON.stringify(summary);
  };
  try {
    const source = input();
    source.history[0].content = "旧资料".repeat(12000);
    assert.ok((await h.service.prepare(source)).checkpoint);
    assert.equal(modes[0], "off");
    assert.ok(modes.slice(1).every((m) => m === "auto"));
  } finally {
    await h.k.dispose();
  }
});
test("坏摘要、取消和超大当前输入均不移动调用方起点、不删除原文", async () => {
  const h = await fixture(undefined, "普通聊天回复");
  const source = input(),
    before = structuredClone(source.history);
  try {
    await assert.rejects(h.service.prepare(source));
    assert.deepEqual(source.history, before);
    assert.equal(h.store.size, 0);
    await assert.rejects(
      h.service.prepare(
        input({
          history: [{ id: "big", role: "user", content: "x".repeat(11000) }],
        }),
      ),
      /当前输入/,
    );
  } finally {
    await h.k.dispose();
  }
  const cancelled = await fixture(undefined, undefined, true),
    abort = new AbortController();
  try {
    const run = cancelled.service.prepare(input({ signal: abort.signal }));
    const rejection = assert.rejects(run);
    for (let n = 0; n < 100 && !cancelled.calls.length; n++)
      await new Promise((r) => setTimeout(r, 5));
    abort.abort();
    await rejection;
    assert.equal(cancelled.store.size, 0);
  } finally {
    await cancelled.k.dispose();
  }
});
test("超过模型窗口的旧历史分块压缩，摘要索引按会话隔离", async () => {
  const h = await fixture();
  try {
    const source = input();
    source.history[0].content = "很长的旧工具资料".repeat(10000);
    const result = await h.service.prepare(source);
    assert.ok(h.calls.length > 2);
    for (const messages of h.calls)
      assert.ok(
        messages.reduce((n: number, m: any) => n + m.content.length, 0) < 10500,
      );
    const other = await h.service.prepare(
      input({ sessionId: "feishu-another" }),
    );
    assert.notEqual(
      result.checkpoint!.id.split("-")[1],
      other.checkpoint!.id.split("-")[1],
    );
    await assert.rejects(h.service.read("../../memory/CORE.md"), /无效/);
  } finally {
    await h.k.dispose();
  }
});
