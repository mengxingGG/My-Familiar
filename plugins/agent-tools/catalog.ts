import { randomUUID } from "node:crypto";
import type { Services } from "../../packages/kernel/index.ts";
import type { ToolEntry, ToolCall } from "../../packages/contracts/index.ts";

const invoked = (name: string, ref: string, completed: readonly ToolCall[]) => completed.some(call => {
  if (call.name !== name) return false;
  try { return JSON.parse(call.arguments).ref === ref; } catch { return false; }
});

type Entry = { ref: string; name: string; description: string; tool: ToolEntry };
/** 所有大型服务共用三个入口；引用只对当前连接有效，实际执行仍交给共享工具所有者。 */
export function deferredToolCatalog(tools: Services["agent.tools"], prefix = "mcp", advertised = true) {
  const names = [`${prefix}_tools_search`, `${prefix}_tool_schema`, `${prefix}_tool_invoke`];
  const groups = new Map<string, { name: string; entries: Entry[] }>();
  let routes: (() => void)[] = [];
  const entries = () => [...groups.values()].flatMap(g => g.entries);
  const entry = (ref: string) => {
    const found = entries().find(e => e.ref === ref);
    if (!found) throw Error("工具引用已失效，请重新检索当前连接的目录");
    return found;
  };
  const reference = { type: "string", pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" };
  const register = () => {
    if (routes.length) return;
    const definitions: ToolEntry[] = [
      {
        name: names[0], advertised, description: "检索工具目录。可按服务编号、工具名关键词搜索，或留空分页；结果含参数说明引用。",
        category: "read", parameters: { type: "object", properties: { server: { type: "string", maxLength: 40 }, query: { type: "string", maxLength: 200 }, offset: { type: "integer", minimum: 0, maximum: 10000 } }, additionalProperties: false },
        async execute({ server, query = "", offset = 0 }) {
          const matches = [...groups].filter(([id]) => !server || id === server).flatMap(([id,g]) => g.entries.map(e => ({ ...e, server: id })))
            .filter(e => `${e.name} ${e.description}`.toLowerCase().includes(query.toLowerCase()));
          return { servers: [...groups].map(([id,g]) => ({ id, name: g.name, tools: g.entries.length })),
            tools: matches.slice(offset, offset + 6).map(e => ({ server: e.server, name: e.name, description: e.description.slice(0, 100), ref: e.ref })),
            nextOffset: offset + 6 < matches.length ? offset + 6 : null, total: matches.length };
        },
      },
      {
        name: names[1], advertised, description: "按检索得到的 ref 读取工具参数 JSON Schema。长定义按 nextOffset 继续读取，不省略参数约束。",
        compactResult(call, result, completed) {
          const args = JSON.parse(call.arguments), value = JSON.parse(result);
          if (typeof args.ref !== "string" || value.ref !== args.ref || typeof value.schema !== "string" || !invoked(names[2], args.ref, completed)) return;
          return JSON.stringify({ ref: value.ref, name: value.name, offset: args.offset ?? 0, nextOffset: value.nextOffset,
            notice: `参数页已用于后续调用；再次需要时可用 ${names[1]} 重新读取。` });
        },
        category: "read", parameters: { type: "object", properties: { ref: reference, offset: { type: "integer", minimum: 0, maximum: 100000 } }, required: ["ref"], additionalProperties: false },
        async execute({ ref, offset = 0 }) {
          const found = entry(ref), schema = JSON.stringify(found.tool.parameters);
          if (offset > schema.length) throw Error("参数定义偏移超出范围");
          let end = Math.min(offset + 1800, schema.length);
          if (end < schema.length && /[\uD800-\uDBFF]/.test(schema[end - 1])) end--;
          return { ref, name: found.name, schema: schema.slice(offset, end), nextOffset: end < schema.length ? end : null, totalCharacters: schema.length };
        },
      },
      {
        name: names[2], advertised, description: "按当前目录的 ref 和已读取的参数定义调用工具；沿用原工具的校验与审批。",
        category: "read", denialKey: args => {
          if (typeof args.ref !== "string") return "";
          try { return entry(args.ref).tool.name; } catch { return args.ref; }
        },
        parameters: { type: "object", properties: { ref: reference, arguments: { type: "object", additionalProperties: true } }, required: ["ref", "arguments"], additionalProperties: false },
        async execute({ ref, arguments: args }, { signal, session, label }) {
          const found = entry(ref);
          const result = await tools.runRich!({ id: randomUUID(), name: found.tool.name, arguments: JSON.stringify(args) }, signal, { session, label, silent: true, expectedTool: found.tool });
          return result.attachments?.length ? { type: "familiar.multimodal", ...result } : result.text;
        },
      },
    ];
    try { for (const definition of definitions) routes.push(tools.register({ ...definition, alwaysAllowed: true, catalogRoute: true })); }
    catch (error) { routes.forEach(dispose => dispose()); routes = []; throw error; }
  };
  return {
    names,
    add(id: string, name: string, definitions: { name: string; tool: ToolEntry }[]): () => void {
      register();
      const group = { name, entries: definitions.map(({name,tool}) => ({ ref: randomUUID(), name, description: tool.description, tool })) };
      groups.set(id, group);
      return () => {
        if (groups.get(id) === group) groups.delete(id);
        if (!groups.size) { routes.forEach(dispose => dispose()); routes = []; }
      };
    },
  };
}
