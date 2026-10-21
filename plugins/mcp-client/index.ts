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
  type ToolEntry,
} from "../../packages/contracts/index.ts";
import { FileStore } from "../home-files/store.ts";
import { runProcess } from "../agent-tools/process.ts";
import { githubConfig, isGithubConfig } from "../github-integration/config.ts";
import { isGithubDeviceCredential } from "../github-integration/device-auth.ts";
import { deferredToolCatalog } from "../agent-tools/catalog.ts";
import {
  githubToolAccess,
  isOfficialGithub,
  githubBusinessSchema,
  guardGithubBusinessArgs,
} from "../github-integration/policy.ts";
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export const mcpCredentialScope = (c: McpConfig) =>
  digest(["mcp", c.id, c.transport, c.url, c.command, c.args, c.auth]);
export const mcpRevision = (c: McpConfig) => digest(validateMcp(c));
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
/** 手机使用 HTTP 传输；桌面继续保留本机 stdio 进程能力。 */
export function createMcpClient(
  options: { stdio?: boolean; trustReadOnlyHints?: boolean; githubWritesRequireApproval?: boolean; deferLargeCatalogs?: boolean; githubDeviceAuth?: boolean } = {},
) {
  const stdio = options.stdio !== false;
  return definePlugin({
    manifest: {
      manifestVersion: 1,
      id: "familiar.mcp-client",
      version: "0.2.0",
      provides: ["mcp.manager"],
      requires: [
        "familiar.home",
        "agent.tools",
        "secrets.local",
        "media.assets",
        ...(options.githubDeviceAuth ? ['github.deviceAuth' as const] : []),
      ],
      permissions: stdio ? ["network.mcp", "process.mcp"] : ["network.mcp"],
    },
    async start(ctx) {
      ctx.require("network.mcp");
      if (stdio) ctx.require("process.mcp");
      const root = ctx.use("familiar.home").root,
        files = new FileStore(join(root, "mcp")),
        tools = ctx.use("agent.tools"),
        secrets = ctx.use("secrets.local");
      const githubAuth = options.githubDeviceAuth ? ctx.use('github.deviceAuth') : undefined;
      const credentialAvailable = (c: McpConfig) => {
        const value=secrets.get(scope(c));
        return isGithubDeviceCredential(value) ? !!(isOfficialGithub(c) && githubAuth?.available(value)) : secrets.has(scope(c));
      };
      const catalog = deferredToolCatalog(tools);
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
      let configs: McpConfig[] = JSON.parse(
        await files.read("servers.json"),
      ).map(validateMcp);
      // 给已有用户补充停用的预置项，不改动他们的其他配置和密钥。
      if (!configs.some((c) => c.id === "amap")) {
        configs.push(amapPreset);
        await files.write("servers.json", JSON.stringify(configs, null, 2));
      }
      const connected = new Map<
          string,
          {
            client: Client;
            dispose: (() => void)[];
            names: Map<string, string>;
          }
        >(),
        errors = new Map<string, string>(),
        inflight = new Map<
          string,
          {
            abort: AbortController;
            signal: AbortSignal;
            promise: Promise<{ tools: string[] }>;
          }
        >();
      const scope = mcpCredentialScope;
      const get = (id: string) => {
        const c = configs.find((c) => c.id === id);
        if (!c) throw new Error("MCP 不存在");
        return c;
      };
      const disconnectConnected = async (id: string) => {
        const item = connected.get(id);
        if (item) {
          connected.delete(id);
          item.dispose.forEach((f) => f());
          await item.client.close().catch(() => {});
        }
      };
      const disconnect = async (id: string) => {
        inflight.get(id)?.abort.abort();
        await disconnectConnected(id);
      };
      const persist = async (next = configs) => {
        await files.write("servers.json", JSON.stringify(next, null, 2));
        configs = next;
      };
      async function connect(
        id: string,
        request?: { signal?: AbortSignal; expectedRevision?: string },
      ) {
        if (
          request?.expectedRevision !== undefined &&
          mcpRevision(get(id)) !== request.expectedRevision
        )
          throw new Error("CONFLICT");
        const previous = inflight.get(id);
        if (previous && !previous.signal.aborted) return previous.promise;
        const c = structuredClone(get(id));
        if (!c.enabled) throw new Error("请先启用此 MCP");
        if (!stdio && c.transport !== "http")
          throw new Error("此设备仅支持 HTTP MCP");
        const abort = new AbortController();
        const signal = AbortSignal.any([
          ctx.abort.signal,
          abort.signal,
          ...(request?.signal ? [request.signal] : []),
          AbortSignal.timeout(45000),
        ]);
        const operation = (async () => {
          await disconnectConnected(id);
          const client = new Client(
            { name: "Familiar", version: "0.2.0" },
            { capabilities: {} },
          );
          const storedCredential = secrets.get(scope(c));
          const deviceCredential = isGithubDeviceCredential(storedCredential);
          if (deviceCredential && (!isOfficialGithub(c) || !githubAuth?.available(storedCredential))) throw Error('GITHUB_LOGIN_REQUIRED');
          const key = deviceCredential ? await githubAuth!.token(storedCredential, signal) : storedCredential;
          const disposers: (() => void)[] = [];
          client.onclose = () => {
            if (connected.get(id)?.client === client) {
              connected.delete(id);
              disposers.forEach((f) => f());
              if (ctx.active) errors.set(id, "服务已断开，请重新连接");
            }
          };
          try {
            signal.throwIfAborted();
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
                    ...(deviceCredential ? {fetch: async (input: string | URL | Request, init?: RequestInit) => {
                      const request=new Request(input,init);
                      if(request.url!==c.url||secrets.get(scope(c))!==storedCredential)throw Error('MCP 连接已变化');
                      const token=await githubAuth!.token(storedCredential,AbortSignal.any([ctx.abort.signal,request.signal]));
                      if(secrets.get(scope(c))!==storedCredential||!githubAuth!.available(storedCredential))throw Error('MCP 登录已变化');
                      request.headers.set('Authorization','Bearer '+token);
                      return fetch(request,{redirect:'error'});
                    }} : {}),
                    requestInit: {
                      headers: {
                        ...(isOfficialGithub(c)
                          ? { "X-MCP-Toolsets": "all" }
                          : {}),
                        ...(key && c.auth?.kind === "header"
                          ? { [c.auth.name]: (c.auth.prefix ?? "") + key }
                          : {}),
                      },
                      redirect: "error",
                    },
                  })
                : new StdioClientTransport({
                    command:
                      c.command === "node" ? process.execPath : c.command!,
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
              signal,
            });
            let cursor: string | undefined;
            const names: string[] = [];
            const definitions: { name: string; tool: ToolEntry }[] = [];
            const seen = new Set<string>();
            let pages = 0;
            do {
              if (++pages > 32) throw new Error("MCP 工具分页过多");
              const page = await client.listTools(cursor ? { cursor } : {}, {
                timeout: 15000,
                signal,
              });
              for (const t of page.tools) {
                if (
                names.length >= 256 || t.name.length>1000 ||
                  registeredNames.has(t.name) ||
                  JSON.stringify(t.inputSchema).length > 100000
                )
                  throw new Error("MCP 工具列表过大或重复");
                const githubAccess = githubToolAccess(c, t.name);
                if (githubAccess === false) continue;
                const githubCategory = githubAccess === "write" && options.githubWritesRequireApproval ? "outsideWrite" : githubAccess;
                const name = `mcp_${c.id}_${digest([scope(c), t.name]).slice(0, 12)}`;
                registeredNames.set(t.name, name);
                const readonlyExa =
                  c.url === "https://mcp.exa.ai/mcp" &&
                  ["web_search_exa", "web_fetch_exa"].includes(t.name);
                definitions.push({ name: t.name, tool: {
                    name,
                    description: `${c.name} · ${t.name}: ${(t.description ?? "").slice(0, 450)}`,
                    parameters: githubAccess
                      ? githubBusinessSchema(
                          t.name,
                          t.inputSchema as Record<string, unknown>,
                        )
                      : (t.inputSchema as Record<string, unknown>),
                    ...(githubAccess
                      ? {
                          permission: async (args: Record<string, unknown>) => {
                            guardGithubBusinessArgs(t.name, args);
                            return {
                              category: githubCategory as "read" | "write" | "outsideWrite",
                              scope: JSON.stringify(args),
                            };
                          },
                        }
                      : {}),
                    category:
                      githubCategory ??
                      (readonlyExa && t.name === "web_search_exa"
                        ? "search"
                        : readonlyExa ||
                            (c.url === "https://mcp.amap.com/mcp" &&
                              amapReadTools.includes(t.name)) ||
                            (options.trustReadOnlyHints !== false &&
                              t.annotations?.readOnlyHint === true)
                          ? "read"
                          : "mcp"),
                    async execute(args, { signal }) {
                      if (
                        connected.get(id)?.client !== client ||
                        digest(get(id)) !== digest(c) ||
                        secrets.get(scope(c)) !== storedCredential || deviceCredential && !githubAuth!.available(storedCredential)
                      )
                        throw new Error("MCP 连接已变化，请重新读取工具");
                      if (githubAccess) guardGithubBusinessArgs(t.name, args);
                      try {
                        const result = await client.callTool(
                          { name: t.name, arguments: args },
                          { signal, timeout: 60000 },
                        );
                        const images = result.content.filter(
                          (v) => v.type === "image",
                        );
                        if (images.length > 8)
                          throw new Error("MCP 返回图片过多");
                        if (images.length) {
                          const attachments = [];
                          for (const item of images) {
                            const img = item as {
                              data: string;
                              mimeType: string;
                            };
                            if (
                              typeof img.data !== "string" ||
                              img.data.length > 16 * 1024 * 1024
                            )
                              throw new Error("MCP 图片过大");
                            attachments.push(
                              await ctx
                                .use("media.assets")
                                .add(
                                  `${c.name}-${t.name}`,
                                  img.mimeType,
                                  Buffer.from(img.data, "base64"),
                                  "mcp",
                                ),
                            );
                          }
                          return {
                            type: "familiar.multimodal",
                            text: JSON.stringify({
                              isError: result.isError ?? false,
                              structuredContent: result.structuredContent,
                              content: result.content
                                .filter((v) => v.type === "text")
                                .map((v) => (v as { text: string }).text)
                                .join("\n"),
                            }),
                            attachments,
                          };
                        }
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
                  } });
                names.push(t.name);
              }
              cursor = page.nextCursor;
              if (cursor && seen.has(cursor)) throw new Error("分页循环");
              if (cursor) seen.add(cursor);
            } while (cursor);
            if (
              !ctx.active ||
              signal.aborted ||
              digest(get(id)) !== digest(c) ||
              secrets.get(scope(c)) !== storedCredential || deviceCredential && !githubAuth!.available(storedCredential)
            )
              throw new Error("连接配置已变化");
            const deferred = options.deferLargeCatalogs && (definitions.length > 12 || Buffer.byteLength(JSON.stringify(definitions.map(d => ({ name: d.tool.name, description: d.tool.description, parameters: d.tool.parameters })))) > 6000);
            for (const definition of definitions) {
              definition.tool = { ...definition.tool, ...(deferred ? { advertised: false } : {}) };
              disposers.push(tools.register(definition.tool));
            }
            if (deferred) disposers.push(catalog.add(c.id, c.name, definitions));
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
            // 迟到的旧连接不能覆盖新连接状态，也不能把取消显示为服务故障。
            if (!signal.aborted)
              errors.set(id, "连接失败：请检查服务、鉴权和传输类型");
            throw new Error(
              signal.aborted
                ? "连接已取消或超时"
                : "连接失败：请检查服务、鉴权和传输类型",
            );
          }
        })();
        inflight.set(id, { abort, signal, promise: operation });
        try {
          return await operation;
        } finally {
          if (inflight.get(id)?.promise === operation) inflight.delete(id);
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
            tools: connected.get(c.id)?.names.size ?? 0,
            toolNames: [...(connected.get(c.id)?.names.keys() ?? [])],
            hasKey: credentialAvailable(c),
            error: errors.get(c.id),
          })),
        save: (input, update) =>
          serial(async () => {
            const c = validateMcp(input);
            if (!stdio && c.transport !== "http")
              throw new Error("此设备仅支持 HTTP MCP");
            const existing = configs.find((v) => v.id === c.id);
            if (
              update?.expectedRevision !== undefined &&
              (existing ? mcpRevision(existing) : null) !==
                update.expectedRevision
            )
              throw new Error("CONFLICT");
            if(update?.expectedKey!==undefined&&(existing?secrets.get(scope(existing)):'')!==update.expectedKey)throw Error('CONFLICT');
            if (
              update?.key !== undefined &&
              (typeof update.key !== "string" ||
                update.key.length > 8000 ||
                /[\r\n]/.test(update.key))
            )
              throw new Error("INVALID_INPUT");
            if (configs.length >= 30 && !configs.some((v) => v.id === c.id))
              throw new Error("最多 30 个 MCP");
            // 在同一串行队列内复核旧配置，只允许官方两种模式之间保留 Token。
            let githubKey: string | undefined;
            if (update?.officialGithub) {
              if (!isGithubConfig(c) || (existing && !isGithubConfig(existing)))
                throw new Error("INVALID_INPUT");
              githubKey = update.key ?? (existing ? secrets.get(scope(existing)) : "") ?? "";
              if (c.enabled && !githubKey) throw new Error("INVALID_INPUT");
            }
            await disconnect(c.id);
            await persist([...configs.filter((v) => v.id !== c.id), c]);
            await disconnect(c.id);
            if (update?.key !== undefined && githubKey === undefined) {
              await secrets.set(scope(c), update.key);
              await disconnect(c.id);
            }
            if (githubKey !== undefined) {
              await secrets.set(scope(c), githubKey);
              const alternate = githubConfig(!c.url!.endsWith("/readonly"));
              await secrets.set(scope(alternate), "");
              await disconnect(c.id);
            }
          }),
        setKey: (id, key) =>
          serial(async () => {
            await disconnect(id);
            await secrets.set(scope(get(id)), key);
            await disconnect(id);
          }),
        connect,
        disconnect,
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
              {
                id: "care-" + Date.now(),
                name,
                arguments: JSON.stringify(args),
              },
              signal,
            ),
          );
        },
        remove: (id, update) =>
          serial(async () => {
            const c = get(id);
            if (
              update?.expectedRevision !== undefined &&
              mcpRevision(c) !== update.expectedRevision
            )
              throw new Error("CONFLICT");
            await disconnect(id);
            await persist(configs.filter((c) => c.id !== id));
            await disconnect(id);
            if (update?.clearKey) {
              await secrets.set(scope(c), "");
              if (isGithubConfig(c)) {
                await secrets.set(scope(githubConfig(true)), "");
                await secrets.set(scope(githubConfig(false)), "");
              }
            }
          }),
        installPackage: (id, pkg, signal = ctx.abort.signal) =>
          serial(async () => {
            if (!stdio)
              throw new Error(
                "此设备不支持安装本机 MCP 进程，请配置 HTTP 服务",
              );
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
              throw new Error(
                "未找到 npm；请安装 Node.js 或手动安装后导入配置",
              );
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
        if (c.enabled && (stdio || c.transport === "http"))
          ctx.timeout(async () => {
            await connect(c.id).catch(() => {});
          }, 100);
      if(githubAuth)ctx.on('github.auth.changed',()=>{
        for(const c of configs)if(isOfficialGithub(c)&&isGithubDeviceCredential(secrets.get(scope(c)))&&!githubAuth.available(secrets.get(scope(c))))void disconnect(c.id).catch(()=>{});
      });
      ctx.effect(async () => {
        await queue;
        for (const item of inflight.values()) item.abort.abort();
        await Promise.allSettled([...inflight.values()].map((v) => v.promise));
        await Promise.all([...connected.keys()].map(disconnect));
      });
    },
  });
}
export const mcpClient = createMcpClient();
