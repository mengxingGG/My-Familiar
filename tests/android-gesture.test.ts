import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { bootstrapAndroid } from "../apps/tauri/runtime/bootstrap.ts";
import type { AndroidNative } from "../plugins/platform-android/index.ts";
import { mobileTasks } from "../plugins/platform-android/approvals.ts";

test("Android 手势经真实共享审批与参数校验，拒绝不触摸，取消只通知对应原生请求", async () => {
  const root = await mkdtemp(resolve(".artifacts/gesture-core-"));
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let finish: ((value: unknown) => void) | undefined, slow = false;
  const native: AndroidNative = { async call<T>(method: string, params = {}): Promise<T> {
    if (method.startsWith("accessibility.gesture")) calls.push({ method, params });
    if (method === "accessibility.gesture") return (slow ? await new Promise<unknown>(done => { finish = done; }) : { dispatched: true, status: "completed", requiresObservation: true }) as T;
    return (method === "secrets.readAll" ? {} : method === "capabilities.status" ? [] : null) as T;
  } };
  const kernel = await bootstrapAndroid(root, resolve("."), native);
  const args = { snapshotId: "observation", nodeId: "3", gesture: "tap", start: { x: .4, y: .5 } };
  const tools = kernel.resolve("agent.tools"), approvals = kernel.resolve("agent.approvals");
  const run = (value: unknown = args, signal = new AbortController().signal) => tools.run({ id: "gesture-test", name: "android_gesture", arguments: JSON.stringify(value) }, signal);
  const wait = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await new Promise(r => setTimeout(r, 5)); assert(check()); };
  try {
    for (const invalid of [
      { ...args, start: { x: -1, y: .5 } }, { ...args, start: { x: 1.01, y: .5 } },
      { ...args, gesture: "swipe" }, { ...args, durationMs: 500 },
      { ...args, gesture: "swipe", end: { x: .9, y: .8 }, durationMs: 1501 },
      { ...args, end: { x: .9, y: .8 } }, { ...args, operationId: "model-must-not-set" },
    ]) await assert.rejects(run(invalid), /参数/);
    assert.equal(approvals.list().length, 0); assert.equal(calls.length, 0);
    let task = run(); let rejection = assert.rejects(task, /拒绝/); await wait(() => approvals.list().length === 1);
    assert.equal(mobileTasks(approvals.list())[0].kind, "accessibility"); assert.equal(calls.length, 0);
    await approvals.decide(approvals.list()[0].id, false); await rejection; assert.equal(calls.length, 0);
    task = run(); await wait(() => approvals.list().length === 1); await approvals.decide(approvals.list()[0].id, true);
    assert.equal(JSON.parse(await task).status, "completed"); assert.equal(calls.length, 1);
    assert.equal(calls[0].params.snapshotId, args.snapshotId); assert.match(String(calls[0].params.operationId), /^[a-f0-9-]{36}$/);
    const before = new AbortController(); task = run(args, before.signal); rejection = assert.rejects(task, /取消/);
    await wait(() => approvals.list().length === 1); before.abort(); await rejection; assert.equal(calls.length, 1);
    slow = true; const after = new AbortController(); task = run({ ...args, gesture: "swipe", end: { x: .9, y: .5 }, durationMs: 600 }, after.signal);
    rejection = assert.rejects(task, /abort/i); await wait(() => approvals.list().length === 1); await approvals.decide(approvals.list()[0].id, true);
    await wait(() => !!finish); after.abort(); await wait(() => calls.length === 3);
    assert.equal(calls[2].method, "accessibility.gesture.cancel"); assert.equal(calls[2].params.operationId, calls[1].params.operationId);
    finish!({ dispatched: true, status: "completed", requiresObservation: true }); await rejection;
  } finally { await kernel.dispose(); await rm(root, { recursive: true, force: true }); }
});
