export interface AudioProfile {
  kind: "compatible" | "openrouter" | "system";
  baseUrl: string;
  model: string;
}
export interface LiveProfile {
  kind: "openai" | "gemini";
  baseUrl: string;
  model: string;
  voice: string;
}
export interface VoiceSettings {
  enabled: boolean;
  wakeEnabled: boolean;
  wakePhrases: string[];
  wakeSensitivity: number;
  mode: "chained" | "realtime";
  autoRead: boolean;
  idleSeconds: number;
  /** 连续接话直到用户结束；关闭时才应用空闲回待机。 */
  continuous?: boolean;
  silenceMs: number;
  cacheDays: number;
  cacheMaxMB: number;
  followPersona: boolean;
  identity:
    | "persona"
    | "gentle"
    | "thorough"
    | "direct"
    | "enthusiastic"
    | "concise"
    | "provider";
  stt: AudioProfile & { language?: string; prompt?: string };
  tts: AudioProfile & {
    voice: string;
    speed: number;
    reference: boolean;
    stream?: boolean;
  };
  live: LiveProfile;
}
export interface VoiceState {
  phase:
    | "off"
    | "sleeping"
    | "connecting"
    | "listening"
    | "recording"
    | "thinking"
    | "speaking"
    | "error";
  active: boolean;
  dictating: boolean;
  autoRead: boolean;
  mode: VoiceSettings["mode"];
  message: string;
  error?: string;
  idleUntil?: number;
  wakeAvailable?: boolean;
  wake?: WakeStatus;
}
export interface WakeStatus {
  available: boolean;
  listening?: boolean;
  message: string;
  level?: number;
  peak?: number;
  lastAudioAt?: number;
  lastSpeechAt?: number;
  lastResult?: string;
  confidence?: number;
  handoffMessage?: string;
}
export interface VoiceChoice {
  id: string;
  name: string;
}
export interface VoiceCatalog {
  models: VoiceChoice[];
  voices: VoiceChoice[];
  voiceSource: "api" | "preset" | "custom";
  note: string;
}
export interface AudioClip {
  id: string;
  mimeType: string;
  data: string;
  cached: boolean;
}
export interface PcmChunk {
  data: Uint8Array;
  rate: number;
}
export interface VoiceReadiness {
  configured: boolean;
  problems: string[];
  route: "chained" | "live-relay";
  summary: string;
}
export interface LiveRecommendation {
  id: string;
  name: string;
  model: string;
  note: string;
  source: string;
  profile?: LiveProfile;
}
declare module "../kernel/index.ts" {
  interface Services {
    "voice.api": {
      get(): VoiceSettings;
      save(value: VoiceSettings): Promise<VoiceSettings>;
      setKey(slot: "stt" | "tts" | "live", value: string): Promise<void>;
      hasKeys(): Record<string, boolean>;
      readiness(): VoiceReadiness;
      recommendations(): LiveRecommendation[];
      catalog(
        slot: "stt" | "tts" | "live",
        draft?: VoiceSettings,
      ): Promise<VoiceCatalog>;
      transcribe(wav: Uint8Array, signal: AbortSignal): Promise<string>;
      speak(
        text: string,
        signal: AbortSignal,
        preview?: { style: string; voice: string },
        onPcm?: (chunk: PcmChunk) => void,
      ): Promise<AudioClip>;
      key(slot: "stt" | "tts" | "live"): string;
      cleanup(): Promise<{ files: number; bytes: number }>;
    };
    "voice.wake": {
      status(): WakeStatus;
      listen(
        phrases: string[],
        onWake: (text: string, audio?: PcmChunk) => void,
        sensitivity?: number,
      ): Promise<void>;
      stop(): void;
    };
    "voice.local": {
      voices(): { id: string; name: string }[];
      catalog?(): Promise<VoiceCatalog>;
      /** 在缓存命中前核对已安装音色；返回固定音色和引擎版本范围。 */
      resolveVoice?(voice: string): Promise<{ voice: string; scope: string }>;
      synthesize(
        text: string,
        style: string,
        voice: string,
        speed: number,
        signal: AbortSignal,
      ): Promise<Uint8Array>;
    };
    "voice.session": {
      state(): VoiceState;
      start(dictation?: boolean): Promise<void>;
      stop(rearm?: boolean): Promise<void>;
      finishDictation(): Promise<void>;
      speak(text: string): Promise<void>;
    };
  }
}
