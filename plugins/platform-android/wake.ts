import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pinyin } from "pinyin-pro";
import type { Context, Services } from "../../packages/kernel/index.ts";
import type { PcmChunk, WakeStatus } from "../../packages/contracts/voice.ts";
import { pcmLevel } from "../voice-session/audio.ts";

export interface AndroidKeyword { text: string; tokens: string[] }
export type AndroidWakeStatus = WakeStatus & { armed: boolean };
declare module "../../packages/kernel/index.ts" {
  interface Services {
    "android.wake": {
      status(): AndroidWakeStatus;
      validate(phrases: string[]): Promise<AndroidKeyword[]>;
      arm(foregroundAt: number): Promise<void>;
      disarm(): Promise<void>;
      host(event: unknown): void;
    };
  }
}

/** 与上游 phone+ppinyin 相同：保留声调，按非 strict 声母拆分；英文查固定词典。 */
export function keywordEncoder(tokensText: string, lexiconText: string) {
  const vocabulary = new Set(tokensText.trim().split(/\r?\n/).map(line => line.split(/\s+/)[0]).filter(token => !token.startsWith("<")));
  const lexicon = new Map(lexiconText.trim().split(/\r?\n/).map(line => { const [word, ...phones] = line.trim().split(/\s+/); return [word.toUpperCase(), phones] as const; }));
  return (phrases: string[]): AndroidKeyword[] => {
    if (!Array.isArray(phrases) || phrases.length < 1 || phrases.length > 8) throw Error("INVALID_INPUT");
    const names = phrases.map(value => typeof value === "string" ? value.trim() : "");
    if (new Set(names).size !== names.length || names.some(value => !value || value.length > 40 || !/^[\u4e00-\u9fffA-Za-z' ]+$/.test(value))) throw Error("INVALID_INPUT");
    return names.map(text => {
      const tokens: string[] = [];
      for (const part of text.match(/[\u4e00-\u9fff]+|[A-Za-z']+/g) ?? []) {
        if (/^[\u4e00-\u9fff]+$/.test(part)) {
          for (const syllable of pinyin(part, { type: "array", toneType: "symbol", toneSandhi: false })) {
            const initial = syllable.match(/^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])/u)?.[0];
            if (initial) tokens.push(initial);
            tokens.push(syllable.slice(initial?.length ?? 0));
          }
        } else { const phones = lexicon.get(part.toUpperCase()); if (!phones) throw Error("INVALID_INPUT"); tokens.push(...phones); }
      }
      if (!tokens.length || tokens.length > 120 || tokens.some(token => !vocabulary.has(token))) throw Error("INVALID_INPUT");
      return { text, tokens };
    });
  };
}

/** 原生检测命中前只保留两秒内存；命中后最多交接八秒，超长不提交截断的指令。 */
export class WakeCapture {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private hit?: string;
  private silence = 0;
  private after = 0;
  push(data: Uint8Array, hit?: string): { text: string; audio: PcmChunk } | undefined {
    this.chunks.push(data); this.bytes += data.length;
    if (!this.hit && hit) this.hit = hit;
    if (!this.hit) { while (this.bytes > 96000) this.bytes -= this.chunks.shift()!.length; return; }
    this.after += data.length;
    this.silence = pcmLevel(data) < 0.015 ? this.silence + data.length : 0;
    if (this.bytes > 8 * 48000) throw Error("WAKE_TOO_LONG");
    if (this.after >= 12000 && this.silence >= 33600) return { text: this.hit, audio: { rate: 24000, data: Buffer.concat(this.chunks) } };
  }
}

export function androidWake(ctx: Context, root: string, send: (method: string, params?: Record<string, unknown>) => Promise<unknown>) {
  let session: string | undefined, operation: string | undefined, version = 0;
  let pending: { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;
  let callback: ((text: string, audio?: PcmChunk) => void) | undefined;
  let capture = new WakeCapture();
  let status: AndroidWakeStatus = { available: true, armed: false, listening: false, message: "唤醒待机未开启" };
  let encoder: Promise<ReturnType<typeof keywordEncoder>> | undefined;
  const validate = async (phrases: string[]) => {
    encoder ??= Promise.all([readFile(join(root, "engine/wake/tokens.txt"), "utf8"), readFile(join(root, "engine/wake/en.phone"), "utf8")]).then(([tokens, lexicon]) => keywordEncoder(tokens, lexicon));
    return (await encoder)(phrases);
  };
  const stop = () => {
    version++;
    const old = operation; operation = undefined; callback = undefined; capture = new WakeCapture();
    if (pending) { clearTimeout(pending.timer); pending.reject(Error("CANCELLED")); pending = undefined; }
    status = { ...status, listening: false };
    if (old) void send("wake.stop", { operationId: old }).catch(() => {});
  };
  const disarm = async () => {
    const old = session; session = undefined; stop();
    status = { ...status, armed: false, listening: false, message: "唤醒待机已停止" };
    if (old) await send("wake.disable", { sessionId: old });
  };
  const failed = (message: string) => {
    void disarm().catch(() => {});
    status.message = message;
    ctx.emit("voice.wake-error", message);
  };
  const service: Services["voice.wake"] = {
    status: () => ({ ...status }), stop,
    async listen(phrases, onWake, sensitivity = 50) {
      if (!session || !ctx.active) throw Error("请在前台点击开启唤醒待机");
      stop(); const current = ++version, lease = session;
      const keywords = await validate(phrases);
      if (version !== current || session !== lease) throw Error("CANCELLED");
      const id = randomUUID(); operation = id; callback = onWake; capture = new WakeCapture();
      status.message = "正在开启离线唤醒…";
      await new Promise<void>((resolve, reject) => {
        pending = { resolve, reject, timer: setTimeout(() => { if (operation === id) failed("唤醒启动超时，请重新开启"); }, 15000) };
        void send("wake.listen", { sessionId: lease, operationId: id, keywords, threshold: .6 - Math.max(0, Math.min(100, sensitivity)) * .005 }).catch(() => { if (operation === id) failed("唤醒未能启动，请检查麦克风权限后重试"); });
      });
    },
  };
  const control: Services["android.wake"] = {
    status: () => ({ ...status }), validate, disarm,
    async arm(foregroundAt) {
      if (session) throw Error("BUSY");
      const id = randomUUID(); session = id;
      status = { ...status, armed: true, message: "正在开启离线唤醒…" };
      try { await send("wake.enable", { sessionId: id, foregroundAt }); if (session !== id) throw Error("CANCELLED"); }
      catch (error) { if (session === id) await disarm().catch(() => {}); throw error; }
    },
    host(value) {
      const event = value as Record<string, any>;
      if (!event || event.sessionId !== session || !session) return;
      if (event.type === "error") { failed("唤醒已停止，请检查权限或音频占用后重新开启"); return; }
      if (!operation || event.operationId !== operation) return;
      if (event.type === "ready") {
        status = { ...status, listening: true, message: "离线唤醒待机中" };
        if (pending) { clearTimeout(pending.timer); pending.resolve(); pending = undefined; }
      } else if (event.type === "pcm" && status.listening && typeof event.data === "string" && event.data.length <= 16000 && /^[A-Za-z0-9+/]*={0,2}$/.test(event.data)) {
        const data = Buffer.from(event.data, "base64"); if (!data.length || data.length % 2 || data.length > 12000) return;
        status.lastAudioAt = Date.now(); status.level = pcmLevel(data);
        const hit = typeof event.hit === "string" && event.hit.length <= 80 ? event.hit : undefined;
        if (hit) { status.lastResult = hit; status.message = "听到唤醒词，正在接收这句话…"; }
        try {
          const result = capture.push(data, hit);
          if (result) { const notify = callback; stop(); notify?.(result.text, result.audio); }
        } catch { failed("这句话超过唤醒片段长度，请先呼唤名字，再说指令"); }
      }
    },
  };
  ctx.effect(() => disarm().catch(() => {}));
  return { service, control };
}
