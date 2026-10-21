import { mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { definePlugin, type Surface } from "../../packages/contracts/index.ts";
import type { AndroidNative } from "./index.ts";
import { androidPetSurface } from "./pet-surface.ts";
import { androidLocalVoice } from "./local-voice.ts";
import { androidWake } from "./wake.ts";

/** 共享 voice.session 的音频宿主适配；不另建识别、会话或朗读编排。 */
export function androidAudio(root: string, native: AndroidNative) {
  return definePlugin({
    manifest: { manifestVersion: 1, id: "familiar.audio-android", version: "0.3.0", provides: ["platform.surface", "voice.local", "voice.wake", "android.wake"], requires: ["commands"], permissions: ["storage.app", "device.microphone"] },
    async start(ctx) {
      ctx.require("storage.app"); ctx.require("device.microphone");
      const outbox = join(root, "voice-outbox"); await mkdir(outbox, { recursive: true });
      for (const name of await readdir(outbox)) if (/^[a-f0-9-]{36}\.audio$/.test(name)) await rm(join(outbox, name), { force: true });
      let queue = Promise.resolve(), queuedBytes = 0, epoch = 0, playback = 0, sequence = 0;
      const fail = (version: number) => ctx.use("commands").call("voice.host", { type: "error", epoch: version, message: "Android 音频未能继续，请检查权限或重新开始。" }).catch(() => {});
      const send = (payload: unknown) => {
        const p = payload as Record<string, any>;
        if (!p || !Number.isSafeInteger(p.epoch) || !Number.isSafeInteger(p.playback)) return;
        epoch = p.epoch; playback = p.playback;
        const bytes = typeof p.data === "string" ? p.data.length : 0;
        if (bytes > 28 * 1024 * 1024 || queuedBytes + bytes > 32 * 1024 * 1024) { void fail(p.epoch); return; }
        queuedBytes += bytes;
        const command: Record<string, any> = { ...p, sequence: ++sequence };
        queue = queue.then(async () => {
          let file: string | undefined;
          try {
            if (p.epoch !== epoch || (["pcm", "play", "audio-end"].includes(p.type) && p.playback !== playback)) return;
            if (p.type === "play") {
              const token = randomUUID(); file = join(outbox, `${token}.audio`);
              await writeFile(file, Buffer.from(p.data, "base64"), { mode: 0o600 });
              delete command.data; command.token = token;
            }
            if (!ctx.active) return;
            await native.call("audio.command", command);
            // 原生在确认接收后拥有文件生命周期，包括停止/错误时的清理。
            file = undefined;
          } finally { queuedBytes -= bytes; if (file) await rm(file, { force: true }); }
        }).catch(() => { void fail(p.epoch); });
      };
      const unsupported = () => { throw Error("Android 尚未提供该桌面表面"); };
      const pet = androidPetSurface(native, action => ctx.emit("pet.interaction", action));
      const surface: Surface = {
        async create(kind) { if (kind !== "voice") await pet.create(kind); },
        send(kind, channel, payload) {
          pet.send(kind, channel, payload);
          if (kind === "voice" && channel === "familiar:voice-host") send(payload);
          if (kind === "composer" && channel === "familiar:voice-state") {
            const state = payload as { active: boolean; phase: string };
            if (state.phase === "error" && wake.control.status().armed) void wake.control.disarm().catch(() => {});
            const version = epoch;
            queue = queue.then(() => native.call("audio.state", { active: state.active, phase: state.phase, epoch: version })).then(() => {}).catch(() => { void fail(version); });
          }
        },
        close(kind) { if (kind === "voice") void native.call("audio.shutdown").catch(() => {}); else pet.close(kind); },
        show: pet.show, configurePet: pet.configurePet, resizeSpeech: pet.resizeSpeech, resetPosition: pet.resetPosition,
        interaction: pet.interaction, openController: pet.openController, quit: unsupported, metrics: () => ({}),
      };
      ctx.provide("platform.surface", surface);
      ctx.provide("voice.local", await androidLocalVoice(root, native));
      const wake = androidWake(ctx, root, (method, params) => {
        const payload = { ...params, epoch };
        const result = queue.then(() => native.call(method, payload)); queue = result.then(() => {}).catch(() => {}); return result;
      });
      ctx.provide("voice.wake", wake.service); ctx.provide("android.wake", wake.control);
      ctx.effect(async () => { await native.call("audio.shutdown").catch(() => {}); });
      ctx.effect(async () => { await native.call("tts.shutdown").catch(() => {}); });
      ctx.effect(() => pet.dispose());
    },
  });
}
