import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { VoiceCatalog } from "../../packages/contracts/voice.ts";
import type { AndroidNative } from "./index.ts";

/** 拼接引擎生成的 PCM WAV，不把每段 RIFF 头混入音频数据。 */
export function joinLocalWav(clips: Uint8Array[]): Uint8Array {
  let format: Buffer | undefined; const data: Buffer[] = [];
  for (const clip of clips) {
    const b = Buffer.from(clip); let fmt: Buffer | undefined, pcm: Buffer | undefined;
    if (b.length < 44 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE" || b.readUInt32LE(4) + 8 !== b.length) throw Error("UNAVAILABLE");
    for (let i = 12; i + 8 <= b.length;) {
      const n = b.readUInt32LE(i + 4), end = i + 8 + n; if (end > b.length) throw Error("UNAVAILABLE");
      const tag = b.toString("ascii", i, i + 4);
      if (tag === "fmt ") fmt = b.subarray(i + 8, end);
      if (tag === "data") pcm = b.subarray(i + 8, end);
      i = end + n % 2;
    }
    if (!fmt || fmt.length < 16 || !pcm?.length || ![1, 3].includes(fmt.readUInt16LE(0)) || ![1, 2].includes(fmt.readUInt16LE(2)) || fmt.readUInt32LE(4) < 8000 || fmt.readUInt32LE(4) > 192000 || ![8, 16, 32].includes(fmt.readUInt16LE(14))) throw Error("UNAVAILABLE");
    if (format && !format.equals(fmt)) throw Error("UNAVAILABLE"); format = fmt; data.push(pcm);
  }
  if (!format) throw Error("UNAVAILABLE");
  const pcm = Buffer.concat(data); if (pcm.length > 24 * 1024 * 1024) throw Error("UNAVAILABLE");
  const header = Buffer.alloc(20); header.write("RIFF"); header.write("WAVEfmt ", 8); header.writeUInt32LE(format.length, 16);
  const tag = Buffer.alloc(8); tag.write("data"); tag.writeUInt32LE(pcm.length, 4);
  const result = Buffer.concat([header, format, Buffer.alloc(format.length % 2), tag, pcm, Buffer.alloc(pcm.length % 2)]); result.writeUInt32LE(result.length - 8, 4); return result;
}

export async function androidLocalVoice(root: string, native: AndroidNative) {
  const directory = join(root, "tts-inbox"); await mkdir(directory, { recursive: true });
  for (const name of await readdir(directory)) if (/^[a-f0-9-]{36}\.wav$/.test(name)) await rm(join(directory, name), { force: true });
  let choices: VoiceCatalog["voices"] = [], active = false;
  const catalog = async () => {
    const c = await native.call<VoiceCatalog>("tts.catalog");
    if (!c || !Array.isArray(c.voices) || c.voices.length > 500 || !c.voices.every(v => /^android:[a-f0-9]{64}$/.test(v.id) && typeof v.name === "string" && v.name.length <= 300) || !Array.isArray(c.models) || c.models.length > 1 || !c.models.every(m => m.id === "android" && typeof m.name === "string" && m.name.length <= 200) || typeof c.note !== "string" || c.note.length > 1000) throw Error("UNAVAILABLE");
    choices = c.voices.map(({ id, name }) => ({ id, name }));
    return { models: c.models.map(({ id, name }) => ({ id, name })), voices: choices, voiceSource: "api" as const, note: c.note };
  };
  const resolveVoice = async (voice: string) => {
    const scope = await native.call<string>("tts.scope", { voice });
    if (!/^android:[a-f0-9]{64}$/.test(scope)) throw Error("UNAVAILABLE");
    return { voice: scope, scope };
  };
  return {
    voices: () => structuredClone(choices), catalog, resolveVoice,
    async synthesize(text: string, _style: string, voice: string, speed: number, signal: AbortSignal): Promise<Uint8Array> {
      signal.throwIfAborted(); if (active) throw Error("BUSY");
      if (!text.trim() || text.length > 4096 || !Number.isFinite(speed) || speed < 0.5 || speed > 2) throw Error("INVALID_INPUT");
      active = true;
      try {
        const resolved = await resolveVoice(voice); signal.throwIfAborted();
        // Android 上限为 4000 UTF-16 单元；共享核心允许 4096，不截断末尾或拆开代理对。
        const chunks: string[] = []; let part = "";
        for (const point of text) { if (part.length + point.length > 4000) { chunks.push(part); part = ""; } part += point; } if (part) chunks.push(part);
        const clips: Uint8Array[] = [];
        for (const chunk of chunks) {
          signal.throwIfAborted(); const operationId = randomUUID(), file = join(directory, `${operationId}.wav`);
          const cancel = () => { void native.call("tts.cancel", { operationId }).catch(() => {}); };
          signal.addEventListener("abort", cancel, { once: true });
          try {
            signal.throwIfAborted(); await native.call("tts.start", { operationId, text: chunk, voice: resolved.voice, speed });
            const until = Date.now() + 45000;
            while (true) {
              signal.throwIfAborted(); if (Date.now() >= until) throw Error("UNAVAILABLE");
              const state = await native.call<{ state: string }>("tts.poll", { operationId }); signal.throwIfAborted();
              if (state.state === "ready") break;
              if (state.state !== "pending") throw Error(state.state === "cancelled" ? "CANCELLED" : "UNAVAILABLE");
              await delay(60, undefined, { signal });
            }
            const info = await stat(file); if (!info.isFile() || info.size > 24 * 1024 * 1024) throw Error("UNAVAILABLE");
            clips.push(await readFile(file)); signal.throwIfAborted();
          } finally { signal.removeEventListener("abort", cancel); await native.call("tts.cancel", { operationId }).catch(() => {}); await rm(file, { force: true }); }
        }
        return joinLocalWav(clips);
      } finally { active = false; }
    },
  };
}
