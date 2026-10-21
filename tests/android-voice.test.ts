import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import { bootstrapAndroid } from "../apps/tauri/runtime/bootstrap.ts";
import { mobileApi } from "../apps/tauri/runtime/mobile-api.ts";
import { isMobileSnapshot } from "../packages/mobile-bridge/index.ts";
import type { AndroidNative } from "../plugins/platform-android/index.ts";
import type { MobileRequest } from "../packages/mobile-bridge/index.ts";
import type { MobileSnapshot } from "../packages/mobile-contracts/index.ts";
import { pcmWav } from "../plugins/voice-session/audio.ts";

test("Android 语音复用共享引擎：独立凭据、真实转写协议、原会话草稿、连续会话保护和取消", async () => {
  const root = await mkdtemp(resolve(".artifacts/android-voice-core-"));
  const keys: Record<string, string> = {}, nativeEvents: any[] = [];
  let allowed = false, slow = false, sttRequests = 0, lastWav = Buffer.alloc(0);
  const server = createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part); const body = Buffer.concat(parts);
    if (req.url?.endsWith("/transcriptions")) {
      sttRequests++; assert.equal(req.headers.authorization, "Bearer isolated-stt"); lastWav = body;
      const timer = setTimeout(() => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ text: "模拟转写回填原会话" })); }, slow ? 3000 : 5); res.on("close", () => clearTimeout(timer));
    } else if (req.url?.endsWith("/speech")) {
      assert.equal(req.headers.authorization, "Bearer isolated-tts");
      res.setHeader("Content-Type", "audio/wav"); res.end(pcmWav(new Uint8Array(4800), 24000));
    } else { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end('data: {"choices":[{"delta":{"content":"语音测试回答"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); const address = server.address(); assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/v1`;
  let api: ReturnType<typeof mobileApi>;
  const native: AndroidNative = { async call<T>(method: string, params = {}) {
    const p = params as any;
    if (method === "secrets.readAll") return { ...keys } as T;
    if (method === "secrets.write") { if (p.value) keys[p.name] = p.value; else delete keys[p.name]; }
    if (method === "capabilities.status") return [{ id: "microphone", state: allowed ? "granted" : "notGranted", title: "麦克风", description: "测试", detail: "隔离设备适配" }] as T;
    if (method === "runtime.status") return { running: false, overlayVisible: false, engine: "ready", detail: "fixture" } as T;
    if (method === "audio.command") {
      nativeEvents.push(p);
      if (p.type === "listen") setTimeout(() => void call("voice.host", { type: "listening", epoch: p.epoch }), 0);
      if (p.type === "play") {
        const file = join(root, "voice-outbox", `${p.token}.audio`); assert((await readFile(file)).subarray(0, 4).toString() === "RIFF"); assert(!p.data); await rm(file);
        setTimeout(() => void call("voice.host", { type: "playing-end", epoch: p.epoch, playback: p.playback, id: p.id }), 0);
      }
      if (p.type === "audio-end") setTimeout(() => void call("voice.host", { type: "playing-end", epoch: p.epoch, playback: p.playback, id: p.id }), 0);
    }
    return null as T;
  } };
  const kernel = await bootstrapAndroid(root, resolve("."), native); api = mobileApi(kernel, native);
  let sequence = 0;
  async function call(method: MobileRequest["method"], params?: unknown) { const r = await api({ protocolVersion: 1, id: `v-${++sequence}`, method, params }); assert(r.ok, `${method}: ${r.error?.code}`); return r.result as any; }
  async function until(test: (s: MobileSnapshot) => boolean) { for (let i = 0; i < 200; i++) { const s = await call("snapshot.get"); if (test(s)) return s as MobileSnapshot; await new Promise(r => setTimeout(r, 10)); } throw Error("voice test timeout " + JSON.stringify({state:kernel.resolve("voice.session").state(), native:nativeEvents.map(p=>({type:p.type,epoch:p.epoch,playback:p.playback}))})); }
  try {
    const config = { stt: { kind: "compatible", baseUrl: url, model: "stt-fixture", apiKey: "isolated-stt" }, tts: { kind: "compatible", baseUrl: url, model: "tts-fixture", voice: "fixture", speed: 1, apiKey: "isolated-tts" }, autoRead: false, continuous: true };
    await call("voice.save", config);
    let s = await call("snapshot.get"); assert(isMobileSnapshot(s)); assert(!JSON.stringify(s).includes("isolated-"));
    assert(s.voice?.settings.stt.keyConfigured && s.voice?.settings.tts.keyConfigured);
    const original = (await call("conversation.create")).id;
    const denied = await api({ protocolVersion: 1, id: "denied", method: "voice.start", params: { mode: "dictation", conversationId: original } }); assert.equal(denied.ok, false); assert(!nativeEvents.some(p => p.type === "listen"));
    allowed = true; await call("voice.start", { mode: "dictation", conversationId: original }); await until(s => s.voice?.state.phase === "recording");
    const listen = nativeEvents.findLast(p => p.type === "listen");
    await call("voice.host", { type: "pcm", epoch: listen.epoch, data: Buffer.alloc(9600).toString("base64") });
    const other = (await call("conversation.create")).id; await call("voice.finish"); s = await until(s => Boolean(s.voice?.dictation));
    assert.equal(s.voice.dictation.conversationId, original); assert.equal(s.activeConversationId, other); assert.equal(s.conversations.find((c: any) => c.id === original).messages.length, 0);
    assert(lastWav.includes(Buffer.from("RIFF"))); assert(lastWav.includes(Buffer.from("stt-fixture"))); assert.equal(sttRequests, 1);
    slow = true; await call("voice.start", { mode: "dictation", conversationId: original }); await until(s => s.voice?.state.phase === "recording");
    await call("voice.host", { type: "pcm", epoch: nativeEvents.findLast(p => p.type === "listen").epoch, data: Buffer.alloc(9600).toString("base64") });
    await call("voice.finish"); await until(s => s.voice?.state.phase === "thinking"); await call("voice.stop");
    s = await call("snapshot.get"); assert.equal(s.voice.dictation, undefined); assert.equal(s.voice.state.active, false);
    await call("provider.save", { kind: "compatible", baseUrl: url, model: "chat-fixture" });
    slow = false; await call("voice.start", { mode: "conversation", conversationId: original }); await until(s => s.voice?.state.phase === "listening");
    for (const [method, params] of [["conversation.select", { id: other }], ["message.send", { text: "错误会话", conversationId: other }], ["conversation.delete", { id: original }]] as const) {
      const r = await api({ protocolVersion: 1, id: `blocked-${method}`, method, params }); assert.equal(r.error?.code, "BUSY");
    }
    const generation = nativeEvents.findLast(p => p.type === "listen").epoch;
    const speech = Buffer.alloc(4800); for (let i = 0; i < speech.length / 2; i++) speech.writeInt16LE(Math.round(Math.sin(i * 0.15) * 5000), i * 2);
    for (let i = 0; i < 5; i++) await call("voice.host", { type: "pcm", epoch: generation, data: speech.toString("base64") });
    for (let i = 0; i < 12; i++) await call("voice.host", { type: "pcm", epoch: generation, data: Buffer.alloc(4800).toString("base64") });
    await until(s => s.voice?.state.phase === "listening" && s.conversations.some(c => c.id === original && c.messages.some(m => m.role === "assistant" && m.status === "complete")));
    await call("voice.stop"); await call("message.send", { text: "测试朗读", conversationId: original });
    s = await until(s => !s.activeReply && s.conversations.some(c => c.id === original && c.messages.some(m => m.role === "assistant" && m.status === "complete")));
    const reply = s.conversations.find((c: any) => c.id === original).messages.findLast((m: any) => m.role === "assistant");
    await call("voice.read", { conversationId: original, messageId: reply.id }); await until(s => s.voice?.state.phase === "off"); assert(nativeEvents.some(p => ["play", "pcm"].includes(p.type)));
    // 相同内容从共享缓存回放，走私有音频文件而不是把完整数据塞入 IPC。
    await call("voice.read", { conversationId: original, messageId: reply.id }); await until(s => s.voice?.state.phase === "off"); assert(nativeEvents.some(p => p.type === "play"));
    await call("voice.save", { ...config, stt: { ...config.stt, apiKey: undefined, baseUrl: `${url}/another` }, tts: { ...config.tts, apiKey: undefined } });
    s = await call("snapshot.get"); assert(!s.voice.settings.stt.keyConfigured); assert(s.voice.settings.tts.keyConfigured);
  } finally { await kernel.dispose(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(root, { recursive: true, force: true }); }
});
