import { createHash } from "node:crypto";
import type {
  VoiceSettings,
  VoiceChoice,
} from "../../packages/contracts/index.ts";
export const voiceDefaults: VoiceSettings = {
  enabled: false,
  wakeEnabled: true,
  wakePhrases: [],
  wakeSensitivity: 50,
  mode: "chained",
  autoRead: false,
  idleSeconds: 30,
  continuous: true,
  silenceMs: 900,
  cacheDays: 7,
  cacheMaxMB: 256,
  followPersona: true,
  identity: "persona",
  stt: {
    kind: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "qwen/qwen3-asr-1.7b",
  },
  tts: {
    kind: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "fish-audio/s2.1-pro",
    voice: "",
    speed: 1,
    reference: true,
    stream: true,
  },
  live: {
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-realtime",
    voice: "coral",
  },
};
export const voicePersonas = [
  {
    id: "gentle",
    name: "温柔陪伴",
    text: "在的在的，今天也陪着你。别着急，我们慢慢来，好不好？",
    tone: "声音轻柔、明亮可爱，像熟悉的小伙伴。语速稍缓，自然停顿，不使用夸张的婴儿腔。",
  },
  {
    id: "thorough",
    name: "细致周到",
    text: "我来陪你一起看看。先确认目标，再一步一步来，最后我们再检查一下。",
    tone: "清晰细致、温和可爱，分步骤时自然停顿，重点说清楚，避免播音腔。",
  },
  {
    id: "direct",
    name: "直白理性",
    text: "收到。先处理眼前这一项，完成后再继续。我会在这里陪着你。",
    tone: "平实清楚、轻巧可爱，少修饰、不拖长尾音，保持友好。",
  },
  {
    id: "enthusiastic",
    name: "热情活泼",
    text: "来啦来啦！今天想先做什么呀？叫上我，一起把它搞定吧！",
    tone: "明亮、活泼、可爱，有轻快的起伏和笑意，避免尖叫和过度兴奋。",
  },
  {
    id: "concise",
    name: "简洁高效",
    text: "在呢。告诉我目标，我来帮忙。需要就叫我哦。",
    tone: "轻快清楚、可爱而利落，短句自然，尾音干净，不刻意催促。",
  },
] as const;
export function voiceStyle(id?: string) {
  return voicePersonas.find((p) => p.id === id) ?? voicePersonas[0];
}
// 声线独立于性格；两套原创参考可以承载不同的说话习惯。
export function voiceIdentity(id?: string) {
  return voiceStyle(
    id === "thorough" || id === "direct" ? "thorough" : "gentle",
  );
}
export function voiceScope(slot: "stt" | "tts" | "live", c: VoiceSettings) {
  return createHash("sha256")
    .update(
      JSON.stringify(["familiar.voice", slot, c[slot].kind, c[slot].baseUrl]),
    )
    .digest("hex");
}
export function validateVoice(value: VoiceSettings): VoiceSettings {
  if (!value || typeof value !== "object") throw new Error("语音设置无效");
  const v = { ...structuredClone(voiceDefaults), ...structuredClone(value) };
  if (!("identity" in value)) v.identity = "provider"; // 旧配置保持原有声音，用户选择档案后才切换。
  if (
    ![
      "persona",
      "gentle",
      "thorough",
      "direct",
      "enthusiastic",
      "concise",
      "provider",
    ].includes(v.identity)
  )
    throw new Error("宠物声音档案无效");
  for (const key of [
    "enabled",
    "wakeEnabled",
    "autoRead",
    "followPersona",
    "continuous",
  ] as const)
    if (typeof v[key] !== "boolean") throw new Error("语音开关无效");
  if (!["chained", "realtime"].includes(v.mode))
    throw new Error("语音模式无效");
  for (const [key, min, max] of [
    ["wakeSensitivity", 0, 100],
    ["idleSeconds", 5, 600],
    ["silenceMs", 300, 3000],
    ["cacheDays", 0, 365],
    ["cacheMaxMB", 16, 2048],
  ] as const)
    if (!Number.isInteger(v[key]) || v[key] < min || v[key] > max)
      throw new Error(`${key} 需在 ${min}—${max} 之间`);
  if (
    !Array.isArray(v.wakePhrases) ||
    v.wakePhrases.length > 12 ||
    v.wakePhrases.some(
      (s) => typeof s !== "string" || !s.trim() || s.length > 40,
    )
  )
    throw new Error("唤醒词最多 12 条，每条 1—40 字");
  v.wakePhrases = [...new Set(v.wakePhrases.map((s) => s.trim()))];
  for (const slot of ["stt", "tts", "live"] as const) {
    const p = v[slot];
    if (
      !p ||
      !(
        (slot === "live"
          ? ["openai", "gemini"]
          : slot === "tts"
            ? ["compatible", "openrouter", "system"]
            : ["compatible", "openrouter"]) as string[]
      ).includes(p.kind)
    )
      throw new Error("请选择支持的语音接口");
    if (typeof p.baseUrl !== "string" || p.baseUrl.length > 2048)
      throw new Error("语音地址无效");
    const url = new URL(p.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("语音地址使用不含密钥和参数的 HTTP(S) 地址");
    p.baseUrl = url.href.replace(/\/$/, "");
    if (
      typeof p.model !== "string" ||
      p.model.length > 200 ||
      /[\r\n]/.test(p.model)
    )
      throw new Error("语音模型 ID 无效");
  }
  for (const p of [v.tts, v.live])
    if (
      typeof p.voice !== "string" ||
      p.voice.length > 200 ||
      /[\r\n]/.test(p.voice)
    )
      throw new Error("音色 ID 无效");
  if (
    (v.stt.language !== undefined &&
      (typeof v.stt.language !== "string" ||
        !/^(?:[a-z]{2,3}(?:-[A-Za-z]{2,4})?)?$/.test(v.stt.language))) ||
    (v.stt.prompt !== undefined &&
      (typeof v.stt.prompt !== "string" || v.stt.prompt.length > 500))
  )
    throw new Error("识别语言或提示词无效（提示词最多 500 字）");
  if (
    !Number.isFinite(v.tts.speed) ||
    v.tts.speed < 0.5 ||
    v.tts.speed > 2 ||
    typeof v.tts.reference !== "boolean" ||
    (v.tts.stream !== undefined && typeof v.tts.stream !== "boolean")
  )
    throw new Error("语速或参考音色设置无效");
  return v;
}
export function presetVoices(
  model: string,
  live = false,
  gemini = false,
): VoiceChoice[] {
  const names = gemini
    ? ["Aoede", "Kore", "Puck", "Charon", "Zephyr", "Fenrir", "Leda", "Orus"]
    : live
      ? [
          "alloy",
          "ash",
          "ballad",
          "coral",
          "echo",
          "sage",
          "shimmer",
          "verse",
          "marin",
          "cedar",
        ]
      : /(?:^|\/)(?:gpt-4o-mini-tts|tts-1)/.test(model)
        ? /(?:^|\/)tts-1/.test(model)
          ? [
              "alloy",
              "ash",
              "coral",
              "echo",
              "fable",
              "onyx",
              "nova",
              "sage",
              "shimmer",
            ]
          : [
              "alloy",
              "ash",
              "ballad",
              "coral",
              "echo",
              "fable",
              "nova",
              "onyx",
              "sage",
              "shimmer",
              "verse",
              "marin",
              "cedar",
            ]
        : [];
  return names.map((id) => ({ id, name: id }));
}
export function spokenText(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, "（代码请看文字）")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "链接见文字")
    .replace(/^[#>*\-]+\s*/gm, "")
    .replace(/[*_`]/g, "")
    .trim();
}
export function speechChunks(text: string): string[] {
  const parts = spokenText(text).match(/[^。！？\n]+[。！？\n]?/g) ?? [];
  const result: string[] = [];
  let pending = "";
  for (const part of parts) {
    if (pending.length + part.length > 600 && pending) {
      result.push(pending);
      pending = "";
    }
    for (let start = 0; start < part.length; start += 600) {
      const chunk = part.slice(start, start + 600);
      if (chunk.length === 600) result.push(chunk);
      else pending += chunk;
    }
  }
  if (pending.trim()) result.push(pending);
  return result;
}
