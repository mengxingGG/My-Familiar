import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHash } from "node:crypto";
import { join, dirname, delimiter } from "node:path";
import { access, mkdir, readFile } from "node:fs/promises";
import {
  definePlugin,
  type McpConfig,
} from "../../packages/contracts/index.ts";
import { FileStore } from "../home-files/store.ts";
import { runProcess } from "../agent-tools/process.ts";
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export const mcpCredentialScope = (c: McpConfig) =>
  digest(["mcp", c.id, c.transport, c.url, c.command, c.args, c.auth]);
export const amapReadTools = [
  "maps_around_search",
  "maps_search_detail",
  "maps_direction_walking",
  "maps_distance",
  "maps_text_search",
  "maps_geo",
  "maps_regeocode",
  "maps_weather",
];
export const amapPreset: McpConfig = {
  id: "amap",
  name: "高德地图",
  transport: "http",
  url: "https://mcp.amap.com/mcp",
  enabled: false,
  auth: { kind: "query", name: "key" },
};
export function validateMcp(v: any): McpConfig {
  if (
    !v ||
    typeof v.id !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,39}$/.test(v.id) ||
    typeof v.name !== "string" ||
    v.name.length > 100 ||
    typeof v.enabled !== "boolean"
  )
    throw new Error("MCP 名称或开关无效");
  if (!["http", "stdio"].includes(v.transport))
    throw new Error("仅支持 HTTP 或 stdio MCP");
  const c: McpConfig = {
    id: v.id,
    name: v.name,
    transport: v.transport,
    enabled: v.enabled,
  };
  if (v.transport === "http") {
    const url = new URL(v.url);
    if (
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      )
    )
      throw new Error("MCP 地址需 HTTPS 或本地 HTTP，密钥不能放在 URL");
    c.url = url.href;
  } else {
    if (
      typeof v.command !== "string" ||
      !v.command.trim() ||
      v.command.length > 500 ||
      !Array.isArray(v.args) ||
      v.args.length > 40 ||
      v.args.some(
        (a: unknown) => typeof a !== "string" || (a as string).length > 2000,
      )
    )
      throw new Error("MCP 命令或参数无效");
    c.command = v.command;
    c.args = v.args;
  }
  if (v.auth) {
    if (
      !["header", "env", "query"].includes(v.auth.kind) ||
      typeof v.auth.name !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(v.auth.name) ||
      typeof (v.auth.prefix ?? "") !== "string" ||
      /[\r\n]/.test(v.auth.prefix ?? "")
    )
      throw new Error("MCP 鉴权字段无效");
    if ((v.transport === "http") !== ["header", "query"].includes(v.auth.kind))
      throw new Error("鉴权字段与传输不匹配");
    c.auth = {
      kind: v.auth.kind,
      name: v.auth.name,
      prefix: (v.auth.prefix ?? "").slice(0, 100),
    };
  }
  return c;
}
export const mcpClient = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.mcp-client",
    version: "0.2.0",
    provides: ["mcp.manager"],
    requires: ["familiar.home", "agent.tools", "secrets.local"],
    permissions: ["network.mcp", "process.mcp"],
  },
  async start(ctx) {
    ctx.require("network.mcp");
    ctx.require("process.mcp");
    const root = ctx.use("familiar.home").root,
      files = new FileStore(join(root, "mcp")),
      tools = ctx.use("agent.tools"),
      secrets = ctx.use("secrets.local");
    await files.init();
    if (!(await files.exists("servers.json")))
      await files.write(
        "servers.json",
        JSON.stringify(
          [
            amapPreset,
            {
              id: "exa",
              name: "Exa 搜索与网页读取",
              transport: "http",
              url: "https://mcp.exa.ai/mcp",
              enabled: false,
              auth: { kind: "header", name: "x-api-key" },
            },
          ],
          null,
          2,
        ),
        undefined,
        false,
      );
    let configs: McpConfig[] = JSON.parse(await files.read("servers.json")).map(
      validateMcp,
    );
    // 给已有用户补充停用的预置项，不改动他们的其他配置和密钥。
    if (!configs.some((c) => c.id === "amap")) {
      configs.push(amapPreset);
      await files.write("servers.json", JSON.stringify(configs, null, 2));
    }
    const connected = new Map<
        string,
        { client: Client; dispose: (() => void)[]; names: Map<string, string> }
      >(),
      errors = new Map<string, string>(),
      inflight = new Map<string, Promise<{ tools: string[] }>>();
    const scope = mcpCredentialScope;
    const get = (id: string) => {
      const c = configs.find((c) => c.id === id);
      if (!c) throw new Error("MCP 不存在");
      return c;
    };
    const disconnect = async (id: string) => {
      const item = connected.get(id);
      if (item) {
        connected.delete(id);
        item.dispose.forEach((f) => f());
        await item.client.close().catch(() => {});
      }
    };
    const persist = async (next = configs) => {
      await files.write("servers.json", JSON.stringify(next, null, 2));
      configs = next;
    };
    async function connect(id: string) {
      if (inflight.has(id)) return inflight.get(id)!;
      const c = structuredClone(get(id));
      if (!c.enabled) throw new Error("请先启用此 MCP");
      const operation = (async () => {
        await disconnect(id);
        const client = new Client(
          { name: "Familiar", version: "0.2.0" },
          { capabilities: {} },
        );
        const key = secrets.get(scope(c));
        const disposers: (() => void)[] = [];
        client.onclose = () => {
          if (connected.get(id)?.client === client) {
            connected.delete(id);
            disposers.forEach((f) => f());
            if (ctx.active) errors.set(id, "服务已断开，请重新连接");
          }
        };
        try {
          const endpoint = c.url ? new URL(c.url) : undefined;
          if (key && c.auth?.kind === "query")
            endpoint!.searchParams.set(
              c.auth.name,
              (c.auth.prefix ?? "") + key,
            );
          const registeredNames = new Map<string, string>();
          const transport =
            c.transport === "http"
              ? new StreamableHTTPClientTransport(endpoint!, {
                  requestInit: {
                    headers:
                      key && c.auth?.kind === "header"
                        ? { [c.auth.name]: (c.auth.prefix ?? "") + key }
                        : {},
                    redirect: "error",
                  },
                })
              : new StdioClientTransport({
                  command: c.command === "node" ? process.execPath : c.command!,
                  args: c.args ?? [],
                  cwd: join(root, "mcp"),
                  stderr: "pipe",
                  env: {
                    ...(c.command === "node"
                      ? { ELECTRON_RUN_AS_NODE: "1" }
                      : {}),
                    ...(key && c.auth ? { [c.auth.name]: key } : {}),
                  },
                });
          if (transport instanceof StdioClientTransport)
            transport.stderr?.on("data", () => {});
          await client.connect(transport, {
            timeout: 20000,
            signal: ctx.abort.signal,
          });
          let cursor: string | undefined;
          const names: string[] = [];
          const seen = new Set<string>();
          do {
            const page = await client.listTools(cursor ? { cursor } : {}, {
              timeout: 15000,
              signal: ctx.abort.signal,
            });
            for (const t of page.tools) {
              if (names.length >= 100) break;
              const name = `mcp_${c.id}_${digest([scope(c), t.name]).slice(0, 12)}`;
              registeredNames.set(t.name, name);
              const readonlyExa =
                c.url === "https://mcp.exa.ai/mcp" &&
                ["web_search_exa", "web_fetch_exa"].includes(t.name);
              disposers.push(
                tools.register({
                  name,
                  description: `${c.name} · ${t.name}: ${(t.description ?? "").slice(0, 450)}`,
                  parameters: t.inputSchema as Record<string, unknown>,
                  category:
                    readonlyExa && t.name === "web_search_exa"
                      ? "search"
                      : readonlyExa ||
                          (c.url === "https://mcp.amap.com/mcp" &&
                            amapReadTools.includes(t.name)) ||
                          t.annotations?.readOnlyHint === true
                        ? "read"
                        : "mcp",
                  async execute(args, { signal }) {
                    try {
                      const result = await client.callTool(
                        { name: t.name, arguments: args },
                        { signal, timeout: 60000 },
                      );
                      return {
                        isError: result.isError ?? false,
                        structuredContent: result.structuredContent,
                        content: result.content
                          .filter((v) => v.type === "text")
                          .map((v) => (v as { text: string }).text)
                          .join("\n"),
                      };
                    } catch {
                      throw new Error("MCP 工具调用失败或已取消，请检查连接");
                    }
                  },
                }),
              );
              names.push(t.name);
            }
            cursor = page.nextCursor;
            if (cursor && seen.has(cursor)) throw new Error("分页循环");
            if (cursor) seen.add(cursor);
          } while (cursor && names.length < 100);
          if (
            !ctx.active ||
            digest(get(id)) !== digest(c) ||
            secrets.get(scope(c)) !== key
          )
            throw new Error("连接配置已变化");
          connected.set(id, {
            client,
            dispose: disposers,
            names: registeredNames,
          });
          errors.delete(id);
          return { tools: names };
        } catch {
          disposers.forEach((f) => f());
          await client.close().catch(() => {});
          errors.set(id, "连接失败：请检查服务、鉴权和传输类型");
          throw new Error(errors.get(id));
        }
      })();
      inflight.set(id, operation);
      try {
        return await operation;
      } finally {
        inflight.delete(id);
      }
    }
    let queue = Promise.resolve();
    const serial = <T>(fn: () => Promise<T>) => {
      const p = queue.then(fn);
      queue = p.then(
        () => {},
        () => {},
      );
      return p;
    };
    ctx.provide("mcp.manager", {
      list: async () =>
        configs.map((c) => ({
          ...c,
          connected: connected.has(c.id),
          tools: connected.get(c.id)?.dispose.length ?? 0,
          hasKey: secrets.has(scope(c)),
          error: errors.get(c.id),
        })),
      save: (input) =>
        serial(async () => {
          const c = validateMcp(input);
          if (configs.length >= 30 && !configs.some((v) => v.id === c.id))
            throw new Error("最多 30 个 MCP");
          await disconnect(c.id);
          await persist([...configs.filter((v) => v.id !== c.id), c]);
        }),
      setKey: (id, key) =>
        serial(async () => {
          await disconnect(id);
          await secrets.set(scope(get(id)), key);
        }),
      connect,
      async callReadOnly(id, tool, args, signal) {
        const c = get(id);
        if (
          c.url !== "https://mcp.amap.com/mcp" ||
          !amapReadTools.includes(tool)
        )
          throw new Error("不是允许的高德只读查询");
        if (!connected.has(id)) await connect(id);
        const name = connected.get(id)?.names.get(tool);
        if (!name) throw new Error("高德服务未提供此工具");
        return JSON.parse(
          await tools.run(
            { id: "care-" + Date.now(), name, arguments: JSON.stringify(args) },
            signal,
          ),
        );
      },
      remove: (id) =>
        serial(async () => {
          get(id);
          await disconnect(id);
          await persist(configs.filter((c) => c.id !== id));
        }),
      installPackage: (id, pkg, signal = ctx.abort.signal) =>
        serial(async () => {
          signal = AbortSignal.any([signal, ctx.abort.signal]);
          signal.throwIfAborted();
          if (
            !/^[a-z0-9][a-z0-9-]{0,39}$/.test(id) ||
            !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(
              pkg,
            )
          )
            throw new Error("填写固定版本 npm 包，例如 example-mcp@1.2.3");
          if (configs.some((c) => c.id === id))
            throw new Error("MCP ID 已存在");
          const installDir = await files.path(`servers/${id}`, true);
          await mkdir(installDir, { recursive: true });
          let npm = "";
          for (const dir of (process.env.PATH ?? "").split(delimiter)) {
            const candidate = join(dir, "node_modules/npm/bin/npm-cli.js");
            try {
              await access(candidate);
              npm = candidate;
              break;
            } catch {}
          }
          if (!npm)
            throw new Error("未找到 npm；请安装 Node.js 或手动安装后导入配置");
          const result = await runProcess(
            process.execPath,
            [
              npm,
              "install",
              "--prefix",
              installDir,
              "--ignore-scripts",
              "--no-audit",
              "--no-fund",
              "--save-exact",
              pkg,
            ],
            installDir,
            signal,
            { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          );
          if (result.code !== 0) throw new Error("npm 安装失败，未注册 MCP");
          const packageName = pkg.slice(0, pkg.lastIndexOf("@")),
            packageDir = join(installDir, "node_modules", packageName),
            manifest = JSON.parse(
              await readFile(join(packageDir, "package.json"), "utf8"),
            );
          const bin =
            typeof manifest.bin === "string"
              ? manifest.bin
              : Object.values(manifest.bin ?? {})[0];
          if (typeof bin !== "string") throw new Error("包未提供可执行入口");
          const packageFiles = new FileStore(packageDir);
          const entry = await packageFiles.path(bin.replace(/^\.\//, ""));
          await access(entry);
          await persist([
            ...configs,
            {
              id,
              name: packageName,
              transport: "stdio",
              command: "node",
              args: [entry],
              enabled: false,
            },
          ]);
        }),
    });
    for (const c of configs)
      if (c.enabled)
        ctx.timeout(async () => {
          await connect(c.id).catch(() => {});
        }, 100);
    ctx.effect(async () => {
      await queue;
      await Promise.allSettled([...inflight.values()]);
      await Promise.all([...connected.keys()].map(disconnect));
    });
  },
});
