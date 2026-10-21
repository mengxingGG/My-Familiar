import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { bootstrapAndroid } from "../apps/tauri/runtime/bootstrap.ts";
import { mobileApi } from "../apps/tauri/runtime/mobile-api.ts";
import { projectFeishuResult } from "../packages/mobile-bridge/feishu.ts";
import { feishuOAuthHttp, officialAuthorizationUrl } from "../plugins/feishu-android/auth-http.ts";
import type { AndroidNative } from "../plugins/platform-android/index.ts";
import type { ManagedFeishuRequest } from "../plugins/feishu-android/runner.ts";
import type { MobileCommand, MobileFeishuStatus } from "../packages/mobile-contracts/index.ts";
const tick = () => new Promise(r => setTimeout(r, 5));
async function until(f: () => boolean) { for (let n = 0; n < 300; n++) { if (f()) return; await tick(); } throw Error("Fixture timeout"); }
const appId = "cli_0123456789abcdef";
async function fixture() {
  const root = await mkdtemp(resolve(".artifacts/auth-core-")), keys = new Map<string, string>();
  const writes: string[] = [], requests: { url: string; init: RequestInit }[] = [], runs: ManagedFeishuRequest[] = [], opened: string[] = [];
  const f = { clock: 1000000, polling: ["success"], refreshFailure: false, failWrite: false, holdPoll: false, holdRefresh: false, missing: false,
    holdUserWrite: false, releaseUserWrite: undefined as (() => void) | undefined,
    releasePoll: undefined as (() => void) | undefined, releaseRefresh: undefined as (() => void) | undefined };
  const waits: { ms: number; release(): void; signal: AbortSignal }[] = [];
  const native: AndroidNative = { async call<T>(method: string, p: Record<string, unknown> = {}) {
    if (method === "secrets.write") {
      if (f.failWrite && p.name === "feishu-user") throw Error("fixture storage unavailable");
      if (f.holdUserWrite && p.name === "feishu-user" && p.value) { f.holdUserWrite = false; await new Promise<void>(r => f.releaseUserWrite = r); }
      p.value ? keys.set(String(p.name), String(p.value)) : keys.delete(String(p.name));
      if (p.name === "feishu-user") writes.push(String(p.value ?? "")); return null as T;
    }
    if (method === "feishu.auth.open") opened.push(String(p.url));
    return (method === "secrets.readAll" ? Object.fromEntries(keys) : method === "runtime.status" ? { running: true, overlayVisible: true, engine: "ready" } : method === "capabilities.status" ? [] : null) as T;
  } };
  const tokens = (name: string) => ({ access_token: "access-" + name, refresh_token: "refresh-" + name, expires_in: 120, refresh_token_expires_in: 1000, scope: "offline_access calendar:calendar:read" });
  const options = { feishuAuth: {
    now: () => f.clock,
    wait: (ms: number, signal: AbortSignal) => new Promise<void>((done, reject) => {
      const cancelled = () => reject(Error("cancelled"));
      const entry = { ms, signal, release() { signal.removeEventListener("abort", cancelled); f.clock += ms; done(); } };
      signal.addEventListener("abort", cancelled, { once: true }); waits.push(entry);
    }),
    fetcher: (async (url: string | URL | Request, init: RequestInit) => {
      requests.push({ url: String(url), init }); assert.equal(init.redirect, "error");
      if (String(url).endsWith("/device_authorization")) {
        assert.equal(init.headers && (init.headers as Record<string, string>).Authorization, "Basic " + Buffer.from(appId + ":fixture-secret").toString("base64"));
        return Response.json({ device_code: "private-device", user_code: "ABCD-EFGH", verification_uri_complete: "https://accounts.feishu.cn/oauth/device?user_code=ABCD-EFGH", expires_in: 240, interval: 5 });
      }
      if (String(url).endsWith("/user_info")) return Response.json({ code: 0, data: { open_id: "ou_fixture", name: "测试用户" } });
      assert.equal(String(url), "https://open.feishu.cn/open-apis/authen/v2/oauth/token");
      if (String(init.body).startsWith("{")) {
        const record = JSON.parse(keys.get("feishu-user")!); assert(record.refreshing, "refresh marker must precede HTTP");
        if (f.holdRefresh) await new Promise<void>(r => f.releaseRefresh = r);
        if (f.refreshFailure) throw Error("secret-server-message");
        return Response.json(tokens("rotated"));
      }
      assert.equal(new URLSearchParams(String(init.body)).get("device_code"), "private-device");
      if (f.holdPoll) await new Promise<void>(r => f.releasePoll = r);
      const next = f.polling.shift() ?? "pending";
      if (next === "network") throw Error("secret-network-message");
      return Response.json(next === "success" ? tokens("initial") : { error: next === "pending" ? "authorization_pending" : next === "slow" ? "slow_down" : next });
    }) as typeof fetch,
  }, feishuOffice: { fetcher: (async () => { throw Error("Bot fallback forbidden"); }) as typeof fetch,
    async execute(input: ManagedFeishuRequest) {
      runs.push(input);
      if (input.args.at(-1) === "--help") return { code: 0, output: input.args.includes("+agenda") ? "Risk: read" : "Risk: write", errors: "" };
      return f.missing ? { code: 1, output: "", errors: JSON.stringify({ error: { type: "authorization", subtype: "missing_scope", missing_scopes: ["docx:document:write_only"] } }) } : { code: 0, output: "{}", errors: "" };
    } } };
  let kernel = await bootstrapAndroid(root, resolve("."), native, options), api = mobileApi(kernel, native), seq = 0;
  const auth = () => kernel.resolve("feishu.auth");
  const raw = (method: MobileCommand, params?: unknown) => api({ protocolVersion: 1, id: String(++seq), method, params });
  const call = async (method: MobileCommand, params?: unknown) => { const result = await raw(method, params); assert(result.ok, JSON.stringify(result)); return result.result as MobileFeishuStatus; };
  let s = await call("feishu.status"); await call("feishu.save", { revision: s.revision, appId, appSecret: "fixture-secret", enabled: false, allowedUsers: [] });
  const begin = async () => { s = await call("feishu.status"); return call("feishu.auth.begin", { revision: s.auth!.revision, channelRevision: s.revision, scopes: [] }); };
  const step = async () => { await until(() => waits.some(w => !w.signal.aborted)); const index = waits.findIndex(w => !w.signal.aborted); const next = waits.splice(index, 1)[0]; next.release(); await tick(); return next.ms; };
  const login = async () => { await begin(); await step(); await until(() => auth().status().connected); };
  return { f, keys, writes, requests, runs, opened, auth, raw, call, begin, step, login, get kernel() { return kernel; },
    async restart() { await kernel.dispose(); kernel = await bootstrapAndroid(root, resolve("."), native, options); api = mobileApi(kernel, native); },
    async close() { f.releasePoll?.(); f.releaseRefresh?.(); f.releaseUserWrite?.(); await kernel.dispose(); await rm(root, { recursive: true, force: true }); } };
}

test("设备登录：pending/slow/network 退避、官方页面、私密字段隔离、加密边界持久化及单次刷新", async () => {
  const x = await fixture();
  try {
    x.f.polling = ["pending", "slow", "network", "success"];
    let s = await x.begin(); assert.equal(s.auth!.phase, "authorizing");
    await x.call("feishu.auth.open", { revision: s.auth!.revision }); assert.match(x.opened[0], /^https:\/\/accounts.feishu.cn\//);
    const projected = projectFeishuResult({ ...s, auth: { ...s.auth, deviceCode: "hidden", accessToken: "hidden", authorization: { ...s.auth!.authorization, token: "hidden" } } });
    assert(!JSON.stringify(projected).includes("hidden")); assert(!JSON.stringify(s).includes("private-device"));
    assert.equal(await x.step(), 5000); assert.equal(await x.step(), 5000); assert.equal(await x.step(), 10000); assert.equal(await x.step(), 15000);
    await until(() => x.auth().status().connected); assert.equal(x.auth().status().user?.name, "测试用户");
    assert.equal(await x.auth().token(new AbortController().signal), "access-initial");
    await x.restart(); assert(x.auth().status().connected);
    x.f.clock += 70000; x.f.holdRefresh = true;
    const a = x.auth().token(new AbortController().signal), b = x.auth().token(new AbortController().signal);
    await until(() => !!x.f.releaseRefresh); assert.equal(x.auth().status().phase, "refreshing");
    x.f.releaseRefresh!(); assert.deepEqual(await Promise.all([a, b]), ["access-rotated", "access-rotated"]);
    assert.equal(x.requests.filter(r => String(r.init.body).startsWith("{")).length, 1);
    assert.equal(JSON.parse(x.keys.get("feishu-user")!).refreshToken, "refresh-rotated"); assert(!JSON.parse(x.keys.get("feishu-user")!).refreshing);
    x.f.failWrite = true;
    assert.equal((await x.raw("feishu.auth.forget", { revision: x.auth().status().revision })).error?.code, "UNAVAILABLE");
    assert.equal(x.auth().status().phase, "error"); assert.match(x.auth().status().detail, /清除本机登录失败/);
    x.f.failWrite = false; await x.call("feishu.auth.forget", { revision: x.auth().status().revision }); assert.equal(x.auth().status().phase, "signedOut");
  } finally { await x.close(); }
});

test("登录取消、拒绝、过期与应用换钥均拒绝迟到结果，不泄漏服务端错误", async () => {
  const x = await fixture();
  try {
    x.f.holdPoll = true; const s = await x.begin(); await x.step(); await until(() => !!x.f.releasePoll);
    await x.call("feishu.auth.cancel", { revision: s.auth!.revision }); x.f.releasePoll!(); await tick(); assert(!x.auth().status().connected && !x.keys.has("feishu-user"));
    assert.equal((await x.raw("feishu.auth.open", { revision: s.auth!.revision })).error?.code, "CONFLICT");
    x.f.holdPoll = false; x.f.polling = ["access_denied"]; await x.begin(); await x.step(); await until(() => x.auth().status().phase !== "authorizing"); assert.match(x.auth().status().detail, /拒绝/);
    x.f.polling = ["pending"]; await x.begin(); x.f.clock += 241000; await x.step(); await until(() => x.auth().status().phase !== "authorizing"); assert.match(x.auth().status().detail, /过期/);
    x.f.polling = ["success"]; await x.login(); let current = await x.call("feishu.status");
    await x.call("feishu.save", { appId, enabled: false, allowedUsers: [], revision: current.revision, appSecret: "changed-secret" });
    await until(() => !x.keys.has("feishu-user")); assert(!x.auth().status().connected);
    assert.equal((await x.raw("feishu.auth.begin", { revision: x.auth().status().revision, channelRevision: current.revision, scopes: [] })).error?.code, "CONFLICT");
  } finally { await x.close(); }
});

test("刷新失败不重放，进程遗留刷新标记须重登，存储失败不发刷新请求", async () => {
  const x = await fixture();
  try {
    await x.login(); x.f.clock += 70000; x.f.refreshFailure = true;
    await assert.rejects(x.auth().token(new AbortController().signal), /FEISHU_USER_REQUIRED/); assert(!x.auth().status().connected);
    const count = x.requests.length; await assert.rejects(x.auth().token(new AbortController().signal)); assert.equal(x.requests.length, count); assert(!JSON.stringify(x.auth().status()).includes("secret-server"));
    x.f.refreshFailure = false; x.f.polling = ["success"]; await x.login();
    const saved = x.keys.get("feishu-user")!; x.keys.set("feishu-user", JSON.stringify({ ...JSON.parse(saved), refreshing: true }));
    await x.restart(); assert.equal(x.auth().status().phase, "error"); await assert.rejects(x.auth().token(new AbortController().signal));
    x.keys.set("feishu-user", saved); await x.restart(); x.f.clock += 70000; x.f.failWrite = true;
    const before = x.requests.length; await assert.rejects(x.auth().token(new AbortController().signal)); assert.equal(x.requests.length, before);
    x.f.failWrite = false; await x.call("feishu.auth.forget", { revision: x.auth().status().revision }); assert(!x.keys.has("feishu-user"));
  } finally { await x.close(); }
});

test("个人办公沿用共享审批，刷新不打断当前命令，换身份使旧审批失效且不回退机器人", async () => {
  const x = await fixture();
  try {
    let s = await x.call("feishu.status"); s = await x.call("feishu.office.save", { enabled: true, identity: "user", revision: s.office!.revision, channelRevision: s.revision });
    assert(!x.kernel.resolve("agent.tools").list().some(t => t.name === "feishu_cli"));
    await x.login();
    const run = (args: string[]) => x.kernel.resolve("agent.tools").run({ id: "test", name: "feishu_cli", arguments: JSON.stringify({ args }) }, new AbortController().signal);
    x.f.clock += 70000; await run(["calendar", "+agenda"]); assert.equal(x.runs.at(-1)!.identity, "user"); assert.equal(x.runs.at(-1)!.token, "access-rotated");
    x.f.missing = true; const result = JSON.parse(await run(["calendar", "+agenda"])); assert.match(result.hint, /设置 → 飞书/); assert.deepEqual(x.kernel.resolve("feishu.office").status().missingScopes, ["docx:document:write_only"]); x.f.missing = false;
    const approvals = x.kernel.resolve("agent.approvals"); const write = run(["docs", "+create"]); const rejected = assert.rejects(write, /工具连接已变化/); await until(() => approvals.list().length === 1);
    assert.match(approvals.list()[0].rule!, /ou_fixture/); const before = x.runs.length;
    await x.call("feishu.auth.forget", { revision: x.auth().status().revision }); await approvals.decide(approvals.list()[0].id, true); await rejected;
    assert.equal(x.runs.length, before); assert(!x.kernel.resolve("agent.tools").list().some(t => t.name === "feishu_cli"));
    assert.equal((await x.raw("feishu.auth.begin", { revision: x.auth().status().revision, channelRevision: s.revision, scopes: [], url: "http://localhost" })).error?.code, "INVALID_INPUT");
  } finally { await x.close(); }
});

test("OAuth 传输限制官方地址、拒绝畸形令牌/超长响应/危险范围", async () => {
  assert(officialAuthorizationUrl("https://accounts.feishu.cn/oauth/device?a=1"));
  for (const url of ["http://accounts.feishu.cn", "https://accounts.feishu.cn.evil.test", "https://user@accounts.feishu.cn", "https://accounts.feishu.cn:444", "javascript:alert(1)"]) assert(!officialAuthorizationUrl(url));
  let response: unknown = { access_token: "bad token", expires_in: 10 };
  const http = feishuOAuthHttp((async () => response === "large" ? new Response("x".repeat(66000)) : Response.json(response)) as typeof fetch), signal = new AbortController().signal;
  await assert.rejects(http.poll("app", "secret", "code", signal), /AUTH_RESPONSE_INVALID/);
  response = "large"; await assert.rejects(http.poll("app", "secret", "code", signal), /^Error: AUTH_NETWORK_FAILED$/);
  await assert.rejects(http.start("app", "secret", ["scope bad"], signal), /INVALID_INPUT/);
});

test("取消与原生凭据写入交错不会复活登录，调用者取消不重发正在轮换的令牌", async () => {
  const x = await fixture();
  try {
    x.f.holdUserWrite = true; const s = await x.begin(); await x.step(); await until(() => !!x.f.releaseUserWrite);
    await x.call("feishu.auth.cancel", { revision: s.auth!.revision }); x.f.releaseUserWrite!(); await tick(); await tick();
    await x.restart(); assert(!x.auth().status().connected); assert(!x.keys.has("feishu-user"));
    x.f.polling = ["success"]; await x.login(); x.f.clock += 70000; x.f.holdRefresh = true;
    const controller = new AbortController(); const first = x.auth().token(controller.signal); const stopped = assert.rejects(first);
    await until(() => !!x.f.releaseRefresh); controller.abort(); await stopped;
    assert.equal(x.auth().status().phase, "refreshing"); const next = x.auth().token(new AbortController().signal);
    x.f.releaseRefresh!(); assert.equal(await next, "access-rotated");
    assert.equal(x.requests.filter(r => String(r.init.body).startsWith("{")).length, 1);
  } finally { await x.close(); }
});
