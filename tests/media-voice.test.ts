import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { Kernel } from "../packages/kernel/index.ts";
import { definePlugin, defaults } from "../packages/contracts/index.ts";
import { storageLocal } from "../plugins/storage-local/index.ts";
import { mediaAssets } from "../plugins/media-assets/index.ts";
import {
  completionMessages,
  claudeImages,
  geminiImages,
  responseImages,
} from "../plugins/llm-shared/images.ts";
import { asksAboutScreen } from "../plugins/media-input/index.ts";
import {
  voiceDefaults,
  validateVoice,
  voiceScope,
} from "../plugins/voice-api/config.ts";
import { voiceApi, parseVoices } from "../plugins/voice-api/index.ts";
import { AudioCache, audioKey } from "../plugins/voice-api/cache.ts";
import { UtteranceDetector, pcmWav } from "../plugins/voice-session/audio.ts";
import {
  SpeechTextBuffer,
  SpeechQueue,
} from "../plugins/voice-session/text-stream.ts";
import { liveConnection } from "../plugins/voice-session/live.ts";
import { pcmRate, readPcm } from "../plugins/voice-api/pcm.ts";
import { StreamedSpeech } from "../plugins/voice-session/streamed-speech.ts";
import { voiceWindows } from "../plugins/voice-windows/index.ts";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);

test("PCM 在响应完成前交付、奇数字节对齐、保留采样率且取消关闭读取", async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let canceled = false;
  const chunks: number[] = [],
    abort = new AbortController();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        source = c;
      },
      cancel() {
        canceled = true;
      },
    }),
    { headers: { "Content-Type": "audio/pcm; rate=44100; channels=1" } },
  );
  const pending = readPcm(response, abort.signal, (c) => {
    assert.equal(c.rate, 44100);
    chunks.push(...c.data);
  });
  source.enqueue(new Uint8Array([1, 2, 3]));
  await delay(5);
  assert.deepEqual(chunks, [1, 2]);
  source.enqueue(new Uint8Array([4, 5, 6]));
  await delay(5);
  assert.deepEqual(chunks, [1, 2, 3, 4, 5, 6]);
  source.close();
  const wav = Buffer.from(await pending);
  assert.equal(wav.readUInt32LE(24), 44100);
  assert.deepEqual([...wav.subarray(44)], chunks);
  assert.throws(() => pcmRate("audio/pcm"), /采样率/);
  assert.throws(() => pcmRate("audio/pcm;rate=24000;channels=2"), /单声道/);
  for (const preAborted of [false, true]) {
    let closed = false;
    const controller = new AbortController();
    if (preAborted) controller.abort();
    const invalid = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          closed = true;
        },
      }),
      {
        headers: {
          "Content-Type": preAborted ? "audio/pcm;rate=24000" : "audio/pcm",
        },
      },
    );
    await assert.rejects(
      readPcm(invalid, controller.signal, () =>
        assert.fail("无效响应不能播放"),
      ),
      preAborted ? { name: "AbortError" } : /采样率/,
    );
    assert.equal(closed, true, "校验失败和提前取消也必须关闭响应流");
  }
  const second = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    }),
    { headers: { "Content-Type": "audio/pcm;rate=24000" } },
  );
  const stopped = readPcm(second, abort.signal, () =>
    assert.fail("取消后不能播放"),
  );
  abort.abort();
  await assert.rejects(stopped, { name: "AbortError" });
  assert.equal(canceled, true);
  await assert.rejects(
    readPcm(
      new Response(new Uint8Array([1]), {
        headers: { "Content-Type": "audio/pcm;rate=24000" },
      }),
      new AbortController().signal,
      () => {},
    ),
    /半个 PCM/,
  );
});

test("合成流首块立即可播，完整音频不重复播放，取消拦截迟到片段", async () => {
  const abort = new AbortController();
  let push!: (c: { data: Uint8Array; rate: number }) => void,
    complete!: () => void;
  const clip = {
    id: "fixture",
    mimeType: "audio/wav",
    data: "",
    cached: false,
  };
  const stream = new StreamedSpeech(async (emit) => {
    push = emit;
    await new Promise<void>((r) => {
      complete = r;
    });
    return clip;
  }, abort.signal);
  const reader = stream[Symbol.asyncIterator]();
  const first = reader.next();
  await delay(1);
  push({ data: new Uint8Array([0, 1]), rate: 24000 });
  assert.ok("pcm" in (await first).value!);
  complete();
  assert.equal((await reader.next()).done, true);
  const cached = new StreamedSpeech(
    async () => ({ ...clip, cached: true }),
    abort.signal,
  );
  const cachedReader = cached[Symbol.asyncIterator]();
  assert.ok("clip" in (await cachedReader.next()).value!);
  assert.equal((await cachedReader.next()).done, true);
  const late = new StreamedSpeech(async (emit) => {
    await delay(20);
    emit({ data: new Uint8Array([0, 1]), rate: 24000 });
    return clip;
  }, abort.signal);
  const waiting = late[Symbol.asyncIterator]().next();
  abort.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});

test("唤醒组件重启时旧进程不污染新诊断，取消启动后可以重新监听", async () => {
  const root = await mkdtemp(join(tmpdir(), "familiar-wake-"));
  const fixture = join(root, "wake.cjs");
  await writeFile(
    fixture,
    `
const send=(v)=>process.stdout.write(JSON.stringify(v)+'\\n');
if(process.argv.includes('--probe')) {send({voices:[],recognizers:[{culture:'zh-CN'}]});process.exit(0);}
process.stdin.once('data',()=>{setTimeout(()=>{send({ready:true});send({level:17});send({recognized:true,accepted:true,confidence:0.91});send({wake:'小森'});},100);});
setInterval(()=>{},1000);
`,
  );
  const k = new Kernel({
    grants: { "familiar.voice-windows": ["device.microphone"] },
  });
  k.install(voiceWindows(process.execPath, [fixture]));
  await k.startAll();
  try {
    const wake = k.resolve("voice.wake"),
      heard: string[] = [];
    const old = wake.listen(["旧名字"], () => assert.fail("旧监听不应唤醒"));
    const rejected = assert.rejects(old);
    wake.stop();
    await wake.listen(["小森"], (text) => heard.push(text));
    await rejected;
    await delay(20);
    assert.deepEqual(heard, ["小森"]);
    assert.equal(wake.status().level, 17);
    assert.equal(wake.status().listening, true);
    assert.equal(wake.status().lastResult, "已识别唤醒词");
    wake.stop();
    assert.equal(wake.status().listening, false);
  } finally {
    await k.dispose();
  }
});
test("附件仅保存引用，重启后重新解析图片和文档，四类协议保留工具图片顺序", async () => {
  const root = await mkdtemp(join(tmpdir(), "familiar-media-"));
  const make = async () => {
    const k = new Kernel({
      grants: { "familiar.storage-local": ["storage.app"] },
    });
    k.install(storageLocal(root));
    k.install(mediaAssets);
    await k.startAll();
    return k;
  };
  let k = await make();
  const a = await k.resolve("media.assets").add("图.png", "image/png", png),
    b = await k
      .resolve("media.assets")
      .add("材料.md", "text/plain", Buffer.from("用户上传的资料"));
  await assert.rejects(
    k
      .resolve("media.assets")
      .add("bad.png", "image/png", Buffer.from("not-image")),
    /无法识别/,
  );
  await k.dispose();
  k = await make();
  try {
    const resolved = await k
      .resolve("media.assets")
      .resolve([{ role: "user", content: "看图", attachments: [a, b] }]);
    assert.equal(resolved[0].images?.[0].data, png.toString("base64"));
    assert.match(resolved[0].content, /用户上传的资料/);
    const m = { ...resolved[0], role: "tool" as const, toolCallId: "one" };
    const out = completionMessages([
      m,
      { role: "tool", toolCallId: "two", content: "第二结果" },
    ]);
    assert.deepEqual(
      out.map((v) => v.role),
      ["tool", "tool", "user"],
    );
    assert.equal(
      out[2].content[1].image_url.url,
      `data:image/png;base64,${png.toString("base64")}`,
    );
    assert.equal(claudeImages(m)[0].source.data, png.toString("base64"));
    assert.equal(geminiImages(m)[0].inlineData.mimeType, "image/png");
    assert.equal(responseImages(m)[0].type, "input_image");
    assert.equal(asksAboutScreen("我在打游戏，帮我看看这个关卡怎么过"), true);
    assert.equal(asksAboutScreen("今天想去散步"), false);
  } finally {
    await k.dispose();
  }
});
test("语音配置与密钥地址独立，灵敏度边界和音色目录兼容真实字段", () => {
  assert.equal(
    validateVoice({
      ...voiceDefaults,
      wakePhrases: ["小森", "火火", "小森"],
    }).wakePhrases.join(),
    "小森,火火",
  );
  assert.throws(() =>
    validateVoice({ ...voiceDefaults, wakeSensitivity: 101 }),
  );
  assert.notEqual(
    voiceScope("stt", voiceDefaults),
    voiceScope("tts", voiceDefaults),
  );
  assert.notEqual(
    voiceScope("tts", voiceDefaults),
    voiceScope("tts", {
      ...voiceDefaults,
      tts: { ...voiceDefaults.tts, baseUrl: "http://localhost:1/v1" },
    }),
  );
  assert.deepEqual(
    parseVoices([
      "longanhuan_v3.6",
      { voice_id: "voice2", name: "第二音色" },
    ]).map((v) => v.id),
    ["longanhuan_v3.6", "voice2"],
  );
});
test("语音短句流在完整回复前产生，代码不朗读，取消清空未开始的音频", async () => {
  const b = new SpeechTextBuffer();
  assert.deepEqual(b.take("你好"), []);
  assert.deepEqual(b.take("你好呀。下面"), ["你好呀。"]);
  assert.deepEqual(
    b.take("你好呀。下面是代码：\n```ts\nsecret()\n```\n然后继续。", true),
    ["下面是代码：", "代码请看文字。", "然后继续。"],
  );
  const abort = new AbortController(),
    synthesized: string[] = [],
    played: string[] = [];
  let release!: () => void;
  const q = new SpeechQueue(
    async (s: string) => {
      synthesized.push(s);
      return s;
    },
    async (s) => {
      played.push(s);
      await new Promise<void>((r) => {
        release = r;
      });
    },
    abort.signal,
  );
  q.add(["第一句。", "第二句。", "第三句。"]);
  await delay(5);
  assert.deepEqual(played, ["第一句。"]);
  assert.deepEqual(synthesized, ["第一句。", "第二句。"]);
  abort.abort();
  release();
  await assert.rejects(q.done());
  assert.deepEqual(played, ["第一句。"]);
  assert.equal(synthesized.includes("第三句。"), false);
});
test("语音活动检测忽略单帧噪声，200ms 插话保留开头并在静音后提交", () => {
  const d = new UtteranceDetector(300),
    loud = Buffer.alloc(4800),
    quiet = Buffer.alloc(4800);
  for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(6000, i);
  assert.equal(d.push(loud).started, undefined);
  assert.equal(d.push(quiet).started, undefined);
  d.push(loud);
  assert.equal(d.push(loud).started, true);
  d.push(quiet);
  d.push(quiet);
  const end = d.push(quiet);
  assert.ok(end.pcm && end.pcm.length >= loud.length * 5);
  assert.equal(Buffer.from(pcmWav(end.pcm!)).toString("ascii", 0, 4), "RIFF");
});
test("音频缓存重用、到期失效，清理不删除随包或无关文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "familiar-cache-"));
  let now = Date.now();
  const c = new AudioCache(root, () => now),
    id = audioKey("same");
  await writeFile(join(root, "reference.wav"), png);
  await c.write(id, png, "audio/wav", 7);
  assert.equal((await c.read(id, 7))?.cached, true);
  now += 8 * 86400000;
  assert.equal(await c.read(id, 7), undefined);
  await c.cleanup(7, 16);
  assert.deepEqual(await readdir(root), ["reference.wav"]);
  await c.write(id, png, "audio/wav", 0);
  assert.equal(await c.read(id, 0), undefined);
});
test("兼容语音接口发送 multipart 录音、发现音色、隔离密钥并缓存合成", async () => {
  const root = await mkdtemp(join(tmpdir(), "familiar-voice-")),
    requests: {
      url: string;
      auth?: string;
      contentType?: string;
      body: string;
    }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const b of req) body += b;
    requests.push({
      url: req.url!,
      auth: req.headers.authorization,
      contentType: req.headers["content-type"],
      body,
    });
    if (req.url?.endsWith("/endpoints")) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: {
            endpoints: [
              { supports_voice_cloning: req.url.includes("/clone/") },
            ],
          },
        }),
      );
    } else if (req.url?.startsWith("/v1/models")) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: [{ id: "qwen/voice", supported_voices: ["cute"] }],
        }),
      );
    } else if (req.url === "/v1/audio/transcriptions") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ text: "火火，在吗" }));
    } else if (
      req.url === "/v1/audio/speech" &&
      JSON.parse(body).response_format === "pcm"
    ) {
      res.setHeader("Content-Type", "audio/pcm;rate=44100;channels=1");
      res.write(Buffer.alloc(4800));
      const timer = setTimeout(() => res.end(Buffer.alloc(4800)), 100);
      res.on("close", () => clearTimeout(timer));
    } else {
      res.setHeader("Content-Type", "audio/wav");
      res.end(pcmWav(Buffer.alloc(4800)));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  const k = new Kernel({
      grants: {
        "familiar.storage-local": ["storage.app"],
        "familiar.voice-api": ["network.voice"],
      },
    }),
    keys = new Map<string, string>();
  k.install(storageLocal(join(root, "data")));
  k.install(
    definePlugin({
      manifest: {
        manifestVersion: 1,
        id: "test.voice",
        version: "1",
        provides: [
          "settings",
          "secrets.local",
          "character.catalog",
          "voice.local",
        ],
        requires: [],
      },
      start(ctx) {
        ctx.provide("settings", {
          get: () => structuredClone(defaults),
          apply: async (v) => v,
          patchPet: async () => structuredClone(defaults),
        });
        ctx.provide("secrets.local", {
          get: (s) => keys.get(s) ?? "",
          has: (s) => keys.has(s),
          set: async (s, v) => {
            keys.set(s, v);
          },
        });
        ctx.provide("character.catalog", {
          list: () => [],
          get: () => ({
            id: "mori",
            name: "小森",
            description: "",
            actions: [],
            representations: {},
            recommendedPersona: "gentle",
          }),
        });
        ctx.provide("voice.local", {
          voices: () => [],
          synthesize: async () => pcmWav(Buffer.alloc(4800)),
        });
      },
    }),
  );
  k.install(voiceApi(join(root, "cache"), join(root, "samples")));
  await k.startAll();
  try {
    const a = k.resolve("voice.api");
    await a.save({
      ...voiceDefaults,
      identity: "provider",
      stt: {
        kind: "openrouter",
        baseUrl: url,
        model: "qwen/asr",
        language: "zh",
        prompt: "小森、Familiar",
      },
      tts: {
        ...voiceDefaults.tts,
        kind: "openrouter",
        baseUrl: url,
        model: "qwen/voice",
        voice: "cute",
        reference: false,
      },
    });
    await a.setKey("stt", "stt-fixture");
    await a.setKey("tts", "tts-fixture");
    assert.equal((await a.catalog("tts")).voices[0].id, "cute");
    assert.equal(
      await a.transcribe(
        pcmWav(Buffer.alloc(4800)),
        new AbortController().signal,
      ),
      "火火，在吗",
    );
    const first = await a.speak("你好。", new AbortController().signal),
      second = await a.speak("你好。", new AbortController().signal);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(
      requests.filter((r) => r.url === "/v1/audio/speech").length,
      1,
    );
    const asr = requests.find((r) => r.url.endsWith("transcriptions"))!;
    assert.match(asr.contentType!, /multipart\/form-data/);
    assert.match(asr.body, /speech.wav/);
    assert.match(asr.body, /name="language"\r\n\r\nzh/);
    assert.match(asr.body, /name="prompt"\r\n\r\n小森、Familiar/);
    assert.equal(asr.auth, "Bearer stt-fixture");
    assert.equal(requests.at(-1)!.auth, "Bearer tts-fixture");
    assert.doesNotMatch(
      await readFile(join(root, "data", "voice-settings.json"), "utf8"),
      /fixture/,
    );
    let firstChunk!: () => void,
      streamedFinished = false;
    const arrived = new Promise<void>((resolve) => {
      firstChunk = resolve;
    });
    const streaming = a
      .speak(
        "流式合成测试。",
        new AbortController().signal,
        undefined,
        (chunk) => {
          assert.equal(chunk.rate, 44100);
          assert.equal(streamedFinished, false);
          firstChunk();
        },
      )
      .then((clip) => {
        streamedFinished = true;
        return clip;
      });
    await arrived;
    assert.equal(streamedFinished, false, "第一块先于整句下载完成");
    const streamed = await streaming;
    assert.equal(streamed.mimeType, "audio/wav");
    assert.equal(Buffer.from(streamed.data, "base64").readUInt32LE(24), 44100);
    const cachedStream = await a.speak(
      "流式合成测试。",
      new AbortController().signal,
      undefined,
      () => assert.fail("缓存不重复下载"),
    );
    assert.equal(cachedStream.cached, true);
    await a.save({
      ...a.get(),
      tts: { ...a.get().tts, model: "openai/gpt-4o-mini-tts", voice: "sage" },
    });
    await a.speak("声音由用户选择。", new AbortController().signal);
    assert.equal(JSON.parse(requests.at(-1)!.body).voice, "sage");
    await mkdir(join(root, "samples"));
    const reference = pcmWav(Buffer.alloc(4800));
    await writeFile(join(root, "samples", "gentle.wav"), reference);
    await a.save({
      ...a.get(),
      identity: "gentle",
      tts: { ...a.get().tts, model: "clone", reference: true },
    });
    await a.speak("换模型，保留宠物声音。", new AbortController().signal);
    const before = JSON.parse(requests.at(-1)!.body);
    await a.save({
      ...a.get(),
      tts: { ...a.get().tts, model: "another/clone" },
    });
    await a.speak("换模型，保留宠物声音。", new AbortController().signal);
    const after = JSON.parse(requests.at(-1)!.body);
    assert.notEqual(before.model, after.model);
    assert.deepEqual(before.input_references, after.input_references);
    assert.equal(
      before.input_references[0].input_audio.data,
      "data:audio/wav;base64," + Buffer.from(reference).toString("base64"),
    );
    assert.equal(after.voice, undefined);
    await assert.rejects(
      a.save({ ...a.get(), tts: { ...a.get().tts, model: "no-clone" } }),
      /保留原语音设置/,
    );
    assert.equal(a.get().tts.model, "another/clone");
    assert.equal(a.get().identity, "gentle");
  } finally {
    await k.dispose();
    server.closeAllConnections();
    server.close();
  }
});
for (const kind of ["openai", "gemini"] as const)
  test(`${kind} 实时协议传 PCM、主模型工具桥接、插话取消和停止连接`, async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((r) => server.on("listening", r));
    const got: any[] = [],
      abort = new AbortController();
    let client: any,
      askSignal: AbortSignal | undefined,
      speech = 0,
      ready = false;
    server.on("connection", (s) => {
      client = s;
      s.on("message", (b) => {
        const v = JSON.parse(b.toString());
        got.push(v);
        if (v.setup || v.type === "session.update")
          s.send(
            JSON.stringify(
              kind === "gemini"
                ? { setupComplete: {} }
                : { type: "session.updated" },
            ),
          );
      });
    });
    const live = liveConnection(
      {
        kind,
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        model: "fixture-live",
        voice: "coral",
      },
      "test",
      "小森",
      "自然",
      {
        ready: () => (ready = true),
        speech: () => speech++,
        audio: () => {},
        done: () => {},
        error: (e) => assert.fail(e),
        ask: async (_text, signal) => {
          askSignal = signal;
          await delay(100);
          return "结果";
        },
      },
      abort.signal,
    );
    try {
      for (let i = 0; i < 100 && !ready; i++) await delay(5);
      assert.equal(ready, true);
      live.sendAudio("AAAA");
      client.send(
        JSON.stringify(
          kind === "gemini"
            ? {
                toolCall: {
                  functionCalls: [
                    {
                      id: "a",
                      name: "ask_familiar",
                      args: { text: "看看屏幕" },
                    },
                  ],
                },
              }
            : {
                type: "response.function_call_arguments.done",
                call_id: "a",
                name: "ask_familiar",
                arguments: '{"text":"看看屏幕"}',
              },
        ),
      );
      for (let i = 0; i < 50 && !askSignal; i++) await delay(5);
      assert.ok(askSignal);
      client.send(
        JSON.stringify(
          kind === "gemini"
            ? { serverContent: { interrupted: true } }
            : { type: "input_audio_buffer.speech_started" },
        ),
      );
      await delay(20);
      assert.equal(askSignal!.aborted, true);
      assert.equal(speech, 1);
      assert.ok(
        got.some(
          (v) => v.realtimeInput?.audio?.data === "AAAA" || v.audio === "AAAA",
        ),
      );
      await delay(120);
      assert.equal(
        got.some(
          (v) => v.toolResponse || v.item?.type === "function_call_output",
        ),
        false,
      );
    } finally {
      live.stop();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
