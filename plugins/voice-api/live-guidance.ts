import type {
  LiveRecommendation,
  VoiceReadiness,
  VoiceSettings,
} from "../../packages/contracts/voice.ts";

// 2026-10-11 核对官方资料。候选没有 profile 时不可当作现成适配器应用。
export const liveRecommendations: LiveRecommendation[] = [
  {
    id: "openai",
    name: "OpenAI Realtime",
    model: "gpt-realtime",
    note: "当前可配置：使用独立 Live API Key 和服务商音色；本版仍由主模型代理回答，尚非原生直接交流。",
    source: "https://developers.openai.com/api/docs/models/gpt-realtime",
    profile: {
      kind: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-realtime",
      voice: "coral",
    },
  },
  {
    id: "gemini",
    name: "Gemini Live",
    model: "gemini-3.8-live",
    note: "当前可配置：官方示例模型，需账户实际开放该模型；本版为主模型代理，真实通话待验证。",
    source: "https://ai.google.dev/gemini-api/docs/live-api/session-management",
    profile: {
      kind: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-3.8-live",
      voice: "Aoede",
    },
  },
  {
    id: "qwen",
    name: "Qwen Omni Realtime",
    model: "qwen3.8-omni-flash-realtime",
    note: "后续适配候选：中文实时交流与注册音色。需独立协议、地域与工作空间配置；当前不能直接使用。",
    source: "https://www.alibabacloud.com/help/en/model-studio/realtime",
  },
  {
    id: "minicpm",
    name: "MiniCPM-o 4.5",
    model: "openbmb/MiniCPM-o-4_5",
    note: "本地双向语音候选：需另行部署模型服务与评估硬件，当前未适配。",
    source: "https://github.com/OpenBMB/MiniCPM-o",
  },
];

export function voiceReadiness(
  config: VoiceSettings,
  hasLiveKey: boolean,
): VoiceReadiness {
  if (config.mode === "chained")
    return {
      configured: true,
      problems: [],
      route: "chained",
      summary:
        "常规模式：识别 → 主模型 → 朗读。支持持续接话与插话；逐段处理无法提供原生 Live 的低延迟同时听说体验。",
    };
  const problems: string[] = [];
  if (!config.live.model.trim())
    problems.push(
      "请先配置支持实时音频的 Live 模型，普通文字模型或 TTS 模型不能替代",
    );
  if (!config.live.voice.trim())
    problems.push("请填写该 Live 模型支持的服务商音色");
  const host = new URL(config.live.baseUrl).hostname;
  if (
    ["api.openai.com", "generativelanguage.googleapis.com"].includes(host) &&
    !hasLiveKey
  )
    problems.push(
      "请保存此 Live 接口的独立 API Key（文字模型或 ASR/TTS 密钥不会自动复用）",
    );
  if (config.identity !== "provider")
    problems.push(
      "当前 Live 适配需主动选择「服务商音色」；保留原创声线可继续使用常规模式",
    );
  return {
    configured: !problems.length,
    problems,
    route: "live-relay",
    summary:
      "Live 需要用户接入支持实时音频的模型。当前适配仍经主模型代理回答，会增加等待；已填写配置不代表连接或低延迟体验已验证。",
  };
}
