import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { bootstrapAndroid } from "../apps/tauri/runtime/bootstrap.ts";
import { mobileApi } from "../apps/tauri/runtime/mobile-api.ts";
import type { AndroidNative } from "../plugins/platform-android/index.ts";
import { isMobileSnapshot, type MobileRequest } from "../packages/mobile-bridge/index.ts";
import { liveFixture } from "./fixtures/live-voice.ts";

test("Android Live：两种协议共享主模型、独立密钥、录音路由与取消生命周期", async () => {
  const fixture = await liveFixture(), root = await mkdtemp(resolve(".artifacts/android-live-"));
  const keys: Record<string, string> = {}, events: any[] = [], states: any[] = [];
  let api: ReturnType<typeof mobileApi>, seq = 0;
  const native: AndroidNative = { async call<T>(method: string, p: any = {}) {
    if (method === "secrets.readAll") return { ...keys } as T;
    if (method === "secrets.write") { if (p.value) keys[p.name] = p.value; else delete keys[p.name]; }
    if (method === "capabilities.status") return [{ id: "microphone", state: "granted", title: "麦克风", description: "fixture", detail: "fixture" }] as T;
    if (method === "runtime.status") return { running: false, overlayVisible: false, engine: "ready", detail: "fixture" } as T;
    if (method === "audio.state") states.push(p);
    if (method === "audio.command") {
      events.push(p);
      if (p.type === "listen") setTimeout(() => void call("voice.host", { type: "listening", epoch: p.epoch }), 0);
      if (p.type === "audio-end") setTimeout(() => void call("voice.host", { type: "playing-end", epoch: p.epoch, playback: p.playback }), 0);
    }
    return null as T;
  } };
  const kernel = await bootstrapAndroid(root, resolve("."), native); api = mobileApi(kernel, native);
  async function raw(method: MobileRequest['method'], params?: unknown) { return api({ protocolVersion: 1, id: `live-${++seq}`, method, params }); }
  async function call(method: MobileRequest['method'], params?: unknown): Promise<any> { const r = await raw(method, params); assert(r.ok, `${method}: ${r.error?.code}`); return r.result; }
  async function until(fn: () => boolean | Promise<boolean>) { for (let i = 0; i < 300; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)); } throw Error("Live fixture timeout: " + JSON.stringify(kernel.resolve("voice.session").state())); }
  try {
    const initial = await call("snapshot.get"); assert(isMobileSnapshot(initial)); assert(initial.voice?.live);
    await call("provider.save", { kind: "compatible", baseUrl: fixture.url, model: "fixture-chat" });
    const id = (await call("conversation.create")).id;
    const profile = { mode: "realtime", kind: "openai", baseUrl: "https://api.openai.com/v1", model: "fixture", voice: "fixture" };
    await call("voice.live.save", profile);
    assert.equal((await raw("voice.start", { mode: "conversation", conversationId: id })).error?.code, "PROVIDER");
    assert(!events.some(p => p.type === "listen")); assert.equal(fixture.sessions.length, 0);
    for (const kind of ["openai", "gemini"] as const) {
      await call("voice.live.save", { ...profile, kind, baseUrl: fixture.url, apiKey: "isolated-" + kind });
      await call("voice.save", initial.voice.settings);
      const s = await call("snapshot.get"); assert(isMobileSnapshot(s)); assert(s.voice?.live); assert.equal(s.voice.live.mode, "realtime"); assert(s.voice.live.profile.keyConfigured);
      assert(!JSON.stringify(s).includes("isolated-")); assert(!s.voice.settings.stt.keyConfigured && !s.voice.settings.tts.keyConfigured);
      assert.equal((await raw("voice.start", { mode: "dictation", conversationId: id })).error?.code, "PROVIDER");
      const listens = events.filter(p => p.type === "listen").length;
      await call("voice.start", { mode: "conversation", conversationId: id });
      await until(() => fixture.sessions.at(-1)?.kind === kind && !!fixture.sessions.at(-1)?.setup);
      assert.equal(events.filter(p => p.type === "listen").length, listens);
      await until(() => states.at(-1)?.active && states.at(-1)?.phase === "connecting"); assert(Number.isInteger(states.at(-1).epoch));
      const socket = fixture.sessions.at(-1)!;
      assert.equal(socket.auth, (kind === "openai" ? "Bearer " : "") + "isolated-" + kind);
      assert.equal((await raw("voice.live.save", profile)).error?.code, "BUSY");
      fixture.ready(); await until(() => events.filter(p => p.type === "listen").length > listens);
      const epoch = events.findLast(p => p.type === "listen").epoch;
      await call("voice.host", { type: "pcm", epoch, data: Buffer.alloc(4800).toString("base64") }); await until(() => socket.bytes === 4800);
      const n = fixture.models.length; fixture.ask(); fixture.ask();
      await until(() => socket.messages.some(v => v.toolResponse || v.item?.type === "function_call_output"));
      assert.equal(fixture.models.length, n + 1);
      const response = socket.messages.find(v => v.toolResponse || v.item?.type === "function_call_output"); assert(JSON.stringify(response).includes("主模型的固定回答"));
      fixture.audio(); await until(() => events.some(p => p.epoch === epoch && p.type === "pcm" && p.rate === 24000));
      fixture.slow(1500); fixture.ask("cancel-turn"); await until(() => fixture.models.length === n + 2); await call("voice.stop");
      await until(() => socket.closed); assert(!socket.messages.some(v => v.item?.call_id === "cancel-turn" || v.toolResponse?.functionResponses?.some((f: any) => f.id === "cancel-turn")));
      await until(() => states.at(-1)?.active === false); fixture.slow(0);
    }
    await call("voice.live.save", { ...profile, baseUrl: fixture.url });
    assert((await call("snapshot.get")).voice.live.profile.keyConfigured);
    await call("voice.live.save", { ...profile, baseUrl: fixture.url, clearApiKey: true });
    assert(!(await call("snapshot.get")).voice.live.profile.keyConfigured);
    await call("voice.start", { mode: "conversation", conversationId: id });
    await until(() => fixture.sessions.length === 3 && !!fixture.sessions[2].setup); fixture.ready();
    await until(() => kernel.resolve("voice.session").state().phase === "listening"); fixture.disconnect();
    await until(() => !kernel.resolve("voice.session").state().active && kernel.resolve("voice.session").state().phase === "error");
    assert.equal((await raw("voice.live.save", { ...profile, baseUrl: "https://user:secret@example.com/v1" })).error?.code, "INVALID_INPUT");
  } finally { await kernel.dispose(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});
