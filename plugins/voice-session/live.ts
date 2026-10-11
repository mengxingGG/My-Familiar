import WebSocket from "ws";
import type { LiveProfile } from "../../packages/contracts/index.ts";
export interface LiveCallbacks {
  ready(): void;
  speech(): void;
  audio(data: string, rate: number): void;
  done(): void;
  error(message: string): void;
  ask(text: string, signal: AbortSignal): Promise<string>;
}
const mainTool = {
  name: "ask_familiar",
  description:
    "必须把用户每次说的话交给主模型，主模型负责图片识别、截图、记忆、搜索和工具。得到结果后只自然朗读结果，不自行执行任务。",
  parameters: {
    type: "object",
    properties: { text: { type: "string", description: "用户本轮完整原话" } },
    required: ["text"],
  },
};
export function liveConnection(
  config: LiveProfile,
  key: string,
  name: string,
  tone: string,
  callbacks: LiveCallbacks,
  signal: AbortSignal,
) {
  const gemini = config.kind === "gemini",
    url = new URL(config.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (gemini) {
    url.pathname =
      "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
  } else {
    url.pathname = url.pathname.replace(/\/$/, "") + "/realtime";
    url.searchParams.set("model", config.model);
  }
  // 凭据留在 Runtime；不会经过渲染进程或输出连接 URL。
  const socket = new WebSocket(url, {
    headers: gemini
      ? { "x-goog-api-key": key }
      : key
        ? { Authorization: `Bearer ${key}` }
        : {},
    maxPayload: 8 * 1024 * 1024,
    handshakeTimeout: 15000,
    followRedirects: false,
  });
  let ready = false,
    closed = false,
    task: AbortController | undefined,
    working = false;
  const handled = new Set<string>();
  const send = (data: unknown) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
  };
  const instructions = `你的名字是${name}。你是桌面伙伴的语音接口，使用中文。${tone} 每次用户说话必须先调用 ask_familiar，把完整原话交给主模型；截图、搜索、记忆均由它处理。拿到结果后准确朗读，不增加事实，不重复调用。不展示思考。`;
  const interrupt = () => {
    task?.abort();
    task = undefined;
    working = false;
    callbacks.speech();
  };
  const ask = async (id: string, text: string, callName: string) => {
    if (handled.has(id)) return;
    handled.add(id);
    if (handled.size > 256) handled.delete(handled.values().next().value!);
    if (
      callName !== "ask_familiar" ||
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 8000
    ) {
      callbacks.error("实时服务返回了无效工具请求");
      return;
    }
    task?.abort();
    const current = new AbortController();
    task = current;
    working = true;
    try {
      const answer = await callbacks.ask(
        text,
        AbortSignal.any([signal, current.signal]),
      );
      if (current.signal.aborted || closed) return;
      if (gemini)
        send({
          toolResponse: {
            functionResponses: [
              { id, name: callName, response: { result: answer } },
            ],
          },
        });
      else {
        send({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: id, output: answer },
        });
        send({
          type: "response.create",
          response: {
            tool_choice: "none",
            instructions:
              "只用中文朗读刚才 ask_familiar 返回的内容，不增加或改写事实。",
          },
        });
      }
    } catch (e) {
      if (!current.signal.aborted && !closed)
        callbacks.error(e instanceof Error ? e.message : "主模型没有完成回复");
    } finally {
      if (task === current) {
        task = undefined;
        working = false;
      }
    }
  };
  socket.on("open", () => {
    if (closed) {
      socket.close();
      return;
    }
    if (gemini)
      send({
        setup: {
          model: "models/" + config.model.replace(/^models\//, ""),
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } },
            },
          },
          systemInstruction: { parts: [{ text: instructions }] },
          tools: [{ functionDeclarations: [mainTool] }],
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              silenceDurationMs: 800,
            },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          contextWindowCompression: { slidingWindow: {} },
        },
      });
    else
      send({
        type: "session.update",
        session: {
          type: "realtime",
          model: config.model,
          instructions,
          output_modalities: ["audio"],
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              turn_detection: {
                type: "server_vad",
                silence_duration_ms: 800,
                create_response: true,
                interrupt_response: true,
              },
            },
            output: {
              format: { type: "audio/pcm", rate: 24000 },
              voice: config.voice,
            },
          },
          tools: [{ type: "function", ...mainTool }],
          tool_choice: "required",
        },
      });
  });
  socket.on("message", (bytes) => {
    try {
      const v = JSON.parse(bytes.toString());
      if (v.error) {
        callbacks.error("实时语音服务拒绝了请求，请检查模型、音色和账户权限");
        return;
      }
      if (v.setupComplete || v.type === "session.updated") {
        if (!ready) {
          ready = true;
          clearTimeout(timer);
          callbacks.ready();
        }
      }
      if (gemini) {
        if (v.goAway) {
          callbacks.error(
            "实时服务要求重新连接，请重新开始语音；文字会话已保留",
          );
          return;
        }
        if (v.serverContent?.interrupted || v.toolCallCancellation) interrupt();
        for (const part of v.serverContent?.modelTurn?.parts ?? [])
          if (
            part.inlineData?.data &&
            /^audio\/pcm/.test(part.inlineData.mimeType ?? "")
          )
            callbacks.audio(
              part.inlineData.data,
              Number(/rate=(\d+)/.exec(part.inlineData.mimeType)?.[1] ?? 24000),
            );
        for (const call of v.toolCall?.functionCalls ?? [])
          void ask(call.id, call.args?.text, call.name);
        if (v.serverContent?.turnComplete && !working) callbacks.done();
      } else {
        if (v.type === "input_audio_buffer.speech_started") interrupt();
        if (
          ["response.output_audio.delta", "response.audio.delta"].includes(
            v.type,
          ) &&
          typeof v.delta === "string"
        )
          callbacks.audio(v.delta, 24000);
        if (v.type === "response.function_call_arguments.done") {
          const args = JSON.parse(v.arguments);
          void ask(v.call_id, args.text, v.name);
        }
        if (
          v.type === "response.done" &&
          !working &&
          !v.response?.output?.some((o: any) => o.type === "function_call")
        )
          callbacks.done();
      }
    } catch {
      callbacks.error("实时语音返回格式无效");
    }
  });
  socket.on("error", () => {
    if (!closed) callbacks.error("实时语音连接失败，请检查地址和网络");
  });
  socket.on("close", () => {
    if (!closed)
      callbacks.error("实时语音连接已断开，文字会话仍保留，可重新开始");
  });
  const timer = setTimeout(() => {
    if (!ready && !closed) callbacks.error("实时语音连接超时");
  }, 20000);
  const stop = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    task?.abort();
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else socket.close();
    signal.removeEventListener("abort", stop);
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  return {
    sendText(text: string) {
      if (!ready || closed) return;
      if (gemini)
        send({
          clientContent: {
            turns: [{ role: "user", parts: [{ text }] }],
            turnComplete: true,
          },
        });
      else {
        send({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          },
        });
        send({ type: "response.create" });
      }
    },
    sendAudio(data: string) {
      if (!ready || closed) return;
      if (socket.bufferedAmount > 512000) {
        callbacks.error("网络过慢，已停止实时音频以避免积压");
        return;
      }
      if (gemini)
        send({
          realtimeInput: { audio: { data, mimeType: "audio/pcm;rate=24000" } },
        });
      else send({ type: "input_audio_buffer.append", audio: data });
    },
    interrupt() {
      if (!gemini) send({ type: "response.cancel" });
      interrupt();
    },
    stop,
  };
}
