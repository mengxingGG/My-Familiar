import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Kernel } from "../packages/kernel/index.ts";
import {
  defaults,
  definePlugin,
  summaryFields,
  type JudgeQuestion,
  type MemoryTrace,
  type ProviderInput,
  type ToolEntry,
} from "../packages/contracts/index.ts";
import { memoryFiles } from "../plugins/memory-files/index.ts";
import {
  applyChange,
  buildIndex,
  characters,
  noteHeader,
  parseEntries,
  setWhen,
  topicName,
} from "../plugins/memory-files/entries.ts";
import {
  memoryJudge,
  parseJudgement,
  validateQuestions,
} from "../plugins/memory-judge/index.ts";
import { memoryTrace, traceKey } from "../plugins/memory-trace/index.ts";
import { conversation } from "../plugins/conversation/index.ts";
import { personaPrompt, personas } from "../plugins/conversation/config.ts";
import { toolsBasic } from "../plugins/tools-basic/index.ts";
const temporary = async () => {
  await mkdir(".artifacts", { recursive: true });
  return mkdtemp(resolve(".artifacts/memory-tests-"));
};
const waitFor = async (fn: () => boolean, timeout = 4000) => {
  const end = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > end) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const answer = (choice: number | null) =>
  async function* () {
    yield JSON.stringify({ answers: [{ id: "relation", choice }] });
  };
async function harness(
  root: string,
  reply: (input: Omit<ProviderInput, "key">) => AsyncIterable<string>,
  seed: Record<string, unknown> = {},
) {
  const traces: MemoryTrace[] = [],
    changes: any[] = [],
    store = new Map<string, unknown>(Object.entries(seed));
  let emit!: (event: unknown) => void;
  const k = new Kernel();
  k.install(
    definePlugin({
      manifest: {
        manifestVersion: 1,
        id: "test.memory-host",
        version: "1",
        provides: [
          "familiar.home",
          "settings",
          "llm.chat",
          "llm.management",
          "storage.local",
        ],
        requires: [],
      },
      start(ctx) {
        const config = structuredClone(defaults);
        config.provider.model = "fixture";
        emit = (event) => ctx.emit("memory.trace", event);
        ctx.provide("familiar.home", { root });
        ctx.provide("settings", {
          get: () => structuredClone(config),
          apply: async (v) => v,
          patchPet: async () => structuredClone(config),
        });
        ctx.provide("llm.chat", { test: async () => "ok", stream: reply });
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
        ctx.provide("storage.local", {
          read: async (key, fallback) =>
            structuredClone(store.has(key) ? store.get(key) : fallback) as any,
          write: async (key, value) => {
            store.set(key, structuredClone(value));
          },
        });
        ctx.on<MemoryTrace>("memory.trace", (event) => {
          traces.push(event);
        });
        ctx.on("memory.changed", (event) => {
          changes.push(event);
        });
      },
    }),
  );
  k.install(memoryTrace);
  k.install(memoryJudge);
  k.install(memoryFiles);
  await k.startAll();
  return { k, traces, changes, store, emit: (e: unknown) => emit(e) };
}
test("条目支持多行，原地改写和删除，定位不到或不唯一时报错", () => {
  let text = "# 核心规则\n\n说明文字\n";
  text = applyChange(text, "add", "回复保持简短");
  assert.equal(text, "# 核心规则\n\n说明文字\n\n- 回复保持简短\n");
  text = applyChange(text, "add", "提交前先跑测试\n包括类型检查");
  assert.equal(
    text,
    "# 核心规则\n\n说明文字\n\n- 回复保持简短\n- 提交前先跑测试\n  包括类型检查\n",
  );
  assert.deepEqual(
    parseEntries(text).entries.map((e) => e.text),
    ["回复保持简短", "提交前先跑测试\n包括类型检查"],
  );
  text = applyChange(text, "replace", "- 回复保持简短，先给结论", "保持简短");
  assert.match(text, /\n- 回复保持简短，先给结论\n- 提交前/);
  assert.throws(() => applyChange(text, "remove", "", "不存在"), /没有找到/);
  text = applyChange(text, "add", "提交前先跑测试和构建");
  assert.throws(() => applyChange(text, "remove", "", "提交前"), /匹配到 2 条/);
  text = applyChange(text, "remove", "", "包括类型检查");
  assert.deepEqual(
    parseEntries(text).entries.map((e) => e.text),
    ["回复保持简短，先给结论", "提交前先跑测试和构建"],
  );
  assert.match(text, /说明文字/);
});
test("主题文件的何时读生成索引，旧文件按标题列出，超限时注明未列出数量", () => {
  assert.equal(topicName(" 部署 / 打包 "), "部署-打包");
  assert.throws(() => topicName("///"), /主题名/);
  const note = setWhen("# 部署\n\n- 打包前退出宠物 — 文件占用\n", "打包发布前");
  assert.deepEqual(noteHeader(note), { title: "部署", when: "打包发布前" });
  assert.equal(noteHeader(setWhen(note, "安装前")).when, "安装前");
  const index = buildIndex([
    { path: "lessons/部署.md", text: note },
    {
      path: "topics/灵伴.md",
      text: "# 灵伴\n> 何时读：开发灵伴项目时\n\n- 遵守开发宪法\n- 文档同步\n",
    },
    { path: "lessons/2026-09-18-lesson-旧-1.md", text: "# 旧的教训\n\n正文" },
    { path: "lessons/2026-09-18-core-overflow-1.md", text: "# 精炼前资料" },
    { path: "daily/2026/09/2026-09-18.md", text: "# 日记" },
  ]);
  const lines = index.text.split("\n");
  assert.match(lines[0], /^- daily\//);
  assert.equal(lines[1], "- topics/灵伴.md：开发灵伴项目时（2 条）");
  assert.equal(lines[2], "- lessons/部署.md：打包发布前（1 条）");
  assert.match(lines[3], /旧教训标题.*旧的教训/);
  assert.doesNotMatch(index.text, /overflow|精炼前/);
  assert.equal(index.omitted, 0);
  const full = buildIndex(
    Array.from({ length: 40 }, (_, i) => ({
      path: `lessons/主题${i}.md`,
      text: `# 主题${i}\n> 何时读：${"很长的触发条件".repeat(4)}${i}\n`,
    })),
  );
  assert.ok(full.characters <= 1000);
  assert.ok(full.omitted > 0);
  assert.match(full.text, new RegExp(`另有 ${full.omitted} 个文件未列出`));
});
test("判断结果按不可信输入校验，越界、类型错误和未知题目不采纳", () => {
  const questions: JudgeQuestion[] = ["a", "b"].map((id) => ({
    id,
    kind: "memory.duplicate",
    prompt: "题目",
    options: ["无关", "重复"],
  }));
  assert.deepEqual(
    parseJudgement(
      '```json\n{"answers":[{"id":"a","choice":1},{"id":"b","choice":5},{"id":"x","choice":0}]}\n```',
      questions,
    ),
    [
      { id: "a", choice: 1 },
      { id: "b", choice: null },
    ],
  );
  assert.deepEqual(
    parseJudgement('{"answers":[{"id":"a","choice":"1"}]}', questions),
    [
      { id: "a", choice: null },
      { id: "b", choice: null },
    ],
  );
  assert.throws(() => parseJudgement("我觉得是重复", questions), /JSON/);
  assert.throws(
    () => validateQuestions([{ ...questions[0], options: ["只有一个"] }]),
    /格式/,
  );
  assert.throws(() => validateQuestions([questions[0], questions[0]]), /格式/);
});
test("核心规则查重：重复或取代时不写入并返回原条目，replace 原地改写，force 确认新增", async () => {
  let choice: number | null = 1;
  const asked: string[] = [];
  const h = await harness(await temporary(), async function* (input) {
    asked.push(input.messages.at(-1)!.content);
    yield* answer(choice)();
  });
  try {
    const m = h.k.resolve("memory.files");
    assert.equal((await m.remember({ text: "回复用中文。" })).written, true);
    // 空的核心没有可比对条目，不调用判断器。
    assert.equal(asked.length, 0);
    const duplicate = await m.remember({ text: "请用中文回复。" });
    assert.equal(duplicate.written, false);
    assert.deepEqual(duplicate.judgement, {
      relation: "duplicate",
      entry: "回复用中文。",
      backend: "main-model",
    });
    assert.match(asked[0], /回复用中文/);
    choice = 2;
    const supersede = await m.remember({ text: "回复改用英文。" });
    assert.equal(supersede.written, false);
    assert.equal(supersede.judgement?.relation, "supersede");
    assert.match(supersede.notice!, /replace/);
    const replaced = await m.remember({
      action: "replace",
      old: "用中文",
      text: "回复改用英文。",
    });
    assert.equal(replaced.written, true);
    assert.equal(asked.length, 2);
    assert.match((await m.read("CORE.md")).text, /- 回复改用英文。/);
    assert.doesNotMatch((await m.read("CORE.md")).text, /用中文/);
    const forced = await m.remember({
      text: "英文回复里保留中文术语。",
      force: true,
    });
    assert.equal(forced.written, true);
    assert.equal(forced.entries, 2);
    assert.equal(forced.limit, 2000);
    const same = await m.remember({ text: "  回复改用英文。 " });
    assert.equal(same.written, false);
    assert.match(same.notice!, /相同条目/);
    assert.equal(asked.length, 2);
    await m.remember({ action: "remove", old: "中文术语" });
    assert.equal(
      parseEntries((await m.read("CORE.md")).text).entries.length,
      1,
    );
    await assert.rejects(
      m.remember({ action: "replace", old: "不存在", text: "x" }),
      /没有找到/,
    );
    choice = 0;
    assert.equal((await m.remember({ text: "晚上少打扰。" })).written, true);
    assert.ok(h.changes.every((c) => c.v === 1 && c.source === "model"));
    assert.equal(h.traces.filter((t) => t.type === "judge").length, 3);
    assert.deepEqual(
      h.traces
        .filter((t) => t.type === "write" && !t.written)
        .map((t) => t.relation),
      ["duplicate", "supersede", "same"],
    );
    const key = traceKey(Date.now());
    await waitFor(
      () =>
        (h.store.get(key) as any)?.entries?.length ===
        h.traces.filter((t) => t.type !== "inject").length,
    );
    assert.ok(
      (h.store.get(key) as any).entries.some(
        (t: MemoryTrace) => t.type === "judge" && t.backend === "main-model",
      ),
    );
  } finally {
    await h.k.dispose();
  }
});
test("教训与扩展记忆按主题写入，新主题需要何时读，索引进入注入的记忆", async () => {
  const h = await harness(await temporary(), answer(0));
  try {
    const m = h.k.resolve("memory.files");
    await assert.rejects(
      m.note("lessons", { topic: "部署", text: "打包前退出宠物" }),
      /when/,
    );
    const first = await m.note("lessons", {
      topic: "部署",
      when: "打包发布前",
      text: "打包前退出宠物 — 文件占用会让构建失败",
    });
    assert.equal(first.path, "lessons/部署.md");
    assert.equal(
      (await m.read("lessons/部署.md")).text,
      "# 部署\n> 何时读：打包发布前\n\n- 打包前退出宠物 — 文件占用会让构建失败\n",
    );
    await m.note("topics", {
      topic: "灵伴项目",
      when: "开发灵伴项目时",
      text: "改代码前先读开发宪法",
    });
    await m.note("lessons", {
      topic: "部署",
      when: "打包、发布或安装前",
      action: "replace",
      old: "打包前退出宠物",
      text: "打包前先退出宠物和控制器 — 文件占用会让构建失败",
    });
    assert.match(
      (await m.read("lessons/部署.md")).text,
      /何时读：打包、发布或安装前\n\n- 打包前先退出宠物和控制器/,
    );
    const context = await m.context();
    assert.match(context, /lessons\/部署\.md：打包、发布或安装前（1 条）/);
    assert.match(context, /topics\/灵伴项目\.md：开发灵伴项目时（1 条）/);
    assert.match(context, /\[CORE\.md 核心规则\]/);
    assert.ok(m.status().index.characters > 0);
    await assert.rejects(
      m.note("topics", { topic: "不存在", action: "remove", old: "x" }),
      /还不存在/,
    );
  } finally {
    await h.k.dispose();
  }
});
test("旧版超限核心完整注入并提示整理，只允许缩小；用户编辑发出 user 事件", async () => {
  const root = await temporary();
  await mkdir(join(root, "memory"), { recursive: true });
  const old =
    "# 核心记忆\n\n" +
    Array.from(
      { length: 100 },
      (_, i) => `- 旧版偏好第 ${i} 条，内容比较长需要整理`,
    ).join("\n") +
    "\n";
  assert.ok(characters(old) > 2000);
  await writeFile(join(root, "memory/CORE.md"), old);
  const h = await harness(root, answer(0));
  try {
    const m = h.k.resolve("memory.files");
    assert.match(m.status().lastError!, /超出上限/);
    assert.ok((await m.context()).includes(old.trim()));
    await assert.rejects(
      m.remember({ text: "新偏好", force: true }),
      /核心规则上限/,
    );
    assert.equal(
      (await m.remember({ action: "remove", old: "旧版偏好第 99 条" })).written,
      true,
    );
    await m.write(
      "CORE.md",
      "# 核心规则\n\n- 只保留这一条\n",
      (await m.read("CORE.md")).revision,
    );
    assert.equal(m.status().lastError, undefined);
    assert.equal(m.status().core.characters, characters("# 核心规则\n\n- 只保留这一条\n"));
    assert.deepEqual(h.changes.at(-1), { v: 1, source: "user", path: "CORE.md" });
    await assert.rejects(
      m.write("CORE.md", "长".repeat(2001), (await m.read("CORE.md")).revision),
      /核心规则上限/,
    );
  } finally {
    await h.k.dispose();
  }
});
test("判断器失败后冷却不再请求；用户取消不计为故障", async () => {
  let calls = 0,
    hang = true;
  const h = await harness(await temporary(), async function* (input) {
    calls++;
    if (hang)
      await new Promise((_, reject) =>
        input.signal.addEventListener("abort", () => reject(input.signal.reason), {
          once: true,
        }),
      );
    throw new Error("offline");
  });
  try {
    const judge = h.k.resolve("memory.judge"),
      questions = [
        { id: "a", kind: "test", prompt: "题目", options: ["是", "否"] },
      ];
    const abort = new AbortController(),
      pending = judge.ask(questions, abort.signal);
    await waitFor(() => calls === 1);
    abort.abort();
    await assert.rejects(pending);
    assert.equal(judge.status().available, true);
    hang = false;
    await assert.rejects(judge.ask(questions), /offline/);
    await assert.rejects(judge.ask(questions), /暂不可用/);
    assert.equal(calls, 2);
    const status = judge.status();
    assert.equal(status.available, false);
    assert.ok(status.retryAt! > Date.now());
    assert.match(status.lastError!, /offline/);
    assert.ok(h.traces.some((t) => t.type === "judge" && t.error === "offline"));
  } finally {
    await h.k.dispose();
  }
});
test("记忆记录只保留最近 30 天，过大或无效的记录不保存", async () => {
  const days = Array.from(
    { length: 30 },
    (_, i) => `memory-trace-2000-01-${String(i + 1).padStart(2, "0")}`,
  );
  const h = await harness(await temporary(), answer(0), {
    "memory-trace-index": days,
    [days[0]]: { version: 1, entries: [], dropped: 0 },
  });
  try {
    const key = traceKey(Date.now());
    h.emit({ v: 1, type: "recall", time: Date.now(), query: "部署" });
    h.emit({ v: 1, type: "recall", time: Date.now(), big: "长".repeat(70000) });
    h.emit({ v: 2, type: "recall", time: Date.now() });
    await waitFor(() => (h.store.get(key) as any)?.dropped === 1);
    assert.deepEqual(
      (h.store.get(key) as any).entries.map((e: any) => e.query),
      ["部署"],
    );
    assert.equal(h.store.get(days[0]), null);
    const index = h.store.get("memory-trace-index") as string[];
    assert.equal(index.length, 30);
    assert.equal(index.at(-1), key);
  } finally {
    await h.k.dispose();
  }
});
test("记忆快照按会话冻结：模型写入不改前缀，压缩、用户编辑和新会话时刷新", async () => {
  let live = "记忆A",
    compact = false,
    emit!: (event: unknown) => void;
  const systems: string[] = [],
    nexts: (string | undefined)[] = [],
    traces: MemoryTrace[] = [],
    store = new Map<string, unknown>();
  const k = new Kernel();
  k.install(
    definePlugin({
      manifest: {
        manifestVersion: 1,
        id: "test.conversation-memory",
        version: "1",
        provides: [
          "agent.chat",
          "agent.tools",
          "memory.files",
          "skills.catalog",
          "llm.management",
          "context.compaction",
          "settings",
          "persona.catalog",
          "storage.local",
          "media.input",
        ],
        requires: [],
      },
      start(ctx) {
        const config = structuredClone(defaults);
        config.provider.model = "fixture";
        emit = (event) => ctx.emit("memory.changed", event);
        ctx.on<MemoryTrace>("memory.trace", (event) => {
          traces.push(event);
        });
        ctx.provide("settings", {
          get: () => structuredClone(config),
          apply: async (v) => v,
          patchPet: async () => structuredClone(config),
        });
        ctx.provide("persona.catalog", {
          list: () => personas.map((p) => ({ ...p })),
          prompt: (c) => personaPrompt(c.persona),
        });
        ctx.provide("storage.local", {
          read: async (key, fallback) =>
            structuredClone(store.has(key) ? store.get(key) : fallback) as any,
          write: async (key, value) => {
            store.set(key, structuredClone(value));
          },
        });
        ctx.provide("media.input", {
          prepare: async (v: any) => ({
            text: typeof v === "string" ? v : v.text,
            attachments: [],
            origin: "text",
          }),
        } as any);
        ctx.provide("agent.tools", {
          list: () => [],
          register: () => () => {},
          run: async () => "",
        });
        ctx.provide("agent.chat", {
          async *stream(input) {
            systems.push(input.messages[0].content);
            yield "好";
          },
        });
        ctx.provide("memory.files", { context: async () => live } as any);
        ctx.provide("skills.catalog", { prompt: async () => "" } as any);
        ctx.provide("llm.management", {
          validate: (c) => c,
          models: async () => [],
          inspect: () => ({ hasKey: true, options: {} as any }),
          plan: async () => ({
            inputBudget: 100000,
            contextWindow: 110000,
            source: "model",
          }),
          count: async () => ({ tokens: 1, exact: false }),
        });
        ctx.provide("context.compaction", {
          forget: async () => {},
          read: async () => ({ text: "", nextOffset: null, totalCharacters: 0 }),
          prepare: async (input) => {
            nexts.push(input.nextSystem?.content);
            const dropped = compact ? 1 : 0;
            compact = false;
            return {
              messages: input.history.slice(dropped),
              checkpoint: dropped
                ? {
                    id: "context-fixture",
                    summary: Object.fromEntries(
                      summaryFields.map((f) => [f, []]),
                    ) as any,
                    throughId: input.history[0].id,
                    created: Date.now(),
                  }
                : input.checkpoint,
              dropped,
              tokens: 1,
              exact: false,
              threshold: 100,
            };
          },
        });
      },
    }),
  );
  k.install(conversation);
  await k.startAll();
  try {
    const c = k.resolve("conversation");
    const say = async (text: string) => {
      await c.send(text);
      await waitFor(() => !c.state().busy);
      assert.equal(c.state().error, undefined);
    };
    await say("一");
    assert.match(systems[0], /记忆A/);
    assert.equal(nexts[0], undefined);
    live = "记忆B";
    emit({ v: 1, source: "model", path: "CORE.md" });
    await say("二");
    assert.match(systems[1], /记忆A/);
    assert.match(nexts[1]!, /记忆B/);
    compact = true;
    await say("三");
    assert.match(systems[2], /记忆B/);
    live = "记忆C";
    await say("四");
    assert.match(systems[3], /记忆B/);
    emit({ v: 1, source: "user", path: "CORE.md" });
    await say("五");
    assert.match(systems[4], /记忆C/);
    live = "记忆D";
    await k.resolve("conversation.history").create();
    await say("六");
    assert.match(systems[5], /记忆D/);
    assert.deepEqual(
      traces.filter((t) => t.type === "inject").map((t) => t.refreshed),
      [true, false, true, false, true, true],
    );
  } finally {
    await k.dispose();
  }
});
test("记忆工具把 old_text 交给记忆服务，并记录检索与读取", async () => {
  const root = await temporary(),
    calls: any[] = [],
    traces: MemoryTrace[] = [],
    tools = new Map<string, ToolEntry>();
  const k = new Kernel({
    grants: { "familiar.tools-basic": ["process.shell"] },
  });
  k.install(
    definePlugin({
      manifest: {
        manifestVersion: 1,
        id: "test.tool-host",
        version: "1",
        provides: [
          "agent.tools",
          "agent.approvals",
          "familiar.home",
          "memory.files",
          "skills.catalog",
          "mcp.manager",
        ],
        requires: [],
      },
      start(ctx) {
        ctx.on<MemoryTrace>("memory.trace", (event) => {
          traces.push(event);
        });
        ctx.provide("familiar.home", { root });
        ctx.provide("agent.tools", {
          register: (tool) => {
            tools.set(tool.name, tool);
            return () => {
              tools.delete(tool.name);
            };
          },
          list: () => [],
          run: async () => "",
        });
        ctx.provide("agent.approvals", {} as any);
        ctx.provide("skills.catalog", {} as any);
        ctx.provide("mcp.manager", {} as any);
        ctx.provide("memory.files", {
          remember: async (change: any) => (calls.push(["core", change]), {}),
          note: async (layer: any, change: any) => (
            calls.push([layer, change]), {}
          ),
          search: async () => [{ path: "lessons/部署.md", excerpt: "" }],
          read: async () => ({ text: "正文", revision: "r" }),
        } as any);
      },
    }),
  );
  k.install(toolsBasic);
  await k.startAll();
  try {
    const context = { signal: new AbortController().signal, session: "s1" };
    await tools
      .get("memory_remember")!
      .execute({ action: "remove", old_text: "旧条目" }, context);
    await tools.get("memory_lesson")!.execute(
      { topic: "部署", when: "打包前", text: "规则 — 原因" },
      context,
    );
    await tools
      .get("memory_topic")!
      .execute({ topic: "灵伴", action: "replace", old_text: "旧", text: "新" }, context);
    assert.deepEqual(calls, [
      ["core", { action: "remove", old: "旧条目" }],
      ["lessons", { topic: "部署", when: "打包前", text: "规则 — 原因", old: undefined }],
      ["topics", { topic: "灵伴", action: "replace", text: "新", old: "旧" }],
    ]);
    await tools.get("memory_search")!.execute({ query: "部署" }, context);
    await tools
      .get("memory_read")!
      .execute({ path: "lessons/部署.md" }, context);
    assert.deepEqual(
      traces.map(({ time, ...t }) => t),
      [
        {
          v: 1,
          type: "recall",
          session: "s1",
          tool: "memory_search",
          query: "部署",
          hits: ["lessons/部署.md"],
        },
        {
          v: 1,
          type: "recall",
          session: "s1",
          tool: "memory_read",
          path: "lessons/部署.md",
          offset: 0,
        },
      ],
    );
  } finally {
    await k.dispose();
  }
});
