import { _electron as electron } from "playwright/test";
import electronPath from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import assert from "node:assert/strict";
const root = process.cwd(),
  packaged = process.argv.includes("--packaged"),
  output = resolve(
    `.artifacts/${packaged ? "packaged-" : ""}smoke-` + Date.now(),
  ),
  data = join(output, "user-data");
await mkdir(output, { recursive: true });
const env = { ...process.env, FAMILIAR_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
const requests = [];
const mock = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        data: [
          { id: "smoke-model", context_length: 65536 },
          { id: "second-model", context_length: 32768 },
        ],
      }),
    );
    return;
  }
  if (req.url !== "/v1/chat/completions") {
    res.writeHead(404);
    res.end();
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const input = JSON.parse(body);
  requests.push(input);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const message = input.messages.at(-1).content;
  const chunks = message.includes("long")
    ? ["长回复验证。".repeat(160)]
    : message.includes("slow")
      ? ["我在", "慢慢想", "，等一下。"]
      : ["你好，", "我会在桌面上", "陪着你。"];
  let index = 0;
  const timer = setInterval(
    () => {
      if (index < chunks.length)
        res.write(
          "data: " +
            JSON.stringify({
              choices: [{ delta: { content: chunks[index++] } }],
            }) +
            "\n\n",
        );
      else {
        clearInterval(timer);
        res.end("data: [DONE]\n\n");
      }
    },
    message.includes("slow") ? 1200 : 80,
  );
  res.on("close", () => clearInterval(timer));
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const launch = (role) =>
  electron.launch({
    executablePath: packaged
      ? join(root, "release/win-unpacked/Familiar.exe")
      : electronPath,
    args: [
      ...(packaged ? [] : [root]),
      ...(role === "controller" ? ["--controller"] : []),
    ],
    env,
    timeout: 30000,
  });
let runtime, controller;
const errors = [];
async function findWindow(application, suffix) {
  for (let i = 0; i < 100; i++) {
    const page = application.windows().find((w) => w.url().endsWith(suffix));
    if (page) return page;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `窗口未就绪：${suffix}; ${application
      .windows()
      .map((w) => w.url())
      .join(",")}`,
  );
}
try {
  runtime = await launch("runtime");
  runtime.process().stderr.on("data", (b) => errors.push(b.toString()));
  const pet = await runtime.firstWindow();
  await pet.waitForFunction(
    () => document.body.dataset.character === "mori",
    {},
    { timeout: 15000 },
  );
  console.log("PASS: 独立宠物、角色加载");
  controller = await launch("controller");
  const page = await controller.firstWindow();
  await page.waitForFunction(() => document.body.dataset.connected === "true");
  assert.notEqual(controller.process().pid, runtime.process().pid);
  const request = (name, params) =>
    page.evaluate(({ name, params }) => window.familiar.request(name, params), {
      name,
      params,
    });
  await request("care.set", {
    ...(await request("care.get")).settings,
    enabled: false,
  });
  await page.locator("#scale").fill("125");
  await page.locator("#character").selectOption("luna");
  await page.waitForFunction(
    () =>
      document.getElementById("pet-save-status").textContent === "已自动保存",
  );
  await pet.waitForFunction(() => document.body.dataset.character === "luna");
  let state = await request("runtime.status");
  assert.equal(state.settings.pet.scale, 1.25);
  assert.equal(state.settings.pet.character, "luna");
  assert.ok(
    Math.abs(
      state.metrics.windows.find((w) => w.kind === "pet").bounds.width - 325,
    ) <= 2,
    "角色应实际缩放至 125%",
  );
  console.log("PASS: 控制器设置应用、角色替换");
  await page.locator("[data-page=model]").click();
  await page
    .locator("#base-url")
    .fill(`http://127.0.0.1:${mock.address().port}/v1`);
  await page.locator("#base-url").press("Tab");
  await page.waitForFunction(
    () => document.querySelector("#model-list").options.length === 2,
  );
  assert.equal(await page.locator("#provider-kind option").count(), 7);
  await page.locator("#model-search").fill("smoke");
  assert.equal(await page.locator("#model-list option").count(), 1);
  await page.locator("#model-list").selectOption("smoke-model");
  await page.locator("#temperature").fill("0.5");
  await page.locator("#model .save").click();
  await page.waitForFunction(() =>
    document.querySelector("#toast").textContent.includes("设置已生效"),
  );
  await page.locator("#test").click();
  await page.waitForFunction(() =>
    document.querySelector("#toast").textContent.includes("连接成功"),
  );
  console.log("PASS: 实际 HTTP SSE 模型连接测试");
  const activeConfig = (await request("runtime.status")).settings.provider;
  await request("secret.set", { config: activeConfig, key: "smoke-secret-a" });
  const otherConfig = { ...activeConfig, kind: "deepseek" };
  assert.equal(
    (await request("provider.inspect", { config: otherConfig })).hasKey,
    false,
  );
  await request("secret.set", { config: otherConfig, key: "smoke-secret-b" });
  assert.equal(
    (await request("provider.inspect", { config: activeConfig })).hasKey,
    true,
  );
  assert.equal(
    (
      await request("provider.inspect", {
        config: { ...activeConfig, baseUrl: "http://localhost:9998/v1" },
      })
    ).hasKey,
    false,
  );
  const secretFile = await readFile(
    join(data, "data", "model-secret.json"),
    "utf8",
  );
  assert.equal(secretFile.includes("smoke-secret"), false);
  await page.locator("#provider-kind").selectOption("claude");
  await page.waitForFunction(
    () => document.querySelector("#thinking-mode").options.length < 5,
  );
  await page.locator("#thinking-mode").selectOption("budget");
  await page.waitForFunction(
    () => document.querySelector("#temperature-auto").disabled,
  );
  assert.equal(await page.locator("#budget-row").isVisible(), true);
  await page.locator("#provider-kind").selectOption("compatible");
  await page.waitForFunction(() =>
    document.querySelector("#base-url").value.includes("127.0.0.1"),
  );
  assert.equal(await page.locator("#model-id").inputValue(), "smoke-model");
  assert.equal(await page.locator("#temperature").inputValue(), "0.5");
  await page.waitForFunction(
    () => document.querySelector("#thinking-mode").options.length === 3,
  );
  assert.equal(await page.locator("#budget-row").isVisible(), false);
  assert.equal(await page.locator("#effort-row").isVisible(), false);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: join(output, "model-settings.png"),
    fullPage: true,
  });
  console.log(
    "PASS: 七种服务、模型自动获取/搜索、参数联动、配置切换、密钥隔离与系统加密",
  );
  await page.locator("[data-page=home]").click();
  await page.screenshot({ path: join(output, "controller.png") });
  await pet.screenshot({ path: join(output, "pet.png"), omitBackground: true });
  await request("chat.open");
  const composer = await findWindow(runtime, "composer.html");
  const speech = await findWindow(runtime, "speech.html");
  assert.ok(composer);
  assert.ok(speech);
  await composer.waitForLoadState("domcontentloaded");
  const inputMetrics = (await request("runtime.status")).metrics.windows;
  const petBounds = inputMetrics.find((w) => w.kind === "pet").bounds;
  const inputBounds = inputMetrics.find((w) => w.kind === "composer").bounds;
  assert.ok(
    Math.abs(
      inputBounds.y +
        inputBounds.height -
        (petBounds.y + petBounds.height * 0.27),
    ) < 3,
    "输入与回复应使用宠物头顶锚点",
  );
  assert.equal(inputMetrics.find((w) => w.kind === "speech").visible, false);
  const beforeTyping = requests.length;
  await composer.locator("#input").fill("第一行");
  await composer.locator("#input").press("Enter");
  await composer.locator("#input").pressSequentially("second line");
  assert.equal(
    await composer.locator("#input").inputValue(),
    "第一行\nsecond line",
  );
  assert.equal(requests.length, beforeTyping, "Enter 换行不能触发请求");
  await composer.locator("#input").dispatchEvent("keydown", {
    key: "Enter",
    shiftKey: true,
    isComposing: true,
  });
  assert.equal(requests.length, beforeTyping, "IME 组合输入不能触发发送");
  await composer.locator("#input").press("Shift+Enter");
  await speech.waitForFunction(() => document.body.dataset.busy === "true");
  await speech.waitForFunction(() => document.body.dataset.busy === "false");
  assert.equal(requests.at(-1).messages.at(-1).content, "第一行\nsecond line");
  console.log("PASS: Enter 换行、Shift+Enter 发送、组合输入不误发送");
  const firstSession = (await request("runtime.status")).session;
  await request("chat.open");
  assert.equal(
    (await request("runtime.status")).metrics.windows.find(
      (w) => w.kind === "speech",
    ).visible,
    false,
    "编辑时必须收起输出气泡",
  );
  await composer.locator("#input").fill("slow 独立聊天");
  await composer.screenshot({
    path: join(output, "composer.png"),
    omitBackground: true,
  });
  await composer.locator("#send").click();
  await speech.waitForFunction(() => document.body.dataset.busy === "true");
  assert.equal(
    (await request("runtime.status")).metrics.windows.find(
      (w) => w.kind === "composer",
    ).visible,
    false,
  );
  const runtimePid = runtime.process().pid;
  await controller.close();
  controller = undefined;
  await speech.waitForFunction(() => document.body.dataset.busy === "false");
  await speech.waitForFunction(() =>
    document
      .querySelector("#speech")
      .textContent.includes("我在慢慢想，等一下。"),
  );
  const shortBubble = await speech.evaluate(() =>
    window.familiar.request("runtime.status"),
  );
  console.log(
    "BUBBLE BOUNDS",
    shortBubble.metrics.windows.find((w) => w.kind === "speech").bounds,
  );
  assert.ok(
    shortBubble.metrics.windows.find((w) => w.kind === "speech").bounds
      .height <= 150,
    "短回复应使用紧凑气泡",
  );
  assert.equal(runtime.process().pid, runtimePid);
  assert.equal(shortBubble.session.id, firstSession.id);
  assert.equal(shortBubble.session.epoch, firstSession.epoch);
  assert.deepEqual(
    requests.at(-1).messages.slice(0, 2),
    requests.at(-2).messages,
  );
  const replyBounds = shortBubble.metrics.windows.find(
    (w) => w.kind === "speech",
  ).bounds;
  assert.ok(
    Math.abs(
      replyBounds.y + replyBounds.height - (inputBounds.y + inputBounds.height),
    ) < 3,
    "回复和输入的底部锚点相同",
  );
  await speech.screenshot({
    path: join(output, "speech.png"),
    omitBackground: true,
  });
  console.log("PASS: 关闭控制器后，气泡中的回复继续完成；输入条已收起");
  controller = await launch("controller");
  const second = await controller.firstWindow();
  await second.waitForFunction(
    () => document.body.dataset.connected === "true",
  );
  const recovered = await second.evaluate(() =>
    window.familiar.request("runtime.status"),
  );
  assert.equal(recovered.settings.pet.scale, 1.25);
  await second.evaluate(() => window.familiar.request("chat.open"));
  await composer.locator("#input").fill("保留未发送草稿");
  await composer.keyboard.press("Escape");
  assert.equal(
    (
      await second.evaluate(() => window.familiar.request("runtime.status"))
    ).metrics.windows.find((w) => w.kind === "composer").visible,
    false,
  );
  await second.evaluate(() => window.familiar.request("chat.open"));
  assert.equal(await composer.locator("#input").inputValue(), "保留未发送草稿");
  await composer.locator("#input").fill("slow 取消测试");
  await composer.locator("#send").click();
  await speech.locator("#cancel").waitFor({ state: "visible" });
  await speech.locator("#cancel").click();
  await speech.waitForFunction(() => document.body.dataset.busy === "false");
  await second.evaluate(() => window.familiar.request("chat.clear"));
  assert.equal(
    (
      await second.evaluate(() => window.familiar.request("runtime.status"))
    ).metrics.windows.find((w) => w.kind === "speech").visible,
    false,
  );
  console.log("PASS: 重连、Esc 保留草稿、气泡取消、清空");
  await second.evaluate(() => window.familiar.request("chat.open"));
  await composer.locator("#input").fill("恢复记录测试");
  await composer.locator("#send").click();
  await speech.waitForFunction(() =>
    document.querySelector("#speech").textContent.includes("陪着你。"),
  );
  await speech.waitForFunction(() => document.body.dataset.busy === "false");
  const controllerPid = await controller.evaluate(() => process.pid);
  const exited = controller.waitForEvent("close");
  process.kill(controllerPid);
  await exited;
  controller = undefined;
  await speech.locator("#continue").click();
  await composer.locator("#input").fill("强制结束控制器后继续");
  await composer.locator("#send").click();
  await speech.waitForFunction(() => document.body.dataset.busy === "false");
  assert.equal(runtime.process().pid, runtimePid);
  console.log("PASS: 强制结束控制器后仍可从宠物发起对话");
  const restartSession = (
    await speech.evaluate(() => window.familiar.request("runtime.status"))
  ).session;
  await runtime.close();
  runtime = undefined;
  // 在隔离数据目录模拟旧版单密钥存储，验证启动迁移。
  const encrypted = Object.values(
    JSON.parse(await readFile(join(data, "data", "model-secret.json"), "utf8"))
      .entries,
  )[0];
  await writeFile(
    join(data, "data", "model-secret.json"),
    JSON.stringify(encrypted),
  );
  runtime = await launch("runtime");
  const restarted = await runtime.firstWindow();
  await restarted.waitForFunction(
    () => document.body.dataset.character === "luna",
  );
  await restarted.waitForFunction(async () => {
    try {
      return (await window.familiar.request("runtime.status")).connected;
    } catch {
      return false;
    }
  });
  await restarted.evaluate(() => window.familiar.request("chat.open"));
  const restoredInput = await findWindow(runtime, "composer.html");
  const restoredSpeech = await findWindow(runtime, "speech.html");
  await restoredInput.locator("#input").fill("接着刚刚的话题");
  const restoredWindows = (
    await restarted.evaluate(() => window.familiar.request("runtime.status"))
  ).metrics.windows;
  assert.equal(
    restoredWindows.find((w) => w.kind === "composer").visible,
    true,
  );
  await restoredInput.screenshot({ path: join(output, "restart-input.png") });
  await restoredInput.locator("#send").click({ timeout: 5000 });
  await restoredSpeech.waitForFunction(
    () => document.body.dataset.busy === "false",
  );
  assert.ok(requests.at(-1).messages.some((m) => m.content === "恢复记录测试"));
  const restoredStatus = await restarted.evaluate(() =>
    window.familiar.request("runtime.status"),
  );
  assert.equal(restoredStatus.session.id, restartSession.id);
  assert.equal(restoredStatus.session.epoch, restartSession.epoch);
  assert.equal(restoredStatus.hasKey, true);
  assert.equal(
    JSON.parse(await readFile(join(data, "data", "model-secret.json"), "utf8"))
      .version,
    2,
  );
  console.log("PASS: Runtime 重启恢复角色、配置和后台上下文，无聊天记录页面");
  await restarted.evaluate(() => window.familiar.request("chat.open"));
  for (let i = 0; i < 15; i++)
    await restarted.evaluate(() => window.familiar.request("chat.open"));
  const overlayMetrics = await restarted.evaluate(() =>
    window.familiar.request("runtime.status"),
  );
  assert.ok(
    overlayMetrics.metrics.windows.find((w) => w.kind === "composer").bounds
      .width < 386,
    "反复唤出输入条不能累积尺寸漂移",
  );
  await restoredInput.locator("#input").fill("long 长回复测试");
  await restoredInput.locator("#send").click();
  await restoredSpeech.waitForFunction(
    () =>
      document.querySelector("#speech").textContent.length > 600 &&
      document.body.dataset.busy === "false",
  );
  assert.ok(
    await restoredSpeech.evaluate(() => {
      const el = document.querySelector("#speech");
      return el.scrollHeight > el.clientHeight;
    }),
  );
  await restoredSpeech.screenshot({
    path: join(output, "long-speech.png"),
    omitBackground: true,
  });
  const metrics = await restarted.evaluate(() =>
    window.familiar.request("runtime.status"),
  );
  assert.ok(
    metrics.metrics.windows.find((w) => w.kind === "speech").bounds.height <=
      287,
  );
  console.log("PASS: 长回复完整保留且内部滚动，重复唤出不累积尺寸漂移");
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(
      {
        passed: true,
        packaged,
        metrics: metrics.metrics,
        output,
        checks: [
          "independent-processes",
          "character-switch",
          "configuration-apply",
          "provider-SSE",
          "provider-model-list-and-parameters",
          "provider-key-isolation-and-migration",
          "shared-head-bubble-anchor",
          "stable-session-prefix-and-restart",
          "controller-close-during-chat",
          "controller-reconnect",
          "controller-force-kill",
          "bubble-stream",
          "enter-newline-shift-enter-send",
          "composer-escape-draft",
          "cancel",
          "clear",
          "restart-persistence",
          "compact-and-scrollable-bubbles",
        ],
        logs: errors,
      },
      null,
      2,
    ),
  );
  console.log("SMOKE OUTPUT: " + output);
} catch (e) {
  console.error(errors.join(""));
  console.error("SMOKE FAILURE", e);
  throw e;
} finally {
  await controller?.close().catch(() => {});
  await runtime?.close().catch(() => {});
  mock.closeAllConnections();
  await new Promise((r) => mock.close(r));
}
