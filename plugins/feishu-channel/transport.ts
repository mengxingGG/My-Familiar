import { createHash } from "node:crypto";
import axios from "axios";
import { Client, DefaultCache, EventDispatcher, WSClient, type HttpInstance } from "@larksuiteoapi/node-sdk";

export type ChannelPhase = "connecting" | "connected" | "reconnecting" | "error";
export interface FeishuTransportOptions {
  appId: string;
  appSecret: string;
  signal: AbortSignal;
  receive(value: unknown): void;
  state(phase: ChannelPhase): void;
}
export interface FeishuTransport {
  reply(id: string, text: string): Promise<void>;
  close(): void;
}
export type FeishuTransportFactory = (options: FeishuTransportOptions) => FeishuTransport;

/** 域名只由可信装配指定，移动网页不提供端点/代理覆盖入口。 */
export function feishuTransport(domain = "https://open.feishu.cn"): FeishuTransportFactory {
  return ({ appId, appSecret, signal, receive, state }) => {
    signal.throwIfAborted();
    const stopped = new AbortController(), active = AbortSignal.any([signal, stopped.signal]);
    // SDK 日志可能包含连接票据；界面只接收固定状态，不转发 SDK 原始日志。
    const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
    const http = axios.create({ timeout: 15000, maxRedirects: 0, signal: active });
    http.interceptors.response.use(response => response.data);
    // 与 SDK 默认适配器一致：响应拦截器返回正文，Axios 静态类型仍保留包装对象。
    const httpInstance = http as unknown as HttpInstance;
    const client = new Client({ appId, appSecret, domain, httpInstance, logger, cache: new DefaultCache() });
    const update = (phase: ChannelPhase) => { if (!active.aborted) state(phase); };
    const ws = new WSClient({ appId, appSecret, domain, httpInstance, logger,
      handshakeTimeoutMs: 15000, wsConfig: { pingTimeout: 15 },
      onReady: () => update("connected"), onReconnected: () => update("connected"),
      onReconnecting: () => update("reconnecting"), onError: () => update("error") });
    const close = () => { stopped.abort(); ws.close({ force: true }); signal.removeEventListener("abort", close); };
    signal.addEventListener("abort", close, { once: true });
    update("connecting");
    void ws.start({ eventDispatcher: new EventDispatcher({ logger }).register({
      "im.message.receive_v1": data => { if (!active.aborted) receive(data); return {}; },
    }) }).catch(() => update("error"));
    return {
      close,
      async reply(id, text) {
        const characters = Array.from(text);
        for (let offset = 0; offset < characters.length; offset += 2500) {
          active.throwIfAborted();
          const response = await client.im.message.reply({ path: { message_id: id }, data: {
            msg_type: "text", content: JSON.stringify({ text: characters.slice(offset, offset + 2500).join("") }),
            uuid: createHash("sha256").update(`${appId}:${id}:${offset}`).digest("hex").slice(0, 32),
          } });
          active.throwIfAborted();
          if (response.code !== 0 || !response.data?.message_id) throw Error("FEISHU_REPLY_UNCONFIRMED");
        }
      },
    };
  };
}
