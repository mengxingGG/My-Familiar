// 必须获得用户授权后才运行；只使用隔离副本，永不打印密钥或原聊天内容。
import { chromium } from "playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import electronPath from "electron";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
if (!process.argv.includes("--saved-api"))
  throw new Error("需要明确授权使用已保存 API：--saved-api");
const root = process.cwd(),
  output = resolve(".artifacts/live-api-" + Date.now()),
  data = join(output, "user-data");
await mkdir(join(data, "data"), { recursive: true });
for (const name of ["settings.json", "model-secret.json"])
  await copyFile(
    join(process.env.APPDATA, "Familiar/data", name),
    join(data, "data", name),
  );
// Windows safeStorage 的 v10 密文还依赖 Runtime 的 Local State 加密材料。
await mkdir(join(data, "runtime"), { recursive: true });
await copyFile(
  join(process.env.APPDATA, "Familiar/runtime/Local State"),
  join(data, "runtime/Local State"),
);
const env = { ...process.env, FAMILIAR_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let runtime, controller;
const result = {};
// Playwright 的 Electron 启动器会使用 mock-keychain，不能用来验证真实用户密钥。
async function launch(args) {
  const listener = createServer();
  await new Promise((r) => listener.listen(0, "127.0.0.1", r));
  const port = listener.address().port;
  await new Promise((r) => listener.close(r));
  const child = spawn(
    electronPath,
    [root, ...args, `--remote-debugging-port=${port}`],
    { env, windowsHide: true, stdio: "ignore" },
  );
  child.on("error", () => {});
  let browser;
  for (let i = 0; i < 100; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!browser) throw new Error("测试窗口未就绪");
  return {
    child,
    browser,
    pages: () => browser.contexts()[0].pages(),
    async first() {
      for (let i = 0; i < 100; i++) {
        const page = this.pages().find((p) => p.url().endsWith(".html"));
        if (page) return page;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("没有页面");
    },
    async close() {
      await browser.close();
      if (child.exitCode === null) child.kill();
    },
  };
}
try {
  runtime = await launch([]);
  const pet = await runtime.first();
  await pet.waitForFunction(
    async () => {
      try {
        return (await window.familiar.request("runtime.status")).connected;
      } catch {
        return false;
      }
    },
    {},
    { timeout: 30000 },
  );
  controller = await launch(["--controller"]);
  const page = await controller.first();
  await page.waitForFunction(() => document.body.dataset.connected === "true");
  const request = (name, params) =>
    page.evaluate(({ name, params }) => window.familiar.request(name, params), {
      name,
      params,
    });
  await request("care.set", {
    ...(await request("care.get")).settings,
    enabled: false,
  });
  const state = await request("runtime.status");
  result.provider = state.settings.provider.kind;
  result.model = state.settings.provider.model;
  assert.equal(state.hasKey, true);
  const models = await request("provider.models", { refresh: true });
  assert.ok(models.length);
  result.models = models.map((m) => m.id);
  console.log("PASS: 保存的 API 已恢复；真实模型目录 " + models.length + " 项");
  await page.locator("[data-page=model]").click();
  await page.waitForFunction(
    () => document.querySelector("#model-list").options.length > 0,
  );
  await page.screenshot({
    path: join(output, "live-models.png"),
    fullPage: true,
  });
  await request("chat.open");
  const composer = runtime
      .pages()
      .find((w) => w.url().endsWith("composer.html")),
    speech = runtime.pages().find((w) => w.url().endsWith("speech.html"));
  async function send(text) {
    await request("chat.open");
    await composer.locator("#input").fill(text);
    await composer.locator("#send").click();
    await speech.waitForFunction(
      () => document.body.dataset.busy === "false",
      {},
      { timeout: 120000 },
    );
    const stored = JSON.parse(
      await readFile(join(data, "data/conversation.json"), "utf8"),
    );
    const last = stored.messages.at(-1);
    assert.equal(
      last.status,
      "complete",
      await speech.locator("#speech").textContent(),
    );
    return stored;
  }
  if (process.argv.includes("--care-only")) {
    const greeting = await request("care.preview");
    assert.ok(greeting.length > 0);
    result.careGreeting = true;
    result.careCharacters = greeting.length;
    assert.equal((await request("care.get")).location, undefined);
    console.log("PASS: 真实模型主动问候，无位置授权时未读取位置");
  } else {
    const first = await send(
      "这是灵伴功能测试。请实际调用 memory_remember，记住：测试用户喜欢绿茶。然后简短确认。",
    );
    assert.match(
      (await request("memory.read", { path: "CORE.md" })).text,
      /绿茶/,
    );
    assert.ok(
      first.messages
        .at(-1)
        .trace.some((m) => m.calls?.some((c) => c.name === "memory_remember")),
    );
    result.memoryTool = true;
    console.log("PASS: 真实模型调用记忆工具并完成回复");
    await send(
      "请通过 memory_search 检索这次测试的记忆，再告诉我刚才记住的饮品。简短回答。",
    );
    result.retrieval = true;
    assert.ok((await request("memory.search", { query: "绿茶" })).length);
    await speech.screenshot({ path: join(output, "live-memory-reply.png") });
    const exa = (await request("mcp.list")).find((c) => c.id === "exa");
    try {
      await request("mcp.save", { ...exa, enabled: true });
      const connected = await request("mcp.connect", { id: "exa" });
      result.exaTools = connected.tools;
      console.log(
        "PASS: Exa 官方 MCP 列出 " + connected.tools.length + " 个工具",
      );
    } catch (e) {
      result.exaError = e.message;
      console.log("Exa 连接未通过：" + e.message);
    }
  }
  result.passed = true;
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log("LIVE OUTPUT: " + output);
} catch (e) {
  await writeFile(
    join(output, "result.json"),
    JSON.stringify({ passed: false, error: e.message }, null, 2),
  );
  throw e;
} finally {
  await controller?.close().catch(() => {});
  await runtime?.close().catch(() => {});
}
