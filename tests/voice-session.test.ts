import test from "node:test";
import assert from "node:assert/strict";
import { Kernel } from "../packages/kernel/index.ts";
import {
  definePlugin,
  defaults,
  type PcmChunk,
  type VoiceSettings,
} from "../packages/contracts/index.ts";
import { voiceDefaults, validateVoice } from "../plugins/voice-api/config.ts";
import {
  liveRecommendations,
  voiceReadiness,
} from "../plugins/voice-api/live-guidance.ts";
import { voiceSession } from "../plugins/voice-session/index.ts";
import { pcmWav } from "../plugins/voice-session/audio.ts";
import { wakeCommand, wakePcm } from "../plugins/voice-session/wake-handoff.ts";
import { decodeWakeAudio } from "../plugins/voice-windows/wake-audio.ts";

const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};

test("连续模式兼容旧配置，保留显式空闲策略，识别提示严格校验", () => {
  const old = structuredClone(voiceDefaults);
  delete old.continuous;
  assert.equal(validateVoice(old).continuous, true);
  assert.equal(validateVoice({ ...old, continuous: false }).continuous, false);
  assert.throws(
    () => validateVoice({ ...old, continuous: "yes" } as any),
    /开关/,
  );
  assert.throws(() => validateVoice({ ...old, stt: null } as any), /接口/);
  assert.throws(
    () => validateVoice({ ...old, stt: { ...old.stt, language: "zh\n" } }),
    /语言/,
  );
  assert.throws(
    () =>
      validateVoice({ ...old, stt: { ...old.stt, prompt: "字".repeat(501) } }),
    /提示词/,
  );
});

test("Live 缺模型/密钥/声音时本地预检；未来候选不会伪装成可用配置", () => {
  const settings = structuredClone(voiceDefaults);
  assert.equal(voiceReadiness(settings, false).route, "chained");
  settings.mode = "realtime";
  settings.live.model = "";
  const missing = voiceReadiness(settings, false);
  assert.equal(missing.configured, false);
  assert.match(missing.problems.join(), /模型.*密钥|模型.*API Key/);
  settings.live.model = "gpt-realtime";
  settings.identity = "provider";
  assert.equal(voiceReadiness(settings, true).configured, true);
  assert.equal(voiceReadiness(settings, true).route, "live-relay");
  settings.live.baseUrl = "http://127.0.0.1:1234/v1";
  assert.equal(voiceReadiness(settings, false).configured, true);
  assert.equal(
    liveRecommendations.find((v) => v.id === "qwen")?.profile,
    undefined,
  );
  assert.equal(
    liveRecommendations.find((v) => v.id === "minicpm")?.profile,
    undefined,
  );
});

test("唤醒 WAV 跨采样率交接保留音频，拒绝截断、立体声和过长输入", () => {
  const pcm = new Uint8Array(3200),
    view = new DataView(pcm.buffer);
  for (let i = 0; i < pcm.length; i += 2) view.setInt16(i, 1234, true);
  const wav = pcmWav(pcm, 16000),
    decoded = decodeWakeAudio(wav);
  assert.equal(decoded.rate, 16000);
  assert.deepEqual(decoded.data, pcm);
  const converted = wakePcm(decoded);
  assert.equal(converted.length, 4800);
  assert.equal(new DataView(converted.buffer).getInt16(100, true), 1234);
  assert.throws(() => decodeWakeAudio(wav.subarray(0, wav.length - 1)), /WAV/);
  const stereo = wav.slice();
  new DataView(stereo.buffer).setUint16(22, 2, true);
  assert.throws(() => decodeWakeAudio(stereo), /单声道/);
  assert.throws(
    () => wakePcm({ data: new Uint8Array(48000 * 9), rate: 24000 }),
    /8 秒/,
  );
  assert.throws(
    () => wakePcm({ data: new Uint8Array(3), rate: 24000 }),
    /格式/,
  );
  assert.throws(() => wakePcm({ data: pcm, rate: NaN }), /格式/);
});

test("唤醒清理只去句首名字和纯问候，不丢请求、否定或正文中的名字", () => {
  assert.equal(wakeCommand("小森", ["小森"]), "");
  assert.equal(wakeCommand("你好，小森，在吗？", ["小森"]), "");
  assert.equal(
    wakeCommand("小森，帮我看看今天的任务", ["小森"]),
    "帮我看看今天的任务",
  );
  assert.equal(wakeCommand("小森，不要结束语音", ["小森"]), "不要结束语音");
  assert.equal(wakeCommand("替小森找一下资料", ["小森"]), "替小森找一下资料");
  assert.equal(wakeCommand("a+b，查资料", ["a+b"]), "查资料");
});

async function fixture(initial: Partial<VoiceSettings> = {}) {
  let config = validateVoice({
    ...structuredClone(voiceDefaults),
    enabled: true,
    identity: "provider",
    ...initial,
  });
  let wakeListener: ((name: string, audio?: PcmChunk) => void) | undefined;
  let messages: any[] = [],
    recognized = "小森，帮我看看任务";
  const sent: any[] = [],
    asked: string[] = [],
    recordings: Uint8Array[] = [];
  const routes = new Map<string, (p?: any) => any>();
  const k = new Kernel({
    grants: {
      "familiar.voice-session": ["device.microphone", "network.voice"],
    },
  });
  k.install(
    definePlugin({
      manifest: {
        manifestVersion: 1,
        id: "fixture.voice",
        version: "1",
        requires: [],
        provides: [
          "voice.api",
          "voice.wake",
          "settings",
          "character.catalog",
          "platform.surface",
          "conversation",
          "commands",
        ],
      },
      start(ctx) {
        ctx.provide("voice.api", {
          get: () => structuredClone(config),
          save: async (v: VoiceSettings) => (config = validateVoice(v)),
          readiness: () => voiceReadiness(config, false),
          recommendations: () => structuredClone(liveRecommendations),
          hasKeys: () => ({}),
          key: () => "",
          cleanup: async () => ({ files: 0, bytes: 0 }),
          transcribe: async (wav: Uint8Array, signal: AbortSignal) => {
            signal.throwIfAborted();
            recordings.push(wav);
            return recognized;
          },
          speak: async () => ({
            id: "fixture",
            data: "",
            mimeType: "audio/wav",
            cached: false,
          }),
        } as any);
        ctx.provide("voice.wake", {
          status: () => ({ available: true, message: "fixture" }),
          listen: async (_p, cb) => {
            wakeListener = cb;
          },
          stop: () => {
            wakeListener = undefined;
          },
        });
        ctx.provide("settings", {
          get: () => ({
            ...structuredClone(defaults),
            persona: { ...defaults.persona, name: "小森" },
          }),
        } as any);
        ctx.provide("character.catalog", {
          get: () => ({ recommendedPersona: "gentle" }),
        } as any);
        ctx.provide("platform.surface", {
          create: async () => {},
          close: () => {},
          send: (surface: string, _event: string, value: any) => {
            if (surface !== "voice") return;
            sent.push(value);
            if (value.type === "play" || value.type === "audio-end")
              queueMicrotask(() => {
                void routes.get("voice.host")?.({
                  type: "playing-end",
                  id: value.id,
                  epoch: value.epoch,
                  playback: value.playback,
                });
              });
          },
        } as any);
        ctx.provide("conversation", {
          state: () => ({ messages, busy: false }),
          cancel: async () => {},
          clear: async () => {},
          send: async (input) => {
            asked.push(typeof input === "string" ? input : input.text);
            messages = [
              {
                id: "assistant",
                role: "assistant",
                text: "收到。",
                origin: "voice",
                status: "complete",
              },
            ];
          },
        });
        ctx.provide("commands", {
          register: (name: string, fn: any) => {
            routes.set(name, fn);
            return () => {
              routes.delete(name);
            };
          },
        } as any);
      },
    }),
  );
  k.install(voiceSession("fixture-samples"));
  await k.startAll();
  await flush();
  return {
    k,
    asked,
    recordings,
    sent,
    config,
    wake: () => wakeListener,
    state: () => k.resolve("voice.session").state(),
    call: (name: string, data?: any) => routes.get(name)!(data),
    listening: async () => {
      const latest = sent.filter((v) => v.type === "listen").at(-1);
      await routes.get("voice.host")!({
        type: "listening",
        epoch: latest.epoch,
      });
    },
    recognize: (text: string) => {
      recognized = text;
    },
  };
}

test("一次唤醒后持续监听，名字不触发模型问答，停止后的旧监听不能复活", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = await fixture({ idleSeconds: 5 });
  try {
    const old = f.wake()!;
    old("小森");
    await flush();
    await f.listening();
    assert.equal(f.state().phase, "listening");
    assert.equal(f.state().idleUntil, undefined);
    t.mock.timers.tick(6000);
    await flush();
    assert.equal(f.state().active, true);
    assert.deepEqual(f.asked, []);
    await f.call("voice.stop");
    old("小森");
    await flush();
    assert.equal(f.state().active, false);
  } finally {
    await f.k.dispose();
  }
});

test("关闭持续模式后按空闲超时退出，重新开始没有旧计时器", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = await fixture({ continuous: false, idleSeconds: 5 });
  try {
    await f.call("voice.start");
    await f.listening();
    assert.equal(typeof f.state().idleUntil, "number");
    t.mock.timers.tick(3000);
    await f.call("voice.start");
    await f.listening();
    t.mock.timers.tick(3000);
    await flush();
    assert.equal(f.state().active, true);
    t.mock.timers.tick(2100);
    await flush();
    assert.equal(f.state().active, false);
  } finally {
    await f.k.dispose();
  }
});

test("唤醒片段只转写一次，名字后请求进入主模型，纯唤醒问候继续监听", async () => {
  const f = await fixture();
  try {
    f.wake()!("小森", { data: new Uint8Array(3200), rate: 16000 });
    await flush();
    assert.deepEqual(f.asked, ["帮我看看任务"]);
    assert.equal(f.recordings.length, 1);
    assert.equal(decodeWakeAudio(f.recordings[0]).rate, 24000);
    await f.call("voice.stop");
    await flush();
    f.recognize("小森，在吗？");
    f.wake()!("小森", { data: new Uint8Array(3200), rate: 16000 });
    await flush();
    assert.equal(f.asked.length, 1);
    assert.equal(f.state().phase, "listening");
  } finally {
    await f.k.dispose();
  }
});

test("未配置 Live 在开麦前失败且不自动落回常规模式", async () => {
  const f = await fixture({ mode: "realtime" });
  try {
    assert.equal(f.wake(), undefined);
    await assert.rejects(f.call("voice.start"), /API Key/);
    assert.equal(
      f.sent.some((v) => v.type === "listen"),
      false,
    );
    assert.equal(f.state().active, false);
    assert.equal(f.state().mode, "realtime");
  } finally {
    await f.k.dispose();
  }
});
