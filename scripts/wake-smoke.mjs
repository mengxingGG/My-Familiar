import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
if (process.platform !== "win32")
  throw new Error("此测试需要 Windows 中文识别器");
const directory = resolve(".artifacts/wake-smoke-" + Date.now());
const executable = resolve("dist/native/Familiar.Speech.exe");
await mkdir(directory, { recursive: true });
const invoke = (args, value) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      args,
      { windowsHide: true, timeout: 20000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || stdout || error.message));
          return;
        }
        try {
          resolve(
            stdout
              .trim()
              .split(/\r?\n/)
              .map((s) => JSON.parse(s)),
          );
        } catch (e) {
          reject(e);
        }
      },
    );
    child.stdin.end(JSON.stringify(value) + "\n");
  });
const results = [];
for (const [i, text] of [
  "小森",
  "小森，在吗？",
  "小森起床啦",
  "你好小森，帮我看看",
  "火火，起床啦",
  "今天天气很好",
  "小明在吗",
].entries()) {
  const audio = (
    await invoke(["--speak"], { text, style: "direct", speed: 1 })
  )[0];
  const file = join(directory, i + ".wav");
  await writeFile(file, Buffer.from(audio.data, "base64"));
  const events = await invoke(["--wake"], {
    phrases: ["小森", "火火"],
    threshold: 0.6,
    wave: file,
  });
  const wakeEvent = events.find((v) => v.wake);
  const wake = wakeEvent?.wake;
  assert.equal(wake, i < 4 ? "小森" : i === 4 ? "火火" : undefined, text);
  if (i === 3) {
    assert.ok(wakeEvent.audio, "带请求的唤醒需要交接识别音频");
    const carried = Buffer.from(wakeEvent.audio, "base64");
    assert.equal(carried.toString("ascii", 0, 4), "RIFF");
    assert.ok(carried.length > 1000 && carried.length < 2 * 1024 * 1024);
  }
  results.push({
    text,
    wake: wake ?? null,
    confidence: events.find((v) => v.accepted)?.confidence,
    audioHandoff: !!wakeEvent?.audio,
  });
}
await writeFile(
  join(directory, "result.json"),
  JSON.stringify(
    { passed: true, realMicrophone: false, cases: results },
    null,
    2,
  ),
);
console.log(
  "PASS: 五句名字/任意前后缀正确唤醒，两句无关语音不唤醒；离线回放，不采集麦克风",
);
console.log("WAKE OUTPUT:", directory);
