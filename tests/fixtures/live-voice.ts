import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

/** 本机协议夹具：不冒充真实云端识别，音频与模型回答均固定。 */
export async function liveFixture() {
  const sessions: { socket: WebSocket; kind: string; path: string; auth: string; messages: any[]; bytes: number; setup?: any; closed: boolean }[] = [];
  const models: any[] = [];
  let modelDelay = 0;
  const server = createServer(async (req, res) => {
    if (req.url?.endsWith('/models')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture-chat' }] })); return; }
    const parts: Buffer[] = []; for await (const p of req) parts.push(p);
    models.push(JSON.parse(Buffer.concat(parts).toString()));
    const timer = setTimeout(() => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"这是主模型的固定回答。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }, modelDelay);
    res.on("close", () => clearTimeout(timer));
  });
  const ws = new WebSocketServer({ server });
  ws.on("connection", (socket, req) => {
    const gemini = req.url!.startsWith("/ws/");
    const item = { socket, kind: gemini ? "gemini" : "openai", path: req.url!, auth: String(req.headers[gemini ? "x-goog-api-key" : "authorization"] ?? ""), messages: [] as any[], bytes: 0, closed: false, setup: undefined as any };
    sessions.push(item);
    socket.on("message", data => {
      const v = JSON.parse(data.toString());
      if (v.type === "input_audio_buffer.append" || v.realtimeInput?.audio) item.bytes += Buffer.from(v.audio ?? v.realtimeInput.audio.data, "base64").length;
      else { item.messages.push(v); if (v.setup || v.type === "session.update") item.setup = v; }
    });
    socket.on("close", () => { item.closed = true; });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address(); if (!address || typeof address === "string") throw Error("fixture address");
  const send = (v: unknown) => sessions.at(-1)!.socket.send(JSON.stringify(v));
  const gemini = () => sessions.at(-1)!.kind === "gemini";
  return {
    port: address.port, url: `http://127.0.0.1:${address.port}/v1`, sessions, models,
    slow(ms: number) { modelDelay = ms; },
    ready() { send(gemini() ? { setupComplete: {} } : { type: "session.updated", session: {} }); },
    ask(id = "isolated-turn", text = "验证主模型代理") { send(gemini() ? { toolCall: { functionCalls: [{ id, name: "ask_familiar", args: { text } }] } } : { type: "response.function_call_arguments.done", call_id: id, name: "ask_familiar", arguments: JSON.stringify({ text }) }); },
    speech() { send(gemini() ? { serverContent: { interrupted: true } } : { type: "input_audio_buffer.speech_started" }); },
    audio() {
      const pcm = Buffer.alloc(48000); for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 220 / 24000) * 500), i * 2);
      send(gemini() ? { serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm.toString("base64"), mimeType: "audio/pcm;rate=24000" } }] }, turnComplete: true } } : { type: "response.output_audio.delta", delta: pcm.toString("base64") });
      if (!gemini()) send({ type: "response.done", response: { output: [] } });
    },
    disconnect() { sessions.at(-1)!.socket.close(); },
    async close() { for (const s of sessions) s.socket.terminate(); await new Promise<void>(r => ws.close(() => r())); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); },
  };
}
