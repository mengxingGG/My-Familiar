import type { Kernel } from "../../../packages/kernel/index.ts";
import type { MobileVoice, MobileCommands } from "../../../packages/mobile-contracts/index.ts";
import type { AndroidNative } from "../../../plugins/platform-android/index.ts";

/** 移动端只做输入校验和会话绑定，声音处理仍由共享 voice.session 完成。 */
export function mobileVoice(kernel: Kernel, native: AndroidNative) {
  const api = kernel.resolve("voice.api"), session = kernel.resolve("voice.session"), commands = kernel.resolve("commands"), history = kernel.resolve("conversation.history");
  const wake = kernel.resolve("android.wake");
  let target: string | null = null, previousDictation: string | undefined, mode: "dictation" | "conversation" | undefined;
  const check: (v: unknown) => asserts v = v => { if (!v) throw Error("INVALID_INPUT"); };
  const busy = () => { const s = session.state(); return wake.status().armed || s.active || !["off", "sleeping", "error"].includes(s.phase); };
  const guard = () => { if (mode === "conversation" && busy()) throw Error("BUSY"); };
  const configured = (slot: "stt" | "tts") => {
    const p = api.get()[slot];
    if (slot === "tts" && p.kind === "system") return;
    if (!p.model.trim() || (p.kind === "openrouter" && !api.hasKeys()[slot]) || p.kind === "system") throw Error("PROVIDER");
  };
  const conversationConfigured = () => {
    if (!kernel.resolve("settings").get().provider.model) throw Error("PROVIDER");
    if (api.get().mode === "realtime") { if (!api.readiness().configured) throw Error("PROVIDER"); }
    else { configured("stt"); configured("tts"); }
  };
  async function snapshot(): Promise<MobileVoice> {
    const c = api.get(), keys = api.hasKeys(), s = session.state();
    const result = await commands.call("voice.dictation") as { id: string; text: string } | undefined;
    const profile = (slot: "stt" | "tts") => ({ kind: c[slot].kind === "openrouter" ? "openrouter" as const : "compatible" as const, baseUrl: c[slot].baseUrl, model: c[slot].model, keyConfigured: Boolean(keys[slot]) });
    return {
      localTts: true,
      systemInput: (await native.call("speech.available")) === true,
      live: { mode: c.mode, profile: { ...c.live, keyConfigured: Boolean(keys.live) }, configured: api.readiness().configured, problems: api.readiness().problems, summary: api.readiness().summary },
      wake: { enabled: c.wakeEnabled, phrases: [...c.wakePhrases], sensitivity: c.wakeSensitivity, armed: wake.status().armed, listening: !!wake.status().listening, message: wake.status().message },
      settings: { stt: profile("stt"), tts: { ...profile("tts"), kind: c.tts.kind, keyConfigured: c.tts.kind !== "system" && Boolean(keys.tts), voice: c.tts.voice, speed: c.tts.speed, stream: c.tts.stream !== false }, autoRead: c.autoRead, continuous: c.continuous !== false },
      state: { phase: s.phase, active: s.active, dictating: s.dictating, ...(mode ? { sessionMode: mode } : {}), message: s.phase === "error" ? "语音未能继续，请检查语音连接或麦克风权限。" : s.message, ...(s.phase === "error" ? { error: "请检查语音连接或麦克风权限后重试。" } : {}) },
      ...(mode === "dictation" && result && result.id !== previousDictation ? { dictation: { id: result.id, text: result.text, conversationId: target } } : {}), maxRecordingSeconds: 90,
    };
  }
  async function run(method: string, p: any) {
    if (method === "voice.stop") { try { await wake.disarm(); } finally { await session.stop(false); } return; }
    if (method === "voice.finish") { check(mode === "dictation"); await commands.call("voice.finish"); return; }
    if (busy()) throw Error("BUSY");
    if (method === "voice.wake.save") {
      check(p && typeof p.enabled === "boolean" && Array.isArray(p.phrases) && p.phrases.length <= 8 && Number.isInteger(p.sensitivity) && p.sensitivity >= 0 && p.sensitivity <= 100);
      const phrases = p.phrases.length ? p.phrases : [kernel.resolve("settings").get().persona.name];
      if (p.enabled || p.phrases.length) await wake.validate(phrases);
      await api.save({ ...api.get(), wakeEnabled: p.enabled, wakePhrases: p.phrases.map((v: string) => v.trim()), wakeSensitivity: p.sensitivity });
      await session.stop(false); return;
    }
    if (method === "voice.wake.start") {
      check(p && (p.conversationId === null || typeof p.conversationId === "string"));
      if (!Number.isFinite(p.foregroundAt) || Date.now() - p.foregroundAt < 0 || Date.now() - p.foregroundAt > 5000) throw Error("UNAVAILABLE");
      check(api.get().wakeEnabled);
      if (kernel.resolve("conversation").state().busy) throw Error("BUSY");
      conversationConfigured();
      const phrases = api.get().wakePhrases.length ? api.get().wakePhrases : [kernel.resolve("settings").get().persona.name];
      await wake.validate(phrases);
      if (p.conversationId !== null) { check((await history.list()).some(c => c.id === p.conversationId)); await history.select(p.conversationId); }
      else p = { ...p, conversationId: await history.create() };
      target = p.conversationId; mode = "conversation";
      if (!api.get().enabled) await api.save({ ...api.get(), enabled: true });
      await wake.arm(p.foregroundAt);
      await session.stop(); return;
    }
    if (method === "voice.local.catalog") {
      const catalog = await kernel.resolve("voice.local").catalog?.();
      if (!catalog) throw Error("UNAVAILABLE");
      return { voices: catalog.voices.map(({ id, name }) => ({ id, name })), note: catalog.note };
    }
    if (method === "voice.live.save") {
      check(p && ["chained", "realtime"].includes(p.mode) && ["openai", "gemini"].includes(p.kind));
      check(typeof p.baseUrl === "string" && p.baseUrl.length <= 2000 && typeof p.model === "string" && p.model.length <= 200 && typeof p.voice === "string" && p.voice.length <= 200);
      check(p.apiKey === undefined || typeof p.apiKey === "string" && p.apiKey.length <= 16384);
      check(p.clearApiKey === undefined || typeof p.clearApiKey === "boolean"); check(!(p.apiKey && p.clearApiKey));
      let url: URL; try { url = new URL(p.baseUrl); } catch { throw Error("INVALID_INPUT"); }
      check(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash);
      const old = api.get();
      await api.save({ ...old, enabled: true, mode: p.mode, identity: "provider", live: { kind: p.kind, baseUrl: p.baseUrl, model: p.model.trim(), voice: p.voice.trim() } });
      const previous = api.key("live");
      try { if (p.apiKey !== undefined || p.clearApiKey) await api.setKey("live", p.clearApiKey ? "" : p.apiKey); }
      catch (e) { await api.setKey("live", previous); await api.save(old); throw e; }
      await session.stop(false); return;
    }
    if (method === "voice.save") {
      check(p && typeof p.autoRead === "boolean" && typeof p.continuous === "boolean");
      for (const slot of ["stt", "tts"] as const) {
        const value = p[slot];
        check(value && (slot === "tts" ? ["compatible", "openrouter", "system"] : ["compatible", "openrouter"]).includes(value.kind) && typeof value.model === "string" && value.model.length <= 200 && typeof value.baseUrl === "string" && value.baseUrl.length <= 2000);
        if (value.kind === "system") check(value.apiKey === undefined && !value.clearApiKey);
        let url: URL; try { url = new URL(value.baseUrl); } catch { throw Error("INVALID_INPUT"); }
        check(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash);
        check(value.apiKey === undefined || typeof value.apiKey === "string" && value.apiKey.length <= 16384);
        check(value.clearApiKey === undefined || typeof value.clearApiKey === "boolean"); check(!(value.apiKey && value.clearApiKey));
      }
      check(typeof p.tts.voice === "string" && p.tts.voice.length <= 200 && Number.isFinite(p.tts.speed) && p.tts.speed >= 0.5 && p.tts.speed <= 2);
      check(p.tts.stream === undefined || typeof p.tts.stream === "boolean");
      const old = api.get();
      const clean = (slot: "stt" | "tts") => ({ kind: p[slot].kind, baseUrl: p[slot].baseUrl, model: p[slot].model.trim() });
      await api.save({ ...old, enabled: true, identity: "provider", autoRead: p.autoRead, continuous: p.continuous, stt: { ...old.stt, ...clean("stt") }, tts: { ...old.tts, ...clean("tts"), reference: false, voice: p.tts.voice, speed: p.tts.speed, stream: p.tts.stream ?? old.tts.stream } });
      const previous = { stt: api.key("stt"), tts: api.key("tts") };
      try { for (const slot of ["stt", "tts"] as const) if (p[slot].apiKey !== undefined || p[slot].clearApiKey) await api.setKey(slot, p[slot].clearApiKey ? "" : p[slot].apiKey); }
      catch (e) { for (const slot of ["stt", "tts"] as const) await api.setKey(slot, previous[slot]); await api.save(old); throw e; }
      return;
    }
    if (method === "voice.start") {
      check(p && ["dictation", "conversation"].includes(p.mode) && (p.conversationId === null || typeof p.conversationId === "string"));
      if (kernel.resolve("conversation").state().busy) throw Error("BUSY");
      const caps = await native.call<{ id: string; state: string }[]>("capabilities.status");
      if (!caps.some(c => c.id === "microphone" && c.state === "granted")) throw Error("UNAVAILABLE");
      if (p.mode === "dictation") configured("stt");
      if (p.conversationId !== null) check((await history.list()).some(c => c.id === p.conversationId));
      if (p.mode === "conversation") {
        conversationConfigured();
        if (p.conversationId === null) p = { ...p, conversationId: await history.create() }; else await history.select(p.conversationId);
      }
      target = p.conversationId; mode = p.mode;
      previousDictation = (await commands.call("voice.dictation") as { id: string } | undefined)?.id;
      await commands.call(p.mode === "dictation" ? "voice.dictate" : "voice.start", { target: "composer" }); return;
    }
    if (method === "voice.read") {
      configured("tts"); check(p && typeof p.conversationId === "string" && typeof p.messageId === "string");
      let page = await history.read(p.conversationId);
      while (true) {
        const message = page.messages.find(m => m.id === p.messageId);
        if (message) { check(message.role === "assistant" && message.status === "complete" && message.text.trim()); await commands.call("voice.read", { text: message.text }); return; }
        if (page.next === null) throw Error("NOT_FOUND"); page = await history.read(p.conversationId, page.next);
      }
    }
    throw Error("UNAVAILABLE");
  }
  return { snapshot, run, guard };
}
