import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { definePlugin } from "../../packages/contracts/index.ts";
import type { FeishuAuthStatus } from "../../packages/contracts/feishu-auth.ts";
import { channelSecretScope } from "../feishu-channel/index.ts";
import { feishuOAuthHttp, validScopes, officialAuthorizationUrl, type OAuthTokens } from "./auth-http.ts";

const scope = "feishu-user";
interface SavedUser {
  v: 1; appId: string; binding: string; user: { id: string; name: string }; scopes: string[];
  accessToken: string; refreshToken: string; expires: number; refreshExpires: number; refreshing: boolean;
}
export interface AndroidFeishuAuthOptions {
  fetcher?: typeof fetch;
  open?: (url: string) => Promise<void>;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}
function decode(value: string): SavedUser | undefined {
  if (!value) return;
  try {
    const s = JSON.parse(value) as SavedUser;
    if (s.v !== 1 || !/^cli_[0-9a-fA-F]{16}$/.test(s.appId) || !/^[a-f0-9]{64}$/.test(s.binding) || !/^ou_[a-zA-Z0-9_-]{1,100}$/.test(s.user.id) ||
        typeof s.user.name !== "string" || s.user.name.length > 200 || !validScopes(s.scopes) || ![s.accessToken, s.refreshToken].every(v => typeof v === "string" && v.length <= 16384 && !/[\s\x00-\x1f]/.test(v)) ||
        !s.accessToken || !Number.isSafeInteger(s.expires) || !Number.isSafeInteger(s.refreshExpires) || typeof s.refreshing !== "boolean") return;
    return s;
  } catch { return; }
}
function waiting<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
/** 一台手机只绑定一个当前飞书用户；密钥、设备码和令牌从不进入公开状态。 */
export function androidFeishuAuth(options: AndroidFeishuAuthOptions = {}) {
  return definePlugin({
    manifest: { manifestVersion: 1, id: "familiar.feishu-auth-android", version: "0.1.0", provides: ["feishu.auth"], requires: ["secrets.local", "feishu.channel"], permissions: ["network.feishu"] },
    async start(ctx) {
      ctx.require("network.feishu"); const keys = ctx.use("secrets.local"), channel = ctx.use("feishu.channel"), http = feishuOAuthHttp(options.fetcher), now = options.now ?? Date.now;
      const wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
      const binding = () => { const id = channel.status().appId, key = keys.get(channelSecretScope(id)); return id && key ? createHash("sha256").update(id + "\0" + key).digest("hex") : ""; };
      let saved = decode(keys.get(scope)), revision = randomUUID() as string, controller = new AbortController(), authorization: FeishuAuthStatus["authorization"];
      let authorizing = false, storageError = false, detail = "尚未登录个人账号。", queue = Promise.resolve(), refreshFlight: Promise<string> | undefined, login: Promise<void> | undefined;
      const valid = () => saved && saved.binding === binding() && saved.appId === channel.status().appId;
      const connected = () => !!(valid() && !saved!.refreshing && (saved!.expires > now() || saved!.refreshToken && saved!.refreshExpires > now()));
      const status = (): FeishuAuthStatus => ({ revision, connected: connected(), phase: authorizing ? "authorizing" : refreshFlight ? "refreshing" : connected() ? "connected" : saved || storageError ? "error" : "signedOut",
        detail: authorizing || refreshFlight ? detail : connected() ? "个人账号已连接，登录凭据按需刷新。" : saved ? "登录已过期、变更或上次刷新中断，请重新登录。" : detail,
        appId: channel.status().appId, scopes: valid() ? [...saved!.scopes] : [], ...(valid() ? { user: { ...saved!.user } } : {}),
        ...(authorization && authorization.expiresAt > now() ? { authorization: { ...authorization } } : {}) });
      const publish = () => { if (ctx.active) ctx.emit("feishu.auth.changed", status()); };
      const serial = <T>(work: () => Promise<T>) => { const task = queue.then(work); queue = task.then(() => {}, () => {}); return task; };
      const invalidate = () => { controller.abort(); controller = new AbortController(); revision = randomUUID(); authorization = undefined; authorizing = false; refreshFlight = undefined; };
      const clear = () => serial(async () => { try { await keys.set(scope, ""); storageError = false; } catch (error) { storageError = true; throw error; } });
      const checkRevision = (value: string) => { if (value !== revision) throw Error("CONFLICT"); };
      const persist = (value: SavedUser, signal: AbortSignal) => serial(async () => {
        signal.throwIfAborted(); if (value.binding !== binding()) throw Error("CONFLICT");
        await keys.set(scope, JSON.stringify(value));
        if (signal.aborted) {
          // 原生写入可能已经完成；取消期间落盘的登录不得在下次启动复活。
          try { await keys.set(scope, valid() ? JSON.stringify(saved) : ""); }
          catch { saved = undefined; storageError = true; detail = "取消时未能清除已写入的登录，请重试清除本机登录。"; publish(); }
          signal.throwIfAborted();
        }
        saved = value; storageError = false;
      });
      const fromTokens = (value: OAuthTokens, old: Pick<SavedUser, "appId" | "binding" | "user">): SavedUser => ({ ...old, v: 1, scopes: value.scopes, accessToken: value.accessToken, refreshToken: value.refreshToken, expires: now() + value.expiresIn * 1000, refreshExpires: value.refreshToken ? now() + value.refreshExpiresIn * 1000 : 0, refreshing: false });
      const message = (error: unknown) => ({ AUTH_DENIED: "你在飞书中拒绝了授权。", AUTH_EXPIRED: "授权已过期，请重新发起登录。", AUTH_START_FAILED: "未能发起授权，请检查应用凭据与授权配置。", AUTH_USER_FAILED: "授权后的用户信息未能确认，请重新登录。" })[(error as Error)?.message] ?? "登录未完成，请检查网络和应用授权后重试。";
      const accountChanged = () => {
        if (saved && !valid() || authorizing && sessionBinding !== binding()) { invalidate(); saved = undefined; detail = "应用凭据已变化，请重新登录。"; void clear().catch(() => { detail = "清除旧登录失败，请重试清除本机登录。"; }); publish(); }
      };
      let sessionBinding = "";
      ctx.on("feishu.channel.changed", accountChanged);
      ctx.on("secrets.changed", key => { if (typeof key === "string" && key.startsWith("feishu-channel:")) accountChanged(); });
      ctx.provide("feishu.auth", {
        status,
        async begin(value) {
          if (refreshFlight) throw Error("CONFLICT");
          checkRevision(value.revision); const account = channel.status();
          if (value.channelRevision !== account.revision) throw Error("CONFLICT");
          if (!validScopes(value.scopes)) throw Error("INVALID_INPUT");
          if (!account.appId || !account.hasSecret) throw Error("UNAVAILABLE");
          invalidate(); authorizing = true; sessionBinding = binding(); detail = "正在准备飞书官方授权…"; publish();
          const signal = AbortSignal.any([controller.signal, ctx.abort.signal]), appId = account.appId, appSecret = keys.get(channelSecretScope(appId)), stamp = sessionBinding;
          try {
            const device = await http.start(appId, appSecret, [...new Set([...(valid() ? saved!.scopes : []), ...value.scopes])], signal); signal.throwIfAborted();
            authorization = { url: device.url, userCode: device.userCode, expiresAt: now() + device.expiresIn * 1000 }; detail = "请打开飞书官方页面确认授权，完成后返回这里。"; publish();
            const expires = authorization.expiresAt;
            login = (async () => {
              let interval = device.interval;
              while (now() < expires) {
                await wait(Math.min(interval * 1000, expires - now()), signal); signal.throwIfAborted(); if (now() >= expires) break;
                let result;
                try { result = await http.poll(appId, appSecret, device.deviceCode, signal); }
                catch (error) { signal.throwIfAborted(); if ((error as Error).message !== "AUTH_NETWORK_FAILED") throw error; interval = Math.min(60, interval + 5); detail = "网络暂时中断，正在等待授权结果。"; continue; }
                if (now() >= expires) throw Error("AUTH_EXPIRED");
                if (result === "pending") continue; if (result === "slow") { interval = Math.min(60, interval + 5); continue; }
                const user = await http.user(result.accessToken, signal); signal.throwIfAborted();
                await persist(fromTokens(result, { appId, binding: stamp, user }), signal); signal.throwIfAborted(); authorizing = false; authorization = undefined; revision = randomUUID(); detail = "个人账号已连接。"; publish(); return;
              }
              throw Error("AUTH_EXPIRED");
            })().catch(error => { if (!signal.aborted) { authorizing = false; authorization = undefined; detail = message(error); publish(); } });
          } catch (error) { if (!signal.aborted) { authorizing = false; authorization = undefined; detail = message(error); publish(); } signal.throwIfAborted(); }
        },
        async open(value) { checkRevision(value); if (!authorization || authorization.expiresAt <= now() || !officialAuthorizationUrl(authorization.url) || !options.open) throw Error("UNAVAILABLE"); await options.open(authorization.url); },
        cancel(value) { checkRevision(value); if (!authorizing) throw Error("CONFLICT"); invalidate(); detail = "本次登录已取消。"; publish(); },
        async forget(value) {
          checkRevision(value); invalidate(); saved = undefined; detail = "正在清除本机登录…"; publish();
          try { await clear(); detail = "本机个人登录已清除；飞书中的应用授权可在飞书中另行撤销。"; }
          catch { detail = "清除本机登录失败，请重试；重启可能恢复旧登录。"; throw Error("UNAVAILABLE"); }
          finally { publish(); }
        },
        async token(signal) {
          signal.throwIfAborted();
          if (refreshFlight) return waiting(refreshFlight, signal);
          if (!connected()) throw Error("FEISHU_USER_REQUIRED");
          if (saved!.expires > now() + 60000 || (!saved!.refreshToken || saved!.refreshExpires <= now()) && saved!.expires > now()) return saved!.accessToken;
          const old = saved!, ownerSignal = AbortSignal.any([controller.signal, ctx.abort.signal]), appSecret = keys.get(channelSecretScope(old.appId));
          const task = (async () => {
            // 发送轮换请求之前原子落盘标记；进程中断后不得重用结果未知的刷新令牌。
            await persist({ ...old, refreshing: true }, ownerSignal); detail = "正在刷新个人登录…";
            const next = await http.refresh(old.appId, appSecret, old.refreshToken, ownerSignal);
            await persist(fromTokens(next, old), ownerSignal); detail = "个人账号已连接。"; return saved!.accessToken;
          })().catch(async error => {
            if (!ownerSignal.aborted) { saved = undefined; detail = "登录刷新结果未确认，请重新登录；未发出办公命令。"; await clear(); publish(); }
            throw Error("FEISHU_USER_REQUIRED");
          });
          refreshFlight = task;
          void task.finally(() => { if (refreshFlight === task) { refreshFlight = undefined; publish(); } }).catch(() => {});
          return waiting(task, signal);
        },
      });
      if (saved && saved.binding !== binding()) { saved = undefined; await clear(); }
      ctx.effect(async () => { controller.abort(); await login; await refreshFlight?.catch(() => {}); await queue; });
    },
  });
}
