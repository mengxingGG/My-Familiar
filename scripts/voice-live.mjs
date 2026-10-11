// 真实语音链路验收：必须获得用户授权后才运行（--saved-api）。
// 使用已保存的识别、合成和主模型密钥，会产生少量费用，并从扬声器播放声音。
// 只使用隔离副本：副本关闭待机唤醒，语音窗口改用无声输入，测试语音由本机 Windows 语音生成后注入，不采集真实麦克风。
// 结果写入 .artifacts/voice-live-时间戳/result.json，不包含密钥。
import { chromium } from "playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import electronPath from "electron";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
if (!process.argv.includes("--saved-api"))
  throw new Error("需要明确授权使用已保存 API：--saved-api");
const root = process.cwd(),
  output = resolve(".artifacts/voice-live-" + Date.now()),
  data = join(output, "user-data"),
  source = join(process.env.APPDATA, "Familiar");
await mkdir(join(data, "data"), { recursive: true });
for (const name of ["settings.json", "model-secret.json", "voice-settings.json"])
  await copyFile(join(source, "data", name), join(data, "data", name));
const voiceFile = join(data, "data", "voice-settings.json");
const saved = JSON.parse(await readFile(voiceFile, "utf8"));
// 正在运行的宠物可能也在监听麦克风；隔离副本不开待机唤醒。
await writeFile(
  voiceFile,
  JSON.stringify({ ...saved, enabled: false, wakeEnabled: false, autoRead: false }),
);
// Windows safeStorage 的密文依赖 Runtime 的 Local State 加密材料。
await mkdir(join(data, "runtime"), { recursive: true });
await copyFile(
  join(source, "runtime/Local State"),
  join(data, "runtime/Local State"),
);
const env = { ...process.env, FAMILIAR_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 本机生成已知原文的测试语音 ----------
function speak(text) {
  return new Promise((done, fail) => {
    const child = spawn(resolve("dist/native/Familiar.Speech.exe"), ["--speak"], {
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.on("error", fail);
    child.on("close", (code) =>
      code
        ? fail(new Error("本机语音合成失败"))
        : done(Buffer.from(JSON.parse(out.trim().split("\n")[0]).data, "base64")),
    );
    child.stdin.end(JSON.stringify({ text, style: "direct", speed: 1 }) + "\n");
  });
}
function resample(samples, rate) {
  const length = Math.floor((samples.length * 24000) / rate),
    out = Buffer.alloc(length * 2);
  for (let i = 0; i < length; i++) {
    const x = (i * rate) / 24000,
      j = Math.floor(x),
      f = x - j,
      v = (samples[j] ?? 0) * (1 - f) + (samples[j + 1] ?? samples[j] ?? 0) * f;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }
  return out;
}
function wavTo24k(wav) {
  let pos = 12,
    rate,
    channels,
    bits,
    pcm;
  while (pos + 8 <= wav.length) {
    const id = wav.toString("ascii", pos, pos + 4),
      size = wav.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      channels = wav.readUInt16LE(pos + 10);
      rate = wav.readUInt32LE(pos + 12);
      bits = wav.readUInt16LE(pos + 22);
    }
    if (id === "data") {
      pcm = wav.subarray(pos + 8, pos + 8 + size);
      break;
    }
    pos += 8 + size + (size % 2);
  }
  if (bits !== 16 || !pcm) throw new Error("测试语音不是 16 位 PCM WAV");
  const frames = Math.floor(pcm.length / 2 / channels),
    mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += pcm.readInt16LE((i * channels + c) * 2);
    mono[i] = sum / channels;
  }
  return resample(mono, rate);
}
// 中文按字比较，忽略标点与空白。
function similarity(expected, actual) {
  const clean = (s) => Array.from(s.replace(/[\s\p{P}]/gu, ""));
  const a = clean(expected),
    b = clean(actual ?? "");
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return a.length ? Math.max(0, 1 - d[a.length][b.length] / a.length) : 0;
}

// ---------- 启动隔离 Runtime（不用 Playwright 的 mock-keychain，才能解密真实密钥） ----------
async function launch(args = []) {
  const listener = createServer();
  await new Promise((r) => listener.listen(0, "127.0.0.1", r));
  const port = listener.address().port;
  await new Promise((r) => listener.close(r));
  const child = spawn(electronPath, [root, ...args, `--remote-debugging-port=${port}`], {
    env,
    windowsHide: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  let browser;
  for (let i = 0; i < 150 && !browser; i++)
    browser = await chromium
      .connectOverCDP(`http://127.0.0.1:${port}`)
      .catch(() => sleep(100).then(() => undefined));
  if (!browser) throw new Error("测试窗口未就绪");
  return { child, browser };
}
const result = { realMicrophone: false, startedAt: new Date().toISOString() };
const runtime = await launch();
let controller;
const find = async (app, suffix) => {
  for (let i = 0; i < 150; i++) {
    const page = app.browser
      .contexts()[0]
      ?.pages()
      .find((p) => p.url().endsWith(suffix));
    if (page) return page;
    await sleep(100);
  }
  throw new Error("窗口未就绪：" + suffix);
};
try {
  // 语音窗口只能上报音频；命令按产品权限从控制器发出。
  const page = await find(runtime, "voice-session/index.html");
  controller = await launch(["--controller"]);
  const panel = await find(controller, "control-center/index.html");
  const call = (name, params) =>
    panel.evaluate(({ name, params }) => window.familiar.request(name, params), {
      name,
      params,
    });
  for (let i = 0; i < 150; i++) {
    if ((await call("runtime.status").catch(() => undefined))?.connected) break;
    await sleep(100);
  }
  await page.evaluate(() => {
    window.__events = [];
    window.__pcm = [];
    window.__starts = [];
    window.familiar.on("familiar:voice-host", (m) => {
      window.__epoch = m.epoch;
      window.__events.push({ type: m.type, t: Date.now() });
      if (m.type === "pcm") window.__pcm.push({ rate: m.rate, data: m.data });
    });
    // 人工麦克风：测试语音按真实节奏播放进这条音频流，不打开真实麦克风。
    // 语音窗口停止录音时会关闭音轨，所以每次打开麦克风都给一条新的流。
    const mic = new AudioContext({ sampleRate: 24000 });
    let destination = mic.createMediaStreamDestination();
    navigator.mediaDevices.getUserMedia = async () => {
      destination = mic.createMediaStreamDestination();
      return destination.stream;
    };
    window.__say = async (base64) => {
      await mic.resume();
      const binary = atob(base64),
        frames = binary.length / 2,
        buffer = mic.createBuffer(1, frames, 24000),
        channel = buffer.getChannelData(0);
      for (let i = 0; i < frames; i++) {
        let v = binary.charCodeAt(2 * i) | (binary.charCodeAt(2 * i + 1) << 8);
        if (v >= 32768) v -= 65536;
        channel[i] = v / 32768;
      }
      const node = mic.createBufferSource();
      node.buffer = buffer;
      node.__mic = true;
      node.connect(destination);
      await new Promise((r) => {
        node.onended = r;
        node.start();
      });
    };
    // 记录宠物声音每段真正开始播放的时刻（不含人工麦克风）。
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when, ...rest) {
      if (!this.__mic)
        window.__starts.push(
          Date.now() + Math.max(0, ((when ?? 0) - this.context.currentTime) * 1000),
        );
      return start.call(this, when, ...rest);
    };
  });
  const status = await call("voice.get");
  result.config = {
    mode: status.settings.mode,
    stt: status.settings.stt.model,
    tts: status.settings.tts.model,
    stream: status.settings.tts.stream !== false,
    reference: status.settings.tts.reference,
    identity: status.settings.identity,
    silenceMs: status.settings.silenceMs,
    keys: status.keys,
  };
  if (!status.keys.stt || !status.keys.tts)
    throw new Error("没有已保存的识别或合成密钥");
  const say = (pcm) =>
    page.evaluate((data) => window.__say(data), pcm.toString("base64"));
  const waitPhase = async (test, timeout = 60000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const s = await call("voice.state");
      if (test(s)) return s;
      if (Date.now() > end) throw new Error("等待语音状态超时：" + s.phase);
      await sleep(50);
    }
  };
  const dictate = async (pcm) => {
    const before = (await call("voice.dictation"))?.id;
    await call("voice.dictate", { target: "composer" });
    await waitPhase((s) => s.dictating);
    await sleep(300);
    await say(pcm);
    await sleep(400);
    const t = Date.now();
    await call("voice.finish");
    for (let i = 0; i < 600; i++) {
      const d = await call("voice.dictation");
      if (d && d.id !== before) return { text: d.text, ms: Date.now() - t };
      const s = await call("voice.state");
      if (s.error && i > 5) throw new Error("识别失败：" + s.error);
      await sleep(100);
    }
    throw new Error("识别超时");
  };

  // 1. 合成：从请求到实际开始播放。
  const reply = "你好呀，今天也会好好陪着你，我们一起慢慢来。";
  await page.evaluate(() => {
    window.__pcm = [];
    window.__starts = [];
  });
  let t = Date.now();
  await call("voice.read", { text: reply });
  await waitPhase((s) => s.phase === "speaking", 30000);
  for (let i = 0; i < 300 && !(await page.evaluate(() => window.__starts.length)); i++)
    await sleep(50);
  const firstStart = await page.evaluate(() => window.__starts[0]);
  await waitPhase((s) => s.phase !== "speaking", 90000);
  const captured = await page.evaluate(() => window.__pcm);
  result.tts = {
    text: reply,
    firstAudioMs: firstStart ? firstStart - t : null,
    pcmChunks: captured.length,
    rate: captured[0]?.rate ?? null,
  };
  console.log("合成：开口用时", result.tts.firstAudioMs, "ms；PCM 片段", captured.length);

  // 2. 识别：本机 Windows 语音朗读已知原文。
  const known = "今天下午三点提醒我去取快递，顺便买两瓶牛奶。";
  const knownPcm = wavTo24k(await speak(known));
  const asr = await dictate(knownPcm);
  result.asr = { expected: known, text: asr.text, accuracy: similarity(known, asr.text), ms: asr.ms };
  console.log("识别：", asr.text, "字准确率", result.asr.accuracy.toFixed(2), "用时", asr.ms, "ms");

  // 3. 回环：宠物声音合成的句子能否被识别回来。
  if (captured.length) {
    const rate = captured[0].rate,
      bytes = Buffer.concat(captured.map((c) => Buffer.from(c.data, "base64"))),
      samples = new Float32Array(bytes.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2);
    const loop = await dictate(resample(samples, rate));
    result.loopback = { expected: reply, text: loop.text, accuracy: similarity(reply, loop.text) };
    console.log("回环：", loop.text, "字准确率", result.loopback.accuracy.toFixed(2));
  } else result.loopback = { skipped: "合成没有返回 PCM 片段（可能关闭了流式播报）" };

  // 4. 完整链路：说完 → 识别 → 主模型 → 开口；随后测插话打断。
  const question = "请用一句话告诉我，多喝水有什么好处？";
  const questionPcm = wavTo24k(await speak(question));
  const before = (await call("history.state")).messages.at(-1)?.id;
  await call("voice.start");
  await waitPhase((s) => s.phase === "listening", 20000);
  await page.evaluate(() => {
    window.__starts = [];
    window.__events = [];
  });
  await say(questionPcm);
  const spoken = Date.now();
  const marks = {};
  // 人工麦克风说完后自然是静音，等端点检测结束这一句。
  for (let i = 0; i < 600 && !marks.endpoint; i++) {
    const s = await call("voice.state");
    if (s.phase !== "recording" && s.phase !== "listening")
      marks.endpoint = Date.now();
    else await sleep(25);
  }
  for (let i = 0; i < 1200; i++) {
    const h = await call("history.state"),
      fresh = h.messages.filter((m) => m.id !== before),
      user = fresh.find((m) => m.role === "user"),
      assistant = fresh.find((m) => m.role === "assistant");
    if (user && !marks.transcript) {
      marks.transcript = Date.now();
      result.chainTranscript = user.text;
    }
    if (assistant?.text && !marks.firstToken) marks.firstToken = Date.now();
    const starts = await page.evaluate(() => window.__starts);
    if (starts.length && !marks.firstAudio) marks.firstAudio = starts[0];
    if (marks.firstAudio) {
      result.chainReply = assistant?.text;
      break;
    }
    if (h.error) throw new Error("对话失败：" + h.error);
    await sleep(50);
  }
  const rel = (v) => (v ? v - spoken : null);
  result.chain = {
    question,
    transcript: result.chainTranscript,
    accuracy: similarity(question, result.chainTranscript),
    endpointMs: rel(marks.endpoint),
    transcriptMs: rel(marks.transcript),
    firstTokenMs: rel(marks.firstToken),
    firstAudioMs: rel(marks.firstAudio),
  };
  console.log("链路：", JSON.stringify(result.chain));

  // 插话：宠物说话时再说一句，测到清空播放的用时。
  const speaking = await waitPhase((s) => s.phase === "speaking", 30000).catch(() => undefined);
  if (speaking) {
    const t0 = Date.now();
    const talking = say(questionPcm);
    let cleared;
    for (let i = 0; i < 200 && !cleared; i++) {
      const events = await page.evaluate(() => window.__events);
      cleared = events.find((e) => e.type === "clear" && e.t >= t0);
      if (!cleared) await sleep(25);
    }
    await call("voice.stop");
    await talking.catch(() => {});
    result.bargeIn = {
      clearedMs: cleared ? cleared.t - t0 : null,
      phase: (await call("voice.state")).phase,
    };
    console.log("插话：清空播放用时", result.bargeIn.clearedMs, "ms");
  } else result.bargeIn = { skipped: "回复在插话前已经播放完" };
  await call("voice.stop");
  result.passed =
    result.asr.accuracy >= 0.8 &&
    (result.loopback.skipped || result.loopback.accuracy >= 0.7) &&
    !!result.chain.firstAudioMs &&
    (result.bargeIn.skipped || result.bargeIn.clearedMs !== null);
} catch (e) {
  result.error = e.message;
  throw e;
} finally {
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log("VOICE LIVE OUTPUT:", output);
  for (const app of [controller, runtime]) {
    if (!app) continue;
    await app.browser.close().catch(() => {});
    if (app.child.exitCode === null) app.child.kill();
  }
}
