import {
  MobileBridgeError,
  type MobileMcpServer,
} from "../mobile-contracts/index.ts";
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const assert: (v: unknown) => asserts v = (v) => {
  if (!v) throw new MobileBridgeError("UNAVAILABLE", "MCP 返回内容不兼容");
};
const string = (v: unknown, max: number) =>
  typeof v === "string" && v.length <= max;
const names = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= 256 && v.every((x) => string(x, 1000));
const server = (v: unknown): MobileMcpServer => {
  assert(
    object(v) &&
      string(v.id, 40) &&
      /^[a-z0-9][a-z0-9-]*$/.test(v.id as string) &&
      string(v.name, 100) &&
      v.transport === "http" &&
      string(v.url, 2000) &&
      typeof v.enabled === "boolean" &&
      typeof v.connected === "boolean" &&
      typeof v.hasKey === "boolean" &&
      Number.isInteger(v.tools) &&
      (v.tools as number) >= 0 &&
      (v.tools as number) <= 256 &&
      names(v.toolNames) &&
      typeof v.revision === "string" &&
      /^[a-f0-9]{64}$/.test(v.revision),
  );
  let url;
  try {
    url = new URL(v.url as string);
  } catch {
    throw new MobileBridgeError("UNAVAILABLE", "MCP 返回地址不兼容");
  }
  assert(
    !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))),
  );
  assert(v.error === undefined || string(v.error, 300));
  if (v.auth !== undefined)
    assert(
      object(v.auth) &&
        ["header", "query"].includes(String(v.auth.kind)) &&
        string(v.auth.name, 100) &&
        string(v.auth.prefix ?? "", 100),
    );
  const a = v.auth as Record<string, unknown> | undefined;
  return {
    id: v.id as string,
    name: v.name as string,
    transport: "http",
    url: v.url as string,
    enabled: v.enabled,
    connected: v.connected,
    hasKey: v.hasKey,
    revision: v.revision,
    tools: v.tools as number,
    toolNames: [...v.toolNames],
    ...(v.error ? { error: v.error as string } : {}),
    ...(a
      ? {
          auth: {
            kind: a.kind as "header" | "query",
            name: a.name as string,
            prefix: (a.prefix ?? "") as string,
          },
        }
      : {}),
  };
};
export function projectMcpResult(method: string, value: unknown): unknown {
  if (method === "mcp.list") {
    assert(Array.isArray(value) && value.length <= 30);
    return value.map(server);
  }
  if (method === "mcp.save" || method === "mcp.github.save") return server(value);
  if (method === "mcp.connect") {
    assert(object(value) && names(value.tools));
    return { tools: [...value.tools] };
  }
  if (["mcp.connect.cancel", "mcp.disconnect", "mcp.remove"].includes(method))
    return undefined;
  throw new MobileBridgeError("UNAVAILABLE", "未知 MCP 返回");
}
