import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Kernel } from "../packages/kernel/index.ts";
import {
  defaults,
  type Settings,
  type Surface,
  type Message,
} from "../packages/contracts/index.ts";
import { settings, validateSettings } from "../plugins/settings/index.ts";
import { storageLocal } from "../plugins/storage-local/index.ts";
import { conversation } from "../plugins/conversation/index.ts";
import { streamChat } from "../plugins/provider-compatible/index.ts";
import { clampRect } from "../plugins/platform-windows/geometry.ts";
import { characterPack } from "../plugins/character-pack/index.ts";
import { petSchema, petConfig } from "../plugins/pet-config/index.ts";
import {
  providerSchema,
  providerConfig,
} from "../plugins/provider-compatible/config.ts";
import {
  personaSchema,
  personaConfig,
} from "../plugins/conversation/config.ts";
const schemas = {
  pet: petSchema,
  persona: personaSchema,
  provider: providerSchema,
};
const manifest = (id: string, provides: any[], requires: any[] = []) => ({
  manifestVersion: 1 as const,
  id,
  version: "1.0.0",
  provides,
  requires,
});
test("坏配置拒绝，未知字段不持久化，URL 不允许内嵌凭据", () => {
  assert.throws(() =>
    validateSettings(
      { ...defaults, pet: { ...defaults.pet, scale: 8 } },
      schemas,
    ),
  );
  assert.throws(() =>
    validateSettings(
      {
        ...defaults,
        provider: {
          ...defaults.provider,
          baseUrl: "https://key:secret@example.com/v1",
        },
      },
      schemas,
    ),
  );
  assert.equal(
    (validateSettings({ ...defaults, apiKey: "secret" }, schemas) as any)
      .apiKey,
    undefined,
  );
});
test("配置版本冲突及写入失败时，磁盘和窗口维持有效配置", async () => {
  const k = new Kernel();
  let displayed = 1,
    fail = false;
  k.install({
    manifest: manifest("test.storage", ["storage.local"]),
    start(ctx) {
      ctx.provide("storage.local", {
        read: async (_key, fallback) => structuredClone(fallback),
        write: async () => {
          if (fail) throw new Error("磁盘失败");
        },
      });
    },
  });
  k.install({
    manifest: manifest("test.surface", [
      "platform.surface",
      "character.catalog",
    ]),
    start(ctx) {
      ctx.provide("platform.surface", {
        configurePet(p) {
          displayed = p.scale;
        },
      } as Surface);
      ctx.provide("character.catalog", {
        list: () => [],
        get: (id) => ({
          id,
          name: "test",
          description: "",
          actions: ["idle"],
          representations: {},
        }),
      });
    },
  });
  for (const plugin of [petConfig, personaConfig, providerConfig, settings])
    k.install(plugin);
  await k.startAll();
  const service = k.resolve("settings");
  const next = service.get();
  next.pet.scale = 1.2;
  await service.apply(next);
  assert.equal(displayed, 1.2);
  await assert.rejects(service.apply(next), /配置已变化/);
  fail = true;
  const bad = service.get();
  bad.pet.scale = 1.4;
  await assert.rejects(service.apply(bad), /磁盘失败/);
  assert.equal(displayed, 1.2);
  assert.equal(service.get().version, 1);
  await k.dispose();
});
test("本地存储串行原子写入，重启恢复最近提交", async () => {
  const dir = await mkdtemp(join(tmpdir(), "familiar-storage-")),
    k = new Kernel({ grants: { "familiar.storage-local": ["storage.app"] } });
  k.install(storageLocal(dir));
  await k.startAll();
  await Promise.all([
    k.resolve("storage.local").write("settings", { version: 1 }),
    k.resolve("storage.local").write("settings", { version: 2 }),
  ]);
  assert.deepEqual(
    JSON.parse(await readFile(join(dir, "settings.json"), "utf8")),
    { version: 2 },
  );
  await k.dispose();
});
test("多屏坐标包含负值，拔屏后宠物回到有效工作区", () => {
  const left = { x: -1920, y: 0, width: 1920, height: 1080 },
    right = { x: 0, y: 0, width: 2560, height: 1440 };
  assert.equal(
    clampRect({ x: -500, y: 100, width: 260, height: 300 }, [left, right]).x,
    -500,
  );
  assert.equal(
    clampRect({ x: -500, y: 100, width: 260, height: 300 }, [right]).x,
    0,
  );
  assert.equal(
    clampRect({ x: 2500, y: 1400, width: 260, height: 300 }, [right]).y,
    1140,
  );
});
test("两个角色包可以通过相同清单加载，不修改内核", async () => {
  const k = new Kernel({
    grants: { "familiar.character-pack": ["assets.read"] },
  });
  k.install(characterPack(join(process.cwd(), "characters")));
  await k.startAll();
  assert.equal(k.resolve("character.catalog").list().length, 2);
  assert.ok(k.resolve("character.catalog").get("luna").representations.sprite);
  await k.dispose();
});
async function fixture(
  mode: "stream" | "401" | "429" | "broken" | "slow",
  run: (url: string) => Promise<void>,
) {
  const server = createServer((_req, res) => {
    if (mode === "401" || mode === "429") {
      res.writeHead(Number(mode));
      res.end("error");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (mode === "slow") {
      res.write(": heartbeat\n\n");
      return;
    }
    const payload = Buffer.from(
      'data: {"choices":[{"delta":{"reasoning_content":"内部推理不应出现在气泡里"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"你好🌿","reasoning_content":"另一段推理"}}]}\r\n\r\n',
    );
    for (let i = 0; i < payload.length; i += 2)
      res.write(payload.subarray(i, i + 2));
    res.end(mode === "broken" ? "" : "data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await run(`http://127.0.0.1:${(server.address() as any).port}/v1`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
async function collect(
  url: string,
  signal = new AbortController().signal,
  timeoutMs = 1000,
) {
  let value = "";
  for await (const text of streamChat({
    settings: { ...defaults.provider, baseUrl: url, model: "fixture" },
    messages: [],
    key: "",
    signal,
    timeoutMs,
  }))
    value += text;
  return value;
}
test("LLM SSE 支持跨字节 UTF-8、CRLF 和 DONE，过滤推理字段", async () =>
  fixture("stream", async (url) => {
    assert.equal(await collect(url), "你好🌿");
  }));
for (const status of ["401", "429"] as const)
  test(`LLM ${status} 显示明确错误，不吞掉故障`, async () =>
    fixture(status, async (url) => {
      await assert.rejects(collect(url), new RegExp(status));
    }));
test("LLM 断流不误报完整回复", async () =>
  fixture("broken", async (url) => {
    await assert.rejects(collect(url), /提前结束/);
  }));
test("LLM 等待期间支持取消和超时", async () =>
  fixture("slow", async (url) => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 40);
    await assert.rejects(collect(url, abort.signal), /abort/i);
    await assert.rejects(collect(url, undefined, 40), /timeout/i);
  }));
test("会话生成互斥、配置快照、清空后无迟到消息，取消部分回复不作为下轮完整上下文", async () => {
  const k = new Kernel();
  let config: Settings = {
      ...structuredClone(defaults),
      provider: { ...defaults.provider, model: "before" },
    },
    captured = "",
    persisted: unknown;
  k.install({
    manifest: manifest("test.dependencies", [
      "settings",
      "storage.local",
      "llm.chat",
    ]),
    start(ctx) {
      ctx.provide("settings", {
        get: () => structuredClone(config),
        apply: async (s) => (config = s),
      });
      ctx.provide("storage.local", {
        read: async (_key, fallback) => fallback,
        write: async (_key, value) => {
          persisted = structuredClone(value);
        },
      });
      ctx.provide("llm.chat", {
        test: async () => "ok",
        async *stream(input) {
          captured = input.settings.model;
          yield "开始";
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 300);
            input.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timeout);
                resolve();
              },
              { once: true },
            );
          });
          yield "迟到";
        },
      });
    },
  });
  k.install(conversation);
  await k.startAll();
  const service = k.resolve("conversation");
  await service.send("你好");
  await assert.rejects(service.send("重复"), /正在回复/);
  config.provider.model = "after";
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(captured, "before");
  await service.cancel();
  assert.equal(service.state().messages.at(-1)?.status, "cancelled");
  assert.equal(service.state().messages.at(-1)?.text, "开始");
  await service.send("重新聊");
  await service.clear();
  assert.deepEqual(service.state().messages, []);
  assert.deepEqual(persisted, []);
  await k.dispose();
});
