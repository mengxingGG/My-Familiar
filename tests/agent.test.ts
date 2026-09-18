import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  symlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { Kernel } from "../packages/kernel/index.ts";
import {
  defaults,
  definePlugin,
  type ProviderInput,
} from "../packages/contracts/index.ts";
import { FileStore, revision } from "../plugins/home-files/store.ts";
import { homeFiles } from "../plugins/home-files/index.ts";
import {
  memoryFiles,
  characters,
  datePath,
} from "../plugins/memory-files/index.ts";
import { skillsLocal, parseSkill } from "../plugins/skills-local/index.ts";
import { storageLocal } from "../plugins/storage-local/index.ts";
import { agentTools } from "../plugins/agent-tools/index.ts";
import { toolsBasic } from "../plugins/tools-basic/index.ts";
import { agentRunner } from "../plugins/agent-runner/index.ts";
import { mcpClient, validateMcp } from "../plugins/mcp-client/index.ts";
import { conversation } from "../plugins/conversation/index.ts";
import { runProcess } from "../plugins/agent-tools/process.ts";
const temporary = async () => {
  await mkdir(".artifacts", { recursive: true });
  return mkdtemp(resolve(".artifacts/agent-tests-"));
};

test("权限按次、会话、精确白名单和全自动生效，重启保存策略但不保存会话允许", async () => {
  const root = await temporary();
  let k = await harness(root);
  const register = () =>
    k
      .resolve("agent.tools")
      .register({
        name: "permission_fixture",
        description: "权限测试",
        category: "shell",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
        execute: async (args) => args.command,
      });
  register();
  const call = (command: string) =>
    k
      .resolve("agent.tools")
      .run(
        {
          id: "call",
          name: "permission_fixture",
          arguments: JSON.stringify({ command }),
        },
        new AbortController().signal,
      );
  const decide = async (choice: "once" | "session" | "whitelist") => {
    const a = k.resolve("agent.approvals");
    await waitFor(() => a.list().length > 0);
    await a.decide(a.list()[0].id, true, choice);
  };
  try {
    let result = call("A");
    await decide("once");
    assert.equal(await result, "A");
    result = call("A");
    await decide("session");
    await result;
    assert.equal(await call("B"), "B");
    k.emit("conversation.session", "next");
    result = call("A");
    await decide("whitelist");
    await result;
    assert.equal(await call("A"), "A");
    result = call("B");
    await decide("session");
    await result;
    await k.dispose();
    k = await harness(root);
    register();
    assert.equal(await call("A"), "A");
    result = call("B");
    await decide("once");
    await result;
    const p = k.resolve("agent.policy");
    await p.set({ ...p.get(), mode: "auto" });
    assert.equal(await call("C"), "C");
    await p.set({
      ...p.get(),
      mode: "custom",
      defaults: { ...p.get().defaults, shell: "deny" },
    });
    await assert.rejects(call("A"), /禁止/);
  } finally {
    await k.dispose();
  }
});

test("文件工具默认允许读写工作目录，可读取外部路径，外部写入可记住目标", async () => {
  const root = await temporary(),
    k = await harness(root);
  const run = (name: string, args: unknown) =>
    k
      .resolve("agent.tools")
      .run(
        { id: "file", name, arguments: JSON.stringify(args) },
        new AbortController().signal,
      );
  try {
    await run("files_write", { path: "inside.txt", text: "inside" });
    assert.equal(k.resolve("agent.approvals").list().length, 0);
    const external = join(root, "outside.txt");
    await writeFile(external, "outside");
    assert.match(await run("files_read", { path: external }), /outside/);
    const pending = run("files_write", { path: external, text: "new" });
    const a = k.resolve("agent.approvals");
    await waitFor(() => a.list().length > 0);
    assert.equal(a.list()[0].category, "outsideWrite");
    await a.decide(a.list()[0].id, true, "whitelist");
    await pending;
    await run("files_write", { path: external, text: "again" });
    assert.equal(await readFile(external, "utf8"), "again");
  } finally {
    await k.dispose();
  }
});

test("历史会话保留超出上下文的原文，可搜索、切换续聊、重命名与删除，重启不遗失", async () => {
  const root = await temporary();
  let k = await harness(root, async function* () {
    yield "回答";
  });
  try {
    k.resolve("agent.tools").list = () => [];
    k.resolve("llm.management").count = async (i) => ({
      tokens: i.messages.length * 100,
      exact: true,
    });
    k.resolve("llm.management").plan = async () => ({
      inputBudget: 500,
      contextWindow: 1000,
      source: "model",
    });
    const c = k.resolve("conversation"),
      h = k.resolve("conversation.history"),
      original = h.current();
    for (let i = 0; i < 6; i++) {
      await c.send("第" + i + "次秘密");
      await waitFor(() => !c.state().busy);
      assert.equal(c.state().error, undefined);
    }
    assert.equal((await h.read(original)).messages.length, 12);
    assert.ok(c.state().session!.trimmedMessages > 0);
    const next = await h.create();
    assert.notEqual(next, original);
    assert.equal((await h.list("第0次秘密"))[0].id, original);
    await h.rename(original, "保留的故事");
    await h.select(original);
    assert.equal(c.state().session?.id, original);
    await c.send("接着聊");
    await waitFor(() => !c.state().busy);
    await k.dispose();
    k = await harness(root);
    assert.equal(k.resolve("conversation.history").current(), original);
    assert.equal(
      (await k.resolve("conversation.history").read(original)).messages.length,
      14,
    );
    assert.equal(
      (await k.resolve("conversation.history").list()).find(
        (v) => v.id === original,
      )?.title,
      "保留的故事",
    );
    await k.resolve("conversation.history").remove(original);
    await assert.rejects(
      k.resolve("conversation.history").read(original),
      /不存在/,
    );
  } finally {
    await k.dispose();
  }
});
const waitFor = async (fn: () => boolean, timeout = 4000) => {
  const end = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > end) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 10));
  }
};
async function harness(
  root: string,
  stream?: (input: Omit<ProviderInput, "key">) => AsyncIterable<string>,
) {
  const k = new Kernel({
    grants: {
      "familiar.storage-local": ["storage.app"],
      "familiar.home-files": ["storage.app"],
      "familiar.mcp-client": ["network.mcp", "process.mcp"],
      "familiar.tools-basic": ["process.shell"],
    },
  });
  k.install(homeFiles(join(root, "home"), join(root, "fallback")));
  k.install(storageLocal(join(root, "data")));
  k.install(
    definePlugin({
      manifest: {
        manifestVersion: 1,
        id: "test.dependencies",
        version: "1",
        provides: ["settings", "llm.chat", "llm.management", "secrets.local"],
        requires: [],
      },
      start(ctx) {
        const config = structuredClone(defaults);
        config.provider.model = "fixture";
        const keys = new Map<string, string>();
        ctx.provide("settings", {
          patchPet: async (patch) => ({
            ...structuredClone(defaults),
            pet: { ...defaults.pet, ...patch },
          }),
          get: () => structuredClone(config),
          apply: async (v) => Object.assign(config, v),
        });
        ctx.provide("llm.chat", {
          test: async () => "ok",
          stream:
            stream ??
            async function* () {
              yield "# 核心记忆\n- 用户喜欢绿茶。";
            },
        });
        ctx.provide("llm.management", {
          validate: (c) => c,
          models: async () => [],
          inspect: () => ({ hasKey: true, options: {} as any }),
          plan: async () => ({
            inputBudget: 100000,
            contextWindow: 110000,
            source: "model",
          }),
          count: async (i) => ({
            tokens: JSON.stringify(i.messages).length,
            exact: false,
          }),
        });
        ctx.provide("secrets.local", {
          has: (s) => keys.has(s),
          get: (s) => keys.get(s) || "",
          set: async (s, v) => {
            keys.set(s, v);
          },
        });
      },
    }),
  );
  for (const p of [
    memoryFiles,
    skillsLocal,
    agentTools,
    mcpClient,
    toolsBasic,
    agentRunner,
    conversation,
  ])
    k.install(p);
  await k.startAll();
  return k;
}
test("文件之家拒绝越界和链接，写入检查版本并保留原文", async () => {
  const root = await temporary(),
    store = new FileStore(join(root, "files"));
  await store.init();
  await store.write("a.txt", "first");
  await assert.rejects(store.write("a.txt", "bad", "stale"), /已被修改/);
  await store.write("a.txt", "second", revision("first"));
  assert.equal(await store.read("a.txt"), "second");
  assert.equal((await readdir(join(store.root, ".history"))).length, 1);
  for (const path of [
    "../escape",
    "C:\\escape",
    "a/../../escape",
    "a:stream",
    "NUL.txt",
  ])
    await assert.rejects(store.read(path));
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret"), "private");
  await symlink(outside, join(store.root, "link"), "junction");
  await assert.rejects(store.read("link/secret"), /链接/);
});
test("核心记忆自动精炼 3000 字符边界，日记同日追加、去重、重启和检索", async () => {
  const root = await temporary(),
    k = await harness(root, async function* () {
      yield "🙂".repeat(3000);
    });
  try {
    const m = k.resolve("memory.files");
    await m.write("core.md", "旧资料".repeat(1500));
    assert.equal(characters((await m.read("CORE.md")).text), 3000);
    assert.ok((await m.list()).some((p) => p.includes("core-overflow")));
    const time = new Date(2026, 8, 18, 14).getTime();
    await m.record({
      id: "one",
      user: "今天去了森林",
      assistant: "听起来很舒服。",
      time,
    });
    await m.record({
      id: "two",
      user: "带上绿茶",
      assistant: "记住了。",
      time,
    });
    await m.record({ id: "one", user: "不能重复", assistant: "", time });
    const diary = (await m.read(datePath(time))).text;
    assert.match(diary, /森林/);
    assert.match(diary, /绿茶/);
    assert.doesNotMatch(diary, /不能重复/);
    assert.ok((await m.search("2026-09-18")).length);
    await m.lesson("路径错误", "先检查路径，再改文件。", "lesson");
    assert.ok((await m.search("路径错误"))[0].path.startsWith("lessons/"));
    await k.dispose();
    const restart = await harness(root);
    assert.equal(
      (await restart.resolve("memory.files").read(datePath(time))).text,
      diary,
    );
    await restart.dispose();
  } finally {
    await k.dispose();
  }
});
test("精炼失败保留完整资料，核心仍有内容且凭据脱敏", async () => {
  const k = await harness(await temporary(), async function* () {
    throw new Error("offline");
  });
  try {
    const m = k.resolve("memory.files");
    await m.remember("偏好".repeat(2000) + "\nAPI_KEY=not-for-memory");
    assert.ok(characters((await m.read("CORE.md")).text) <= 3000);
    assert.match((await m.read("CORE.md")).text, /偏好/);
    assert.doesNotMatch((await m.read("CORE.md")).text, /not-for-memory/);
    assert.match(m.status().lastError!, /精炼/);
    assert.ok((await m.list()).some((p) => p.includes("overflow")));
  } finally {
    await k.dispose();
  }
});
test("Skill 目录安装保留二进制资源，停用生效，移除后重启不复活", async () => {
  const root = await temporary(),
    k = await harness(root);
  try {
    const source = join(root, "import");
    await mkdir(join(source, "assets"), { recursive: true });
    const text =
      "---\nname: sample-skill\ndescription: 示例方法\n---\n使用时先读取资料。";
    await writeFile(join(source, "SKILL.md"), text);
    const image = Buffer.from([0, 128, 255, 65]);
    await writeFile(join(source, "assets/image.bin"), image);
    const skills = k.resolve("skills.catalog");
    await skills.install(source);
    assert.deepEqual(
      await readFile(join(root, "home/skills/sample-skill/assets/image.bin")),
      image,
    );
    await skills.setEnabled("sample-skill", false);
    assert.doesNotMatch(await skills.prompt(), /sample-skill/);
    await assert.rejects(
      k
        .resolve("agent.tools")
        .run(
          { id: "s", name: "skill_read", arguments: '{"id":"sample-skill"}' },
          new AbortController().signal,
        ),
      /未启用/,
    );
    await skills.remove("shell-tasks");
    await k.dispose();
    const restart = await harness(root);
    assert.ok(
      !(await restart.resolve("skills.catalog").list()).some(
        (s) => s.id === "shell-tasks",
      ),
    );
    await restart.dispose();
    assert.throws(() =>
      parseSkill("---\nname: ../bad\ndescription: x\n---\ny"),
    );
  } finally {
    await k.dispose();
  }
});
test("具体工具参数先确认，拒绝与取消不会执行，关闭运行时清理等待", async () => {
  const k = new Kernel({
    grants: { "familiar.storage-local": ["storage.app"] },
  });
  k.install(storageLocal(await temporary()));
  k.install(agentTools);
  await k.startAll();
  let writes = 0;
  const tools = k.resolve("agent.tools"),
    approval = k.resolve("agent.approvals");
  tools.register({
    name: "write",
    description: "写入",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    approval: true,
    execute: async () => ++writes,
  });
  const op = tools.run(
    { id: "1", name: "write", arguments: '{"text":"全部参数"}' },
    new AbortController().signal,
  );
  await waitFor(() => approval.list().length > 0);
  assert.match(approval.list()[0].detail, /全部参数/);
  approval.decide(approval.list()[0].id, false);
  await assert.rejects(op, /拒绝/);
  assert.equal(writes, 0);
  const abort = new AbortController(),
    cancel = tools.run(
      { id: "2", name: "write", arguments: '{"text":"cancel"}' },
      abort.signal,
    );
  await waitFor(() => approval.list().length > 0);
  abort.abort();
  await assert.rejects(cancel, /取消/);
  assert.equal(approval.list().length, 0);
  const close = tools.run(
    { id: "3", name: "write", arguments: '{"text":"close"}' },
    new AbortController().signal,
  );
  const rejected = assert.rejects(close, /拒绝/);
  await k.dispose();
  await rejected;
  assert.equal(writes, 0);
  assert.equal(k.diagnostics.length, 0);
});
test("MCP stdio 握手、工具列出、环境密钥、确认及停用撤销", async () => {
  const k = await harness(await temporary());
  try {
    const m = k.resolve("mcp.manager");
    const config = {
      id: "fixture",
      name: "测试 MCP",
      transport: "stdio" as const,
      command: "node",
      args: [resolve("tests/fixtures/mcp-server.cjs")],
      enabled: true,
      auth: { kind: "env" as const, name: "FIXTURE_KEY" },
    };
    await m.save(config);
    await m.setKey("fixture", "test-only-key");
    assert.deepEqual((await m.connect("fixture")).tools, ["echo"]);
    const tool = k
      .resolve("agent.tools")
      .list()
      .find((t) => t.name.startsWith("mcp_fixture_"))!;
    assert.ok(tool);
    const call = k
      .resolve("agent.tools")
      .run(
        { id: "m", name: tool.name, arguments: '{"text":"hello"}' },
        AbortSignal.timeout(10000),
      );
    await waitFor(() => k.resolve("agent.approvals").list().length > 0);
    const a = k.resolve("agent.approvals");
    a.decide(a.list()[0].id, true);
    assert.match(await call, /echo:hello:auth=true/);
    assert.doesNotMatch(JSON.stringify(await m.list()), /test-only-key/);
    await m.save({ ...config, enabled: false });
    assert.ok(
      !k
        .resolve("agent.tools")
        .list()
        .some((t) => t.name === tool.name),
    );
    assert.throws(() =>
      validateMcp({
        ...config,
        transport: "http",
        url: "https://example.com/?key=secret",
      }),
    );
  } finally {
    await k.dispose();
  }
});
test("对话执行记忆工具并保留隐藏轨迹，日记持续保存且新会话不清记忆", async () => {
  const seen: any[] = [];
  const root = await temporary();
  const k = await harness(root, async function* (input) {
    seen.push(structuredClone(input.messages));
    if (
      input.messages.at(-1)?.role === "user" &&
      input.messages.at(-1)?.content === "请记住绿茶"
    ) {
      input.onTools?.([
        {
          id: "remember1",
          name: "memory_remember",
          arguments: '{"text":"用户喜欢绿茶。"}',
        },
      ]);
      input.onNative?.({ scope: "test", items: [{ private: "隐藏思考" }] });
    } else yield "好，我记住你喜欢绿茶了。";
  });
  try {
    const c = k.resolve("conversation");
    await c.send("请记住绿茶");
    await waitFor(() => !c.state().busy);
    assert.equal(c.state().error, undefined);
    assert.match(
      (await k.resolve("memory.files").read("CORE.md")).text,
      /绿茶/,
    );
    assert.ok(
      seen[1].some(
        (m: any) => m.role === "tool" && m.toolCallId === "remember1",
      ),
    );
    assert.doesNotMatch(JSON.stringify(c.state()), /隐藏思考|remember1/);
    await c.send("继续");
    await waitFor(() => !c.state().busy);
    assert.ok(seen.at(-1).some((m: any) => m.calls?.[0]?.id === "remember1"));
    await c.clear();
    assert.match(
      (await k.resolve("memory.files").read("CORE.md")).text,
      /绿茶/,
    );
    assert.ok((await k.resolve("memory.files").search("请记住绿茶")).length);
  } finally {
    await k.dispose();
  }
});

test("取消核心精炼不会在后台继续改写记忆，长日记保留末尾且可分段读取", async () => {
  const root = await temporary();
  let started = false;
  const k = await harness(root, async function* (input) {
    started = true;
    await new Promise((resolve, reject) => {
      if (input.signal.aborted) return reject(input.signal.reason);
      input.signal.addEventListener(
        "abort",
        () => reject(input.signal.reason),
        { once: true },
      );
    });
    yield "不应写入";
  });
  try {
    const m = k.resolve("memory.files"),
      before = (await m.read("CORE.md")).text,
      abort = new AbortController();
    const task = m.remember("偏好".repeat(2000), abort.signal);
    const rejected = assert.rejects(task);
    await waitFor(() => started);
    abort.abort();
    await rejected;
    assert.equal((await m.read("CORE.md")).text, before);
    const time = Date.now();
    await m.record({
      id: "long",
      user: "开始",
      assistant: "长".repeat(30000) + "完整末尾",
      time,
    });
    const path = datePath(time);
    assert.match((await m.read(path)).text, /完整末尾/);
    const page = JSON.parse(
      await k.resolve("agent.tools").run(
        {
          id: "read",
          name: "memory_read",
          arguments: JSON.stringify({ path, offset: 24000 }),
        },
        new AbortController().signal,
      ),
    );
    assert.match(page.text, /完整末尾/);
    assert.equal(page.nextOffset, null);
  } finally {
    await k.dispose();
  }
});
test("运行中的子程序收到取消后停止，不阻塞下一轮", async () => {
  const abort = new AbortController(),
    started = Date.now();
  const run = runProcess(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    await temporary(),
    abort.signal,
  );
  const rejected = assert.rejects(run, /取消/);
  setTimeout(() => abort.abort(), 150);
  await rejected;
  assert.ok(Date.now() - started < 6000);
});
