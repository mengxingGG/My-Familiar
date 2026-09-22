import { _electron as electron } from "playwright/test";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

// 传入旧版 EXE，在完全独立的数据目录验证升级；不运行安装器或使用真实密钥。
if (!process.argv[2])
  throw new Error("用法：node scripts/upgrade-smoke.mjs <旧版 Familiar.exe>");
const oldExe = resolve(process.argv[2]);
const newExe = resolve("release/win-unpacked/Familiar.exe");
const output = resolve(`.artifacts/upgrade-smoke-${Date.now()}`);
const data = join(output, "user-data"),
  home = join(data, "home");
await mkdir(output, { recursive: true });
const env = { ...process.env, FAMILIAR_DATA_DIR: data, FAMILIAR_HOME: home };
delete env.ELECTRON_RUN_AS_NODE;
const key = "upgrade-fixture-not-a-real-key";
let authorizedCalls = 0;
const mock = createServer(async (req, res) => {
  if (req.headers.authorization === `Bearer ${key}`) authorizedCalls++;
  if (req.url === "/v1/models") {
    res.setHeader("Content-Type", "application/json");
    return res.end(
      JSON.stringify({
        data: [{ id: "upgrade-fixture", context_length: 65536 }],
      }),
    );
  }
  for await (const chunk of req) void chunk;
  res.setHeader("Content-Type", "text/event-stream");
  res.end(
    `data: ${JSON.stringify({ choices: [{ delta: { content: "已经记住这段升级演示对话。" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
let runtime, controller;
const wait = async (predicate) => {
  const end = Date.now() + 20000;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error("等待升级演示数据就绪超时");
    await new Promise((r) => setTimeout(r, 50));
  }
};
const close = async () => {
  await controller?.close();
  controller = undefined;
  await runtime?.close();
  runtime = undefined;
};
const launch = async (executablePath) => {
  runtime = await electron.launch({
    executablePath,
    args: [],
    env,
    timeout: 30000,
  });
  await runtime.firstWindow();
  controller = await electron.launch({
    executablePath,
    args: ["--controller"],
    env,
    timeout: 30000,
  });
  const page = await controller.firstWindow();
  page.setDefaultTimeout(20000);
  await page.waitForFunction(() => document.body.dataset.connected === "true");
  const request = (name, params) =>
    page.evaluate(({ name, params }) => window.familiar.request(name, params), {
      name,
      params,
    });
  return { page, request };
};
try {
  let { page, request } = await launch(oldExe);
  const oldStatus = await request("runtime.status");
  assert.equal(oldStatus.apiVersion, 3, "基线应为 v0.1.0 协议");
  await request("care.set", {
    ...(await request("care.get")).settings,
    enabled: false,
  });
  const settings = oldStatus.settings;
  settings.persona.name = "升级演示伙伴";
  settings.persona.instruction = "保留用户自己写的性格约定。";
  settings.pet.character = "luna";
  settings.pet.scale = 1.25;
  Object.assign(settings.provider, {
    kind: "compatible",
    model: "upgrade-fixture",
    baseUrl: `http://127.0.0.1:${mock.address().port}/v1`,
    contextTokens: 100000,
  });
  await request("settings.apply", settings);
  await request("secret.set", { config: settings.provider, key });
  const core = "# 核心记忆\n\n- 升级演示：这份旧记忆必须原样保留。\n";
  await request("memory.write", {
    path: "CORE.md",
    text: core,
    revision: (await request("memory.read", { path: "CORE.md" })).revision,
  });
  const skill =
    "---\nname: upgrade-demo\ndescription: 升级时保留用户自定义技能\n---\n原始内容不要覆盖。\n";
  await request("skills.install", { content: skill });
  const session = (await request("history.state")).current;
  await request("history.send", {
    id: session,
    text: "这是旧版留下的一段升级演示对话。",
  });
  await wait(async () => {
    const state = await request("history.state");
    return (
      !state.busy &&
      state.messages.length === 2 &&
      state.messages.at(-1).status === "complete"
    );
  });
  await wait(async () =>
    (await request("memory.list")).some((p) => p.startsWith("daily/")),
  );
  const diaries = (await request("memory.list")).filter((p) =>
    p.startsWith("daily/"),
  );
  assert.equal(diaries.length, 1);
  await close();
  const oldHistory = JSON.parse(
    await readFile(join(data, "data/conversation.json"), "utf8"),
  );
  assert.equal(oldHistory.messages.length, 2);
  const secretBefore = await readFile(join(data, "data/model-secret.json"));
  const diaryBefore = await readFile(join(home, "memory", diaries[0]));
  ({ page, request } = await launch(newExe));
  const current = await request("runtime.status");
  assert.equal(current.apiVersion, 4);
  assert.equal(current.hasKey, true);
  assert.equal(current.settings.persona.name, settings.persona.name);
  assert.equal(
    current.settings.persona.instruction,
    settings.persona.instruction,
  );
  assert.equal(current.settings.persona.style, "custom");
  assert.equal(current.settings.pet.character, "luna");
  assert.equal(current.settings.pet.scale, 1.25);
  assert.equal(current.settings.provider.contextTokens, 100000);
  assert.equal(current.settings.provider.autoCompactPercent, 80);
  assert.equal((await request("memory.read", { path: "CORE.md" })).text, core);
  assert.equal(
    await readFile(join(home, "skills/upgrade-demo/SKILL.md"), "utf8"),
    skill,
  );
  assert.deepEqual(
    await readFile(join(home, "memory", diaries[0])),
    diaryBefore,
  );
  assert.equal((await request("history.state")).current, session);
  const history = JSON.parse(
    await readFile(join(data, "data/conversation.json"), "utf8"),
  );
  assert.deepEqual(history.messages, oldHistory.messages);
  assert.deepEqual(
    await readFile(join(data, "data/model-secret.json")),
    secretBefore,
  );
  authorizedCalls = 0;
  await request("provider.test");
  assert.ok(authorizedCalls > 0, "新版必须能解密旧版密钥并传给本地模拟模型");
  assert.deepEqual(
    await readFile(join(home, "memory", diaries[0])),
    diaryBefore,
  );
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      {
        passed: true,
        from: "0.1.0",
        to: "0.2.0",
        checks: [
          "settings",
          "custom-personality",
          "context-defaults",
          "encrypted-key-unchanged-and-usable",
          "core-memory",
          "old-diary-unchanged",
          "custom-skill",
          "history-and-session",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: v0.1.0 → v0.2.0 配置、自定义性格、密钥可用性、核心记忆、旧日记、Skill 与历史会话保持。",
  );
  console.log("OUTPUT: " + output);
} finally {
  await close();
  mock.closeAllConnections();
  await new Promise((r) => mock.close(r));
}
