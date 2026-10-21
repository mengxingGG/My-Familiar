import { createHash, randomBytes, randomUUID } from "node:crypto";
import { definePlugin, type FeishuChannelConfig, type FeishuChannelStatus, type FeishuChannelUpdate } from "../../packages/contracts/index.ts";
import { incomingMessage } from "../feishu-cli/validation.ts";
import { feishuTransport, type FeishuTransportFactory, type FeishuTransport } from "./transport.ts";

export const channelSecretScope = (id: string) => "feishu-channel:" + id;
// 官方长连接 SDK 只接受 cli_ 加 16 位十六进制编号；提前拒绝，避免静默停在连接中。
const validId = (id: unknown) => typeof id === "string" && /^cli_[0-9a-fA-F]{16}$/.test(id);
const userId = (id: unknown) => typeof id === "string" && /^ou_[a-zA-Z0-9_-]{1,100}$/.test(id);
export function validateChannel(value: FeishuChannelConfig): FeishuChannelConfig {
  if (!value || !(value.appId === "" || validId(value.appId)) || typeof value.enabled !== "boolean" ||
      !Array.isArray(value.allowedUsers) || value.allowedUsers.length > 20 || !value.allowedUsers.every(userId) || value.enabled && !validId(value.appId)) throw Error("INVALID_INPUT");
  return { appId: value.appId, enabled: value.enabled, allowedUsers: [...new Set(value.allowedUsers)] };
}
export function normalizeChannelMessage(value: unknown) {
  const data = value as { sender?: { sender_type?: string; sender_id?: { open_id?: string } }; message?: { chat_type?: string; message_type?: string; content?: string; message_id?: string; chat_id?: string } };
  const m = data?.message;
  if (!m || typeof m.content !== "string" || m.content.length > 32000 || [m.message_id, m.chat_id, data.sender?.sender_id?.open_id].some(id => typeof id !== "string" || id.length > 128)) return;
  try {
    return incomingMessage({ type: "im.message.receive_v1", sender_type: data.sender?.sender_type, sender_id: data.sender?.sender_id?.open_id,
      chat_type: m.chat_type, message_type: m.message_type, message_id: m.message_id, chat_id: m.chat_id, content: JSON.parse(m.content).text });
  } catch { return; }
}

/** 通道只拥有连接、配对与去重；回复和权限仍由原有 channel.chat / Agent 拥有。 */
export function createFeishuChannel(options: { available(): Promise<boolean>; transport?: FeishuTransportFactory; pollMs?: number }) {
  return definePlugin({
    manifest: { manifestVersion: 1, id: "familiar.feishu-channel", version: "0.1.0", provides: ["feishu.channel"],
      requires: ["storage.local", "secrets.local", "channel.chat"], permissions: ["network.feishu"] },
    async start(ctx) {
      ctx.require("network.feishu");
      const storage = ctx.use("storage.local"), secrets = ctx.use("secrets.local");
      let saved = await storage.read("feishu-channel", { config: { appId: "", enabled: false, allowedUsers: [] } as FeishuChannelConfig, revision: randomUUID() as string });
      saved.config = validateChannel(saved.config);
      let phase: FeishuChannelStatus["phase"] = "off", detail = "飞书私聊未开启。";
      let pairing: FeishuChannelStatus["pairing"], connection: FeishuTransport | undefined, abort: AbortController | undefined;
      let generation = 0, pending = 0, reconciling = false, changing = false, stoppedByUser = false, residentAllowed = true;
      let configQueue = Promise.resolve(), messageQueue = Promise.resolve();
      const queued = new Set<string>();
      const status = (): FeishuChannelStatus => ({ ...structuredClone(saved.config), revision: saved.revision, hasSecret: !!saved.config.appId && secrets.has(channelSecretScope(saved.config.appId)),
        phase, detail, pending, ...(pairing && pairing.expires > Date.now() ? { pairing: { ...pairing } } : {}) });
      const serial = <T>(operation: () => Promise<T>): Promise<T> => { const task = configQueue.then(operation); configQueue = task.then(() => {}, () => {}); return task; };
      const disconnect = () => { generation++; abort?.abort(); abort = undefined; connection?.close(); connection = undefined; pairing = undefined; phase = "off"; detail = "私聊连接已停止。"; };
      const persist = async (config: FeishuChannelConfig) => { const next = { config, revision: randomUUID() }; await storage.write("feishu-channel", next); saved = next; ctx.emit("feishu.channel.changed", status()); };
      const reconcile = async () => {
        if (reconciling || changing || stoppedByUser || !residentAllowed || !ctx.active) return;
        reconciling = true;
        try {
          if (!saved.config.enabled) { if (connection) disconnect(); phase = "off"; detail = "飞书私聊未开启。"; return; }
          const current = generation, available = await options.available();
          if (current !== generation || changing || !ctx.active) return;
          if (!saved.config.enabled || !available) {
            if (connection) disconnect();
            phase = saved.config.enabled ? "waiting" : "off";
            detail = saved.config.enabled ? "等待开启常驻伙伴；当前不接收私聊。" : "飞书私聊未开启。";
            return;
          }
          if (connection) return;
          const appId = saved.config.appId, key = secrets.get(channelSecretScope(appId));
          if (!key) { phase = "error"; detail = "请保存应用密钥后再开启。"; return; }
          abort = new AbortController();
          const signal = AbortSignal.any([abort.signal, ctx.abort.signal]), epoch = ++generation;
          const seenKey = "feishu-seen-" + createHash("sha256").update(appId).digest("hex");
          const seen = new Set(await storage.read<string[]>(seenKey, []));
          if (signal.aborted || epoch !== generation) return;
          connection = (options.transport ?? feishuTransport())({ appId, appSecret: key, signal,
            state(next) { if (signal.aborted || epoch !== generation) return; phase = next; detail = { connecting: "正在连接飞书…", connected: "已连接，仅响应已配对用户的私聊文字。", reconnecting: "连接中断，正在重连。", error: "连接失败，请检查应用凭据、长连接订阅和网络；保存设置可重新连接。" }[next]; },
            receive(value) {
              const message = normalizeChannelMessage(value);
              if (!message || signal.aborted || epoch !== generation || seen.has(message.id) || queued.has(message.id)) return;
              const isPair = !saved.config.allowedUsers.includes(message.sender) && pairing && pairing.expires > Date.now() && message.text === "/pair " + pairing.code;
              if (!saved.config.allowedUsers.includes(message.sender) && !isPair) return;
              if (pending >= 20) { detail = "待回复消息过多，请稍后重发未处理的消息。"; return; }
              pending++; queued.add(message.id);
              // 即刻返回给 SDK 确认收包；执行前再持久化去重，不等待模型完成才 ACK。
              messageQueue = messageQueue.then(async () => {
                if (signal.aborted || epoch !== generation) return;
                if (!saved.config.allowedUsers.includes(message.sender)) {
                  const paired = await serial(async () => {
                    if (signal.aborted || epoch !== generation || !pairing || pairing.expires <= Date.now() || message.text !== "/pair " + pairing.code || saved.config.allowedUsers.length >= 20) return false;
                    await persist({ ...saved.config, allowedUsers: [...saved.config.allowedUsers, message.sender] }); pairing = undefined; return true;
                  });
                  if (!paired) return;
                  seen.add(message.id); await storage.write(seenKey, [...seen]);
                  signal.throwIfAborted();
                  await connection!.reply(message.id, "配对成功，我在这里。现在可以直接和我聊天了。"); return;
                }
                seen.add(message.id); while (seen.size > 2000) seen.delete(seen.values().next().value!);
                await storage.write(seenKey, [...seen]); signal.throwIfAborted();
                const channel = `feishu:${appId}:${message.sender}:${message.chat}`;
                let answer: string;
                try {
                  if (message.text === "/new") { await ctx.use("channel.chat").clear(channel); answer = "新的对话开始了，记忆仍然保留。"; }
                  else answer = await ctx.use("channel.chat").reply(channel, message.text, signal);
                } catch { signal.throwIfAborted(); answer = "这次没能完成，请在灵伴中检查模型连接或待批准任务后重试。"; }
                signal.throwIfAborted();
                if (epoch !== generation) return;
                await connection!.reply(message.id, answer);
              }).catch(() => { if (!signal.aborted && epoch === generation) detail = "有一条回复未确认送达；未自动重发，请检查连接。"; })
                .finally(() => { pending--; queued.delete(message.id); });
            },
          });
        } catch { if (ctx.active) { phase = "error"; detail = "私聊连接未就绪，请检查常驻状态和网络。"; } }
        finally { reconciling = false; }
      };
      ctx.provide("feishu.channel", {
        status,
        setResident(enabled) {
          residentAllowed = enabled;
          if (enabled) { void reconcile(); return; }
          disconnect();
          if (saved.config.enabled) { phase = "waiting"; detail = "等待开启常驻伙伴；当前不接收私聊。"; }
        },
        save(input: FeishuChannelUpdate) { return serial(async () => {
          const config = validateChannel(input);
          if (input.revision !== saved.revision) throw Error("CONFLICT");
          if (input.appSecret !== undefined && (typeof input.appSecret !== "string" || input.appSecret.length > 500 || /[\s\x00-\x1f]/.test(input.appSecret)) || input.clearSecret !== undefined && typeof input.clearSecret !== "boolean" || input.clearSecret && input.appSecret) throw Error("INVALID_INPUT");
          const changedApp = config.appId !== saved.config.appId;
          if (changedApp) config.allowedUsers = [];
          const scope = channelSecretScope(config.appId), oldScope = channelSecretScope(saved.config.appId), previous = secrets.get(scope);
          const key = input.clearSecret ? "" : input.appSecret || (changedApp ? "" : previous);
          if (input.clearSecret) config.enabled = false;
          if (config.enabled && !key) throw Error("INVALID_INPUT");
          if (!config.appId && key) throw Error("INVALID_INPUT");
          changing = true; disconnect();
          try {
            await secrets.set(scope, key);
            try { await persist(config); } catch (error) { await secrets.set(scope, previous); throw error; }
            if (changedApp) await secrets.set(oldScope, "");
          } finally { changing = false; }
          stoppedByUser = false; phase = config.enabled ? "waiting" : "off"; detail = config.enabled ? "等待连接飞书。" : "飞书私聊未开启。";
          void reconcile(); return status();
        }); },
        pair(revision) { return serial(async () => { if (revision !== saved.revision) throw Error("CONFLICT"); if (phase !== "connected") throw Error("UNAVAILABLE"); if (saved.config.allowedUsers.length >= 20) throw Error("LIMIT"); pairing = { code: randomBytes(4).toString("hex").toUpperCase(), expires: Date.now() + 600000 }; return status(); }); },
        stop() { return serial(async () => { stoppedByUser = true; disconnect(); await persist({ ...saved.config, enabled: false }); phase = "off"; detail = "飞书私聊已停止。"; return status(); }); },
      });
      const timer = setInterval(() => { void reconcile(); }, options.pollMs ?? 2000); timer.unref();
      ctx.effect(async () => { clearInterval(timer); disconnect(); await configQueue; await messageQueue; });
      void reconcile();
    },
  });
}
