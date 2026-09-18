import { experienceCommands } from "../experience-controls/index.ts";
import { definePlugin } from "../../packages/contracts/index.ts";
export const companionCommands = [
  ...experienceCommands,
  "companion.status",
  "settings.pet",
  "policy.get",
  "policy.set",
  "policy.resetSession",
  "memory.list",
  "memory.read",
  "memory.write",
  "memory.search",
  "skills.list",
  "skills.read",
  "skills.install",
  "skills.toggle",
  "skills.remove",
  "mcp.list",
  "mcp.save",
  "mcp.key",
  "mcp.connect",
  "mcp.remove",
  "mcp.install",
  "agent.approvals",
  "agent.decide",
];
export const companionControls = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.companion-controls",
    version: "0.2.0",
    provides: [],
    requires: [
      "commands",
      "memory.files",
      "skills.catalog",
      "mcp.manager",
      "agent.approvals",
      "agent.policy",
      "familiar.home",
    ],
  },
  start(ctx) {
    const memory = ctx.use("memory.files"),
      skills = ctx.use("skills.catalog"),
      mcp = ctx.use("mcp.manager"),
      approvals = ctx.use("agent.approvals");
    const routes = {
      "companion.status": () => ({
        home: ctx.use("familiar.home").root,
        memory: memory.status(),
        approvals: approvals.list(),
      }),
      "memory.list": () => memory.list(),
      "memory.read": async (p: any) => {
        const value = await memory.read(p.path);
        return {
          ...value,
          text: value.text.slice(0, 100000),
          truncated: value.text.length > 100000,
        };
      },
      "memory.write": (p: any) => memory.write(p.path, p.text, p.revision),
      "memory.search": (p: any) => memory.search(p.query),
      "skills.list": () => skills.list(),
      "skills.read": (p: any) => skills.read(p.id),
      "skills.install": (p: any) => skills.install(p.source, p.content),
      "skills.toggle": (p: any) => {
        if (typeof p.enabled !== "boolean") throw new Error("开关无效");
        return skills.setEnabled(p.id, p.enabled);
      },
      "skills.remove": (p: any) => skills.remove(p.id),
      "mcp.list": () => mcp.list(),
      "mcp.save": (p: any) => mcp.save(p),
      "mcp.key": (p: any) => mcp.setKey(p.id, p.key),
      "mcp.connect": (p: any) => mcp.connect(p.id),
      "mcp.remove": (p: any) => mcp.remove(p.id),
      "mcp.install": (p: any) => mcp.installPackage(p.id, p.package),
      "policy.get": () => ctx.use("agent.policy").get(),
      "policy.set": (p: any) => ctx.use("agent.policy").set(p),
      "policy.resetSession": () => ctx.use("agent.policy").resetSession(),
      "agent.approvals": () => approvals.list(),
      "agent.decide": (p: any) => {
        if (typeof p.allow !== "boolean") throw new Error("确认参数无效");
        return approvals.decide(p.id, p.allow, p.choice);
      },
    };
    for (const [name, run] of Object.entries(routes))
      ctx.effect(ctx.use("commands").register(name, run));
  },
});
