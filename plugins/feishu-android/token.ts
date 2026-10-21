/** 可信宿主可替换传输做隔离测试；网页和模型不能设置认证端点。 */
export function tenantTokenClient(fetcher: typeof fetch = fetch, now = Date.now) {
  let cached: { appId: string; secret: string; token: string; expires: number } | undefined;
  return {
    clear() { cached = undefined; },
    async get(appId: string, secret: string, signal: AbortSignal): Promise<string> {
      signal.throwIfAborted();
      if (cached?.appId === appId && cached.secret === secret && cached.expires > now()) return cached.token;
      // 按官方 OAuth v3 返回的 expires_in 提前更新；不落盘，不输出服务端原文。
      const active = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
      try {
        const response = await fetcher("https://accounts.feishu.cn/oauth/v3/token", {
          method: "POST", redirect: "error", signal: active,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grant_type: "client_credentials", client_id: appId, client_secret: secret }),
        });
        if (!response.ok || !response.body) { await response.body?.cancel(); throw Error(); }
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 65536) throw Error(); chunks.push(value); }
        } finally { await reader.cancel().catch(() => {}); }
        const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (data.code !== 0 || data.token_type !== "Bearer" || typeof data.access_token !== "string" || !data.access_token ||
            data.access_token.length > 16384 || /[\s\x00-\x1f]/.test(data.access_token) || !Number.isSafeInteger(data.expires_in) || data.expires_in < 1 || data.expires_in > 86400) throw Error();
        active.throwIfAborted();
        cached = { appId, secret, token: data.access_token, expires: now() + Math.max(0, data.expires_in - Math.min(60, data.expires_in / 10)) * 1000 };
        return cached.token;
      } catch { signal.throwIfAborted(); throw Error("FEISHU_AUTH_FAILED"); }
    },
  };
}
