// --saved-api 仅在用户已授权使用其保存的模型连接时运行；只复制配置和密文，不复制真实聊天。
import { chromium } from "playwright/test";
import electronPath from "electron";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
const live = process.argv.includes("--saved-api"),
  packaged = process.argv.includes("--packaged"),
  root = process.cwd(),
  executablePath = packaged
    ? join(root, "release/win-unpacked/Familiar.exe")
    : electronPath,
  baseArgs = packaged ? [] : [root],
  output = resolve(
    `.artifacts/${packaged ? "packaged-" : ""}context-${live ? "live" : "smoke"}-${Date.now()}`,
  ),
  data = join(output, "user-data");
await mkdir(join(data, "data"), { recursive: true });
const summary = {
  goals: ["准备青岚计划"],
  constraints: ["预算 347 元，不代购，不改 9 月 22 日"],
  facts: ["目的地是森林"],
  decisions: ["先核对清单"],
  progress: ["已查路线"],
  pending: ["未买票"],
  uncertainties: ["午餐未确定"],
  artifacts: ["qinglan.md"],
};
const requests = [];
const mock = createServer(async (req, res) => {
  if (req.url === "/v1/models") {
    res.setHeader("Content-Type", "application/json");
    return res.end(
      JSON.stringify({
        data: [{ id: "context-fixture", context_length: 128000 }],
      }),
    );
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  const compact = body.messages[0]?.content.startsWith("你是会话交接整理器");
  res.setHeader("Content-Type", "text/event-stream");
  res.end(
    "data: " +
      JSON.stringify({
        choices: [
          {
            delta: {
              content: compact
                ? JSON.stringify(summary)
                : "青岚计划预算 347 元，9 月 22 日出发。还没有买票，先核对清单。",
            },
            finish_reason: "stop",
          },
        ],
      }) +
      "\n\ndata: [DONE]\n\n",
  );
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
if (live) {
  for (const file of ["settings.json", "model-secret.json"])
    await copyFile(
      join(process.env.APPDATA, "Familiar/data", file),
      join(data, "data", file),
    );
  await mkdir(join(data, "runtime"), { recursive: true });
  await copyFile(
    join(process.env.APPDATA, "Familiar/runtime/Local State"),
    join(data, "runtime/Local State"),
  );
}
// 合成旧历史：关键约束在最早一轮，近期不重复，检查压缩后的实际回答。
const id = randomUUID(),
  messages = [];
for (let i = 0; i < 10; i++) {
  messages.push({
    id: randomUUID(),
    role: "user",
    text:
      (i === 0
        ? "青岚计划：预算 347 元，9 月 22 日去森林，不能替我买票，清单文件 qinglan.md。"
        : `第 ${i} 段普通资料。`) +
      "This is an unimportant repeated note about the scenery. ".repeat(105),
    time: Date.now() + i * 2,
    status: "complete",
  });
  messages.push({
    id: randomUUID(),
    role: "assistant",
    text: "了解，继续核对清单。",
    time: Date.now() + i * 2 + 1,
    status: "complete",
  });
}
await writeFile(
  join(data, "data/conversation.json"),
  JSON.stringify({
    version: 2,
    session: { id, epoch: 0, fingerprint: "", trimmed: 0 },
    messages,
  }),
);
const env = { ...process.env, FAMILIAR_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
const processes = [];
async function launch(args) {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const child = spawn(
    executablePath,
    [...baseArgs, ...args, `--remote-debugging-port=${port}`],
    { env, windowsHide: true, stdio: "ignore" },
  );
  const item = { child };
  processes.push(item);
  for (let n = 0; n < 150; n++) {
    try {
      item.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!item.browser) throw new Error("测试应用未就绪");
  for (let n = 0; n < 100; n++) {
    const page = item.browser
      .contexts()[0]
      .pages()
      .find((p) => p.url().endsWith(".html"));
    if (page) return page;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("测试窗口未就绪");
}
let request;
try {
  await launch([]);
  const page = await launch(["--controller"]);
  await page.waitForFunction(
    () => document.body.dataset.connected === "true",
    {},
    { timeout: 30000 },
  );
  request = (name, params) =>
    page.evaluate(({ name, params }) => window.familiar.request(name, params), {
      name,
      params,
    });
  await request("care.set", {
    ...(await request("care.get")).settings,
    enabled: false,
  });
  const config = (await request("runtime.status")).settings;
  if (!live)
    Object.assign(config.provider, {
      kind: "compatible",
      baseUrl: `http://127.0.0.1:${mock.address().port}/v1`,
      model: "context-fixture",
    });
  Object.assign(config.provider, {
    contextTokens: 32768,
    autoCompactPercent: 80,
    maxOutputTokens: 4096,
  });
  await request("settings.apply", config);
  await page.locator("#refresh").click();
  await page.locator('[data-page="model"]').click();
  await page.waitForFunction(
    () => document.querySelector("#context-tokens").value === "32768",
  );
  assert.equal(await page.locator("#compact-percent").inputValue(), "80");
  await page.locator("#compact-percent").fill("75");
  await page.locator("#model .save").click();
  await page.waitForFunction(
    async () =>
      (await window.familiar.request("runtime.status")).settings.provider
        .autoCompactPercent === 75,
  );
  await page.screenshot({
    path: join(output, "model-settings.png"),
    fullPage: true,
  });
  await request("history.send", {
    id,
    text: "继续青岚计划。请说出原定预算、出发日期和还没完成的事。只回答，不操作文件，不执行命令，不写记忆或日记。",
  });
  const end = Date.now() + 240000;
  let state;
  do {
    await new Promise((r) => setTimeout(r, 250));
    state = await request("history.state");
    if (Date.now() > end) throw new Error("会话测试超时");
  } while (state.busy);
  assert.equal(state.error, undefined);
  const stored = JSON.parse(
    await readFile(join(data, "data/conversation.json"), "utf8"),
  );
  assert.equal(stored.session.id, id);
  assert.ok(stored.session.compactions > 0);
  assert.equal(stored.messages.length, 22);
  assert.match(stored.messages.at(-1).text, /347/);
  assert.match(stored.messages.at(-1).text, /22/);
  assert.match(JSON.stringify(stored.session.checkpoint.summary), /347/);
  assert.equal(
    (await request("memory.list")).filter((p) => p.startsWith("daily/")).length,
    0,
  );
  await page.locator('[data-page="history"]').click();
  await page.locator("#history-list").selectOption(id);
  await page.locator("#history-context").waitFor({ state: "visible" });
  await page.locator("#history-context-title").click();
  assert.match(
    await page.locator("#history-context-body").textContent(),
    /347/,
  );
  await page.screenshot({
    path: join(output, "history-summary.png"),
    fullPage: true,
  });
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      {
        passed: true,
        live,
        model: config.provider.model,
        compactions: stored.session.compactions,
        inputTokens: stored.session.status.inputTokens,
        threshold: stored.session.status.compactThreshold,
        originalMessages: 20,
        preservedMessages: stored.messages.length,
        answerRecallsBudgetAndDate: true,
        diaryFiles: 0,
        uiThresholdSaved: true,
        summaryVisible: true,
        mockCompactionCalls: live
          ? undefined
          : requests.filter((r) =>
              r.messages[0]?.content.startsWith("你是会话交接整理器"),
            ).length,
      },
      null,
      2,
    ),
  );
  console.log("CONTEXT CHECK PASS: " + output);
} catch (e) {
  await writeFile(
    join(output, "report.json"),
    JSON.stringify({ passed: false, live, error: e.message }, null, 2),
  );
  throw e;
} finally {
  await request?.("runtime.stop").catch(() => {});
  for (const p of processes.reverse()) {
    await p.browser?.close().catch(() => {});
    if (p.child.exitCode === null) p.child.kill();
  }
  mock.closeAllConnections();
  await new Promise((r) => mock.close(r));
}
