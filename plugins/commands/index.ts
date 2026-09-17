import { definePlugin, type Command } from "../../packages/contracts/index.ts";
export const commands = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.commands",
    version: "0.1.0",
    provides: ["commands"],
    requires: [],
  },
  start(ctx) {
    const handlers = new Map<string, Command>();
    ctx.provide("commands", {
      register(name, command) {
        if (handlers.has(name)) throw new Error(`命令重复：${name}`);
        handlers.set(name, command);
        return () => {
          handlers.delete(name);
        };
      },
      async call(name, params) {
        const handler = handlers.get(name);
        if (!handler) throw new Error(`命令不可用：${name}`);
        return handler(params);
      },
    });
    ctx.effect(() => handlers.clear());
  },
});
