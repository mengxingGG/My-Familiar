import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { definePlugin } from "../../packages/contracts/index.ts";
import {
  dependencies,
  installDependency,
  exists,
  startCli,
  cliEnvironment,
} from "../cli-dependencies/index.ts";
import { jobs } from "../cli-dependencies/jobs.ts";
export function githubIntegration(
  openExternal: (url: string) => Promise<void> = async () => {},
) {
  return definePlugin({
    manifest: {
      manifestVersion: 1,
      id: "familiar.github",
      version: "0.1.0",
      provides: ["github.integration"],
      requires: [
        "mcp.manager",
        "familiar.home",
        "storage.local",
        "secrets.local",
      ],
      permissions: ["process.github", "network.dependencies"],
    },
    async start(ctx) {
      ctx.require("process.github");
      ctx.require("network.dependencies");
      const mcp = ctx.use("mcp.manager"),
        storage = ctx.use("storage.local"),
        secrets = ctx.use("secrets.local");
      const root = join(ctx.use("familiar.home").root, "plugins", "github"),
        bin = join(root, "bin"),
        exe = join(bin, dependencies.github.executable);
      const env = cliEnvironment({ GH_CONFIG_DIR: join(root, "config") }),
        job = jobs(ctx.abort.signal);
      await mkdir(root, { recursive: true });
      let authMode = await storage.read<"browser" | "token">(
          "github-auth-mode",
          "browser",
        ),
        saving = false;
      const credential = (mode: string) =>
        createHash("sha256")
          .update("integration:github:" + mode)
          .digest("hex");
      const command = (
        args: string[],
        signal: AbortSignal,
        output?: (text: string) => void,
      ) =>
        startCli(exe, args, {
          cwd: root,
          env,
          signal,
          stdin: "\n",
          timeout: 600000,
          onStdout: output,
          onStderr: output,
        }).done;
      const browserToken = async (signal: AbortSignal) => {
        const result = await command(
          ["auth", "token", "--hostname", "github.com"],
          signal,
        );
        if (result.code !== 0 || !result.output.trim())
          throw new Error("请先完成 GitHub 浏览器登录");
        return result.output.trim();
      };
      ctx.provide("github.integration", {
        async status() {
          const entry = (await mcp.list()).find((c) => c.id === "github");
          return {
            enabled: entry?.enabled ?? false,
            readOnly: entry?.url?.endsWith("/readonly") ?? false,
            hasKey: entry?.hasKey ?? false,
            connected: entry?.connected ?? false,
            tools: entry?.tools ?? 0,
            error: entry?.error,
            authMode,
            installed: await exists(exe),
            job: job.state(),
          };
        },
        async save(input) {
          if (
            !input ||
            typeof input.enabled !== "boolean" ||
            typeof input.readOnly !== "boolean" ||
            !["browser", "token"].includes(input.authMode) ||
            (input.token !== undefined &&
              (typeof input.token !== "string" || input.token.length > 4096))
          )
            throw new Error("GitHub 配置无效");
          if (saving || job.busy()) throw new Error("请等待当前保存或登录完成");
          saving = true;
          try {
            const source = credential(input.authMode);
            if (input.authMode === "token" && input.token !== undefined)
              await secrets.set(source, input.token.trim());
            if (input.authMode === "browser" && input.enabled)
              await secrets.set(source, await browserToken(ctx.abort.signal));
            if (input.enabled && !secrets.has(source))
              throw new Error(
                input.authMode === "browser"
                  ? "请先完成浏览器登录"
                  : "请填写 GitHub Token",
              );
            const entry = {
              id: "github",
              name: "GitHub 官方",
              transport: "http" as const,
              url:
                "https://api.githubcopilot.com/mcp/" +
                (input.readOnly ? "readonly" : ""),
              enabled: false,
              auth: {
                kind: "header" as const,
                name: "Authorization",
                prefix: "Bearer ",
              },
            };
            // 固定官方地址；同步对应凭据，不把 Token 返回界面。
            await mcp.save(entry);
            await mcp.setKey(
              "github",
              secrets.has(source) ? secrets.get(source) : "",
            );
            await mcp.save({ ...entry, enabled: input.enabled });
            await storage.write("github-auth-mode", input.authMode);
            authMode = input.authMode;
          } finally {
            saving = false;
          }
        },
        async connect() {
          if (saving || job.busy()) throw new Error("请等待当前保存或登录完成");
          const entry = (await mcp.list()).find((c) => c.id === "github");
          if (
            !entry ||
            entry.transport !== "http" ||
            ![
              "https://api.githubcopilot.com/mcp/",
              "https://api.githubcopilot.com/mcp/readonly",
            ].includes(entry.url ?? "") ||
            entry.auth?.kind !== "header" ||
            entry.auth.name !== "Authorization" ||
            entry.auth.prefix !== "Bearer "
          )
            throw new Error(
              "GitHub MCP 配置已被修改，请先在 GitHub 插件页重新保存；未向该地址发送登录凭据",
            );
          if (authMode === "browser")
            await mcp.setKey("github", await browserToken(ctx.abort.signal));
          return mcp.connect("github");
        },
        async install() {
          if (saving) throw new Error("正在保存配置");
          job.start("安装 GitHub 登录依赖", async (signal, append) => {
            await installDependency("github", bin, signal, append);
          });
        },
        async login() {
          if (!(await exists(exe)))
            throw new Error("请先安装 GitHub 登录依赖，或选择 Token 接入");
          if (saving) throw new Error("正在保存配置");
          job.start("GitHub 浏览器登录", async (signal, append) => {
            const result = await command(
              [
                "auth",
                "login",
                "--hostname",
                "github.com",
                "--git-protocol",
                "https",
                "--web",
                "--skip-ssh-key",
              ],
              signal,
              append,
            );
            if (result.code !== 0)
              throw new Error("GitHub 登录未完成，请查看登录提示并重试");
            await secrets.set(
              credential("browser"),
              await browserToken(signal),
            );
            authMode = "browser";
            await storage.write("github-auth-mode", authMode);
            append("\n登录完成。选择启用并保存，即可连接 GitHub 工具。");
          });
        },
        cancelJob: () => job.cancel(),
        async openAuthorization() {
          const url = job.state()?.url;
          if (!url) throw new Error("当前没有待完成的登录链接");
          await openExternal(url);
        },
      });
      ctx.effect(() => job.cancel());
    },
  });
}
