import type { Kernel } from "../../../packages/kernel/index.ts";
import type { MobileMcpServer } from "../../../packages/mobile-contracts/mcp.ts";
import { validateMcp, mcpRevision } from "../../../plugins/mcp-client/index.ts";
import { githubConfig } from "../../../plugins/github-integration/config.ts";

const input: (ok: unknown) => asserts ok = (ok) => {
  if (!ok) throw Error("INVALID_INPUT");
};
const id = (v: unknown): string => {
  input(typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(v));
  return v;
};
const revision = (v: unknown): string => {
  input(typeof v === "string" && /^[a-f0-9]{64}$/.test(v));
  return v;
};
/** 配置和连接归属共享 MCP；此处只投影公开字段与管理取消请求。 */
export function mobileMcp(kernel: Kernel) {
  const manager = kernel.resolve("mcp.manager");
  const active = new Map<string, { id: string; abort: AbortController }>();
  const list = async (): Promise<MobileMcpServer[]> =>
    (await manager.list())
      .filter((s) => s.transport === "http")
      .map((s) => ({
        id: s.id,
        name: s.name,
        transport: "http",
        url: s.url!,
        enabled: s.enabled,
        ...(s.auth
          ? {
              auth: {
                kind: s.auth.kind as "header" | "query",
                name: s.auth.name,
                prefix: s.auth.prefix ?? "",
              },
            }
          : {}),
        revision: mcpRevision(s),
        connected: s.connected,
        hasKey: s.hasKey,
        tools: s.tools,
        toolNames: (s.toolNames ?? []).slice(0, 256),
        ...(s.error
          ? { error: "连接未就绪，请检查服务地址、鉴权和网络。" }
          : {}),
      }));
  const abortFor = (target: string) => {
    for (const item of active.values())
      if (item.id === target) item.abort.abort();
  };
  return async (method: string, p: Record<string, unknown> = {}) => {
    if (method === "mcp.list") return list();
    if (method === "mcp.connect.cancel") {
      input(typeof p.operationId === "string" && p.operationId.length <= 100);
      const item = active.get(p.operationId);
      if (item) {
        item.abort.abort();
        await manager.disconnect(item.id);
      }
      return;
    }
    if (method === "mcp.save" || method === "mcp.github.save") {
      const github = method === "mcp.github.save";
      if (github) {
        input(Object.keys(p).every(k => ["enabled", "readOnly", "revision", "apiKey", "clearApiKey"].includes(k)));
        input(typeof p.enabled === "boolean" && typeof p.readOnly === "boolean");
      }
      let config;
      try {
        config = validateMcp(github ? githubConfig(p.readOnly as boolean, p.clearApiKey ? false : p.enabled as boolean) : p.config);
      } catch {
        throw Error("INVALID_INPUT");
      }
      input(config.transport === "http" && typeof config.url === "string" && config.url.length<=2000);
      input(
        p.revision === null ||
          (typeof p.revision === "string" && /^[a-f0-9]{64}$/.test(p.revision)),
      );
      input(
        p.apiKey === undefined ||
          (typeof p.apiKey === "string" &&
            p.apiKey.length <= 8000 &&
            !/[\r\n]/.test(p.apiKey)),
      );
      input(p.clearApiKey === undefined || typeof p.clearApiKey === "boolean");
      input(!(p.clearApiKey && p.apiKey));
      input(!p.apiKey || config.auth);
      abortFor(config.id);
      await manager.save(config, {
        expectedRevision: p.revision as string | null,
        ...(github ? { officialGithub: true as const } : {}),
        ...(p.clearApiKey
          ? { key: "" }
          : p.apiKey
            ? { key: p.apiKey as string }
            : {}),
      });
      return (await list()).find((v) => v.id === config.id)!;
    }
    const target = id(p.id);
    if (method === "mcp.disconnect") {
      abortFor(target);
      await manager.disconnect(target);
      return;
    }
    if (method === "mcp.remove") {
      const version = revision(p.revision);
      abortFor(target);
      await manager.remove(target, {
        expectedRevision: version,
        clearKey: true,
      });
      return;
    }
    if (method === "mcp.connect") {
      const version = revision(p.revision);
      input(
        typeof p.operationId === "string" &&
          /^[a-zA-Z0-9:_-]{1,100}$/.test(p.operationId),
      );
      if (
        active.has(p.operationId) ||
        [...active.values()].some((v) => v.id === target)
      )
        throw Error("BUSY");
      const abort = new AbortController();
      active.set(p.operationId, { id: target, abort });
      try {
        return await manager.connect(target, {
          signal: abort.signal,
          expectedRevision: version,
        });
      } catch (e) {
        throw Error(
          abort.signal.aborted
            ? "CANCELLED"
            : (e as Error).message === "CONFLICT"
              ? "CONFLICT"
              : "PROVIDER",
        );
      } finally {
        active.delete(p.operationId);
      }
    }
    throw Error("UNAVAILABLE");
  };
}
