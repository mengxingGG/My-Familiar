import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { bootstrapAndroid } from "../apps/tauri/runtime/bootstrap.ts";
import { mobileApi } from "../apps/tauri/runtime/mobile-api.ts";
import { projectFeishuResult } from "../packages/mobile-bridge/feishu.ts";
import { tenantTokenClient } from "../plugins/feishu-android/token.ts";
import { mobileTasks } from "../plugins/platform-android/approvals.ts";
import type { AndroidNative } from "../plugins/platform-android/index.ts";
import type { ManagedFeishuRequest } from "../plugins/feishu-android/runner.ts";
import type { MobileCommand, MobileFeishuStatus } from "../packages/mobile-contracts/index.ts";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await sleep(10); } throw Error("Fixture deadline"); }

test("飞书办公真实核心装配：独立开关、审批、凭据变更、崩溃不重放及重启", async () => {
  await mkdir(".artifacts", { recursive: true }); const root = await mkdtemp(resolve(".artifacts/office-core-"));
  const keys = new Map<string, string>(); let serial = 0, authCalls = 0, crash = false, hold = false;
  const calls: ManagedFeishuRequest[] = [];
  const native: AndroidNative = { async call<T>(method: string, p: Record<string, unknown> = {}) {
    if (method === "secrets.write") { p.value ? keys.set(String(p.name), String(p.value)) : keys.delete(String(p.name)); return null as T; }
    return (method === "secrets.readAll" ? Object.fromEntries(keys) : method === "runtime.status" ? { running: true, overlayVisible: true, engine: "ready" } : method === "capabilities.status" ? [] : null) as T;
  } };
  const options = { feishuOffice: {
    fetcher: (async (url: string | URL | Request, init?: RequestInit) => { authCalls++; assert.equal(url, "https://accounts.feishu.cn/oauth/v3/token"); assert.equal(init?.redirect, "error"); const p = JSON.parse(String(init?.body)); assert.equal(p.client_id, "cli_0123456789abcdef"); assert(["fixture-secret", "fixture-replaced"].includes(p.client_secret)); return Response.json({ code: 0, access_token: "fixture-token", token_type: "Bearer", expires_in: 7200 }); }) as typeof fetch,
    async execute(input: ManagedFeishuRequest, signal: AbortSignal) {
      signal.throwIfAborted(); calls.push(structuredClone(input));
      if (input.args.at(-1) === "--help") return { code: 0, output: input.args.includes("+agenda") ? "Risk: read" : input.args[0] === "docs" && input.args.includes("+create") ? "Risk: high-risk-write\n      --yes confirm" : "Risk: write", errors: "" };
      if (input.args[0] === "calendar" && input.args.includes("--yes")) return { code: 2, output: "", errors: "unknown flag: --yes" };
      if (hold) await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("cancelled")), { once: true }));
      return crash ? { code: 139, output: "", errors: "", interrupted: "process-failed" as const } : { code: 0, output: JSON.stringify({ ok: true, fixture: true }), errors: "" };
    },
  } };
  let kernel = await bootstrapAndroid(root, resolve("."), native, options), api = mobileApi(kernel, native);
  const raw = (method: MobileCommand, params?: unknown) => api({ protocolVersion: 1, id: String(++serial), method, params });
  const call = async (method: MobileCommand, params?: unknown) => { const r = await raw(method, params); assert(r.ok, JSON.stringify(r)); return r.result as MobileFeishuStatus; };
  const tools = () => kernel.resolve("agent.tools"), approvals = () => kernel.resolve("agent.approvals");
  const run = (args: string[]) => tools().run({ id: String(++serial), name: "feishu_cli", arguments: JSON.stringify({ args }) }, new AbortController().signal);
  const enable = async (s: MobileFeishuStatus, enabled = true) => call("feishu.office.save", { enabled, revision: s.office!.revision, channelRevision: s.revision });
  try {
    let s = await call("feishu.status"); assert(!s.office!.enabled && s.office!.available); assert(!tools().list().some(tool => tool.name === "feishu_cli"));
    assert.equal((await raw("feishu.office.save", { enabled: true, revision: s.office!.revision, channelRevision: s.revision })).error?.code, "UNAVAILABLE");
    assert.equal((await raw("feishu.office.check", { args: ["docs", "+create"] })).error?.code, "INVALID_INPUT");
    await call("feishu.office.check"); assert.equal(authCalls, 0); assert.equal(calls.length, 1);
    s = await call("feishu.save", { appId: "cli_0123456789abcdef", enabled: false, allowedUsers: [], revision: s.revision, appSecret: "fixture-secret" });
    s = await enable(s); assert(s.office!.enabled && !s.enabled); assert(tools().list().some(tool => tool.name === "feishu_cli"));
    await run(["docs", "--help"]); assert.equal(authCalls, 0);
    await run(["calendar", "+agenda"]); assert.equal(authCalls, 1); assert.equal(calls.at(-1)!.token, "fixture-token"); assert.equal(calls.at(-1)!.identity, "bot");
    const write = run(["docs", "+create", "--title", "审批验证", "--content", "text"]); await until(() => approvals().list().length === 1);
    assert.equal(calls.at(-1)!.args.at(-1), "--help"); assert.equal(authCalls, 1);
    assert.match(mobileTasks(approvals().list())[0].title, /飞书办公/);
    await approvals().decide(approvals().list()[0].id, false); await assert.rejects(write); assert.equal(calls.at(-1)!.args.at(-1), "--help");
    const allowed = run(["docs", "+create", "--title", "批准验证", "--content", "text"]); await until(() => approvals().list().length === 1); await approvals().decide(approvals().list()[0].id, true); await allowed;
    assert.equal(calls.at(-1)!.args.at(-1), "--yes"); assert.equal(authCalls, 1);
    const regular = run(["calendar", "+create", "--dry-run"]); await until(() => approvals().list().length === 1); await approvals().decide(approvals().list()[0].id, true);
    assert.equal(JSON.parse(await regular).ok, true); assert(!calls.at(-1)!.args.includes("--yes")); assert.equal(authCalls, 1);
    const stale = run(["docs", "+create"]); await until(() => approvals().list().length === 1); const oldCalls = calls.length;
    s = await call("feishu.status"); s = await call("feishu.save", { appId: s.appId, enabled: false, allowedUsers: [], revision: s.revision, appSecret: "fixture-replaced" });
    await approvals().decide(approvals().list()[0].id, true); await assert.rejects(stale, /工具连接已变化/); assert.equal(calls.length, oldCalls);
    crash = true; const result = JSON.parse(await run(["calendar", "+agenda"])); assert.equal(result.outcome, "unknown"); assert.equal(result.interrupted, "process-failed"); assert.equal(authCalls, 2); const once = calls.length; await sleep(50); assert.equal(calls.length, once); crash = false;
    hold = true; const inflight = run(["calendar", "+agenda"]); const cancelled = assert.rejects(inflight); await until(() => kernel.resolve("feishu.office").status().pending === 1);
    await call("runtime.set", { enabled: false }); await cancelled; assert(!tools().list().some(tool => tool.name === "feishu_cli")); hold = false;
    await call("runtime.set", { enabled: true }); assert(tools().list().some(tool => tool.name === "feishu_cli"));
    await kernel.dispose(); kernel = await bootstrapAndroid(root, resolve("."), native, options); api = mobileApi(kernel, native); assert(tools().list().some(tool => tool.name === "feishu_cli"));
    s = await call("feishu.status"); assert(!JSON.stringify(projectFeishuResult({ ...s, office: { ...s.office, token: "must-hide" } })).includes("must-hide"));
    assert(!(await readFile(join(root, "data/feishu-office.json"), "utf8")).includes("fixture-secret"));
    await enable(s, false); assert(!tools().list().some(tool => tool.name === "feishu_cli"));
  } finally { await kernel.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("机器人临时凭据按期限刷新、支持长 JWT、拒绝重定向/畸形/超限并隐藏错误内容", async () => {
  let clock = 0, calls = 0, mode = "ok";
  const client = tenantTokenClient((async (_url: unknown, init?: RequestInit) => {
    calls++; assert.equal(init?.redirect, "error");
    if (mode === "large") return new Response("s".repeat(66000));
    if (mode === "bad") return Response.json({ code: 999, error: "sensitive-secret" });
    return Response.json({ code: 0, access_token: "t".repeat(8192), token_type: "Bearer", expires_in: 100 });
  }) as typeof fetch, () => clock);
  const signal = new AbortController().signal;
  assert.equal((await client.get("app", "secret", signal)).length, 8192); await client.get("app", "secret", signal); assert.equal(calls, 1);
  clock = 91000; await client.get("app", "secret", signal); assert.equal(calls, 2);
  await client.get("app", "changed", signal); assert.equal(calls, 3); client.clear(); mode = "bad";
  await assert.rejects(client.get("app", "changed", signal), /^Error: FEISHU_AUTH_FAILED$/); mode = "large";
  await assert.rejects(client.get("app", "changed", signal), /^Error: FEISHU_AUTH_FAILED$/);
  const aborted = AbortSignal.abort(); const before = calls; await assert.rejects(client.get("app", "secret", aborted)); assert.equal(calls, before);
});
