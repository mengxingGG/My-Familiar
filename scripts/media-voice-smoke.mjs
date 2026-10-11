import { _electron as electron } from "playwright/test";
import electronPath from "electron";
import { createServer } from "node:http";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const root = process.cwd(),
  output = resolve(".artifacts/media-voice-" + Date.now()),
  data = join(output, "user-data");
await mkdir(output, { recursive: true });
const env = { ...process.env, FAMILIAR_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
const requests = [],
  errors = [];
const wav = Buffer.alloc(44 + 24000);
wav.write("RIFF");
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24);
wav.writeUInt32LE(48000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(24000, 40);
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const b of req) raw += b;
  const body =
    /json/.test(req.headers["content-type"] ?? "") && raw
      ? JSON.parse(raw)
      : raw;
  const request = { url: req.url, body, time: Date.now(), finished: false };
  requests.push(request);
  if (req.url?.startsWith("/v1/models")) {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        data: [
          {
            id: "fixture-vision",
            context_length: 65536,
            architecture: { input_modalities: ["text", "image"] },
            supported_voices: ["cute"],
          },
        ],
      }),
    );
    return;
  }
  if (req.url?.startsWith("/v1/audio/voices")) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ voices: ["cute"] }));
    return;
  }
  if (req.url === "/v1/audio/transcriptions") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ text: "插话的文字" }));
    return;
  }
  if (req.url === "/v1/audio/speech") {
    if (body.response_format === "pcm") {
      res.setHeader("Content-Type", "audio/pcm;rate=24000;channels=1");
      res.write(wav.subarray(44, 4844));
      const timer = setTimeout(() => {
        request.finished = true;
        res.end(wav.subarray(4844));
      }, 1500);
      res.on("close", () => clearTimeout(timer));
    } else {
      res.setHeader("Content-Type", "audio/wav");
      res.end(wav);
    }
    return;
  }
  if (req.url !== "/v1/chat/completions") {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.write('data: {"choices":[{"delta":{"content":"你好呀。"}}]}\n\n');
  const timer = setTimeout(
    () =>
      res.end(
        'data: {"choices":[{"delta":{"content":"这是后面的内容。"}}]}\n\ndata: [DONE]\n\n',
      ),
    2800,
  );
  res.on("close", () => clearTimeout(timer));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
let runtime, controller;
const find = async (app, suffix) => {
  for (let n = 0; n < 200; n++) {
    const p = app.windows().find((p) => p.url().endsWith(suffix));
    if (p) return p;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("窗口未加载：" + suffix);
};
try {
  runtime = await electron.launch({
    executablePath: electronPath,
    args: [
      root,
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
    env,
  });
  runtime.process().stderr.on("data", (b) => errors.push(b.toString()));
  const voice = await find(runtime, "voice-session/index.html"),
    composer = await find(runtime, "bubble-chat/composer.html"),
    speech = await find(runtime, "bubble-chat/speech.html");
  for (const p of [voice, composer, speech])
    p.on("pageerror", (e) => errors.push(e.message));
  await voice.evaluate(() => {
    window.audioEvents = [];
    window.familiar.on("familiar:voice-host", (v) =>
      window.audioEvents.push(v.type),
    );
  });
  controller = await electron.launch({
    executablePath: electronPath,
    args: [root, "--controller"],
    env,
  });
  const page = await find(controller, "control-center/index.html");
  page.on("pageerror", (e) => errors.push(e.message));
  const call = (name, params) =>
    page.evaluate(
      ([name, params]) => window.familiar.request(name, params),
      [name, params],
    );
  const manifest = JSON.parse(
    await readFile(join(root, "assets/voices/manifest.json"), "utf8"),
  );
  const audioChecks = [];
  for (const item of [...manifest.samples, ...manifest.previews]) {
    const source = await readFile(join(root, "assets/voices", item.file));
    const bundled = await readFile(join(root, "dist/assets/voices", item.file));
    assert.equal(
      createHash("sha256").update(source).digest("hex"),
      item.sha256,
    );
    assert.deepEqual(bundled, source);
    const decoded = await voice.evaluate(async (base64) => {
      const ctx = new AudioContext();
      try {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const audio = await ctx.decodeAudioData(bytes.buffer);
        return {
          duration: audio.duration,
          signal: audio.getChannelData(0).some((v) => Math.abs(v) > 0.001),
        };
      } finally {
        await ctx.close();
      }
    }, source.toString("base64"));
    assert.ok(decoded.duration > 1 && decoded.signal, item.file);
    audioChecks.push({ file: item.file, ...decoded });
  }
  await writeFile(
    join(output, "bundled-voices.json"),
    JSON.stringify(audioChecks, null, 2),
  );
  console.log(
    "PASS: 两套参考声与五段免费试听摘要一致，构建资源可解码且包含声音",
  );
  // 用依赖自带的简单 Word 文档和生成的单页 PDF 验证真实 Electron 提取路径。
  const pdfPath = join(output, "text.pdf");
  const stream = "BT /F1 18 Tf 40 100 Td (Familiar PDF text) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await writeFile(pdfPath, pdf);
  await runtime.evaluate(
    ({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: files,
      });
    },
    [
      pdfPath,
      join(root, "node_modules/mammoth/test/test-data/single-paragraph.docx"),
    ],
  );
  const documents = await call("media.choose");
  assert.equal(documents.length, 2);
  for (const doc of documents) {
    const preview = await call("media.preview", { id: doc.id });
    assert.equal(doc.kind, "text");
    assert.ok(preview.text.trim().length > 5);
    if (doc.name === "text.pdf")
      assert.match(preview.text, /Familiar PDF text/);
  }
  console.log("PASS: PDF 与 Word 在实际应用内提取文字");
  await page.locator('nav [data-page="voice"]').click();
  await page.waitForFunction(
    () => !document.getElementById("voice-save").disabled,
  );
  await page.locator("#voice-identity").selectOption("provider");
  assert.match(
    await page.locator("#voice-mode-limit").innerText(),
    /需要你自己接入.*Live 模型/,
  );
  assert.equal(await page.locator("#voice-continuous").isChecked(), true);
  assert.equal(await page.locator("#voice-idle").isDisabled(), true);
  await page.locator("#voice-mode").selectOption("realtime");
  assert.equal(
    await page.locator("#voice-live-recommendations button").count(),
    2,
  );
  assert.match(
    await page.locator("#voice-live-recommendations").innerText(),
    /Qwen.*[\s\S]*当前不能直接使用/,
  );
  await page.locator("#voice-live-recommendations button").nth(1).click();
  assert.equal(
    await page.locator("#voice-live-model").inputValue(),
    "gemini-3.8-live",
  );
  await page.locator("#voice-live-model").fill("");
  await page.locator("#voice-start").click();
  await page.waitForFunction(() =>
    document.getElementById("toast").textContent.includes("请先配置"),
  );
  assert.equal((await call("voice.state")).active, false);
  assert.equal((await call("voice.get")).settings.mode, "realtime");
  await page.screenshot({ path: join(output, "live-setup-required.png") });
  await page.locator("#voice-mode").selectOption("chained");
  await page.locator("#voice-stt-language").fill("zh");
  await page.locator("#voice-stt-prompt").fill("小森、Familiar");
  await page.locator("#voice-reference").uncheck();
  await page.locator("#voice-stt-kind").selectOption("openrouter");
  await page.locator("#voice-stt-baseUrl").fill(baseUrl);
  await page.locator("#voice-stt-model").fill("fixture-asr");
  await page.locator("#voice-stt-key").fill("fixture-stt-key");
  await page.locator("#voice-stt-save-key").click();
  await page.waitForFunction(
    () => document.getElementById("voice-stt-key").value === "",
  );
  await page.locator("#voice-tts-kind").selectOption("compatible");
  await page.locator("#voice-tts-baseUrl").fill(baseUrl);
  await page.locator("#voice-tts-model").fill("fixture-vision");
  await page.locator("#voice-tts-voice").fill("cute");
  await page.locator("#voice-tts-catalog").click();
  await page.waitForFunction(
    () => document.getElementById("voice-tts-voices").children.length === 1,
  );
  await page.locator("#voice-autoread").check();
  await page.locator("#voice-sensitivity").fill("72");
  await page.locator("#voice-phrases").fill("火火，小森");
  await page.locator("#voice-save").click();
  await page.waitForFunction(
    () => document.getElementById("toast").textContent === "语音设置已保存",
  );
  const cfg = await call("voice.get");
  assert.equal(cfg.settings.wakeSensitivity, 72);
  assert.equal(cfg.settings.continuous, true);
  assert.equal(cfg.settings.stt.language, "zh");
  assert.deepEqual(cfg.settings.wakePhrases, ["火火", "小森"]);
  assert.equal(cfg.keys.stt, true);
  assert.doesNotMatch(
    await readFile(join(data, "data", "voice-settings.json"), "utf8"),
    /fixture-stt-key/,
  );
  await page.screenshot({ path: join(output, "voice-settings.png") });
  console.log(
    "PASS: 真实控制器语音页、独立加密 Key、Qwen 默认项、目录和自定义唤醒设置",
  );
  const settings = (await call("runtime.status")).settings;
  settings.provider.baseUrl = baseUrl;
  settings.provider.model = "fixture-vision";
  settings.provider.kind = "compatible";
  await call("settings.apply", settings);
  await call("provider.models");
  const imagePath = join(output, "fixture.png");
  const imageBase64 = await runtime.evaluate(
    async ({ nativeImage, dialog, clipboard, ClipboardItem }, file) => {
      const image = nativeImage.createFromBuffer(
        Buffer.from([
          255, 50, 20, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
        ]),
        { width: 2, height: 2 },
      );
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
      await clipboard.write([
        new ClipboardItem({
          "image/png": new Blob([image.toPNG()], { type: "image/png" }),
        }),
      ]);
      return image.toPNG().toString("base64");
    },
    imagePath,
  );
  await writeFile(imagePath, Buffer.from(imageBase64, "base64"));
  await call("chat.open");
  await composer.locator("#attach").click();
  await composer.waitForFunction(
    () => document.querySelectorAll("#attachments button").length === 1,
  );
  await composer.locator("#input").fill("请看这张图");
  await composer.locator("#send").click();
  for (
    let i = 0;
    i < 80 && !requests.some((r) => r.url === "/v1/audio/speech");
    i++
  )
    await new Promise((r) => setTimeout(r, 20));
  const firstSpeech = requests.find((r) => r.url === "/v1/audio/speech");
  assert.ok(firstSpeech, "首句尚未开始合成");
  await voice.waitForFunction(() => window.audioEvents.includes("pcm"));
  assert.equal(firstSpeech.body.response_format, "pcm");
  assert.equal(firstSpeech.finished, false, "整句下载结束前已交付播放片段");
  assert.equal(
    (await call("history.state")).busy,
    true,
    "应在主模型输出结束前朗读首句",
  );
  const chatRequest = requests.find((r) => r.url === "/v1/chat/completions");
  assert.ok(
    chatRequest.body.messages
      .at(-1)
      .content.some((c) => c.type === "image_url"),
  );
  assert.ok(firstSpeech.time - chatRequest.time < 2000);
  await speech.locator("#close").click();
  await speech.evaluate(() => window.familiar.request("speech.hover", false));
  assert.equal(
    await runtime.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().endsWith("speech.html"))
        .isVisible(),
    ),
    false,
  );
  await call("voice.stop");
  await call("history.cancel");
  console.log(
    "PASS: 图片进入主模型，文字首句提前合成且音频下载完成前已播放，气泡关闭与取消",
  );
  await voice.evaluate(() => {
    window.sent = [];
    window.voiceEpoch = 0;
    window.familiar.on("familiar:voice-host", (m) => {
      window.voiceEpoch = m.epoch;
      window.sent.push(m.type);
    });
    // 对话监听使用无声的人工 MediaStream，不采集用户的真实麦克风。
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext({ sampleRate: 24000 });
      window.fixtureMicContext = ctx;
      return ctx.createMediaStreamDestination().stream;
    };
  });
  await call("voice.start");
  await page.waitForFunction(
    async () =>
      (await window.familiar.request("voice.state")).phase === "listening",
  );
  assert.equal((await call("voice.state")).idleUntil, undefined);
  await call("voice.read", { text: "用于验证插话取消的长句。" });
  await page.waitForFunction(
    async () =>
      (await window.familiar.request("voice.state")).phase === "speaking",
  );
  await voice.evaluate(async () => {
    const b = new Uint8Array(4800),
      view = new DataView(b.buffer);
    for (let i = 0; i < b.length; i += 2) view.setInt16(i, 6000, true);
    const data = btoa(String.fromCharCode(...b));
    for (let i = 0; i < 2; i++)
      await window.familiar.request("voice.host", {
        type: "pcm",
        epoch: window.voiceEpoch,
        data,
      });
  });
  assert.equal((await call("voice.state")).phase, "recording");
  assert.ok(await voice.evaluate(() => window.sent.includes("clear")));
  await call("voice.stop");
  await call("voice.dictate", { target: "composer" });
  await page.waitForFunction(
    async () => (await window.familiar.request("voice.state")).dictating,
  );
  await voice.evaluate(async () => {
    const data = btoa("\0".repeat(9600));
    await window.familiar.request("voice.host", {
      type: "pcm",
      epoch: window.voiceEpoch,
      data,
    });
  });
  await call("voice.finish");
  await composer.waitForFunction(() =>
    document.getElementById("input").value.includes("插话的文字"),
  );
  await call("voice.preview", { id: "gentle" });
  await page.waitForFunction(
    async () => (await window.familiar.request("voice.state")).phase === "off",
  );
  console.log(
    "PASS: 连续监听中插话立即清播放、录音转文字留给用户编辑、离线随包试听",
  );
  await call("chat.open");
  await composer.screenshot({ path: join(output, "composer.png") });
  assert.equal(
    errors.filter((s) =>
      /Uncaught|TypeError|未声明|不存在的能力|启动失败/.test(s),
    ).length,
    0,
    errors.join("\n"),
  );
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(
      {
        passed: true,
        imageRequests: requests.filter((r) => r.url === "/v1/chat/completions")
          .length,
        speechRequests: requests.filter((r) => r.url === "/v1/audio/speech")
          .length,
        realMicrophone: false,
        realProvider: false,
        liveSetupGate: true,
        continuousMode: true,
      },
      null,
      2,
    ),
  );
  console.log("SMOKE OUTPUT:", output);
} finally {
  await controller?.close().catch(() => {});
  await runtime?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
