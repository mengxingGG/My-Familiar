import { MobileBridgeError, type MobileFeishuStatus } from "../mobile-contracts/index.ts";
const validScopes = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 100 && v.every(s => typeof s === "string" && (s === "offline_access" || /^[a-zA-Z0-9_.-]+(?::[a-zA-Z0-9_.-]+)+$/.test(s))) && v.join(" ").length <= 3000;
const officialUrl = (v: unknown) => { try { const u = new URL(String(v)); return typeof v === "string" && v.length <= 4096 && u.origin === "https://accounts.feishu.cn" && !u.username && !u.password && !u.hash; } catch { return false; } };
export function projectFeishuResult(value: unknown): MobileFeishuStatus {
  const s = value as MobileFeishuStatus;
  if (!s || typeof s.appId !== "string" || !/^(?:cli_[0-9a-fA-F]{16})?$/.test(s.appId) || typeof s.enabled !== "boolean" || typeof s.hasSecret !== "boolean" ||
      !Array.isArray(s.allowedUsers) || s.allowedUsers.length > 20 || !s.allowedUsers.every(id => typeof id === "string" && /^ou_[a-zA-Z0-9_-]{1,100}$/.test(id)) ||
      typeof s.revision !== "string" || !/^[a-f0-9-]{36}$/.test(s.revision) || !["off", "waiting", "connecting", "connected", "reconnecting", "error"].includes(s.phase) ||
      typeof s.detail !== "string" || s.detail.length > 300 || !Number.isInteger(s.pending) || s.pending < 0 || s.pending > 20 ||
      s.pairing !== undefined && (!s.pairing || typeof s.pairing.code !== "string" || !/^[A-F0-9]{8}$/.test(s.pairing.code) || !Number.isSafeInteger(s.pairing.expires) || s.pairing.expires < 0)) throw new MobileBridgeError("UNAVAILABLE", "飞书状态不兼容");
  const o = s.office;
  if (o !== undefined && (!o || typeof o.enabled !== "boolean" || typeof o.available !== "boolean" || typeof o.checking !== "boolean" || !["bot", "user"].includes(o.identity) ||
      typeof o.revision !== "string" || !/^[a-f0-9-]{36}$/.test(o.revision) || typeof o.appId !== "string" || !/^(?:cli_[0-9a-fA-F]{16})?$/.test(o.appId) ||
      typeof o.detail !== "string" || o.detail.length > 300 || !Number.isSafeInteger(o.pending) || o.pending < 0 || o.pending > 100 ||
      o.missingScopes !== undefined && !validScopes(o.missingScopes) || o.checkedAt !== undefined && (!Number.isSafeInteger(o.checkedAt) || o.checkedAt < 0))) throw new MobileBridgeError("UNAVAILABLE", "飞书办公状态不兼容");
  const a = s.auth;
  if (a !== undefined && (!a || typeof a.revision !== "string" || !/^[a-f0-9-]{36}$/.test(a.revision) || typeof a.connected !== "boolean" ||
      !["signedOut", "authorizing", "connected", "refreshing", "error"].includes(a.phase) || typeof a.detail !== "string" || a.detail.length > 300 || a.appId !== s.appId || !validScopes(a.scopes) ||
      a.user !== undefined && (!a.user || typeof a.user.id !== "string" || !/^ou_[a-zA-Z0-9_-]{1,100}$/.test(a.user.id) || typeof a.user.name !== "string" || a.user.name.length > 200) ||
      a.authorization !== undefined && (!a.authorization || !officialUrl(a.authorization.url) || typeof a.authorization.userCode !== "string" || !/^[A-Za-z0-9 -]{1,100}$/.test(a.authorization.userCode) || !Number.isSafeInteger(a.authorization.expiresAt) || a.authorization.expiresAt < 0))) throw new MobileBridgeError("UNAVAILABLE", "飞书登录状态不兼容");
  return { appId: s.appId, enabled: s.enabled, hasSecret: s.hasSecret, allowedUsers: [...s.allowedUsers], revision: s.revision, phase: s.phase, detail: s.detail, pending: s.pending,
    ...(o ? { office: { enabled: o.enabled, available: o.available, checking: o.checking, identity: o.identity, revision: o.revision, appId: o.appId, detail: o.detail, pending: o.pending, ...(o.missingScopes ? { missingScopes: [...o.missingScopes] } : {}), ...(o.checkedAt ? { checkedAt: o.checkedAt } : {}) } } : {}),
    ...(a ? { auth: { revision: a.revision, connected: a.connected, phase: a.phase, detail: a.detail, appId: a.appId, scopes: [...a.scopes], ...(a.user ? { user: { id: a.user.id, name: a.user.name } } : {}), ...(a.authorization ? { authorization: { url: a.authorization.url, userCode: a.authorization.userCode, expiresAt: a.authorization.expiresAt } } : {}) } } : {}),
    ...(s.pairing ? { pairing: { code: s.pairing.code, expires: s.pairing.expires } } : {}) };
}
