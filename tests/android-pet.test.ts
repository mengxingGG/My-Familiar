import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { bootstrapAndroid } from "../apps/tauri/runtime/bootstrap.ts";
import { mobileApi } from "../apps/tauri/runtime/mobile-api.ts";
import { createMobileBridge, isMobileSnapshot, type MobileRequest } from "../packages/mobile-bridge/index.ts";
import type { MobileSnapshot } from "../packages/mobile-contracts/index.ts";
import type { AndroidNative } from "../plugins/platform-android/index.ts";

test("Android 宠物复用行为与气泡，停靠独立持久化，错误配置不覆盖已有设置", async () => {
  const root = await mkdtemp(resolve(".artifacts/pet-core-"));
  const presentations: Record<string, unknown>[] = [];
  let docking = { snapToEdge: false, hideWhenIdle: true, delaySeconds: 30, tucked: false }, fail = false;
  const native: AndroidNative = { async call<T>(method: string, params = {}): Promise<T> {
    if (method === "pet.present") presentations.push(params);
    if (method === "pet.docking.save") { if (fail) throw Error("UNAVAILABLE"); docking = { ...docking, ...params }; }
    if (method === "companion.update" && fail) throw Error("UNAVAILABLE");
    return (method === "secrets.readAll" ? {} : method === "capabilities.status" ? [] : method === "pet.docking.get" ? { ...docking } : method === "runtime.status" ? { running: true, engine: "ready", overlayVisible: true, detail: "fixture" } : null) as T;
  } };
  let kernel = await bootstrapAndroid(root, resolve("."), native); let api = mobileApi(kernel, native); let sequence = 0;
  const call = (method: MobileRequest["method"], params?: unknown) => api({ protocolVersion: 1, id: String(++sequence), method, params });
  const good = async (method: MobileRequest["method"], params?: unknown) => { const r = await call(method, params); assert(r.ok, JSON.stringify(r)); return r.result; };
  const snapshot = async () => await good("snapshot.get") as MobileSnapshot;
  const flush = () => new Promise(r => setImmediate(r));
  try {
    assert(isMobileSnapshot(await snapshot()));
    await good("pet.interact", { action: "sleep" }); await flush(); assert.equal((await snapshot()).pet?.action, "sleep");
    assert(presentations.some(p => p.type === "action" && p.action === "sleep"));
    await good("pet.host", { action: "drag-start" }); assert.equal((await snapshot()).pet?.action, "drag");
    await good("pet.host", { action: "drag-end" }); assert.equal((await snapshot()).pet?.action, "idle");
    await good("pet.interact", { action: "click" }); await flush(); assert.equal((await snapshot()).pet?.action, "happy");
    assert(presentations.some(p => p.type === "speech" && p.text === "我在这里。"));
    await good("pet.host", { action: "close" }); await flush(); assert.equal(presentations.filter(p => p.type === "speech-visible").at(-1)?.visible, false);
    await good("pet.settings.save", { scale: 1.25, visible: true, quiet: true, bubbleSeconds: 0 });
    presentations.length = 0; await good("pet.interact", { action: "click" }); await flush(); assert(!presentations.some(p => p.type === "speech"));
    await good("pet.docking.save", { snapToEdge: true, hideWhenIdle: false, delaySeconds: 45 });
    for (const bad of [{ snapToEdge: "true", hideWhenIdle: true, delaySeconds: 30 }, { snapToEdge: true, hideWhenIdle: true, delaySeconds: 9 }, { snapToEdge: true, hideWhenIdle: true, delaySeconds: 300.5 }]) assert(!(await call("pet.docking.save", bad)).ok);
    fail = true;
    assert(!(await call("pet.docking.save", { snapToEdge: false, hideWhenIdle: true, delaySeconds: 30 })).ok);
    assert(!(await call("pet.settings.save", { scale: 1.6, visible: false, quiet: false, bubbleSeconds: 15 })).ok);
    fail = false;
    assert.equal((await snapshot()).pet?.scale, 1.25); assert.equal((await snapshot()).pet?.docking?.snapToEdge, true);
    assert(!(await call("pet.interact", { action: "drag-start" })).ok);
    await kernel.dispose(); kernel = await bootstrapAndroid(root, resolve("."), native); api = mobileApi(kernel, native);
    const state = await snapshot(); assert.equal(state.pet?.quiet, true); assert.equal(state.pet?.scale, 1.25); assert.equal(state.pet?.docking?.delaySeconds, 45);
    // 快照投影拒绝错误停靠状态，且不泄露原生附加字段。
    const bridge = createMobileBridge({ listen: () => () => {}, async invoke(r) { return { protocolVersion: 1, id: r.id, ok: true, result: { ...state, pet: { ...state.pet, docking: { ...state.pet!.docking, nativePrivate: "secret" } } } }; } });
    try { assert(!JSON.stringify(await bridge.request("snapshot.get", undefined)).includes("secret")); } finally { bridge.dispose(); }
    assert(!isMobileSnapshot({ ...state, pet: { ...state.pet, docking: { ...state.pet!.docking, tucked: 1 } } }));
  } finally { await kernel.dispose(); await rm(root, { recursive: true, force: true }); }
});
