import { conversationFixture } from "./conversation-fixture.ts";
import type { ToolCall, PromptMessage } from "../packages/contracts/index.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { Kernel } from "../packages/kernel/index.ts";
import {
  defaults,
  profileDefaults,
  type ProviderDefinition,
  type ProviderProfile,
  type ProviderInput,
  type NativeTurn,
} from "../packages/contracts/index.ts";
import { compatibleDefinition } from "../plugins/provider-compatible/index.ts";
import { openaiDefinition } from "../plugins/provider-openai/index.ts";
import { deepseekDefinition } from "../plugins/provider-deepseek/index.ts";
import { geminiDefinition } from "../plugins/provider-gemini/index.ts";
import { claudeDefinition } from "../plugins/provider-claude/index.ts";
import { openrouterDefinition } from "../plugins/provider-openrouter/index.ts";
import { llamacppDefinition } from "../plugins/provider-llamacpp/index.ts";
import { llmRegistry } from "../plugins/llm-registry/index.ts";
import { llmRouter, nativeScope } from "../plugins/llm-router/index.ts";
import {
  credentialScope,
  validateProfile,
} from "../plugins/llm-shared/config.ts";
import { baseOptions } from "../plugins/llm-shared/chat-completions.ts";
import { conversation } from "../plugins/conversation/index.ts";
import { fitContext } from "../plugins/conversation/context.ts";

type Recorded = { url: string; headers: Record<string, unknown>; body: any };
async function fixture(
  handler: (request: Recorded, res: ServerResponse) => void,
  run: (url: string, requests: Recorded[]) => Promise<void>,
) {
  const requests: Recorded[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = {
      url: req.url!,
      headers: req.headers,
      body: raw ? JSON.parse(raw) : undefined,
    };
    requests.push(request);
    handler(request, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await run(
      `http://127.0.0.1:${(server.address() as any).port}/v1`,
      requests,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
const json = (res: ServerResponse, value: unknown) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
};
const events = (res: ServerResponse, values: unknown[], done = false) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const v of values) res.write(`data: ${JSON.stringify(v)}\r\n\r\n`);
  res.end(done ? "data: [DONE]\n\n" : "");
};
const config = (p: ProviderDefinition, url = p.baseUrl): ProviderProfile => ({
  ...structuredClone(profileDefaults),
  kind: p.id,
  baseUrl: url,
  model: "fixture",
});
async function collect(
  p: ProviderDefinition,
  c: ProviderProfile,
  extra: Partial<ProviderInput> = {},
) {
  let text = "",
    usage = {},
    native: NativeTurn | undefined;
  const input: ProviderInput = {
    settings: c,
    messages: [
      { role: "system", content: "固定人格" },
      { role: "user", content: "你好" },
    ],
    signal: AbortSignal.timeout(2000),
    key: "fixture-key",
    sessionKey: "stable-session",
    nativeScope: nativeScope(c),
    onUsage: (v) => {
      usage = { ...usage, ...v };
    },
    onNative: (v) => {
      native = v;
    },
    ...extra,
  };
  for await (const chunk of p.stream(input)) text += chunk;
  return { text, usage, native };
}
for (const p of [
  compatibleDefinition,
  deepseekDefinition,
  openrouterDefinition,
  llamacppDefinition,
])
  test(`${p.id} 正确协议、参数、用量与推理过滤`, async () => {
    await fixture(
      (req, res) => {
        if (req.url === "/v1/models")
          return json(res, {
            data: [
              {
                id: "fixture",
                context_length: 65536,
                supported_parameters: ["reasoning", "temperature", "top_p"],
              },
            ],
          });
        if (req.url === "/props")
          return json(res, { default_generation_settings: { n_ctx: 8192 } });
        events(
          res,
          [
            { choices: [{ delta: { reasoning_content: "不能显示" } }] },
            ...["<th", "ink>内部", "思考</thi", "nk>你好🌿"].map((content) => ({
              choices: [{ delta: { content } }],
            })),
            {
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 120,
                completion_tokens: 10,
                prompt_cache_hit_tokens: 80,
                prompt_tokens_details: { cache_write_tokens: 20 },
              },
            },
          ],
          true,
        );
      },
      async (url, requests) => {
        const c = config(p, url);
        c.thinking = {
          mode: p.id === "llamacpp" ? "budget" : "effort",
          effort: "high",
          budgetTokens: 1024,
        };
        const result = await collect(p, c);
        assert.equal(result.text, "你好🌿");
        assert.deepEqual(result.usage, {
          inputTokens: 120,
          outputTokens: 10,
          cachedInputTokens: 80,
          cacheWriteTokens: 20,
        });
        const r = requests[0];
        assert.equal(r.url, "/v1/chat/completions");
        assert.equal(r.headers.authorization, "Bearer fixture-key");
        assert.equal(r.body.temperature, undefined);
        if (p.id === "deepseek")
          assert.deepEqual(r.body.thinking, { type: "enabled" });
        if (p.id === "openrouter") {
          assert.equal(r.body.session_id, "stable-session");
          assert.equal(r.body.reasoning.exclude, true);
          assert.equal(r.body.reasoning.effort, "high");
        }
        if (p.id === "llamacpp") {
          assert.equal(r.body.reasoning_budget_tokens, 1024);
          assert.equal(r.body.cache_prompt, true);
        }
        const models = await p.models({
          settings: c,
          signal: AbortSignal.timeout(2000),
          key: "fixture-key",
        });
        assert.equal(
          models[0].contextWindow,
          p.id === "llamacpp" ? 8192 : 65536,
        );
      },
    );
  });
test("OpenAI Responses 保持原生加密推理、缓存键、计数且不展示推理", async () => {
  const output = [
    { type: "reasoning", id: "rs_1", encrypted_content: "opaque", summary: [] },
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "你好", annotations: [] }],
    },
  ];
  await fixture(
    (req, res) => {
      if (req.url.endsWith("input_tokens"))
        return json(res, { input_tokens: 90 });
      events(res, [
        { type: "response.reasoning_summary_text.delta", delta: "隐藏" },
        { type: "response.output_text.delta", delta: "你好" },
        {
          type: "response.completed",
          response: {
            output,
            usage: {
              input_tokens: 100,
              output_tokens: 9,
              input_tokens_details: { cached_tokens: 80 },
            },
          },
        },
      ]);
    },
    async (url, requests) => {
      const c = config(openaiDefinition, url);
      c.model = "gpt-5";
      c.thinking.mode = "effort";
      c.thinking.effort = "high";
      const first = await collect(openaiDefinition, c);
      assert.equal(first.text, "你好");
      assert.equal((first.usage as any).cachedInputTokens, 80);
      assert.deepEqual(first.native?.items, output);
      const messages = [
        { role: "assistant", content: first.text, native: first.native },
        { role: "user", content: "继续" },
      ];
      await collect(openaiDefinition, c, { messages });
      assert.deepEqual(requests[1].body.input.slice(0, 2), output);
      assert.equal(requests[0].body.store, false);
      assert.equal(
        requests[0].body.prompt_cache_key,
        requests[1].body.prompt_cache_key,
      );
      assert.equal(
        await openaiDefinition.countTokens!({
          settings: c,
          messages,
          signal: AbortSignal.timeout(2000),
          key: "k",
          nativeScope: nativeScope(c),
        }),
        90,
      );
      c.model = "other";
      await collect(openaiDefinition, c, { messages });
      assert.deepEqual(
        requests.at(-1)!.body.input[0],
        { role: "assistant", content: "你好" },
        "切换模型不能重放其他模型的原生状态",
      );
    },
  );
});
test("Claude Messages 思考签名保留、自动缓存、目录能力与计数", async () => {
  await fixture(
    (req, res) => {
      if (req.url.includes("/models"))
        return json(res, {
          data: [
            {
              id: "fixture",
              display_name: "Fixture",
              max_input_tokens: 200000,
              max_tokens: 8192,
              capabilities: {
                thinking: {
                  supported: true,
                  types: {
                    enabled: { supported: true },
                    adaptive: { supported: false },
                  },
                },
                effort: { supported: true, high: { supported: true } },
              },
            },
          ],
          has_more: false,
        });
      if (req.url.endsWith("count_tokens"))
        return json(res, { input_tokens: 100 });
      events(res, [
        {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 20,
              cache_read_input_tokens: 80,
              cache_creation_input_tokens: 10,
            },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "隐藏思考" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig" },
        },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "你好" },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 12 },
        },
        { type: "message_stop" },
      ]);
    },
    async (url, requests) => {
      const c = config(claudeDefinition, url);
      c.thinking.mode = "budget";
      c.thinking.budgetTokens = 1024;
      const result = await collect(claudeDefinition, c);
      assert.equal(result.text, "你好");
      assert.equal(requests[0].headers["x-api-key"], "fixture-key");
      assert.equal(requests[0].headers.authorization, undefined);
      assert.deepEqual(requests[0].body.thinking, {
        type: "enabled",
        budget_tokens: 1024,
      });
      assert.deepEqual(requests[0].body.cache_control, { type: "ephemeral" });
      assert.equal((result.usage as any).inputTokens, 110);
      await collect(claudeDefinition, c, {
        messages: [
          { role: "assistant", content: result.text, native: result.native },
          { role: "user", content: "继续" },
        ],
      });
      assert.equal(requests[1].body.messages[0].content[0].signature, "sig");
      const models = await claudeDefinition.models({
        settings: c,
        key: "k",
        signal: AbortSignal.timeout(2000),
      });
      assert.ok(models[0].thinking?.modes.includes("budget"));
      assert.equal(models[0].thinking?.modes.includes("adaptive"), false);
      assert.equal(
        await claudeDefinition.countTokens!({
          settings: c,
          key: "k",
          messages: [],
          signal: AbortSignal.timeout(2000),
        }),
        100,
      );
    },
  );
});
test("Gemini 原生流、隐藏 thought、签名回放、分页目录和输入输出上限", async () => {
  await fixture(
    (req, res) => {
      if (req.url.includes(":countTokens"))
        return json(res, { totalTokens: 80 });
      if (req.url.includes("/models?") && !req.url.includes("pageToken"))
        return json(res, {
          models: [
            {
              name: "models/gemini-2.5-flash",
              displayName: "Flash",
              supportedGenerationMethods: ["generateContent"],
              inputTokenLimit: 1000000,
              outputTokenLimit: 65536,
            },
            {
              name: "models/embed",
              supportedGenerationMethods: ["embedContent"],
            },
          ],
          nextPageToken: "next",
        });
      if (req.url.includes("pageToken")) return json(res, { models: [] });
      events(res, [
        {
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: "隐藏" },
                  { text: "你好", thoughtSignature: "sig" },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 4,
            thoughtsTokenCount: 12,
            cachedContentTokenCount: 80,
          },
        },
      ]);
    },
    async (url, requests) => {
      const c = config(geminiDefinition, url);
      c.model = "gemini-2.5-flash";
      c.thinking.mode = "budget";
      const result = await collect(geminiDefinition, c);
      assert.equal(result.text, "你好");
      assert.equal(requests[0].headers["x-goog-api-key"], "fixture-key");
      assert.equal(
        requests[0].body.generationConfig.thinkingConfig.thinkingBudget,
        2048,
      );
      await collect(geminiDefinition, c, {
        messages: [
          { role: "assistant", content: "你好", native: result.native },
          { role: "user", content: "继续" },
        ],
      });
      assert.equal(
        requests[1].body.contents[0].parts[1].thoughtSignature,
        "sig",
      );
      const models = await geminiDefinition.models({
        settings: c,
        key: "k",
        signal: AbortSignal.timeout(2000),
      });
      assert.equal(models.length, 1);
      assert.equal(models[0].inputLimit, 1000000);
      assert.equal(
        await geminiDefinition.countTokens!({
          settings: c,
          key: "k",
          messages: [],
          signal: AbortSignal.timeout(2000),
        }),
        80,
      );
    },
  );
});
test("各原生协议的中断和输出截断不会标记为成功", async () => {
  for (const [provider, payload] of [
    [openaiDefinition, { type: "response.incomplete" }],
    [
      claudeDefinition,
      { type: "message_delta", delta: { stop_reason: "max_tokens" } },
    ],
    [geminiDefinition, { candidates: [{ finishReason: "MAX_TOKENS" }] }],
    [compatibleDefinition, { choices: [{ finish_reason: "length" }] }],
  ] as const) {
    await fixture(
      (_req, res) => events(res, [payload]),
      async (url) => {
        await assert.rejects(
          collect(provider, config(provider, url)),
          /上限|完整/,
        );
      },
    );
    await fixture(
      (_req, res) => events(res, []),
      async (url) => {
        await assert.rejects(
          collect(provider, config(provider, url)),
          /提前结束/,
        );
      },
    );
  }
});
test("llama.cpp 模板分词与实际运行上下文，训练上限不冒充已分配上限", async () => {
  await fixture(
    (req, res) => {
      if (req.url.endsWith("/models"))
        return json(res, {
          data: [{ id: "fixture", meta: { n_ctx_train: 1000000 } }],
        });
      if (req.url.endsWith("/props")) {
        res.writeHead(404);
        return res.end();
      }
      if (req.url.endsWith("/apply-template"))
        return json(res, { prompt: "<bos>hello" });
      json(res, { tokens: [1, 2, 3] });
    },
    async (url, requests) => {
      const c = config(llamacppDefinition, url);
      assert.equal(
        (
          await llamacppDefinition.models({
            settings: c,
            key: "",
            signal: AbortSignal.timeout(2000),
          })
        )[0].contextWindow,
        undefined,
      );
      assert.equal(
        await llamacppDefinition.countTokens!({
          settings: c,
          key: "",
          messages: [{ role: "user", content: "hello" }],
          signal: AbortSignal.timeout(2000),
        }),
        3,
      );
      assert.equal(requests.at(-1)!.body.parse_special, true);
    },
  );
});
test("上下文保留最长完整轮次，超预算才裁剪，当前输入超限给出错误", async () => {
  const system = { role: "system", content: "fixed" },
    history = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
      { role: "user", content: "e" },
    ];
  const count = async (m: any[]) => ({ tokens: m.length * 10, exact: true });
  assert.equal((await fitContext(system, history, 60, count)).dropped, 0);
  const trim = await fitContext(system, history, 40, count);
  assert.equal(trim.dropped, 2);
  assert.deepEqual(trim.messages, history.slice(2));
  await assert.rejects(fitContext(system, history, 15, count), /当前输入/);
});

function harness(
  store = new Map<string, any>(),
  profile = config(compatibleDefinition),
  provider: ProviderDefinition = compatibleDefinition,
) {
  const k = new Kernel(),
    keys = new Map<string, string>(),
    captured: ProviderInput[] = [];
  let current = {
    ...structuredClone(defaults),
    provider: { ...profile, savedProfiles: {} },
  };
  k.install(llmRegistry);
  k.install({
    manifest: {
      manifestVersion: 1,
      id: "test.services",
      version: "1",
      provides: ["settings", "storage.local", "secrets.local"],
      requires: ["llm.registry"],
    },
    start(ctx) {
      ctx.provide("settings", {
        patchPet: async (patch) => ({
          ...structuredClone(defaults),
          pet: { ...defaults.pet, ...patch },
        }),
        get: () => structuredClone(current),
        apply: async (value) => (current = value),
      });
      ctx.provide("storage.local", {
        read: async (key, fallback) =>
          structuredClone(store.get(key) ?? fallback),
        write: async (key, value) => {
          store.set(key, structuredClone(value));
        },
      });
      ctx.provide("secrets.local", {
        has: (scope) => keys.has(scope),
        get: (scope) => keys.get(scope) ?? "",
        set: async (scope, key) => {
          keys.set(scope, key);
          ctx.emit("secrets.changed", scope);
        },
      });
      ctx.effect(
        ctx.use("llm.registry").register({
          ...provider,
          stream: async function* (input) {
            captured.push(input);
            yield "回复";
            input.onNative?.({
              scope: input.nativeScope!,
              items: [{ type: "thinking", thinking: "private thought" }],
            });
            input.onUsage?.({
              inputTokens: 200,
              cachedInputTokens: 150,
              outputTokens: 2,
            });
          },
        }),
      );
    },
  });
  k.install(llmRouter);
  k.install(conversationFixture);
  k.install(conversation);
  return { k, store, captured, current, keys };
}
async function idle(k: Kernel) {
  for (let i = 0; i < 200 && k.resolve("conversation").state().busy; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(k.resolve("conversation").state().busy, false);
}
const fake: ProviderDefinition = {
  ...compatibleDefinition,
  options: () => baseOptions,
  models: async () => [
    {
      id: "fixture",
      name: "fixture",
      contextWindow: 200000,
      outputLimit: 65536,
    },
  ],
  countTokens: async (input) =>
    input.messages.reduce((n, m) => n + m.content.length, 0),
};
test("长会话追加保持相同前缀与缓存键，重启保持会话，私有原生状态不出现在 UI", async () => {
  const h = harness(undefined, config(fake), fake);
  await h.k.startAll();
  for (let i = 0; i < 4; i++) {
    await h.k.resolve("conversation").send(String(i) + "字".repeat(6000));
    await idle(h.k);
  }
  assert.equal(h.captured.length, 4);
  assert.equal(h.captured[0].sessionKey, h.captured[3].sessionKey);
  assert.deepEqual(h.captured[1].messages.slice(0, 2), h.captured[0].messages);
  assert.ok(
    h.captured[3].messages.map((m) => m.content).join("").length > 24000,
  );
  assert.equal(h.k.resolve("conversation").state().session?.trimmedMessages, 0);
  assert.equal(
    JSON.stringify(h.k.resolve("conversation").state()).includes(
      "private thought",
    ),
    false,
  );
  const key = h.captured[3].sessionKey;
  await h.k.dispose();
  const restart = harness(h.store, config(fake), fake);
  await restart.k.startAll();
  await restart.k.resolve("conversation").send("继续");
  await idle(restart.k);
  assert.equal(restart.captured[0].sessionKey, key);
  assert.equal(restart.captured[0].messages.length, 10);
  await restart.k.resolve("conversation").clear();
  await restart.k.resolve("conversation").send("新会话");
  await idle(restart.k);
  assert.notEqual(restart.captured[1].sessionKey, key);
  await restart.k.dispose();
});
test("靠近上限才移动整轮前缀，取消轮次不重放，手动上限不能超模型上限", async () => {
  const c = config(fake);
  c.contextTokens = 2048;
  c.maxOutputTokens = 128;
  const h = harness(undefined, c, fake);
  await h.k.startAll();
  for (let i = 0; i < 5; i++) {
    await h.k.resolve("conversation").send(String(i) + "a".repeat(600));
    await idle(h.k);
  }
  const state = h.k.resolve("conversation").state();
  assert.ok(state.session!.trimmedMessages > 0);
  assert.equal(state.session!.trimmedMessages % 2, 0);
  assert.notEqual(h.captured[0].sessionKey, h.captured.at(-1)!.sessionKey);
  assert.ok(state.session!.inputTokens <= state.session!.inputBudget);
  const p = await h.k
    .resolve("llm.management")
    .plan({ ...c, contextTokens: 1000000 });
  assert.equal(p.contextWindow, 200000);
  await h.k.dispose();
});
test("目录能力验证、密钥地址隔离和旧配置兼容", async () => {
  const p = {
    ...fake,
    id: "openrouter",
    options: openrouterDefinition.options,
    models: async () => [
      {
        id: "fixture",
        name: "fixture",
        contextWindow: 32768,
        outputLimit: 2048,
        supportedParameters: ["temperature"],
      },
    ],
  };
  const c = config(p);
  c.maxOutputTokens = 1024;
  const h = harness(undefined, c, p);
  await h.k.startAll();
  const m = h.k.resolve("llm.management");
  await m.models(c);
  assert.deepEqual(m.inspect(c).options.modes, ["auto"]);
  assert.throws(() => m.validate({ ...c, topP: 0.8 }), /Top P/);
  assert.throws(() => m.validate({ ...c, maxOutputTokens: 4096 }), /输出上限/);
  await h.k.resolve("secrets.local").set(credentialScope(c), "key");
  assert.equal(m.inspect(c).hasKey, true);
  assert.equal(
    m.inspect({ ...c, baseUrl: "http://localhost:9999/v1" }).hasKey,
    false,
  );
  assert.notEqual(
    credentialScope(c),
    credentialScope({ ...c, kind: "compatible" }),
  );
  const legacy = validateProfile({
    baseUrl: "http://localhost:1234/v1",
    model: "local",
    temperature: 0.7,
  });
  assert.equal(legacy.kind, "compatible");
  assert.equal(legacy.thinking.mode, "auto");
  await h.k.dispose();
});
test("模型目录加载期间取消不必等待网络超时", async () => {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  const p = {
    ...fake,
    models: async () => {
      await wait;
      return [];
    },
  };
  const h = harness(undefined, config(p), p);
  await h.k.startAll();
  await h.k.resolve("conversation").send("取消目录加载");
  await new Promise((r) => setTimeout(r, 5));
  const start = Date.now();
  await h.k.resolve("conversation").cancel();
  assert.ok(Date.now() - start < 200);
  assert.equal(
    h.k.resolve("conversation").state().messages.at(-1)?.status,
    "cancelled",
  );
  release();
  await h.k.dispose();
});
test("更换凭据后原生会话状态隔离，保留可见文字历史", async () => {
  const p = { ...fake, id: "openai", requiresKey: true };
  const c = config(p),
    h = harness(undefined, c, p);
  await h.k.startAll();
  await h.k.resolve("secrets.local").set(credentialScope(c), "first-account");
  await h.k.resolve("conversation").send("第一轮");
  await idle(h.k);
  const firstScope = h.captured[0].nativeScope;
  await h.k.resolve("secrets.local").set(credentialScope(c), "second-account");
  await h.k.resolve("conversation").send("换凭据后继续");
  await idle(h.k);
  assert.notEqual(h.captured[1].nativeScope, firstScope);
  assert.equal(h.captured[1].messages[2].native?.scope, firstScope);
  assert.equal(h.captured[1].messages[2].content, "回复");
  assert.equal(
    JSON.stringify(h.store.get("conversation")).includes("first-account"),
    false,
  );
  await h.k.dispose();
});

for (const provider of [
  compatibleDefinition,
  deepseekDefinition,
  openrouterDefinition,
  llamacppDefinition,
  openaiDefinition,
  claudeDefinition,
  geminiDefinition,
])
  test(
    provider.id + " 工具流式参数、原生思考保留、结果回传和最终回复",
    async () => {
      let round = 0;
      await fixture(
        (req, res) => {
          round++;
          if (provider.id === "openai")
            return events(
              res,
              round === 1
                ? [
                    {
                      type: "response.completed",
                      response: {
                        output: [
                          {
                            type: "reasoning",
                            id: "rs1",
                            encrypted_content: "private",
                          },
                          {
                            type: "function_call",
                            id: "fc1",
                            call_id: "call1",
                            name: "echo",
                            arguments: '{"text":"你好"}',
                          },
                        ],
                      },
                    },
                  ]
                : [
                    { type: "response.output_text.delta", delta: "完成" },
                    {
                      type: "response.completed",
                      response: {
                        output: [
                          {
                            type: "message",
                            role: "assistant",
                            content: [{ type: "output_text", text: "完成" }],
                          },
                        ],
                      },
                    },
                  ],
            );
          if (provider.id === "claude")
            return events(
              res,
              round === 1
                ? [
                    {
                      type: "content_block_start",
                      index: 0,
                      content_block: {
                        type: "thinking",
                        thinking: "private",
                        signature: "sig",
                      },
                    },
                    {
                      type: "content_block_start",
                      index: 1,
                      content_block: {
                        type: "tool_use",
                        id: "call1",
                        name: "echo",
                        input: {},
                      },
                    },
                    {
                      type: "content_block_delta",
                      index: 1,
                      delta: {
                        type: "input_json_delta",
                        partial_json: '{"text":"你好"}',
                      },
                    },
                    {
                      type: "message_delta",
                      delta: { stop_reason: "tool_use" },
                    },
                    { type: "message_stop" },
                  ]
                : [
                    {
                      type: "content_block_start",
                      index: 0,
                      content_block: { type: "text", text: "完成" },
                    },
                    {
                      type: "message_delta",
                      delta: { stop_reason: "end_turn" },
                    },
                    { type: "message_stop" },
                  ],
            );
          if (provider.id === "gemini")
            return events(res, [
              {
                candidates: [
                  {
                    content: {
                      parts:
                        round === 1
                          ? [
                              {
                                functionCall: {
                                  id: "call1",
                                  name: "echo",
                                  args: { text: "你好" },
                                },
                                thoughtSignature: "private-signature",
                              },
                            ]
                          : [{ text: "完成" }],
                    },
                    finishReason: "STOP",
                  },
                ],
              },
            ]);
          return events(
            res,
            round === 1
              ? [
                  {
                    choices: [
                      {
                        delta: {
                          reasoning_content: "private",
                          tool_calls: [
                            {
                              index: 0,
                              id: "call1",
                              function: { name: "echo", arguments: '{"text":' },
                            },
                          ],
                        },
                      },
                    ],
                  },
                  {
                    choices: [
                      {
                        delta: {
                          tool_calls: [
                            { index: 0, function: { arguments: '"你好"}' } },
                          ],
                        },
                        finish_reason: "tool_calls",
                      },
                    ],
                  },
                ]
              : [
                  {
                    choices: [
                      { delta: { content: "完成" }, finish_reason: "stop" },
                    ],
                  },
                ],
            true,
          );
        },
        async (url, requests) => {
          const settings = config(provider, url),
            tools = [
              {
                name: "echo",
                description: "echo text",
                parameters: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"],
                },
              },
            ];
          const messages: PromptMessage[] = [
            { role: "system", content: "system" },
            { role: "user", content: "echo" },
          ];
          let calls: ToolCall[] = [],
            native: NativeTurn | undefined,
            visible = "";
          const input = {
            settings,
            key: "fixture",
            signal: AbortSignal.timeout(5000),
            nativeScope: "scope",
            tools,
            messages,
            onTools: (v: ToolCall[]) => {
              calls = v;
            },
            onNative: (v: NativeTurn) => {
              native = v;
            },
          };
          for await (const delta of provider.stream(input)) visible += delta;
          assert.equal(visible, "");
          assert.equal(calls.length, 1);
          assert.equal(calls[0].name, "echo");
          assert.deepEqual(JSON.parse(calls[0].arguments), { text: "你好" });
          assert.ok(native);
          assert.match(JSON.stringify(native), /private/);
          messages.push(
            { role: "assistant", content: "", calls, native },
            {
              role: "tool",
              content: "tool-result",
              toolCallId: calls[0].id,
              toolName: "echo",
            },
          );
          for await (const delta of provider.stream(input)) visible += delta;
          assert.equal(visible, "完成");
          assert.ok(requests[0].body.tools.length);
          const body = requests[1].body;
          if (provider.id === "openai") {
            assert.ok(
              body.input.some(
                (v: any) =>
                  v.type === "function_call_output" && v.call_id === "call1",
              ),
            );
            assert.ok(
              body.input.some((v: any) => v.encrypted_content === "private"),
            );
          } else if (provider.id === "claude") {
            assert.equal(body.messages.at(-1).content[0].tool_use_id, "call1");
            assert.equal(body.messages[1].content[0].signature, "sig");
          } else if (provider.id === "gemini") {
            assert.equal(
              body.contents.at(-1).parts[0].functionResponse.name,
              "echo",
            );
            assert.equal(
              body.contents[1].parts[0].thoughtSignature,
              "private-signature",
            );
          } else {
            assert.equal(body.messages.at(-1).tool_call_id, "call1");
            assert.equal(body.messages[2].reasoning_content, "private");
          }
        },
      );
    },
  );
