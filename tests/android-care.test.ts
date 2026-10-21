import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { bootstrapAndroid } from "../apps/tauri/runtime/bootstrap.ts";
import { mobileApi } from "../apps/tauri/runtime/mobile-api.ts";
import { createCompanionCare } from "../plugins/companion-care/index.ts";
import { careDefaults } from "../plugins/companion-care/schedule.ts";
import {
  androidLocationValue,
  locationMaxAge,
} from "../plugins/platform-android/location.ts";
import { amapCare } from "../plugins/amap-care/index.ts";
import { projectCareResult } from "../packages/mobile-bridge/care.ts";
import type { AndroidNative } from "../plugins/platform-android/index.ts";
import type { MobileCommand } from "../packages/mobile-contracts/index.ts";

test("Android 关怀复用真实模型/历史，取消及配置冲突阻止迟到写入，位置撤权清理缓存", async () => {
  const root = await mkdtemp(resolve(".artifacts/android-care-"));
  let slow = false,
    received = 0,
    permission = true;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    received++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const timer = setTimeout(
      () =>
        res.end(
          "data: " +
            JSON.stringify({
              choices: [
                { delta: { content: "隔离关怀问候" }, finish_reason: "stop" },
              ],
            }) +
            "\n\ndata: [DONE]\n\n",
        ),
      slow ? 10000 : 2,
    );
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const native: AndroidNative = {
    async call<T>(method: string) {
      return (
        method === "secrets.readAll"
          ? {}
          : method === "location.status"
            ? { permission, enabled: true }
            : method === "care.available"
              ? false
              : method === "capabilities.status"
                ? []
                : method === "runtime.status"
                  ? { running: true, overlayVisible: true, engine: "ready" }
                  : null
      ) as T;
    },
  };
  const kernel = await bootstrapAndroid(root, resolve("."), native),
    api = mobileApi(kernel, native);
  let seq = 0;
  const raw = (method: string, params?: unknown) =>
    api({
      protocolVersion: 1,
      id: "care-" + ++seq,
      method: method as MobileCommand,
      params,
    });
  const call = async (method: string, params?: unknown) => {
    const r = await raw(method, params);
    assert(r.ok, JSON.stringify(r));
    return r.result as any;
  };
  const until = async (fn: () => Promise<boolean> | boolean) => {
    for (let i = 0; i < 200; i++) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error("Care fixture timeout");
  };
  try {
    assert((await call("snapshot.get")).careManagement);
    let s = await call("care.get");
    assert(!s.settings.location);
    s = await call("care.save", {
      settings: { ...s.settings, enabled: false, location: true },
      revision: s.revision,
    });
    const old = s.revision;
    s = await call("care.save", {
      settings: {
        ...s.settings,
        custom: [
          {
            id: "one",
            label: "提醒",
            time: "13:00",
            prompt: "喝水",
            enabled: true,
          },
        ],
      },
      revision: s.revision,
    });
    assert.equal(
      (await raw("care.save", { settings: s.settings, revision: old })).error
        ?.code,
      "CONFLICT",
    );
    assert.equal(
      (await raw("care.location.import", { revision: old, value: {} })).error
        ?.code,
      "CONFLICT",
    );
    const value = {
      latitude: 25,
      longitude: 121,
      accuracy: 1500,
      time: Date.now(),
      source: "Android/network",
      mock: false,
    };
    s = await call("care.location.import", { revision: s.revision, value });
    assert(s.location);
    assert(!JSON.stringify(s).includes("latitude"));
    permission = false;
    assert(!(await call("care.get")).location);
    assert.equal(kernel.resolve("android.location").peek(), undefined);
    permission = true;
    await call("provider.save", {
      kind: "compatible",
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      model: "fixture",
    });
    await call("care.preview");
    await until(async () => !(await call("care.get")).busy);
    assert.equal((await call("care.get")).lastMessage, "隔离关怀问候");
    const notes = () => kernel.resolve("conversation").state().messages.length;
    assert.equal(notes(), 1);
    slow = true;
    const seen = received;
    await call("care.preview");
    await until(() => received > seen);
    await call("care.stop");
    await until(async () => !(await call("care.get")).busy);
    assert.equal(notes(), 1);
    const seen2 = received;
    await call("care.preview");
    await until(() => received > seen2);
    s = await call("care.get");
    await call("care.save", {
      settings: { ...s.settings, location: false },
      revision: s.revision,
    });
    await until(async () => !(await call("care.get")).busy);
    assert.equal(notes(), 1);
    const seen3 = received;
    await call("care.preview");
    await until(() => received > seen3);
    await call("conversation.create");
    await until(async () => !(await call("care.get")).busy);
    assert.equal(notes(), 0);
  } finally {
    await kernel.dispose();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    assert(root.startsWith(resolve(".artifacts") + sep));
    await rm(root, { recursive: true, force: true });
  }
});

test("关怀自动调度检查宿主可运行状态，失败/重启不重放已使用时段", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date(2026, 9, 19, 9).getTime(),
  });
  let callback: () => Promise<void>,
    care: any,
    available = false,
    fail = false,
    requests = 0;
  const notes: string[] = [],
    stored = new Map();
  const settings = {
    provider: { model: "fixture", timeoutSeconds: 60 },
    pet: { quiet: false, visible: true },
  };
  const services: any = {
    "storage.local": {
      async read(k: string, f: unknown) {
        return structuredClone(stored.get(k) ?? f);
      },
      async write(k: string, v: unknown) {
        stored.set(k, structuredClone(v));
      },
    },
    settings: { get: () => settings },
    conversation: { state: () => ({ busy: false, messages: [] }) },
    "conversation.history": {
      async note(v: string) {
        notes.push(v);
      },
    },
    "companion.presentation": { inController: () => false },
    "persona.catalog": { prompt: () => "" },
    "memory.files": {
      async context() {
        return "";
      },
    },
    "llm.chat": {
      async *stream() {
        requests++;
        if (fail) throw Error('isolated provider failure');
        yield "问候";
      },
    },
    "platform.location": {},
    "companion.places": {},
  };
  const start = async () => {
    await createCompanionCare({ canRun: async () => available }).start({
      use: (s: string) => services[s],
      provide: (_s: string, v: any) => (care = v),
      on: () => {},
      interval: (f: () => Promise<void>) => (callback = f),
      effect: () => {},
      abort: new AbortController(),
    } as any);
  };
  await start();
  t.mock.timers.tick(16000);
  await callback!();
  assert.equal(requests, 0);
  available = true;
  await callback!();
  assert.equal(requests, 1);
  assert.deepEqual(notes, ["问候"]);
  await callback!();
  assert.equal(requests, 1);
  await start();
  t.mock.timers.tick(16000);
  await callback!();
  assert.equal(requests, 1);
  await care.set({ ...careDefaults, enabled: false });
  t.mock.timers.tick(21 * 60000);
  await callback!();
  assert.equal(requests, 1);
  await care.preview();
  assert.equal(requests, 2);
  fail = true;
  await care.set({...careDefaults,custom:[{id:'failure',label:'失败防重',prompt:'隔离提醒',time:'09:00',enabled:true}]});
  await callback!();assert.equal(requests,3);assert.equal(notes.length,2);
  await start();t.mock.timers.tick(16000);await callback!();assert.equal(requests,3);assert.equal(notes.length,2);
});

test("Android 位置与公开投影拒绝过期或伪造数据，不向页面返回坐标", () => {
  const v = {
    latitude: 25,
    longitude: 121,
    accuracy: 1500,
    time: Date.now(),
    source: "Android/network",
    mock: false,
  };
  assert.equal(androidLocationValue(v).accuracy, 1500);
  for (const bad of [
    { ...v, source: "IP" },
    { ...v, time: Date.now() - locationMaxAge - 1 },
    { ...v, longitude: 181 },
    { ...v, accuracy: 10001 },
    { ...v, mock: undefined },
  ])
    assert.throws(() => androidLocationValue(bad));
  const s = projectCareResult("care.get", {
    settings: careDefaults,
    revision: "a".repeat(64),
    busy: false,
    locationPermission: true,
    locationEnabled: true,
    location: { ...v },
    privatePath: "/private",
  });
  assert(s?.location);
  assert(!JSON.stringify(s).includes("latitude"));
  assert(!JSON.stringify(s).includes("privatePath"));
});

test("高德附近建议按大致误差扩大查询范围，低精度不估算步行，模拟位置不外发", async (t) => {
  const calls: { name: string; args: any }[] = [];
  let places: any,
    fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches++;
    return new Response(
      JSON.stringify({ status: "1", locations: "121.1,25.1" }),
    );
  });
  const services: any = {
    "mcp.manager": {
      async list() {
        return [
          {
            id: "amap",
            name: "高德",
            enabled: true,
            transport: "http",
            url: "https://mcp.amap.com/mcp",
          },
        ];
      },
      async callReadOnly(_id: string, name: string, args: any) {
        calls.push({ name, args });
        return name === "maps_around_search"
          ? { pois: [{ id: "p", name: "餐厅", location: "121.2,25.2" }] }
          : { poi: { location: "121.2,25.2" } };
      },
    },
    "secrets.local": { get: () => "isolated-key" },
  };
  await amapCare.start({
    require: () => {},
    use: (s: string) => services[s],
    provide: (_s: string, v: any) => (places = v),
  } as any);
  const v = {
    latitude: 25,
    longitude: 121,
    accuracy: 1500,
    time: Date.now(),
    source: "Android/network",
    mock: false,
  };
  const result = await places.nearby(v, new AbortController().signal);
  assert.match(result, /误差约 1500 米/);
  assert.equal(calls[0].args.radius, "3000");
  assert(!calls.some((c) => c.name === "maps_direction_walking"));
  await assert.rejects(
    places.nearby({ ...v, mock: true }, new AbortController().signal),
    /模拟位置/,
  );
  assert.equal(fetches, 1);
});
