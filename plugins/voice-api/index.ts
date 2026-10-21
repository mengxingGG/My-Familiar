import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  definePlugin,
  type VoiceCatalog,
  type VoiceChoice,
  type VoiceSettings,
} from "../../packages/contracts/index.ts";
import { AudioCache, audioKey } from "./cache.ts";
import { readPcm } from "./pcm.ts";
import { liveRecommendations, voiceReadiness } from "./live-guidance.ts";
import {
  presetVoices,
  validateVoice,
  voiceDefaults,
  voiceScope,
  voiceStyle,
  voiceIdentity,
  spokenText,
} from "./config.ts";
export async function limitedBytes(response: Response, max = 20 * 1024 * 1024) {
  if (!response.body) throw new Error("语音服务返回空响应");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new Error("语音服务响应过大");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
export function voiceApi(directory: string, assetsDirectory: string, initial: VoiceSettings = voiceDefaults) {
  return definePlugin({
    manifest: {
      manifestVersion: 1,
      id: "familiar.voice-api",
      version: "0.3.0",
      provides: ["voice.api"],
      requires: [
        "storage.local",
        "secrets.local",
        "settings",
        "character.catalog",
        "voice.local",
      ],
      permissions: ["network.voice"],
    },
    async start(ctx) {
      const storage = ctx.use("storage.local"),
        secrets = ctx.use("secrets.local"),
        cache = new AudioCache(directory);
      let config = validateVoice(
        await storage.read("voice-settings", initial),
      );
      const style = () => {
        const c = ctx.use("settings").get();
        return voiceStyle(
          c.persona.style === "character"
            ? ctx.use("character.catalog").get(c.pet.character)
                .recommendedPersona
            : c.persona.style,
        );
      };
      const key = (slot: "stt" | "tts" | "live") =>
        secrets.get(voiceScope(slot, config));
      const auth = (
        slot: "stt" | "tts" | "live",
        c = config,
      ): Record<string, string> => {
        const value = secrets.get(voiceScope(slot, c));
        return value ? { Authorization: `Bearer ${value}` } : {};
      };
      const request = async (
        url: string,
        init: RequestInit,
        signal: AbortSignal,
      ) => {
        ctx.require("network.voice");
        const response = await fetch(url, {
          ...init,
          redirect: "error",
          signal: AbortSignal.any([
            signal,
            ctx.abort.signal,
            AbortSignal.timeout(90000),
          ]),
        });
        if (!response.ok) {
          // 不回显服务响应正文，避免上游把凭据或录音原文写入错误提示。
          await response.body?.cancel();
          throw new Error(
            `语音接口返回 HTTP ${response.status}，请核对地址、模型、密钥及该模型的音色支持`,
          );
        }
        return response;
      };
      // 性格只控制表达方式，不覆盖用户选定的服务商声音。
      const currentVoice = () => config.tts.voice;
      const cleanup = () => cache.cleanup(config.cacheDays, config.cacheMaxMB);
      const cloneModels = new Map<string, boolean>();
      const supportsIdentity = async (c: VoiceSettings) => {
        if (c.identity === "provider") return;
        if (c.tts.kind === "system" || !c.tts.reference)
          throw new Error(
            "固定宠物声音需要支持参考音频的语音接口；原设置已保留。可选 OpenRouter 的 fish-audio/s2.1-pro，或支持参考音频的兼容服务。",
          );
        if (c.tts.kind !== "openrouter") return;
        const id = c.tts.baseUrl + "/" + c.tts.model;
        if (!cloneModels.has(id)) {
          const r = await request(
            c.tts.baseUrl +
              "/models/" +
              c.tts.model.split("/").map(encodeURIComponent).join("/") +
              "/endpoints",
            {},
            AbortSignal.timeout(15000),
          );
          const v = JSON.parse(
            (await limitedBytes(r, 1024 * 1024)).toString("utf8"),
          );
          cloneModels.set(
            id,
            v.data?.endpoints?.some(
              (e: any) => e.supports_voice_cloning === true,
            ) === true,
          );
        }
        if (!cloneModels.get(id))
          throw new Error(
            "这个模型不支持宠物参考声音，已保留原语音设置。请选支持声音克隆的模型，或主动切换到「服务商音色」。",
          );
      };
      await cleanup();
      ctx.interval(async () => {
        await cleanup();
      }, 3600000);
      ctx.provide("voice.api", {
        get: () => structuredClone(config),
        readiness: () => voiceReadiness(config, !!key("live")),
        recommendations: () => structuredClone(liveRecommendations),
        key,
        async save(value) {
          const next = validateVoice(value);
          await supportsIdentity(next);
          await storage.write("voice-settings", next);
          config = next;
          await cleanup();
          ctx.emit("voice.settings", structuredClone(config));
          return structuredClone(config);
        },
        hasKeys: () =>
          Object.fromEntries(
            (["stt", "tts", "live"] as const).map((slot) => [
              slot,
              secrets.has(voiceScope(slot, config)),
            ]),
          ),
        async setKey(slot, value) {
          if (!["stt", "tts", "live"].includes(slot))
            throw new Error("语音密钥类型无效");
          await secrets.set(voiceScope(slot, config), value);
        },
        cleanup,
        async catalog(slot, draft): Promise<VoiceCatalog> {
          if (!["stt", "tts", "live"].includes(slot))
            throw new Error("语音类型无效");
          const catalogConfig = draft ? validateVoice(draft) : config,
            profile = catalogConfig[slot];
          if (slot === "tts" && profile.kind === "system")
            return ctx.use("voice.local").catalog?.() ?? {
              models: [{ id: "windows", name: "Windows 本地语音（无需 API）" }],
              voices: ctx.use("voice.local").voices(),
              voiceSource: "api",
              note: "本地语音不消耗 API；随包风格试听是离线生成的参考，非云端模型音色。",
            };
          const voices = presetVoices(
            profile.model,
            slot === "live",
            profile.kind === "gemini",
          );
          let models: VoiceChoice[] = [],
            detected: VoiceChoice[] = [],
            note = "可手动填写模型和音色 ID。";
          if (profile.kind !== "gemini") {
            const query =
              profile.kind === "openrouter"
                ? `?output_modalities=${slot === "tts" ? "speech" : "transcription"}`
                : "";
            const response = await request(
              profile.baseUrl + "/models" + query,
              { headers: auth(slot, catalogConfig) },
              AbortSignal.timeout(20000),
            );
            const data = JSON.parse(
              (await limitedBytes(response, 6 * 1024 * 1024)).toString("utf8"),
            );
            if (!Array.isArray(data.data))
              throw new Error("模型目录格式无效，仍可手动填写模型 ID");
            models = data.data
              .filter((m: any) => typeof m.id === "string")
              .slice(0, 5000)
              .map((m: any) => ({ id: m.id, name: m.name || m.id }));
            models.sort(
              (a, b) =>
                Number(!/qwen/i.test(a.id)) - Number(!/qwen/i.test(b.id)) ||
                a.id.localeCompare(b.id),
            );
            const selected = data.data.find((m: any) => m.id === profile.model);
            detected = parseVoices(
              selected?.voices ??
                selected?.audio?.voices ??
                selected?.supported_voices,
            );
            if (
              slot === "tts" &&
              !detected.length &&
              profile.kind !== "openrouter"
            ) {
              try {
                const result = await fetch(
                  profile.baseUrl +
                    "/audio/voices?model=" +
                    encodeURIComponent(profile.model),
                  {
                    headers: auth(slot, catalogConfig),
                    redirect: "error",
                    signal: AbortSignal.any([
                      ctx.abort.signal,
                      AbortSignal.timeout(6000),
                    ]),
                  },
                );
                if (result.ok) {
                  const v = JSON.parse(
                    (await limitedBytes(result, 1024 * 1024)).toString("utf8"),
                  );
                  detected = parseVoices(v.voices ?? v.data ?? v);
                } else await result.body?.cancel();
              } catch {
                /* 音色目录不是兼容协议的必需接口，回退到预设与手填。 */
              }
            }
          } else {
            const secret = secrets.get(voiceScope(slot, catalogConfig));
            const response = await request(
              profile.baseUrl + "/models",
              { headers: { "x-goog-api-key": secret } },
              AbortSignal.timeout(20000),
            );
            const body = JSON.parse(
              (await limitedBytes(response, 4 * 1024 * 1024)).toString("utf8"),
            );
            models = (body.models ?? [])
              .filter(
                (m: any) =>
                  /live|native.audio/i.test(m.name) ||
                  m.supportedGenerationMethods?.includes("bidiGenerateContent"),
              )
              .map((m: any) => ({
                id: m.name.replace(/^models\//, ""),
                name: m.displayName ?? m.name,
              }));
          }
          if (detected.length)
            note = "已读取服务返回的音色；选择模型后可重新探测。";
          else if (voices.length)
            note =
              "服务未提供音色目录，显示此协议/模型的内置预设，可手动覆盖。";
          else
            note =
              "此模型未返回音色目录，请按模型说明填写音色 ID；不会强塞 OpenAI 音色。";
          return {
            models,
            voices: detected.length ? detected : voices,
            voiceSource: detected.length
              ? "api"
              : voices.length
                ? "preset"
                : "custom",
            note,
          };
        },
        async transcribe(wav, signal) {
          const c = structuredClone(config.stt);
          if (!c.model) throw new Error("请先配置语音识别模型");
          if (wav.length > 24 * 1024 * 1024)
            throw new Error("录音过长，请分段输入");
          const form = new FormData();
          form.append("model", c.model);
          form.append(
            "file",
            new Blob([new Uint8Array(wav)], { type: "audio/wav" }),
            "speech.wav",
          );
          form.append("response_format", "json");
          // 仅发送显式设置；兼容接口不一定接受语言与词汇提示。
          if (c.language) form.append("language", c.language);
          if (c.prompt?.trim()) form.append("prompt", c.prompt.trim());
          const response = await request(
            c.baseUrl + "/audio/transcriptions",
            { method: "POST", headers: auth("stt"), body: form },
            signal,
          );
          const body = JSON.parse(
            (await limitedBytes(response, 256000)).toString("utf8"),
          );
          if (typeof body.text !== "string")
            throw new Error("语音识别未返回 text 字段");
          return body.text.trim().slice(0, 8000);
        },
        async speak(input, signal, preview, onPcm) {
          const c = structuredClone(config),
            streaming =
              !!onPcm && c.tts.stream !== false && c.tts.kind !== "system",
            tone = preview ? voiceStyle(preview.style) : style(),
            identity = voiceIdentity(
              c.identity === "persona" ? tone.id : c.identity,
            ),
            text = spokenText(input),
            voice = preview?.voice || currentVoice();
          await supportsIdentity(c);
          const reference = c.tts.reference
            ? await readFile(join(assetsDirectory, identity.id + ".wav"))
            : undefined;
          if (!text) throw new Error("没有可朗读的文字");
          if (text.length > 4096) throw new Error("单段语音过长，请分段朗读");
          signal.throwIfAborted();
          const local = c.tts.kind === "system" ? await ctx.use("voice.local").resolveVoice?.(voice) : undefined;
          signal.throwIfAborted();
          const id = audioKey([
              streaming ? "v3-pcm" : "v2",
              c.tts,
              c.identity,
              reference
                ? createHash("sha256").update(reference).digest("hex")
                : "",
              voice,
              c.followPersona ? tone.id : "custom",
              text,
              voiceScope("tts", c),
              ...(local ? [local.scope] : []),
            ]),
            hit = await cache.read(id, c.cacheDays);
          signal.throwIfAborted();
          if (hit) return hit;
          let data: Uint8Array,
            mimeType = "audio/wav";
          if (c.tts.kind === "system")
            data = await ctx
              .use("voice.local")
              .synthesize(
                text,
                c.followPersona ? tone.id : "direct",
                local?.voice ?? voice,
                c.tts.speed,
                signal,
              );
          else {
            if (!c.tts.model) throw new Error("请先配置语音合成模型");
            const body: Record<string, unknown> = {
              model: c.tts.model,
              input: text,
              response_format: streaming ? "pcm" : "mp3",
              speed: c.tts.speed,
            };
            if (c.tts.reference) {
              body.input_references = [
                {
                  type: "input_audio",
                  input_audio: {
                    data:
                      "data:audio/wav;base64," + reference!.toString("base64"),
                  },
                },
                {
                  type: "text",
                  text: identity.text,
                },
              ];
            } else {
              if (!voice.trim())
                throw new Error(
                  "请填写当前模型的音色 ID，或选择该模型支持的参考音频模式",
                );
              body.voice = voice;
            }
            if (
              c.followPersona &&
              /(?:^|\/)gpt-4o-mini-tts/.test(c.tts.model)
            ) {
              if (c.tts.kind === "openrouter")
                body.provider = {
                  options: { openai: { instructions: tone.tone } },
                };
              else body.instructions = tone.tone;
            }
            const response = await request(
              c.tts.baseUrl + "/audio/speech",
              {
                method: "POST",
                headers: { ...auth("tts"), "Content-Type": "application/json" },
                body: JSON.stringify(body),
              },
              signal,
            );
            mimeType =
              response.headers.get("content-type")?.split(";")[0] ??
              "audio/mpeg";
            if (
              !/^audio\//.test(mimeType) &&
              mimeType !== "application/octet-stream"
            )
              throw new Error("语音服务未返回音频");
            if (mimeType === "application/octet-stream")
              mimeType = "audio/mpeg";
            if (streaming && /^audio\/(?:x-)?pcm$/.test(mimeType)) {
              data = await readPcm(response, signal, onPcm!);
              mimeType = "audio/wav";
            } else data = await limitedBytes(response);
          }
          signal.throwIfAborted();
          if (!data.length) throw new Error("语音为空");
          await cache.write(id, data, mimeType, c.cacheDays);
          await cleanup();
          return {
            id,
            data: Buffer.from(data).toString("base64"),
            mimeType,
            cached: false,
          };
        },
      });
    },
  });
}
export function parseVoices(value: any): VoiceChoice[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 500)
    .map((v) =>
      typeof v === "string"
        ? { id: v, name: v }
        : {
            id: v?.id ?? v?.voice_id ?? v?.name,
            name: v?.name ?? v?.id ?? v?.voice_id,
          },
    )
    .filter(
      (v) =>
        typeof v.id === "string" &&
        v.id.length <= 200 &&
        typeof v.name === "string",
    );
}
