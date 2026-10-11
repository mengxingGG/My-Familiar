import { spawn, type ChildProcess } from "node:child_process";
import {
  definePlugin,
  type WakeStatus,
} from "../../packages/contracts/index.ts";
import { decodeWakeAudio } from "./wake-audio.ts";
export function voiceWindows(executable: string, prefixArgs: string[] = []) {
  return definePlugin({
    manifest: {
      manifestVersion: 1,
      id: "familiar.voice-windows",
      version: "0.3.0",
      provides: ["voice.wake", "voice.local"],
      requires: [],
      permissions: ["device.microphone"],
    },
    async start(ctx) {
      let child: ChildProcess | undefined;
      const run = (args: string[], input: unknown, signal: AbortSignal) =>
        new Promise<any>((resolve, reject) => {
          signal.throwIfAborted();
          const process = spawn(executable, [...prefixArgs, ...args], {
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          });
          let output = "",
            settled = false;
          const end = (error?: Error, value?: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            process.kill();
            error ? reject(error) : resolve(value);
          };
          const abort = () => end(new Error("语音操作已取消")),
            timer = setTimeout(() => end(new Error("本地语音超时")), 60000);
          signal.addEventListener("abort", abort, { once: true });
          process.on("error", () => end(new Error("本地语音组件不可用")));
          process.stdin.on("error", () => {});
          process.stderr.resume();
          process.stdout.setEncoding("utf8");
          process.stdout.on("data", (data) => {
            output += data;
            if (output.length > 28 * 1024 * 1024) end(new Error("音频过大"));
          });
          process.on("close", () => {
            try {
              const value = JSON.parse(output.trim());
              end(value.error ? new Error(value.error) : undefined, value);
            } catch {
              end(new Error("本地语音没有返回结果"));
            }
          });
          process.stdin.end(JSON.stringify(input) + "\n");
        });
      const probe = await run(["--probe"], {}, ctx.abort.signal).catch(() => ({
        voices: [],
        recognizers: [],
      }));
      let message = probe.recognizers.some((v: any) =>
        v.culture.startsWith("zh"),
      )
        ? "中文唤醒可用，待启用"
        : "未检测到 Windows 中文识别器，可手动开始语音";
      let diagnostics: Partial<WakeStatus> = {};
      const stop = () => {
        diagnostics.listening = false;
        diagnostics.level = 0;
        child?.kill();
        child = undefined;
      };
      ctx.provide("voice.local", {
        voices: () =>
          probe.voices.map((v: any) => ({ id: v.id, name: v.name })),
        async synthesize(text, style, voice, speed, signal) {
          const result = await run(
            ["--speak"],
            { text, style, voice, speed },
            signal,
          );
          return Buffer.from(result.data, "base64");
        },
      });
      ctx.provide("voice.wake", {
        status: () => ({
          available: probe.recognizers.some((v: any) =>
            v.culture.startsWith("zh"),
          ),
          message,
          ...diagnostics,
        }),
        stop,
        async listen(phrases, onWake, sensitivity = 50) {
          ctx.require("device.microphone");
          stop();
          diagnostics = { listening: false, level: 0, peak: 0 };
          if (!probe.recognizers.some((v: any) => v.culture.startsWith("zh")))
            throw new Error(message);
          const current = spawn(executable, [...prefixArgs, "--wake"], {
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          });
          child = current;
          current.stdin.on("error", () => {});
          current.stderr.resume();
          current.stdin.write(
            JSON.stringify({
              phrases,
              threshold: 0.85 - Math.max(0, Math.min(100, sensitivity)) * 0.005,
            }) + "\n",
          );
          let buffer = "";
          await new Promise<void>((resolve, reject) => {
            let ready = false;
            const timer = setTimeout(() => {
              if (!ready) {
                if (child === current) stop();
                reject(new Error("唤醒组件启动超时"));
              }
            }, 8000);
            const fail = (error: Error) => {
              clearTimeout(timer);
              if (child !== current) {
                if (!ready) reject(error);
                return;
              }
              diagnostics.listening = false;
              message = error.message;
              if (!ready) reject(error);
              else if (ctx.active) ctx.emit("voice.wake-error", message);
            };
            current.on("error", () => fail(new Error("无法启动语音唤醒")));
            current.on("close", () => {
              if (!ready || child === current)
                fail(new Error("语音唤醒已停止"));
            });
            current.stdout.setEncoding("utf8");
            current.stdout.on("data", (value) => {
              if (child !== current) return;
              buffer += value;
              if (buffer.length > 3 * 1024 * 1024) {
                fail(new Error("唤醒响应异常"));
                if (child === current) stop();
                return;
              }
              while (buffer.includes("\n")) {
                const end = buffer.indexOf("\n"),
                  line = buffer.slice(0, end);
                buffer = buffer.slice(end + 1);
                try {
                  const item = JSON.parse(line.trim());
                  if (child !== current) continue;
                  if (item.ready) {
                    ready = true;
                    clearTimeout(timer);
                    message = "等待唤醒";
                    diagnostics.listening = true;
                    resolve();
                  }
                  if (item.error) {
                    fail(new Error(item.error));
                    if (child === current) stop();
                  }
                  if (child !== current) continue;
                  if (Number.isFinite(item.level)) {
                    diagnostics.level = Math.max(0, Math.min(100, item.level));
                    diagnostics.peak = Math.max(
                      diagnostics.peak ?? 0,
                      diagnostics.level!,
                    );
                    if (item.level > 1) diagnostics.lastAudioAt = Date.now();
                  }
                  if (item.speech) diagnostics.lastSpeechAt = Date.now();
                  if (item.rejected || item.recognized) {
                    diagnostics.confidence = item.confidence;
                    diagnostics.lastResult = item.accepted
                      ? "已识别唤醒词"
                      : item.rejected
                        ? "听到声音，但未识别到名字"
                        : "识别置信度不足，可提高灵敏度";
                  }
                  if (item.signal)
                    diagnostics.lastResult =
                      (
                        {
                          TooSoft: "声音偏小，请靠近麦克风",
                          TooLoud: "声音过大",
                          TooNoisy: "背景噪声较大",
                          NoSignal: "麦克风没有声音",
                        } as Record<string, string>
                      )[item.signal] ?? "麦克风信号不稳定";
                  if (
                    typeof item.wake === "string" &&
                    item.wake.length <= 40 &&
                    child === current &&
                    ctx.active
                  ) {
                    let audio;
                    if (
                      typeof item.audio === "string" &&
                      item.audio.length <= 2 * 1024 * 1024
                    ) {
                      try {
                        audio = decodeWakeAudio(
                          Buffer.from(item.audio, "base64"),
                        );
                      } catch {
                        /* 旧组件或异常音频仍允许唤醒，不把原始内容写日志。 */
                      }
                    }
                    diagnostics.handoffMessage = audio
                      ? "已保留唤醒片段用于接话"
                      : "已进入对话，请继续说";
                    onWake(item.wake, audio);
                  }
                } catch {
                  /* 忽略不完整诊断，不记录麦克风内容。 */
                }
              }
            });
          });
        },
      });
      ctx.effect(stop);
    },
  });
}
