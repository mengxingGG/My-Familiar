import { WorkspaceFiles } from "./files.ts";
import { join } from "node:path";
import {
  definePlugin,
  type ToolEntry,
} from "../../packages/contracts/index.ts";
import { revision } from "../home-files/store.ts";
import { runProcess } from "../agent-tools/process.ts";
const str = { type: "string" };
const schema = (
  properties: Record<string, unknown>,
  required: string[] = Object.keys(properties),
) => ({ type: "object", properties, required, additionalProperties: false });
export const toolsBasic = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.tools-basic",
    version: "0.2.0",
    provides: [],
    requires: [
      "agent.tools",
      "agent.approvals",
      "familiar.home",
      "memory.files",
      "skills.catalog",
      "mcp.manager",
    ],
    permissions: ["process.shell"],
  },
  async start(ctx) {
    ctx.require("process.shell");
    const files = new WorkspaceFiles(
      join(ctx.use("familiar.home").root, "workspace"),
      ctx.use("familiar.home").root,
    );
    await files.init();
    const memory = ctx.use("memory.files"),
      skills = ctx.use("skills.catalog"),
      mcp = ctx.use("mcp.manager");
    const entries: ToolEntry[] = [
      {
        name: "files_list",
        description: "列出文件，默认灵伴工作目录，支持绝对路径",
        parameters: schema({ path: str }, []),
        category: "read",
        execute: async ({ path }) => files.list(path),
      },
      {
        name: "files_read",
        description: "读取文本文件，支持工作目录相对路径或绝对路径",
        parameters: schema({ path: str }),
        execute: async ({ path }) => {
          const text = await files.read(path);
          return { text, revision: revision(text) };
        },
      },
      {
        name: "files_search",
        description: "搜索文件中的文字，默认工作目录，可指定绝对路径",
        parameters: schema({ query: str, path: str }, ["query"]),
        category: "search",
        execute: async ({ query, path: base }) => {
          if (!query.trim() || query.length > 200)
            throw new Error("检索词无效");
          const result = [];
          for (const path of await files.list(base)) {
            const text = await files.read(path).catch(() => "");
            const i = text.toLowerCase().indexOf(query.toLowerCase());
            if (i >= 0)
              result.push({
                path,
                excerpt: text.slice(Math.max(0, i - 100), i + 500),
              });
            if (result.length >= 30) break;
          }
          return result;
        },
      },
      {
        name: "files_write",
        description: "保存文本文件，支持工作目录相对路径或绝对路径",
        parameters: schema({ path: str, text: str, revision: str }, [
          "path",
          "text",
        ]),
        permission: async ({ path }) => ({
          category: (await files.internal(path)) ? "write" : "outsideWrite",
          scope: await files.path(path),
        }),
        execute: async ({ path, text, revision: r }) => {
          await files.write(path, text, r);
          return { saved: path };
        },
      },
      {
        name: "shell_run",
        description: "执行 Shell 命令（非系统沙箱）",
        parameters: schema({ command: str }),
        category: "shell",
        permission: async ({ command }) => ({
          category: "shell",
          scope: JSON.stringify({ cwd: files.root, command }),
        }),
        execute: async ({ command }, { signal }) => {
          if (!command.trim() || command.length > 8000)
            throw new Error("命令过长或为空");
          return runProcess(
            process.platform === "win32" ? "powershell.exe" : "/bin/sh",
            process.platform === "win32"
              ? ["-NoProfile", "-NonInteractive", "-Command", command]
              : ["-c", command],
            files.root,
            signal,
          );
        },
      },
      {
        name: "memory_search",
        category: "search",
        description: "检索核心记忆、日记和教训，可输入日期或关键词",
        parameters: schema({ query: str }),
        execute: async ({ query }) => memory.search(query),
      },
      {
        name: "memory_read",
        description: "分段读取记忆文件，offset 为字符起点",
        parameters: schema(
          { path: str, offset: { type: "integer", minimum: 0 } },
          ["path"],
        ),
        execute: async ({ path, offset = 0 }) => {
          const value = await memory.read(path);
          return {
            text: value.text.slice(offset, offset + 24000),
            totalCharacters: value.text.length,
            nextOffset:
              offset + 24000 < value.text.length ? offset + 24000 : null,
          };
        },
      },
      {
        name: "memory_remember",
        category: "write",
        description: "记住用户明确确认的长期偏好或约定",
        parameters: schema({ text: str }),
        execute: async ({ text }, { signal }) => memory.remember(text, signal),
      },
      {
        name: "memory_lesson",
        category: "write",
        description: "记录可复用的经验、技能或犯错教训",
        parameters: schema(
          {
            title: str,
            text: str,
            category: {
              type: "string",
              enum: ["lesson", "skill", "experience"],
            },
          },
          ["title", "text"],
        ),
        execute: async ({ title, text, category }) =>
          memory.lesson(title, text, category),
      },
      {
        name: "skill_read",
        description:
          "读取已启用 Skill 的说明或包内文本资料，path 相对 Skill 目录",
        parameters: schema({ id: str, path: str }, ["id"]),
        execute: async ({ id, path }) => {
          if (
            !(await skills.list()).some(
              (s) => s.id === id && s.enabled && !s.error,
            )
          )
            throw new Error("Skill 未启用");
          return skills.read(id, path);
        },
      },
      {
        name: "skill_install",
        description: "安装 Skill 到灵伴自己的 skills 目录",
        parameters: schema({ source: str, content: str }, ["source"]),
        category: "install",
        execute: async ({ source, content }, { signal }) =>
          skills.install(source, content, signal),
      },
      {
        name: "mcp_list",
        description: "查看 MCP 服务状态，不读取密钥",
        parameters: schema({}),
        execute: async () => mcp.list(),
      },
      {
        name: "mcp_install",
        description: "安装固定版本 npm MCP 到灵伴目录（不运行安装脚本）",
        parameters: schema({ id: str, package: str }),
        approval: true,
        execute: async (args, { signal }) => {
          await mcp.installPackage(args.id, args.package, signal);
          return "已安装，尚未启用；可在控制器设置鉴权并启用。";
        },
      },
      {
        name: "mcp_enable",
        description: "启用并连接一个已经安装的 MCP 服务",
        parameters: schema({ id: str }),
        execute: async ({ id }, { signal }) => {
          const c = (await mcp.list()).find((c) => c.id === id);
          if (!c) throw new Error("MCP 不存在");
          await ctx
            .use("agent.approvals")
            .request(
              "启用 MCP 并允许启动服务",
              JSON.stringify(c, null, 2),
              signal,
              {
                tool: "mcp_enable",
                category: "install",
                scope: JSON.stringify(c),
              },
            );
          await mcp.save({ ...c, enabled: true });
          return mcp.connect(id);
        },
      },
    ];
    for (const tool of entries)
      ctx.effect(ctx.use("agent.tools").register(tool));
  },
});
