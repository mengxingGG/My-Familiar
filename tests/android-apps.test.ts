import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { bootstrapAndroid } from "../apps/tauri/runtime/bootstrap.ts";
import type { AndroidNative } from "../plugins/platform-android/index.ts";
import { mobileTasks } from "../plugins/platform-android/approvals.ts";

test("Android 应用发现/启动共用审批，拒绝任意 Intent，取消只到对应原生操作", async () => {
  const root = await mkdtemp(resolve(".artifacts/android-apps-core-")), calls: { method: string; params: any }[] = [];
  const target = { ref: "a".repeat(8) + "-aaaa-aaaa-aaaa-" + "a".repeat(12), label: "日历 <script>", packageName: "fixture.calendar" };
  let finish: ((v: unknown) => void) | undefined, slow = false;
  const native: AndroidNative = { async call<T>(method: string, params = {}) {
    if (method.startsWith("apps.")) calls.push({ method, params });
    if (method === "apps.search") return { matches: [target], total: 1, nextOffset: null, expiresInSeconds: 120 } as T;
    if (method === "apps.open") return (slow ? await new Promise<unknown>(r => { finish = r; }) : { submitted: true, status: "visible", requiresObservation: true }) as T;
    return (method === "secrets.readAll" ? {} : method === "capabilities.status" ? [] : null) as T;
  } };
  const kernel = await bootstrapAndroid(root, resolve("."), native), tools = kernel.resolve("agent.tools"), approvals = kernel.resolve("agent.approvals");
  const run = (name: string, args: unknown, signal = new AbortController().signal) => tools.run({ id: "apps-check", name, arguments: JSON.stringify(args) }, signal);
  const wait = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise(r => setTimeout(r, 5)); assert(fn()); };
  try {
    for (const invalid of [{ target, uri: "https://example.com" }, { target: { ...target, ref: "made-up" } }, { target: { ...target, component: "other/Screen" } }, { target, operationId: "injected" }]) await assert.rejects(run("android_open_app", invalid), /参数/);
    for (const invalid of [{ query: "" }, { query: "app", offset: -1 }]) await assert.rejects(run("android_apps", invalid), /参数/);
    let request = run("android_apps", { query: "日历" }); await wait(() => approvals.list().length === 1);
    assert.equal(calls.length, 0); assert.equal(mobileTasks(approvals.list())[0].title, "查找手机应用");
    await approvals.decide(approvals.list()[0].id, true); assert.equal(JSON.parse(await request).matches[0].label, target.label);
    request = run("android_open_app", { target }); let rejected = assert.rejects(request, /拒绝/); await wait(() => approvals.list().length === 1);
    const view = mobileTasks(approvals.list())[0]; assert.equal(view.kind, "accessibility"); assert.equal(view.title, "打开手机应用"); assert(view.detail.includes(target.label)); assert(!view.detail.includes(target.ref));
    await approvals.decide(view.id, false); await rejected; assert.equal(calls.length, 1);
    request = run("android_open_app", { target }); await wait(() => approvals.list().length === 1); await approvals.decide(approvals.list()[0].id, true);
    assert.equal(JSON.parse(await request).status, "visible"); assert.match(calls.at(-1)!.params.operationId, /^[a-f0-9-]{36}$/);
    const before = new AbortController(); request = run("android_open_app", { target }, before.signal); rejected = assert.rejects(request, /取消/);
    await wait(() => approvals.list().length === 1); before.abort(); await rejected; assert.equal(calls.length, 2);
    slow = true; const during = new AbortController(); request = run("android_open_app", { target }, during.signal); rejected = assert.rejects(request, /abort/i);
    await wait(() => approvals.list().length === 1); await approvals.decide(approvals.list()[0].id, true); await wait(() => !!finish); during.abort();
    await wait(() => calls.length === 4); assert.equal(calls[3].method, "apps.cancel"); assert.equal(calls[3].params.operationId, calls[2].params.operationId);
    finish!({ submitted: true, status: "unconfirmed", requiresObservation: true }); await rejected;
  } finally { await kernel.dispose(); await rm(root, { recursive: true, force: true }); }
});
