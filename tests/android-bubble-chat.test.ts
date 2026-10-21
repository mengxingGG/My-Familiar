import test from "node:test";
import assert from "node:assert/strict";
import { mobileApi } from "../apps/tauri/runtime/mobile-api.ts";
import { androidPetSurface } from "../plugins/platform-android/pet-surface.ts";
import type { Kernel } from "../packages/kernel/index.ts";
import type { MobileRequest } from "../packages/mobile-bridge/index.ts";
import type { ChatState } from "../packages/contracts/index.ts";
import type { AndroidNative } from "../plugins/platform-android/index.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { bootstrapAndroid } from "../apps/tauri/runtime/bootstrap.ts";

test("气泡使用当前共享会话连续发送、流式状态、停止，旧会话与额外参数拒绝", async () => {
  let current = "conversation-original", sequence = 0, configured = true, sends = 0, cancelled = 0;
  const actions: string[] = [];
  const state: ChatState = { busy: false, messages: [] };
  const services: Record<string, unknown> = {
    settings: { get: () => ({ persona: { name: "小森" }, provider: { model: configured ? "test" : "" } }) },
    "conversation.history": { current: () => current },
    conversation: {
      state: () => structuredClone(state),
      async send(text: string) { sends++; state.messages.push({ id: "user-" + sends, role: "user", text, status: "complete", time: Date.now() }, { id: "reply-" + sends, role: "assistant", text: "", status: "streaming", time: Date.now() }); state.busy = true; },
      async cancel() { cancelled++; state.busy = false; },
    },
    "companion.presentation": { controller: (active: boolean) => actions.push("controller:" + active) },
    commands: { call: async (name: string) => { actions.push(name); } },
    "voice.session": { state: () => ({ active: false, phase: "off" }) },
    "android.wake": { status: () => ({ armed: false }) },
  };
  const kernel = { resolve: (id: string) => services[id] ?? {} } as unknown as Kernel;
  const native: AndroidNative = { async call<T>() { assert.fail("气泡核心不启动主 Activity 或另建原生会话"); return null as T; } };
  const api = mobileApi(kernel, native);
  const call = (method: MobileRequest["method"], params?: unknown) => api({ protocolVersion: 1, id: String(++sequence), method, params });
  const good = async (method: MobileRequest["method"], params?: unknown) => { const r = await call(method, params); assert(r.ok, JSON.stringify(r)); return r.result as Record<string, unknown>; };
  const send = (text: string, id = current) => call("pet.chat.send", { conversationId: id, text });
  await good("pet.host", { action: "compose" }); assert(actions.includes("chat.open"));
  const first = await good("pet.chat.state"); assert.equal(first.conversationId, current); assert.equal(first.reply, "");
  assert((await send("第一句")).ok); assert.equal((await good("pet.chat.state")).lastUser, "第一句");
  assert.equal((await send("不能重复发送")).error?.code, "BUSY"); assert.equal(sends, 1);
  state.messages.at(-1)!.text = "流式第一段"; assert.equal((await good("pet.chat.state")).reply, "流式第一段");
  state.messages.at(-1)!.text += "，第二段"; state.busy = false; state.messages.at(-1)!.status = "complete";
  assert((await send("接着第二句")).ok); assert.equal(sends, 2); assert.equal(state.messages.filter(m => m.role === "user").length, 2);
  await good("pet.chat.cancel", { conversationId: current }); assert.equal(cancelled, 1);
  current = "conversation-switched";
  assert.equal((await send("旧草稿", "conversation-original")).error?.code, "CONFLICT");
  assert.equal((await call("pet.chat.cancel", { conversationId: "conversation-original" })).error?.code, "CONFLICT"); assert.equal(cancelled, 1);
  assert.equal((await call("pet.chat.send", { conversationId: current, text: "text", provider: "other" })).error?.code, "INVALID_INPUT");
  assert.equal((await send(" ")).error?.code, "INVALID_INPUT"); configured = false; assert.equal((await send("尚未配置")).error?.code, "PROVIDER");
  assert.equal(sends, 2); await good("pet.host", { action: "close" }); assert(actions.includes("chat.close") && actions.includes("speech.close"));
  state.messages.at(-1)!.text = "中".repeat(13000); const bounded = await good("pet.chat.state"); assert.equal(String(bounded.reply).length, 12000); assert.equal(bounded.truncated, true);
  assert.deepEqual(Object.keys(bounded).sort(), ["busy", "conversationId", "lastUser", "modelConfigured", "name", "reply", "replyId", "truncated"].sort());
});

test("共享 chat.open 对 Android 映射到气泡输入，不再映射主应用打开", async () => {
  const calls: Record<string, unknown>[] = [];
  const native: AndroidNative = { async call<T>(method: string, p = {}) { calls.push({ method, ...p }); return null as T; } };
  const surface = androidPetSurface(native, () => {});
  await surface.create("composer"); surface.show("composer", true); surface.show("composer", false);
  surface.show("speech", true); await new Promise(r => setImmediate(r));
  assert(calls.some(p => p.type === "composer-visible" && p.visible === true));
  assert(calls.some(p => p.type === "composer-visible" && p.visible === false)); assert(!calls.some(p => p.type === "open"));
  surface.openController(); await new Promise(r => setImmediate(r)); assert(calls.some(p => p.type === "open"));
  await surface.dispose();
});

test("真实共享核心的气泡入口连续对话保留上下文，流式可停止并与主应用历史一致", async () => {
  const requests: any[] = [], presentations: Record<string, unknown>[] = [];
  let hold = false;
  const server = createServer(async (req, res) => {
    if (req.url?.endsWith("/models")) { res.end(JSON.stringify({ data: [{ id: "bubble-test" }] })); return; }
    let raw = ""; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw); requests.push(request);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const content = request.messages.filter((m: any) => m.role === "user").at(-1).content;
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "回答：" + content }, finish_reason: null }] })}\n\n`);
    if (!hold) res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); const address = server.address() as { port: number };
  const root = await mkdtemp(resolve(".artifacts/bubble-core-"));
  const native: AndroidNative = { async call<T>(method: string, p = {}) {
    if (method === "pet.present") presentations.push(p);
    return (method === "secrets.readAll" ? {} : method === "capabilities.status" ? [] : method === "runtime.status" ? { engine: "ready", running: true, overlayVisible: true } : null) as T;
  } };
  const kernel = await bootstrapAndroid(root, resolve("."), native), api = mobileApi(kernel, native); let sequence = 0;
  const raw = (method: MobileRequest["method"], params?: unknown) => api({ protocolVersion: 1, id: String(++sequence), method, params });
  const call = async (method: MobileRequest["method"], params?: unknown) => { const result = await raw(method, params); assert(result.ok, JSON.stringify(result)); return result.result as Record<string, any>; };
  const until = async (check: () => boolean) => { for (let n = 0; n < 400; n++) { if (check()) return; await new Promise(done => setTimeout(done, 5)); } throw Error("Fixture deadline"); };
  try {
    await call("provider.save", { kind: "compatible", model: "bubble-test", baseUrl: `http://127.0.0.1:${address.port}/v1` });
    await call("pet.host", { action: "compose" }); await until(() => presentations.some(p => p.type === "composer-visible" && p.visible));
    const id = (await call("pet.chat.state")).conversationId;
    await call("pet.chat.send", { conversationId: id, text: "你好" }); await until(() => !kernel.resolve("conversation").state().busy);
    assert.equal((await call("pet.chat.state")).reply, "回答：你好");
    await call("pet.chat.send", { conversationId: id, text: "继续聊" }); await until(() => !kernel.resolve("conversation").state().busy);
    assert(requests.at(-1).messages.some((m: any) => m.role === "assistant" && m.content === "回答：你好"));
    assert.equal((await call("pet.chat.state")).conversationId, id);
    hold = true; await call("pet.chat.send", { conversationId: id, text: "请慢慢说" }); await until(() => kernel.resolve("conversation").state().messages.at(-1)!.text.startsWith("回答："));
    assert.equal((await raw("pet.chat.send", { conversationId: id, text: "不要重复" })).error?.code, "BUSY");
    await call("pet.chat.cancel", { conversationId: id }); assert(!kernel.resolve("conversation").state().busy);
    const full = await call("snapshot.get"), conversation = full.conversations.find((c: any) => c.id === id);
    assert.equal(conversation.messages.filter((m: any) => m.role === "user").length, 3); assert.equal(conversation.messages.at(-1).status, "stopped");
    const next = await call("conversation.create"); const count = requests.length;
    assert.equal((await raw("pet.chat.send", { conversationId: id, text: "旧窗口草稿" })).error?.code, "CONFLICT");
    assert.equal(requests.length, count); assert.equal((await call("pet.chat.state")).conversationId, next.id);
    assert(!presentations.some(p => p.type === "open"));
  } finally { await kernel.dispose(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true }); }
});
