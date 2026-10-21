import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
const app = "app.familiar.mobile.debug",
  output = ".artifacts/android-device";
const adb = (...args) =>
  execFileSync(
    "C:/AndroidSDK/platform-tools/adb.exe",
    ["-s", "emulator-5554", ...args],
    { encoding: "utf8", windowsHide: true },
  ).trim();
const wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  results = [],
  usage = [];
let browser,
  page,
  seq = 0,
  before,
  conversationId,
  changed = false,
  slow = false,
  lastTest,
  summaryRequests = 0,
  normalRequests = 0;
const summary = {
  goals: ["验证 Android 长会话上下文"],
  constraints: ["只使用隔离的本地验收服务"],
  facts: ["fixture-source-marker 已保留"],
  decisions: ["继续当前会话"],
  progress: ["模型目录与参数已检查"],
  pending: ["检查原文回查"],
  uncertainties: [],
  artifacts: ["本地验收会话"],
};
const server = createServer(async (req, res) => {
  try {
    if (req.url.endsWith("/models")) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: [
            {
              id: "model-fixture",
              name: "隔离模型",
              context_length: 120000,
              top_provider: { max_completion_tokens: 10000 },
            },
            {
              id: "model-fixture-selected",
              name: "目录选择验收",
              context_length: 120000,
              top_provider: { max_completion_tokens: 10000 },
            },
          ],
        }),
      );
      return;
    }
    let body = "";
    for await (const c of req) body += c;
    const input = JSON.parse(body),
      test =
        input.messages.length === 1 &&
        input.messages[0].content === "请只回复：连接成功",
      compact = input.messages.some(
        (m) =>
          typeof m.content === "string" &&
          m.content.startsWith("你是会话交接整理器"),
      );
    if (test) lastTest = input;
    else if (compact) summaryRequests++;
    else normalRequests++;
    const content = test
      ? "连接成功"
      : compact
        ? JSON.stringify(summary)
        : "这是隔离的模型验收回复，继续保留当前记录。".repeat(40);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const timer = setTimeout(
      () =>
        res.end(
          `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 4321, completion_tokens: 128, prompt_tokens_details: { cached_tokens: 1024 } } })}\n\ndata: [DONE]\n\n`,
        ),
      test && slow ? 10000 : 5,
    );
    res.on("close", () => clearTimeout(timer));
  } catch {
    res.writeHead(500);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port,
  baseUrl = `http://127.0.0.1:${port}/v1`;
adb("reverse", `tcp:${port}`, `tcp:${port}`);
const pass = (name) => {
  results.push(name);
  console.log("PASS " + name);
};
async function attach() {
  adb("shell", "am", "start", "-n", `${app}/app.familiar.mobile.MainActivity`);
  for (let n = 0; n < 60; n++) {
    try {
      adb(
        "forward",
        "tcp:9227",
        `localabstract:webview_devtools_remote_${adb("shell", "pidof", app)}`,
      );
      browser = await chromium.connectOverCDP("http://127.0.0.1:9227");
      page = browser.contexts()[0].pages()[0];
      if (page) break;
      await browser.close();
    } catch {}
    await wait(250);
  }
  assert(page);
  await page.reload();
  await page.locator('#familiar-root[data-ready="true"]').waitFor();
}
async function raw(method, params) {
  return page.evaluate(
    (payload) =>
      window.__TAURI_INTERNALS__.invoke("plugin:familiar-android|invoke", {
        payload,
      }),
    { protocolVersion: 1, id: `model-${++seq}`, method, params },
  );
}
async function call(method, params) {
  const r = await raw(method, params);
  assert(r.ok, `${method}: ${r.error?.code}`);
  return r.result;
}
const restoreProfile = (p) => ({
  kind: p.kind,
  baseUrl: p.baseUrl,
  model: p.model,
  advanced: p.advanced,
});
try {
  await attach();
  before = await call("snapshot.get");
  await writeFile(
    `${output}/model-before.json`,
    JSON.stringify(
      {
        provider: before.provider,
        providers: before.providers,
        activeConversationId: before.activeConversationId,
      },
      null,
      2,
    ),
  );
  assert(before.modelManagement && before.contextManagement);
  assert(!before.activeReply && !before.voice.state.active);
  const original = before.providers.find((p) => p.id === "compatible").profile;
  await call("provider.save", {
    kind: "compatible",
    baseUrl,
    model: "model-fixture",
    advanced: original.advanced,
    apiKey: "isolated-android-model-fixture",
  });
  changed = true;
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /模型连接/ }).click();
  await page.waitForFunction(expected => document.querySelector('.page:not([hidden]) input[type=url]')?.value === expected, baseUrl);
  await page.getByRole("button", { name: "获取模型列表", exact: true }).click();
  await page
    .getByRole("button", {
      name: "选择模型 model-fixture-selected",
      exact: true,
    })
    .click();
  assert.equal((await call("snapshot.get")).provider.model, "model-fixture");
  await page.locator(".model-tools details summary").click();
  await page
    .getByLabel("温度（留空使用模型默认）", { exact: true })
    .fill("0.4");
  await page
    .getByLabel("Top P（留空使用模型默认）", { exact: true })
    .fill("0.9");
  await page.getByLabel("最大输出 token", { exact: true }).fill("2048");
  await page
    .getByLabel("上下文窗口（留空自动识别）", { exact: true })
    .fill("120000");
  await page.getByLabel("自动压缩阈值（%）", { exact: true }).fill("70");
  await page.getByLabel("请求超时（秒）", { exact: true }).fill("45");
  await page.getByLabel("思考模式", { exact: true }).selectOption("effort");
  await page.getByLabel("思考强度", { exact: true }).selectOption("high");
  await page.getByLabel("使用提供方支持的提示缓存", { exact: true }).uncheck();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("已保存。", { exact: true }).waitFor();
  const saved = (await call("snapshot.get")).provider;
  assert.equal(saved.model, "model-fixture-selected");
  assert.equal(saved.advanced.autoCompactPercent, 70);
  assert.equal(saved.advanced.contextTokens, 120000);
  assert.equal(saved.advanced.thinking.effort, "high");
  pass("实际 Android 页面获取目录、选择模型并保存高级参数");
  await page
    .getByRole("button", { name: "测试已保存连接", exact: true })
    .click();
  await page.getByText(/连接成功，模型已返回文字/).waitFor();
  assert.deepEqual(lastTest.messages, [
    { role: "user", content: "请只回复：连接成功" },
  ]);
  assert.equal(lastTest.model, "model-fixture-selected");
  assert.equal(lastTest.temperature, 0.4);
  assert.equal(lastTest.top_p, 0.9);
  assert.equal(lastTest.max_tokens, 2048);
  assert.equal(lastTest.reasoning_effort, "high");
  assert.equal(
    JSON.stringify(
      (await call("snapshot.get")).conversations.map((c) => ({
        id: c.id,
        messages: c.messages,
      })),
    ),
    JSON.stringify(
      before.conversations.map((c) => ({ id: c.id, messages: c.messages })),
    ),
  );
  pass("原生桥连接测试使用已保存参数，固定测试句不带聊天记忆也不写入历史");
  slow = true;
  lastTest = null;
  await page
    .getByRole("button", { name: "测试已保存连接", exact: true })
    .click();
  for (let n = 0; !lastTest && n < 60; n++) await wait(50);
  assert(lastTest);
  const started = Date.now();
  await call("snapshot.get");
  await page.getByRole("button", { name: "停止连接测试", exact: true }).click();
  await page.getByText("连接测试已停止。", { exact: true }).waitFor();
  assert(Date.now() - started < 3000);
  slow = false;
  pass("慢连接测试可以停止，期间核心快照仍可响应");
  await page
    .getByLabel("温度（留空使用模型默认）", { exact: true })
    .scrollIntoViewIfNeeded();
  await wait(3500);
  await page.screenshot({ path: `${output}/model-settings.png` });
  await page
    .locator(".page")
    .filter({
      has: page.getByRole("heading", { name: "模型连接", exact: true }),
    })
    .locator(".pagebar button")
    .click();
  conversationId = (await call("conversation.create")).id;
  assert.equal(
    (await call("conversation.context", { conversationId })).status,
    undefined,
  );
  let context;
  for (let round = 0; round < 16; round++) {
    await call("message.send", {
      conversationId,
      text:
        `fixture-source-marker 第 ${round + 1} 轮，仅用于本地长会话验收。` +
        "资料片段内容记录".repeat(950),
    });
    let done = false;
    for (let n = 0; n < 180; n++) {
      const s = await call("snapshot.get");
      if (!s.activeReply) {
        const m = s.conversations
          .find((c) => c.id === conversationId)
          ?.messages.at(-1);
        if (m?.role === "assistant") {
          assert.equal(
            m.status,
            "complete",
            m.status === "error" ? m.text : undefined,
          );
          done = true;
          break;
        }
      }
      await wait(100);
    }
    assert(done, "模型响应超时");
    context = await call("conversation.context", { conversationId });
    usage.push({
      round: round + 1,
      inputTokens: context.status?.inputTokens,
      compactions: context.status?.compactions,
      threshold: context.status?.compactThreshold,
    });
    console.log("CONTEXT " + JSON.stringify(usage.at(-1)));
    if (context.checkpoint) break;
  }
  assert(context.checkpoint && summaryRequests > 0);
  assert.equal(context.status.exact, false);
  assert.equal(context.status.usage.inputTokens, 4321);
  assert.equal(context.status.usage.cachedInputTokens, 1024);
  assert.deepEqual(context.checkpoint.summary.pending, summary.pending);
  const archive = await call("context.archive", {
    conversationId,
    checkpoint: context.checkpoint.id,
  });
  assert(archive.text.includes("fixture-source-marker"));
  if (archive.nextOffset !== null)
    assert(
      (
        await call("context.archive", {
          conversationId,
          checkpoint: context.checkpoint.id,
          offset: archive.nextOffset,
        })
      ).text.length > 0,
    );
  pass("真实会话达到阈值后自动生成检查点，摘要、用量和完整原文可回查");
  await page.getByRole("button", { name: "聊天", exact: true }).click();
  await page.getByRole("button", { name: "会话上下文", exact: true }).click();
  await page.getByText("输入 token（保守估算）", { exact: true }).waitFor();
  await page.getByText("4321 / 128", { exact: true }).waitFor();
  await wait(3500);
  await page.screenshot({ path: `${output}/model-context.png` });
  await page.locator(".context-page details summary").click();
  await page.getByRole("button", { name: "读取本段原文", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector(".context-page pre")
      .textContent.includes("fixture-source-marker"),
  );
  await page.locator(".context-page pre").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${output}/model-archive.png` });
  await page
    .getByLabel("查找压缩原文", { exact: true })
    .fill("fixture-source-marker");
  await page.getByRole("button", { name: "查找", exact: true }).click();
  pass("设备上下文页面展示真实检查点与服务用量，原文读取及搜索可用");
  const apk = adb("shell", "pm", "path", app)
      .split("\n")[0]
      .replace("package:", "")
      .trim(),
    verified = JSON.parse(
      await readFile(`${output}/apk-verification.json`, "utf8"),
    );
  assert.equal(adb("shell", "sha256sum", apk).split(/\s+/)[0], verified.sha256);
  pass("模拟器安装包与 ARM64 验证产物哈希相同");
} finally {
  try {
    if (page && before) {
      await call("reply.cancel");
      if (conversationId) {
        await call("conversation.delete", { id: conversationId });
        if (before.activeConversationId)
          await call("conversation.select", {
            id: before.activeConversationId,
          });
      }
      if (changed) {
        const current = (await call("snapshot.get")).provider;
        await call("provider.save", {
          ...restoreProfile(current),
          baseUrl,
          clearApiKey: true,
        });
        await call(
          "provider.save",
          restoreProfile(
            before.providers.find((p) => p.id === "compatible").profile,
          ),
        );
        if (before.provider.kind !== "compatible")
          await call("provider.save", restoreProfile(before.provider));
      }
      const after = await call("snapshot.get");
      assert.deepEqual(after.provider, before.provider);
      assert.equal(after.activeReply, null);
      await writeFile(
        `${output}/model-restored.json`,
        JSON.stringify(
          {
            date: new Date().toISOString(),
            provider: after.provider,
            modelManagement: after.modelManagement,
            contextManagement: after.contextManagement,
            runtime: after.runtime,
            testConversationRemoved: !after.conversations.some(
              (c) => c.id === conversationId,
            ),
          },
          null,
          2,
        ),
      );
    }
  } catch (error) {
    console.error("模型验收清理失败", error);
    process.exitCode = 1;
  }
  await browser?.close();
  adb("reverse", "--remove", `tcp:${port}`);
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await writeFile(
    `${output}/model-smoke.json`,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        results,
        usage,
        normalRequests,
        summaryRequests,
      },
      null,
      2,
    ),
  );
}
