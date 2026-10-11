import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { voicePersonas } from "../plugins/voice-api/config.ts";
// 单独执行的资产创作脚本：官方公开演示只收到项目试听文案，不需要或读取用户密钥。
const root = "https://qwen-qwen3-tts.hf.space",
  directory = "assets/voices";
const descriptions = {
  gentle:
    "原创中文桌面小精灵的声音，清亮柔软、轻盈可爱，略偏高但不尖，带自然的笑意和好奇感，咬字清楚，温暖亲近，尾音短而轻，不是播音腔，不模仿任何真人。",
  thorough:
    "原创中文桌面小动物伙伴，圆润清透的年轻中性声线，轻柔可爱，耐心细致，语速略慢，词句之间有自然小停顿，音高稍高，亲近而不夸张，不使用新闻播音腔，不模仿真人。",
  direct:
    "原创中文桌面小机器人伙伴，轻巧清脆的中性声音，可爱但平实，略带一点呆萌，咬字干净，短句直接，音高适中偏高，语气友好，不机械卡顿，不低沉，不模仿真人。",
  enthusiastic:
    "原创中文桌面火焰小精灵，明亮甜润的小伙伴声线，可爱、好奇、精神饱满，轻快跳跃，带笑意，声音小巧有弹性，略高音但不尖叫，不刻意婴儿腔，不模仿任何真人。",
  concise:
    "原创中文桌面小鸟伙伴，清亮轻盈的中性声线，萌而利落，语速稍快但每个字清楚，尾音短干净，亲切自然，带一点轻松笑意，不像播音员，不模仿任何真人。",
};
await mkdir(directory, { recursive: true });
const samples = [];
for (const p of voicePersonas.filter((p) =>
  ["gentle", "thorough"].includes(p.id),
)) {
  const call = await fetch(root + "/gradio_api/call/generate_voice_design", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: [p.text, "Chinese", descriptions[p.id]] }),
    signal: AbortSignal.timeout(20000),
  });
  if (!call.ok) throw new Error("VoiceDesign 请求失败 " + call.status);
  const task = await call.json();
  const response = await fetch(
    root + "/gradio_api/call/generate_voice_design/" + task.event_id,
    { signal: AbortSignal.timeout(180000) },
  );
  const sse = await response.text();
  if (/event: error/.test(sse))
    throw new Error("VoiceDesign 生成失败；请稍后人工重试");
  const line = sse
    .split("\n")
    .filter((s) => s.startsWith("data: "))
    .at(-1);
  const result = JSON.parse(line.slice(6));
  if (!result[0]?.url?.startsWith(root + "/gradio_api/file="))
    throw new Error("缺少官方演示音频");
  const audio = await fetch(result[0].url, {
    signal: AbortSignal.timeout(30000),
  });
  if (!audio.ok) throw new Error("音频下载失败");
  const bytes = Buffer.from(await audio.arrayBuffer());
  if (
    bytes.length > 4 * 1024 * 1024 ||
    bytes.toString("ascii", 0, 4) !== "RIFF"
  )
    throw new Error("试听文件格式无效");
  await writeFile(join(directory, p.id + ".wav"), bytes);
  samples.push({
    id: p.id,
    name: p.name,
    file: p.id + ".wav",
    text: p.text,
    design: descriptions[p.id],
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  });
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify(
      {
        source: "Qwen3-TTS VoiceDesign · Qwen 官方公开演示",
        sourceUrl: "https://huggingface.co/spaces/Qwen/Qwen3-TTS",
        modelLicense: "Apache-2.0",
        originalSyntheticVoice: true,
        generatedAt: new Date().toISOString(),
        samples,
      },
      null,
      2,
    ) + "\n",
  );
  console.log("已生成原创参考：", p.id, bytes.length);
}
