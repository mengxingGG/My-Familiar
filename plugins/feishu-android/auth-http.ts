const accounts = "https://accounts.feishu.cn";
const tokenEndpoint = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
export const validScopes = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 100 && value.every(v => typeof v === "string" && (v === "offline_access" || /^[a-zA-Z0-9_.-]+(?::[a-zA-Z0-9_.-]+)+$/.test(v))) && value.join(" ").length <= 3000;
const secret = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 16384 && !/[\s\x00-\x1f]/.test(value);
const lifetime = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= max;
export function officialAuthorizationUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try { const url = new URL(value); return url.origin === accounts && !url.username && !url.password && !url.hash; } catch { return false; }
}
export interface OAuthTokens { accessToken: string; refreshToken: string; expiresIn: number; refreshExpiresIn: number; scopes: string[]; }
export interface DeviceAuthorization { deviceCode: string; userCode: string; url: string; expiresIn: number; interval: number; }
function tokens(value: Record<string, unknown>): OAuthTokens {
  const scopes = typeof value.scope === "string" ? value.scope.trim().split(/\s+/).filter(Boolean) : [];
  if (!secret(value.access_token) || !lifetime(value.expires_in, 86400) || !validScopes(scopes) ||
      value.refresh_token !== undefined && value.refresh_token !== "" && (!secret(value.refresh_token) || !lifetime(value.refresh_token_expires_in, 366 * 86400))) throw Error("AUTH_RESPONSE_INVALID");
  return { accessToken: value.access_token, refreshToken: String(value.refresh_token ?? ""), expiresIn: value.expires_in, refreshExpiresIn: value.refresh_token ? Number(value.refresh_token_expires_in) : 0, scopes };
}
/** 依据官方 CLI v1.0.96 的设备授权与刷新协议，端点不接受网页覆盖。 */
export function feishuOAuthHttp(fetcher: typeof fetch = fetch) {
  async function request(url: string, init: RequestInit, signal: AbortSignal) {
    signal.throwIfAborted();
    try {
      const response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
      if (!response.body) throw Error();
      const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 65536) throw Error(); chunks.push(value); } }
      finally { await reader.cancel().catch(() => {}); }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) throw Error();
      signal.throwIfAborted(); return { data: data as Record<string, any>, ok: response.ok };
    } catch { signal.throwIfAborted(); throw Error("AUTH_NETWORK_FAILED"); }
  }
  return {
    async start(appId: string, appSecret: string, scopes: string[], signal: AbortSignal): Promise<DeviceAuthorization> {
      if (!validScopes(scopes)) throw Error("INVALID_INPUT");
      const { data, ok } = await request(accounts + "/oauth/v1/device_authorization", { method: "POST", headers: {
        "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(appId + ":" + appSecret).toString("base64"),
      }, body: new URLSearchParams({ client_id: appId, scope: [...new Set([...scopes, "offline_access"])].join(" ") }).toString() }, signal);
      const url = data.verification_uri_complete || data.verification_uri;
      if (!ok || data.error || !secret(data.device_code) || typeof data.user_code !== "string" || !/^[A-Za-z0-9 -]{1,100}$/.test(data.user_code) ||
          !officialAuthorizationUrl(url) || !lifetime(data.expires_in, 1800) || data.interval !== undefined && !lifetime(data.interval, 60)) throw Error("AUTH_START_FAILED");
      return { deviceCode: data.device_code, userCode: data.user_code, url, expiresIn: data.expires_in, interval: data.interval ?? 5 };
    },
    async poll(appId: string, appSecret: string, deviceCode: string, signal: AbortSignal): Promise<OAuthTokens | "pending" | "slow"> {
      const { data, ok } = await request(tokenEndpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: appId, client_secret: appSecret }).toString() }, signal);
      if (data.error === "authorization_pending") return "pending";
      if (data.error === "slow_down") return "slow";
      if (data.error === "access_denied") throw Error("AUTH_DENIED");
      if (["expired_token", "invalid_grant"].includes(data.error)) throw Error("AUTH_EXPIRED");
      if (!ok || data.error || data.code !== undefined && data.code !== 0) throw Error("AUTH_POLL_FAILED");
      return tokens(data);
    },
    async user(accessToken: string, signal: AbortSignal) {
      const { data, ok } = await request("https://open.feishu.cn/open-apis/authen/v1/user_info", { headers: { Authorization: "Bearer " + accessToken } }, signal);
      if (!ok || data.code !== 0 || typeof data.data?.open_id !== "string" || !/^ou_[a-zA-Z0-9_-]{1,100}$/.test(data.data.open_id) || typeof data.data.name !== "string" || data.data.name.length > 200) throw Error("AUTH_USER_FAILED");
      return { id: data.data.open_id as string, name: data.data.name as string };
    },
    async refresh(appId: string, appSecret: string, refreshToken: string, signal: AbortSignal) {
      const { data, ok } = await request(tokenEndpoint, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ grant_type: "refresh_token", client_id: appId, client_secret: appSecret, refresh_token: refreshToken }) }, signal);
      if (!ok || data.error || data.code !== undefined && data.code !== 0) throw Error("AUTH_REFRESH_FAILED");
      return tokens(data);
    },
  };
}
