import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  definePlugin,
  type ChatState,
  type VoiceState,
  type PcmChunk,
} from "../../packages/contracts/index.ts";
import {
  voicePersonas,
  voiceStyle,
  speechChunks,
} from "../voice-api/config.ts";
import { pcmWav, UtteranceDetector } from "./audio.ts";
import { liveConnection } from "./live.ts";
import { SpeechQueue, SpeechTextBuffer } from "./text-stream.ts";
import { StreamedSpeech } from "./streamed-speech.ts";
import { wakeCommand, wakePcm } from "./wake-handoff.ts";
export const voiceCommands = [
  "voice.get",
  "voice.save",
  "voice.key",
  "voice.catalog",
  "voice.start",
  "voice.stop",
  "voice.dictate",
  "voice.finish",
  "voice.state",
  "voice.read",
  "voice.autoread",
  "voice.preview",
  "voice.test",
  "voice.cache",
  "voice.dictation",
  "voice.wake-test",
  "voice.sample",
  "voice.verify",
];
export function voiceSession(samples: string) {
  return definePlugin({
    manifest: {
      manifestVersion: 1,
      id: "familiar.voice-session",
      version: "0.3.0",
      provides: ["voice.session"],
      requires: [
        "voice.api",
        "voice.wake",
        "settings",
        "character.catalog",
        "platform.surface",
        "conversation",
        "commands",
      ],
      permissions: ["device.microphone", "network.voice"],
    },
    async start(ctx) {
      const api = ctx.use("voice.api"),
        wake = ctx.use("voice.wake"),
        surface = ctx.use("platform.surface"),
        chat = ctx.use("conversation");
      let wakeRevision = 0;
      const stopWake = () => {
        wakeRevision++;
        waking = false;
        wake.stop();
      };
      let epoch = 0,
        playback = 0,
        sessionAbort = new AbortController(),
        turnAbort = new AbortController(),
        timer: ReturnType<typeof setTimeout> | undefined;
      let live: ReturnType<typeof liveConnection> | undefined,
        chunks: Uint8Array[] = [],
        dictationBytes = 0,
        detector = new UtteranceDetector(api.get().silenceMs),
        onset = 0;
      let lastRead = "",
        waking = false,
        ready = false,
        dictationResult:
          | { id: string; text: string; target: string }
          | undefined,
        dictationTarget = "composer";
      let autoStream:
        | {
            id: string;
            buffer: SpeechTextBuffer;
            queue: SpeechQueue<StreamedSpeech>;
            signal: AbortSignal;
          }
        | undefined;
      let state: VoiceState = {
        phase: "off",
        active: false,
        dictating: false,
        autoRead: api.get().autoRead,
        mode: api.get().mode,
        message: "语音未开启",
      };
      const playWaiters = new Map<
        string,
        { resolve(): void; reject(error: Error): void }
      >();
      const publish = () => {
        state.autoRead = api.get().autoRead;
        state.mode = api.get().mode;
        state.wakeAvailable = wake.status().available;
        for (const kind of ["composer", "speech", "pet"])
          surface.send(kind, "familiar:voice-state", structuredClone(state));
      };
      const update = (
        phase: VoiceState["phase"],
        message: string,
        error?: string,
      ) => {
        state = { ...state, phase, message, error };
        publish();
      };
      const host = (value: Record<string, unknown>) =>
        surface.send("voice", "familiar:voice-host", {
          ...value,
          epoch,
          playback,
        });
      const disarm = () => {
        clearTimeout(timer);
        timer = undefined;
        delete state.idleUntil;
      };
      const armIdle = () => {
        disarm();
        if (
          !state.active ||
          api.get().continuous !== false ||
          state.dictating ||
          !["listening"].includes(state.phase)
        )
          return;
        state.idleUntil = Date.now() + api.get().idleSeconds * 1000;
        publish();
        timer = setTimeout(() => {
          void stop().catch(report);
        }, api.get().idleSeconds * 1000);
      };
      const clearPlayback = () => {
        playback++;
        host({ type: "clear" });
        for (const p of playWaiters.values()) p.reject(new Error("播放已停止"));
        playWaiters.clear();
      };
      const style = () => {
        const c = ctx.use("settings").get();
        return voiceStyle(
          c.persona.style === "character"
            ? ctx.use("character.catalog").get(c.pet.character)
                .recommendedPersona
            : c.persona.style,
        );
      };
      const phrases = () =>
        api.get().wakePhrases.length
          ? api.get().wakePhrases
          : [ctx.use("settings").get().persona.name];
      const armWake = async () => {
        if (
          !ctx.active ||
          !ready ||
          state.active ||
          state.phase === "speaking" ||
          waking ||
          !api.get().enabled ||
          !api.get().wakeEnabled
        )
          return;
        waking = true;
        const version = epoch;
        const revision = ++wakeRevision;
        try {
          const readiness = api.readiness();
          if (!readiness.configured) {
            update("off", "语音配置尚未完成", readiness.problems.join("；"));
            return;
          }
          await wake.listen(
            phrases(),
            (text, audio) => {
              if (
                state.active ||
                version !== epoch ||
                revision !== wakeRevision
              )
                return;
              void start(false, text, audio).catch(report);
            },
            api.get().wakeSensitivity,
          );
          if (version === epoch && revision === wakeRevision && !state.active)
            update("sleeping", "等待唤醒：" + phrases()[0]);
        } catch (e) {
          if (version === epoch && revision === wakeRevision && !state.active)
            update(
              "off",
              "可点击开始语音",
              e instanceof Error ? e.message : "唤醒不可用",
            );
        } finally {
          if (version === epoch && revision === wakeRevision) waking = false;
        }
      };
      const stop = async (rearm = true) => {
        epoch++;
        waking = false;
        disarm();
        stopWake();
        live?.stop();
        live = undefined;
        sessionAbort.abort();
        turnAbort.abort();
        clearPlayback();
        host({ type: "stop" });
        chunks = [];
        dictationBytes = 0;
        detector.reset();
        state.active = false;
        state.dictating = false;
        update("off", api.get().enabled ? "语音已结束" : "语音未开启");
        // 只取消本模块提交的当前轮次，不影响用户从文字入口发起的请求。
        if (
          chat.state().busy &&
          chat.state().messages.at(-1)?.origin === "voice"
        )
          await chat.cancel();
        if (ctx.active && rearm) void armWake();
      };
      const report = (e: unknown) => {
        if (!ctx.active) return;
        const message = e instanceof Error ? e.message : String(e);
        void stop(false).then(() => {
          if (ctx.active) update("error", "语音暂时停止，可重新开始", message);
        });
      };
      const interrupt = () => {
        disarm();
        turnAbort.abort();
        clearPlayback();
        if (
          chat.state().busy &&
          chat.state().messages.at(-1)?.origin === "voice"
        )
          void chat.cancel();
        if (state.active) update("recording", "听你说，可以直接打断我");
      };
      const waitPlayback = (signal: AbortSignal, send: (id: string) => void) =>
        new Promise<void>((resolve, reject) => {
          signal.throwIfAborted();
          const id = randomUUID();
          const timeout = setTimeout(
            () => finish(new Error("音频播放超时")),
            180000,
          );
          const finish = (e?: Error) => {
            clearTimeout(timeout);
            signal.removeEventListener("abort", cancel);
            playWaiters.delete(id);
            e ? reject(e) : resolve();
          };
          const cancel = () => {
            host({ type: "clear" });
            finish(new Error("播放已取消"));
          };
          playWaiters.set(id, {
            resolve: () => finish(),
            reject: (e) => finish(e),
          });
          signal.addEventListener("abort", cancel, { once: true });
          send(id);
        });
      const play = (
        clip: { data: string; mimeType: string },
        signal: AbortSignal,
      ) => waitPlayback(signal, (id) => host({ type: "play", id, ...clip }));
      const queueFor = (signal: AbortSignal) =>
        new SpeechQueue(
          async (part: string) =>
            new StreamedSpeech(
              (onPcm) => api.speak(part, signal, undefined, onPcm),
              signal,
            ),
          async (stream: StreamedSpeech) => {
            let sent = false;
            for await (const part of stream) {
              signal.throwIfAborted();
              update(
                "speaking",
                state.active ? "正在说话，可以直接打断" : "正在朗读（可停止）",
              );
              if ("pcm" in part) {
                sent = true;
                host({
                  type: "pcm",
                  data: Buffer.from(part.pcm.data).toString("base64"),
                  rate: part.pcm.rate,
                });
              } else await play(part.clip, signal);
            }
            signal.throwIfAborted();
            if (sent)
              await waitPlayback(signal, (id) =>
                host({ type: "audio-end", id }),
              );
          },
          signal,
        );
      const speak = async (text: string) => {
        stopWake();
        disarm();
        turnAbort.abort();
        turnAbort = new AbortController();
        const version = epoch,
          signal = AbortSignal.any([turnAbort.signal, ctx.abort.signal]);
        try {
          update("speaking", "正在朗读（可停止）");
          const queue = queueFor(signal);
          queue.add(speechChunks(text));
          await queue.done();
          if (version === epoch) {
            if (state.active) {
              update("listening", "我在听，继续说就好");
              armIdle();
            } else {
              update("off", "朗读结束");
              void armWake();
            }
          }
        } catch (e) {
          if (!signal.aborted && version === epoch) throw e;
        }
      };
      const ask = async (
        text: string,
        parentSignal: AbortSignal,
      ): Promise<string> => {
        if (!text.trim()) {
          update("listening", "没有听清，再说一次吧");
          armIdle();
          return "";
        }
        disarm();
        turnAbort.abort();
        turnAbort = new AbortController();
        const version = epoch,
          signal = AbortSignal.any([
            parentSignal,
            turnAbort.signal,
            ctx.abort.signal,
          ]);
        update("thinking", "正在听懂并回复…");
        if (chat.state().busy) {
          if (chat.state().messages.at(-1)?.origin === "voice")
            await chat.cancel();
          else
            throw new Error("主模型正在处理文字消息，请完成或停止后再开始语音");
        }
        signal.throwIfAborted();
        await chat.send({ text, origin: "voice" });
        const id = chat.state().messages.at(-1)?.id;
        const buffer = new SpeechTextBuffer();
        const queue = state.mode === "chained" ? queueFor(signal) : undefined;
        while (chat.state().busy) {
          signal.throwIfAborted();
          const current = chat.state().messages.at(-1);
          if (current && current.id === id)
            queue?.add(buffer.take(current.text));
          await new Promise((r) => setTimeout(r, 30));
        }
        signal.throwIfAborted();
        const result = chat.state(),
          answer = result.messages.at(-1);
        if (
          !answer ||
          answer.id !== id ||
          answer.status !== "complete" ||
          result.error
        )
          throw new Error(result.error || "语音回复已停止");
        queue?.add(buffer.take(answer.text, true));
        await queue?.done();
        if (version === epoch && state.mode === "chained") {
          update("listening", "我在听，继续说就好");
          armIdle();
        }
        return answer.text;
      };
      const transcribe = async (
        pcm: Uint8Array,
        dictation: boolean,
        fromWake = false,
      ) => {
        const version = epoch;
        turnAbort.abort();
        turnAbort = new AbortController();
        const signal = AbortSignal.any([
          turnAbort.signal,
          sessionAbort.signal,
          ctx.abort.signal,
        ]);
        let operationSignal: AbortSignal = signal;
        disarm();
        update("thinking", "正在转成文字…");
        try {
          const recognized = await api.transcribe(pcmWav(pcm), signal);
          const text = fromWake
            ? wakeCommand(recognized, phrases())
            : recognized;
          if (version !== epoch || signal.aborted) return;
          if (dictation) {
            dictationResult = {
              id: randomUUID(),
              text,
              target: dictationTarget,
            };
            surface.send("composer", "familiar:dictation", dictationResult);
            await stop();
            if (!text) update("off", "没有识别到文字，可以重新录音");
          } else {
            if (fromWake && !text) {
              update("listening", "我在听，继续说就好");
              armIdle();
              return;
            }
            const answer = ask(text, sessionAbort.signal);
            operationSignal = turnAbort.signal;
            await answer;
          }
        } catch (e) {
          if (!operationSignal.aborted && version === epoch) report(e);
        }
      };
      const start = async (
        dictation = false,
        wakeText?: string,
        wakeAudio?: PcmChunk,
      ) => {
        if (!dictation) {
          const readiness = api.readiness();
          if (!readiness.configured)
            throw new Error(readiness.problems.join("；"));
        }
        ctx.require("device.microphone");
        if (!ready) throw new Error("语音界面正在准备，请稍后再试");
        epoch++;
        const version = epoch;
        const handoff = wakeAudio ? wakePcm(wakeAudio) : undefined;
        stopWake();
        waking = false;
        disarm();
        live?.stop();
        live = undefined;
        sessionAbort.abort();
        turnAbort.abort();
        clearPlayback();
        host({ type: "stop" });
        sessionAbort = new AbortController();
        turnAbort = new AbortController();
        chunks = [];
        dictationBytes = 0;
        detector = new UtteranceDetector(api.get().silenceMs);
        onset = 0;
        state = {
          ...state,
          active: true,
          dictating: dictation,
          mode: api.get().mode,
          error: undefined,
        };
        update("connecting", "正在打开麦克风…");
        if (wakeText) ctx.emit("pet.speech", "在呢，正在听你说。");
        if (!dictation && api.get().mode === "realtime") {
          ctx.require("network.voice");
          const c = api.get();
          live = liveConnection(
            c.live,
            api.key("live"),
            ctx.use("settings").get().persona.name,
            c.followPersona ? style().tone : "",
            {
              ready: () => {
                if (version === epoch) {
                  host({ type: "listen" });
                  update("listening", "实时语音已连接，我在听");
                  armIdle();
                  if (handoff) {
                    // 已识别片段先于新麦克风数据送达；只有名字时不发起一轮回答。
                    live?.sendAudio(Buffer.from(handoff).toString("base64"));
                    live?.sendAudio(Buffer.alloc(24000).toString("base64"));
                  }
                }
              },
              speech: () => {
                if (version === epoch) interrupt();
              },
              audio: (data, rate) => {
                if (version === epoch) {
                  disarm();
                  update("speaking", "正在说话，可以直接打断");
                  host({ type: "pcm", data, rate });
                }
              },
              done: () => {
                if (version === epoch) host({ type: "audio-end" });
              },
              error: (message) => {
                if (version === epoch) report(new Error(message));
              },
              ask: (text, signal) => ask(text, signal),
            },
            sessionAbort.signal,
          );
        } else {
          host({ type: "listen" });
          if (handoff) void transcribe(handoff, false, true);
        }
      };
      const finishDictation = async () => {
        if (!state.dictating) return;
        state.dictating = false;
        host({ type: "mic-stop" });
        const pcm = Buffer.concat(chunks);
        chunks = [];
        dictationBytes = 0;
        if (pcm.length < 4800) {
          await stop();
          throw new Error("录音太短，请重新说一句话");
        }
        await transcribe(pcm, true);
      };
      const routes: Record<string, (p: any) => any> = {
        "voice.get": () => ({
          settings: api.get(),
          state: { ...state },
          keys: api.hasKeys(),
          readiness: api.readiness(),
          recommendations: api.recommendations(),
          wake: wake.status(),
          personas: voicePersonas.map((v) => ({
            id: v.id,
            name: v.name,
            text: v.text,
            tone: v.tone,
          })),
          style: style().id,
        }),
        "voice.state": () => ({
          ...state,
          wake: wake.status(),
          readiness: api.readiness(),
        }),
        "voice.save": async (p) => {
          const next = await api.save(p);
          await stop();
          return next;
        },
        "voice.key": async (p) => {
          await api.setKey(p.slot, p.key);
          if (!state.active) await stop();
        },
        "voice.catalog": (p) => api.catalog(p.slot, p.settings),
        "voice.start": () => start(false),
        "voice.stop": () => stop(),
        "voice.dictate": (p) => {
          dictationTarget = p?.target === "history" ? "history" : "composer";
          return start(true);
        },
        "voice.finish": () => {
          void finishDictation().catch(report);
          return true;
        },
        "voice.dictation": () => dictationResult,
        "voice.read": (p) => {
          if (
            typeof p?.text !== "string" ||
            !p.text.trim() ||
            p.text.length > 256000
          )
            throw new Error("朗读文字无效");
          void speak(p.text).catch(report);
          return true;
        },
        "voice.autoread": (p) => {
          if (typeof p !== "boolean") throw new Error("朗读开关无效");
          return api.save({ ...api.get(), autoRead: p });
        },
        "voice.test": () => {
          void speak("你好呀，我在这里。今天想一起做点什么呢？").catch(report);
          return true;
        },
        "voice.sample": async (p) => {
          const persona = voicePersonas.find((v) => v.id === p?.id);
          if (!persona || typeof p.voice !== "string" || p.voice.length > 200)
            throw new Error("试听参数无效");
          const started = Date.now();
          let firstChunkMs: number | undefined,
            chunkCount = 0,
            sampleRate: number | undefined;
          const clip = await api.speak(
            persona.text,
            ctx.abort.signal,
            {
              style: persona.id,
              voice: p.voice,
            },
            p.stream === true
              ? (chunk) => {
                  firstChunkMs ??= Date.now() - started;
                  chunkCount++;
                  sampleRate = chunk.rate;
                }
              : undefined,
          );
          if (clip.data.length > 1400000)
            throw new Error("试听音频过大，请改用普通朗读");
          return {
            ...clip,
            ...(p.stream === true
              ? {
                  streaming: {
                    firstChunkMs,
                    totalMs: Date.now() - started,
                    chunkCount,
                    sampleRate,
                  },
                }
              : {}),
          };
        },
        "voice.verify": async () => {
          const wav = await readFile(join(samples, "gentle.wav"));
          const text = await api.transcribe(wav, ctx.abort.signal);
          return { text, reference: voicePersonas[0].text };
        },
        "voice.preview": async (p) => {
          if (!voicePersonas.some((v) => v.id === p?.id))
            throw new Error("试听不存在");
          stopWake();
          disarm();
          clearPlayback();
          turnAbort.abort();
          turnAbort = new AbortController();
          const previewSignal = turnAbort.signal;
          const clip = await readFile(join(samples, p.id + ".mp3"))
            .then((data) => ({ data, mimeType: "audio/mpeg" }))
            .catch(async () => ({
              data: await readFile(join(samples, p.id + ".wav")),
              mimeType: "audio/wav",
            }));
          previewSignal.throwIfAborted();
          update("speaking", "播放随包试听，不调用 API");
          void play(
            { data: clip.data.toString("base64"), mimeType: clip.mimeType },
            previewSignal,
          )
            .then(() => {
              update(state.active ? "listening" : "off", "试听结束");
              armIdle();
              if (!state.active) void armWake();
            })
            .catch(() => {});
          return true;
        },
        "voice.cache": () => api.cleanup(),
        "voice.wake-test": async () => {
          await stop(false);
          waking = true;
          const version = epoch;
          await wake.listen(
            phrases(),
            (text) => {
              if (version === epoch) {
                update("sleeping", `唤醒测试成功：${text}`);
                stopWake();
              }
            },
            api.get().wakeSensitivity,
          );
          update("sleeping", "本地唤醒测试：请说“" + phrases()[0] + "”");
          ctx.timeout(() => {
            if (version === epoch) {
              waking = false;
              stopWake();
              void armWake();
            }
          }, 20000);
          return true;
        },
        "voice.host": async (p) => {
          if (p?.epoch !== epoch || !p || typeof p.type !== "string") return;
          if (p.type === "error") {
            report(new Error(String(p.message).slice(0, 200)));
            return;
          }
          if (p.type === "playing-end") {
            if (p.playback !== playback) return;
            if (p.id) playWaiters.get(p.id)?.resolve();
            else if (state.active) {
              update("listening", "我在听，继续说就好");
              armIdle();
            }
            return;
          }
          if (p.type === "listening") {
            if (state.active && state.phase === "connecting") {
              update(
                state.dictating ? "recording" : "listening",
                state.dictating ? "录音中，点麦克风结束" : "我在听，继续说就好",
              );
              armIdle();
            }
            return;
          }
          if (
            p.type !== "pcm" ||
            !state.active ||
            typeof p.data !== "string" ||
            p.data.length > 24000 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(p.data)
          )
            return;
          const bytes = Buffer.from(p.data, "base64");
          if (bytes.length % 2) return;
          if (state.dictating) {
            chunks.push(bytes);
            dictationBytes += bytes.length;
            if (dictationBytes >= 90 * 48000)
              void finishDictation().catch(report);
            return;
          }
          if (state.mode === "realtime") {
            live?.sendAudio(p.data);
            return;
          }
          const result = detector.push(bytes);
          if (result.started) {
            onset = Date.now();
            interrupt();
          }
          if (result.pcm) {
            void transcribe(result.pcm, false);
            onset = 0;
          } else if (onset && Date.now() - onset > 95000) {
            detector.reset();
            onset = 0;
            update("listening", "请分段说，我在听");
            armIdle();
          }
        },
      };
      for (const [name, command] of Object.entries(routes))
        ctx.effect(ctx.use("commands").register(name, command));
      ctx.provide("voice.session", {
        state: () => ({ ...state }),
        start,
        stop,
        speak,
        finishDictation,
      });
      ctx.on<ChatState>("conversation.changed", (value) => {
        const last = value.messages.at(-1);
        if (
          !last ||
          last.role !== "assistant" ||
          last.origin === "voice" ||
          !api.get().autoRead
        )
          return;
        if (last.id !== lastRead) {
          lastRead = last.id;
          if (!["streaming", "complete"].includes(last.status)) return;
          stopWake();
          disarm();
          turnAbort.abort();
          turnAbort = new AbortController();
          const signal = AbortSignal.any([turnAbort.signal, ctx.abort.signal]);
          autoStream = {
            id: last.id,
            buffer: new SpeechTextBuffer(),
            signal,
            queue: queueFor(signal),
          };
        }
        const stream = autoStream;
        if (!stream || stream.id !== last.id || stream.signal.aborted) return;
        stream.queue.add(stream.buffer.take(last.text, !value.busy));
        if (!value.busy) {
          autoStream = undefined;
          if (last.status !== "complete") {
            turnAbort.abort();
            clearPlayback();
            return;
          }
          void stream.queue
            .done()
            .then(() => {
              if (stream.signal.aborted) return;
              update(
                state.active ? "listening" : "off",
                state.active ? "我在听，继续说就好" : "朗读结束",
              );
              armIdle();
              if (!state.active)
                ctx.timeout(() => {
                  void armWake();
                }, 400);
            })
            .catch((e) => {
              if (!stream.signal.aborted) report(e);
            });
        }
      });
      ctx.on("voice.settings", () => {
        publish();
        if (!api.get().autoRead && autoStream) {
          turnAbort.abort();
          clearPlayback();
          autoStream = undefined;
        }
      });
      ctx.on("settings.changed", () => {
        if (!state.active && state.phase !== "speaking") {
          stopWake();
          void armWake();
        }
      });
      ctx.on("voice.wake-error", (message) => {
        if (!state.active)
          update("off", "唤醒已停止，可手动开始", String(message));
      });
      ctx.effect(async () => {
        ready = false;
        disarm();
        stopWake();
        sessionAbort.abort();
        turnAbort.abort();
        live?.stop();
        clearPlayback();
        surface.close("voice");
      });
      await surface.create("voice", "ui/voice-session/index.html");
      ready = true;
      publish();
      void armWake();
    },
  });
}
