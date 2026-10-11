import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { voicePersonas, voiceIdentity } from "../plugins/voice-api/config.ts";
import { rpc } from "../packages/protocol/index.ts";
// 人工执行才调用已配置的语音 API；构建和随包试听均不调用此脚本。
const folder = join(process.cwd(), "assets", "voices");
const data =
  process.env.FAMILIAR_DATA_DIR || join(process.env.APPDATA, "Familiar");
const current = await rpc(data, "voice.get");
if (current.settings.identity === "provider" || !current.settings.tts.reference)
  throw new Error("请先选择原创宠物声音和支持参考音频的合成模型");
const manifest = JSON.parse(
  await readFile(join(folder, "manifest.json"), "utf8"),
);
manifest.previews = [];
await mkdir(folder, { recursive: true });
for (const persona of voicePersonas) {
  const result = await rpc(data, "voice.sample", { id: persona.id, voice: "" });
  if (result.mimeType !== "audio/mpeg")
    throw new Error("模型未返回 MP3，未覆盖试听文件");
  const bytes = Buffer.from(result.data, "base64"),
    file = persona.id + ".mp3";
  await writeFile(join(folder, file), bytes);
  manifest.previews.push({
    id: persona.id,
    file,
    text: persona.text,
    model: current.settings.tts.model,
    reference:
      voiceIdentity(
        current.settings.identity === "persona"
          ? persona.id
          : current.settings.identity,
      ).id + ".wav",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  });
  console.log(
    "随包试听：",
    persona.id,
    bytes.length,
    result.cached ? "缓存" : "新合成",
  );
}
await writeFile(
  join(folder, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
