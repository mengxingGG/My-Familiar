import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { bootstrapAndroid } from "../apps/tauri/runtime/bootstrap.ts";
import { mobileApi } from "../apps/tauri/runtime/mobile-api.ts";
import { createMobileBridge } from "../packages/mobile-bridge/index.ts";
import { projectModelResult } from "../packages/mobile-bridge/model.ts";
import { advancedProfile } from "../apps/tauri/runtime/mobile-model.ts";
import { profileDefaults, summaryFields } from "../packages/contracts/index.ts";
import type { AndroidNative } from "../plugins/platform-android/index.ts";

test("Android 模型目录、参数与连接测试复用真实请求；凭据变化失效缓存、取消不阻塞核心", async () => {
  await mkdir(".artifacts", { recursive: true });
  const root = await mkdtemp(resolve(".artifacts/android-model-")),
    keys: Record<string, string> = {},
    requests: any[] = [];
  let slow = false,
    modelRequests = 0,
    lastBody: any;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, key: req.headers.authorization });
    if (req.url?.endsWith("/models")) {
      modelRequests++;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: [
            {
              id: "fixture-model",
              name: "测试模型",
              context_length: 120000,
              top_provider: { max_completion_tokens: 10000 },
            },
          ],
        }),
      );
      return;
    }
    lastBody = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const timer = setTimeout(
      () =>
        res.end(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "连接成功" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        ),
      slow ? 10000 : 5,
    );
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const native: AndroidNative = {
    async call<T>(method: string, p = {}) {
      const args = p as Record<string, unknown>;
      if (method === "secrets.write") {
        if (args.value) keys[String(args.name)] = String(args.value);
        else delete keys[String(args.name)];
      }
      return (
        method === "secrets.readAll"
          ? { ...keys }
          : method === "capabilities.status"
            ? []
            : method === "runtime.status"
              ? {
                  running: true,
                  engine: "ready",
                  overlayVisible: false,
                  detail: "fixture",
                }
              : null
      ) as T;
    },
  };
  let kernel = await bootstrapAndroid(root, resolve("."), native),
    api = mobileApi(kernel, native);
  const bridge = createMobileBridge({
    listen: () => () => {},
    invoke: (r) => api(r),
  });
  const b = bridge.request.bind(bridge),
    bad = (code: string) => (e: unknown) => {
      assert.equal((e as any).code, code);
      return true;
    };
  try {
    const advanced = {
      ...advancedProfile(profileDefaults),
      temperature: 0.4,
      topP: 0.9,
      maxOutputTokens: 2048,
      contextTokens: 120000,
      autoCompactPercent: 70,
      timeoutSeconds: 45,
      thinking: { mode: "effort" as const, effort: "high", budgetTokens: 2048 },
      cache: false,
    };
    const query = {
      kind: "compatible" as const,
      baseUrl,
      model: "fixture-model",
      advanced,
    };
    await b("provider.save", { ...query, apiKey: "isolated-model-key" });
    assert.deepEqual(
      (await b("snapshot.get", undefined)).provider.advanced,
      advanced,
    );
    const models = await b("provider.models", query);
    assert.equal(models.items[0].id, "fixture-model");
    assert.equal(modelRequests, 1);
    await b("provider.models", query);
    assert.equal(modelRequests, 1);
    const info = await b("provider.inspect", query);
    assert(info.hasKey);
    assert(info.options.modes.includes("effort"));
    assert.equal(info.model?.contextWindow, 120000);
    assert(
      !(await b("provider.inspect", { ...query, baseUrl: baseUrl + "/other" }))
        .hasKey,
    );
    await b("provider.save", { ...query, apiKey: "rotated-model-key" });
    await b("provider.models", query);
    assert.equal(modelRequests, 2);
    assert.equal(requests.at(-1).key, "Bearer rotated-model-key");
    await b("provider.test", { ...query, operationId: "model-test" });
    assert.deepEqual(lastBody.messages, [
      { role: "user", content: "请只回复：连接成功" },
    ]);
    assert.equal(lastBody.temperature, 0.4);
    assert.equal(lastBody.top_p, 0.9);
    assert.equal(lastBody.max_tokens, 2048);
    assert.equal(lastBody.reasoning_effort, "high");
    assert.equal(
      (await b("snapshot.get", undefined)).conversations.flatMap(
        (c) => c.messages,
      ).length,
      0,
    );
    await assert.rejects(
      b("provider.test", {
        ...query,
        model: "changed-draft",
        operationId: "wrong",
      }),
      bad("CONFLICT"),
    );
    await assert.rejects(
      b("provider.save", {
        ...query,
        advanced: { ...advanced, temperature: 3 },
      }),
      bad("INVALID_INPUT"),
    );
    assert.equal(
      (await b("snapshot.get", undefined)).provider.advanced?.temperature,
      0.4,
    );
    slow = true;
    const pending = b("provider.test", {
      ...query,
      operationId: "cancel-test",
    });
    const cancelled = assert.rejects(pending, bad("CANCELLED"));
    await new Promise((r) => setTimeout(r, 30));
    const start = Date.now();
    await b("snapshot.get", undefined);
    await b("voice.stop", undefined);
    await b("provider.test.cancel", { operationId: "old-test" });
    await b("provider.test.cancel", { operationId: "cancel-test" });
    await cancelled;
    assert(Date.now() - start < 1500);
    slow = false;
    await kernel.dispose();
    kernel = await bootstrapAndroid(root, resolve("."), native);
    api = mobileApi(kernel, native);
    assert.deepEqual(
      (await b("snapshot.get", undefined)).provider.advanced,
      advanced,
    );
  } finally {
    bridge.dispose();
    await kernel.dispose();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});

test("Android 上下文读取区分未请求与已有检查点，原文索引绑定会话且删除后不可读", async () => {
  const root = await mkdtemp(resolve(".artifacts/android-context-"));
  const native: AndroidNative = {
    async call<T>(method: string) {
      return (
        method === "secrets.readAll"
          ? {}
          : method === "capabilities.status"
            ? []
            : method === "runtime.status"
              ? {
                  running: true,
                  engine: "ready",
                  overlayVisible: false,
                  detail: "fixture",
                }
              : null
      ) as T;
    },
  };
  let kernel = await bootstrapAndroid(root, resolve("."), native),
    api = mobileApi(kernel, native);
  const bridge = createMobileBridge({
      listen: () => () => {},
      invoke: (r) => api(r),
    }),
    b = bridge.request.bind(bridge);
  try {
    const { id } = await b("conversation.create", undefined),
      before = await b("conversation.context", { conversationId: id });
    assert.equal(before.active, true);
    assert.equal(before.status, undefined);
    // 用真实私有持久化格式构造已压缩会话，检验重启读取与关联保护；压缩生成算法另由 context.test 验证。
    const storage = kernel.resolve("storage.local"),
      record = await storage.read<any>(`conversation-session-${id}`, null),
      checkpoint = `context-${createHash("sha256").update(id).digest("hex").slice(0, 24)}-${randomUUID()}`;
    const summary = Object.fromEntries(
      summaryFields.map((k) => [k, [k === "pending" ? "尚未订票" : "资料"]]),
    ) as any;
    record.session.checkpoint = {
      id: checkpoint,
      created: Date.now(),
      throughId: "test-source",
      summary,
    };
    record.session.compactions = 1;
    record.session.status = {
      id,
      epoch: 2,
      retainedMessages: 4,
      inputTokens: 2000,
      exact: false,
      inputBudget: 10000,
      limitSource: "manual",
      trimmedMessages: 6,
      compactions: 1,
      compactThreshold: 8000,
      usage: { inputTokens: 2100, outputTokens: 100, cachedInputTokens: 1500 },
    };
    await kernel.dispose();
    const writeFixture = (key: string, value: unknown) =>
      writeFile(join(root, "data", `${key}.json`), JSON.stringify(value));
    await writeFixture(`conversation-session-${id}`, record);
    await writeFixture("conversation", record);
    await writeFixture(checkpoint, {
      source: "原文".repeat(10000) + "TAIL",
      checkpoint: record.session.checkpoint,
    });
    await writeFixture(
      `context-index-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`,
      [checkpoint],
    );
    kernel = await bootstrapAndroid(root, resolve("."), native);
    api = mobileApi(kernel, native);
    // 历史激活从会话文件读取，避免依赖旧启动入口键名。
    const other = await b("conversation.create", undefined);
    await b("conversation.select", { id });
    const value = await b("conversation.context", { conversationId: id });
    assert.equal(value.status?.inputTokens, 2000);
    assert.equal(value.status?.exact, false);
    assert.equal(value.status?.usage?.cachedInputTokens, 1500);
    assert.deepEqual(value.checkpoint?.summary.pending, ["尚未订票"]);
    const first = await b("context.archive", {
      conversationId: id,
      checkpoint,
    });
    assert.equal(first.text.length, 16000);
    assert.equal(first.nextOffset, 16000);
    assert(
      (
        await b("context.archive", {
          conversationId: id,
          checkpoint,
          offset: first.nextOffset!,
        })
      ).text.endsWith("TAIL"),
    );
    await assert.rejects(
      b("context.archive", { conversationId: other.id, checkpoint }),
      (e: any) => e.code === "INVALID_INPUT",
    );
    await b("conversation.delete", { id });
    await assert.rejects(
      b("context.archive", { conversationId: id, checkpoint }),
      (e: any) => e.code === "NOT_FOUND",
    );
  } finally {
    bridge.dispose();
    await kernel.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("模型管理投影拒绝跨地址结果，隐藏未知私有字段", () => {
  const models = projectModelResult(
    "provider.models",
    {
      kind: "compatible",
      baseUrl: "https://example.test/v1",
      items: [{ id: "x", name: "x", private: "secret" }],
      secret: "never",
    },
    { kind: "compatible", baseUrl: "https://example.test/v1/" },
  );
  assert(!JSON.stringify(models).includes("secret"));
  assert.throws(() =>
    projectModelResult(
      "provider.models",
      { kind: "compatible", baseUrl: "https://wrong.test", items: [] },
      { kind: "compatible", baseUrl: "https://example.test/v1" },
    ),
  );
  assert.throws(() =>
    projectModelResult(
      "conversation.context",
      { conversationId: "wrong", active: true },
      { conversationId: "right" },
    ),
  );
});
