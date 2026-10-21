import test from "node:test";
import assert from "node:assert/strict";
import { Kernel } from "../packages/kernel/index.ts";
import {
  definePlugin,
  type ToolCategory,
} from "../packages/contracts/index.ts";
import { agentTools } from "../plugins/agent-tools/index.ts";
import { deferredToolCatalog } from "../plugins/agent-tools/catalog.ts";

async function harness() {
  const k = new Kernel();
  let stored: unknown;
  k.install(
    definePlugin({
      manifest: {
        manifestVersion: 1,
        id: "fixture.store",
        version: "1",
        provides: ["storage.local"],
        requires: [],
      },
      start(ctx) {
        ctx.provide("storage.local", {
          async read(_key, fallback) {
            return (stored ?? fallback) as typeof fallback;
          },
          async write(_key, value) {
            stored = structuredClone(value);
          },
        });
      },
    }),
  );
  k.install(agentTools);
  await k.startAll();
  const t = k.resolve("agent.tools"),
    a = k.resolve("agent.approvals"),
    p = k.resolve("agent.policy");
  let count = 0;
  const add = (name: string, category: ToolCategory, alwaysAllowed = false) =>
    t.register({
      name,
      category,
      alwaysAllowed,
      description: name,
      parameters: { type: "object", additionalProperties: false },
      execute: async () => ++count,
    });
  add("safe_read", "read");
  add("write_external", "outsideWrite");
  add("command", "shell");
  add("web_search", "search");
  add("diary", "write", true);
  const run = (name: string, session?: string) =>
    t.run(
      { id: "fixture", name, arguments: "{}" },
      new AbortController().signal,
      { session },
    );
  const pending = async () => {
    for (let i = 0; i < 100 && !a.list().length; i++)
      await new Promise((r) => setTimeout(r, 2));
    assert.equal(a.list().length, 1);
    return a.list()[0].id;
  };
  return { k, t, a, p, run, pending };
}

test("四种全局模式始终允许搜索/内部记忆，拒绝模式覆盖用户白名单", async () => {
  const { k, p, a, run, pending } = await harness();
  try {
    assert.equal(p.get().mode, "limited");
    await run("safe_read");
    let waiting = run("write_external");
    await a.decide(await pending(), true, "whitelist");
    await waiting;
    for (const mode of ["auto", "limited", "approval", "deny"] as const) {
      await p.set({
        ...p.get(),
        mode,
        defaults: { ...p.get().defaults, search: "deny", write: "deny" },
      });
      await run("web_search");
      await run("diary");
      if (mode === "deny") {
        await assert.rejects(run("write_external"), /禁止/);
        await assert.rejects(run("safe_read"), /禁止/);
      } else {
        await run("write_external");
        if (mode === "approval") {
          waiting = run("safe_read");
          await a.decide(await pending(), true, "once");
          await waiting;
        } else await run("safe_read");
      }
      assert.equal(a.list().length, 0);
    }
  } finally {
    await k.dispose();
  }
});
test("当前会话全部授权跨工具生效，但不扩展至其他会话；切换和模式更改撤销", async () => {
  const { k, p, a, run, pending } = await harness();
  try {
    await p.set({ ...p.get(), mode: "approval" });
    let r = run("write_external", "local:A");
    await a.decide(await pending(), true, "session");
    await r;
    await run("command", "local:A");
    await run("safe_read", "local:A");
    r = run("command", "remote:B");
    await a.decide(await pending(), true, "once");
    await r;
    k.emit("conversation.session", "next");
    r = run("command", "local:A");
    await a.decide(await pending(), true, "once");
    await r;
    r = run("safe_read", "local:A");
    const rejected = assert.rejects(r, /拒绝/);
    await pending();
    await p.set({ ...p.get(), mode: "deny" });
    await rejected;
    assert.equal(a.list().length, 0);
  } finally {
    await k.dispose();
  }
});
test("拒绝模式仍能读取目录，但目录调用不能绕过目标工具；无意图请求不扩大会话授权", async () => {
  const { k, p, t, a } = await harness();
  const catalog = deferredToolCatalog(t, "fixture");
  const dangerous = {
    name: "actual_external",
    description: "修改外部资料",
    category: "outsideWrite" as const,
    parameters: { type: "object" },
    execute: async () => "must not run",
  };
  t.register(dangerous);
  catalog.add("test", "测试", [{ name: dangerous.name, tool: dangerous }]);
  try {
    await p.set({ ...p.get(), mode: "deny" });
    const run = (name: string, args: unknown) =>
      t.run(
        { id: "c", name, arguments: JSON.stringify(args) },
        new AbortController().signal,
      );
    const list = JSON.parse(await run("fixture_tools_search", {}));
    assert.equal(list.tools.length, 1);
    await run("fixture_tool_schema", { ref: list.tools[0].ref });
    await assert.rejects(
      run("fixture_tool_invoke", { ref: list.tools[0].ref, arguments: {} }),
      /禁止/,
    );
    assert.equal(a.list().length, 0);
  } finally {
    await k.dispose();
  }
});
