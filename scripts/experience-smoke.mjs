import { _electron as electron } from "playwright/test";
import electronPath from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import assert from "node:assert/strict";
const root = process.cwd(),
  packaged = process.argv.includes("--packaged"),
  executablePath = packaged
    ? join(root, "release/win-unpacked/Familiar.exe")
    : electronPath,
  baseArgs = packaged ? [] : [root],
  output = resolve(
    `.artifacts/${packaged ? "packaged-" : ""}experience-smoke-` + Date.now(),
  ),
  data = join(output, "user-data");
await mkdir(output, { recursive: true });
const requests = [],
  errors = [];
const mock = createServer(async (req, res) => {
  if (req.url === "/v1/models") {
    res.setHeader("Content-Type", "application/json");
    return res.end(
      JSON.stringify({ data: [{ id: "ux-fixture", context_length: 65536 }] }),
    );
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  const last = body.messages.at(-1);
  res.setHeader("Content-Type", "text/event-stream");
  const emit = (value) =>
    res.write("data: " + JSON.stringify({ choices: [value] }) + "\n\n");
  if (last.role === "user" && last.content.startsWith("shell"))
    emit({
      delta: {
        tool_calls: [
          {
            index: 0,
            id: "ux-" + requests.length,
            type: "function",
            function: {
              name: "shell_run",
              arguments: JSON.stringify({
                command: "Write-Output 'UX_PERMISSION_OK'",
              }),
            },
          },
        ],
      },
      finish_reason: "tool_calls",
    });
  else {
    emit({
      delta: {
        content:
          last.role === "tool" ? "工具完成。" : "我在这里，今天也陪着你。",
      },
    });
    await new Promise((r) => setTimeout(r, 350));
  }
  res.end("data: [DONE]\n\n");
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const env = { ...process.env, FAMILIAR_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let runtime, controller, page;
async function wait(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("等待条件超时");
    await new Promise((r) => setTimeout(r, 60));
  }
}
try {
  runtime = await electron.launch({
    executablePath,
    args: baseArgs,
    env,
  });
  runtime.process().stderr.on("data", (b) => errors.push(b.toString()));
  await runtime.firstWindow();
  controller = await electron.launch({
    executablePath,
    args: [...baseArgs, "--controller"],
    env,
  });
  page = await controller.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
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
  const config = (await request("runtime.status")).settings;
  assert.equal(config.pet.bubbleSeconds, 15);
  config.provider.model = "ux-fixture";
  config.provider.baseUrl = `http://127.0.0.1:${mock.address().port}/v1`;
  await request("settings.apply", config);
  await page.locator("#scale").fill("135");
  await page.locator("#character").selectOption("luna");
  await wait(async () => {
    const c = (await request("runtime.status")).settings;
    return c.pet.scale === 1.35 && c.pet.character === "luna";
  });
  await page.locator("#bubble-seconds").fill("1");
  await page.locator("#bubble-seconds").blur();
  await wait(
    async () =>
      (await request("runtime.status")).settings.pet.bubbleSeconds === 1,
  );
  console.log("PASS: 角色和大小无需保存实时改变，气泡秒数自动保存");
  // 使用独立注册项验证 Windows 的真实写入/读回，不修改用户的 Familiar 注册项。
  const login = await runtime.evaluate(({ app }) => {
    const options = {
      name: "Familiar UX Test " + Date.now(),
      path: process.execPath,
      args: app.isPackaged ? [] : [app.getAppPath()],
    };
    try {
      app.setLoginItemSettings({
        ...options,
        openAtLogin: true,
        enabled: true,
      });
      const s = app.getLoginItemSettings({
        ...options,
        path: `"${process.execPath}"`,
      });
      const item = s.launchItems.find((i) => i.name === options.name);
      return {
        open:
          !!item && JSON.stringify(item.args) === JSON.stringify(options.args),
        enabled: item?.enabled,
        items: item ? [item] : [],
      };
    } finally {
      app.setLoginItemSettings({
        ...options,
        openAtLogin: false,
        enabled: false,
      });
    }
  });
  console.log("LOGIN TEST", JSON.stringify(login));
  assert.equal(login.open, true);
  assert.equal(login.enabled, true);
  console.log("PASS: Windows 登录启动注册与读回（带空格路径），测试项已移除");
  await page.locator('[data-page="permissions"]').click();
  await wait(
    async () => (await page.locator("#policy-read").inputValue()) === "allow",
  );
  assert.equal(await page.locator("#policy-shell").inputValue(), "ask");
  await page.locator("#policy-shell").selectOption("allow");
  await page.locator("#policy-save").click();
  await wait(
    async () => (await request("policy.get")).defaults.shell === "allow",
  );
  await page.locator("#policy-shell").selectOption("ask");
  await page.locator("#policy-save").click();
  await page.screenshot({
    path: join(output, "permissions.png"),
    fullPage: true,
  });
  await page.locator('[data-page="history"]').click();
  await page.locator("#history-input").fill("第一行");
  await page.locator("#history-input").press("Enter");
  await page.locator("#history-input").pressSequentially("第二行");
  assert.equal(
    await page.locator("#history-input").inputValue(),
    "第一行\n第二行",
  );
  await page.locator("#history-input").press("Shift+Enter");
  await wait(
    async () => (await request("history.state")).messages.length === 2,
  );
  assert.equal(
    (await request("runtime.status")).metrics.windows.find(
      (w) => w.kind === "speech",
    ).visible,
    false,
  );
  await wait(async () => !(await request("history.state")).busy);
  await wait(async () =>
    (await page.locator("#history-messages").textContent()).includes(
      "今天也陪着你",
    ),
  );
  const first = (await request("history.state")).current;
  await page.locator("#history-new").click();
  await wait(async () => (await request("history.state")).current !== first);
  await page.locator("#history-list").selectOption(first);
  await page.locator("#history-continue").click();
  await wait(async () => (await request("history.state")).current === first);
  await page.locator("#history-input").fill("接着聊");
  await page.locator("#history-send").click();
  await wait(async () => {
    const c = await request("history.state");
    return !c.busy && c.messages.length === 4;
  });
  assert.equal(
    requests.at(-1).messages.filter((m) => m.role === "user").length,
    2,
  );
  await page.locator("#history-rename").click();
  await page.locator("#history-new-title").fill("一起度过的今天");
  await page.locator("#history-rename-save").click();
  await wait(async () =>
    (await request("history.list")).some((s) => s.title === "一起度过的今天"),
  );
  await page.screenshot({ path: join(output, "history.png"), fullPage: true });
  console.log(
    "PASS: 历史浏览、新建、继续、重命名、Enter 换行和应用内聊天抑制气泡",
  );
  await page.locator('[data-page="home"]').click();
  await request("chat.open");
  await wait(() =>
    runtime.windows().some((p) => p.url().endsWith("composer.html")),
  );
  const composer = runtime
    .windows()
    .find((p) => p.url().endsWith("composer.html"));
  const speech = runtime.windows().find((p) => p.url().endsWith("speech.html"));
  await composer.locator("#input").fill("外面的气泡");
  await composer.locator("#send").click();
  await wait(async () => !(await request("history.state")).busy);
  await speech.evaluate(() => window.familiar.request("speech.hover", false));
  await wait(
    async () =>
      !(await request("runtime.status")).metrics.windows.find(
        (w) => w.kind === "speech",
      ).visible,
    5000,
  );
  console.log("PASS: 普通回复完成后按设置自动收起气泡");
  await request("chat.open");
  await composer.locator("#input").fill("shell one");
  await composer.locator("#send").click();
  await speech.locator("#approval").waitFor({ state: "visible" });
  await speech.locator("#allow-scope").selectOption("session");
  await speech.locator("#allow").click();
  await wait(async () => !(await request("history.state")).busy);
  await request("chat.open");
  await composer.locator("#input").fill("shell two");
  await composer.locator("#send").click();
  await wait(async () => {
    const c = await request("history.state");
    return !c.busy && c.messages.at(-1)?.text === "工具完成。";
  });
  assert.equal((await request("agent.approvals")).length, 0);
  await page.locator('[data-page="history"]').click();
  await page.locator("#history-new").click();
  await wait(async () => !(await page.locator("#history-input").isDisabled()));
  await page.locator("#history-input").fill("shell three");
  await page.locator("#history-send").click();
  await page.locator("#agent-confirmations").waitFor({ state: "visible" });
  assert.equal(
    (await request("runtime.status")).metrics.windows.find(
      (w) => w.kind === "speech",
    ).visible,
    false,
  );
  await page.locator("#confirm-scope").selectOption("whitelist");
  await page.locator("#confirm-allow").click();
  await wait(async () => !(await request("history.state")).busy);
  assert.equal((await request("policy.get")).whitelist.length, 1);
  console.log("PASS: 宠物气泡会话授权，控制器审批和精确白名单");
  await page.locator('[data-page="care"]').click();
  await wait(async () => !(await page.locator("#care-enabled").isDisabled()));
  assert.equal(await page.locator("#care-events").count(), 0);
  await page.locator("#care-custom-label").fill("活动一下");
  await page.locator("#care-custom-time").fill("15:30");
  await page.locator("#care-custom-prompt").fill("提醒我喝水、伸展。");
  await page.locator("#care-custom-enabled").check();
  await page.locator("#care-custom-add").click();
  await wait(
    async () => (await request("care.get")).settings.custom.length === 1,
  );
  await page.locator("#care-custom-list input").uncheck();
  await wait(
    async () => !(await request("care.get")).settings.custom[0].enabled,
  );
  await page.locator("#care-preview").click();
  await wait(async () =>
    (await page.locator("#care-message").textContent()).includes(
      "今天也陪着你",
    ),
  );
  assert.equal((await request("care.get")).location, undefined);
  assert.equal(requests.at(-1).tools, undefined);
  await page.screenshot({ path: join(output, "care.png"), fullPage: true });
  const amap = (await request("mcp.list")).find((s) => s.id === "amap");
  assert.equal(amap.url, "https://mcp.amap.com/mcp");
  assert.equal(amap.auth.kind, "query");
  assert.equal(amap.enabled, false);
  await page.locator('[data-page="mcp"]').click();
  await page
    .locator("#mcp-list .extension-row")
    .filter({ hasText: "高德地图" })
    .getByRole("button", { name: "配置", exact: true })
    .click();
  assert.equal(await page.locator("#mcp-auth-kind").inputValue(), "query");
  await page.locator("#mcp-key").fill("TEST_ONLY_NOT_A_REAL_KEY");
  await page.locator("#mcp-save").click();
  await wait(
    async () => (await request("mcp.list")).find((s) => s.id === "amap").hasKey,
  );
  const secrets = await readFile(join(data, "data/model-secret.json"), "utf8");
  assert.ok(!secrets.includes("TEST_ONLY_NOT_A_REAL_KEY"));
  assert.ok(
    !(await readFile(join(data, "home/mcp/servers.json"), "utf8")).includes(
      "TEST_ONLY_NOT_A_REAL_KEY",
    ),
  );
  await controller.close();
  controller = undefined;
  const originalCount = (
    await readFile(join(data, "data/conversation.json"), "utf8")
  ).length;
  await runtime.close();
  runtime = undefined;
  const stored = JSON.parse(
    await readFile(join(data, "data/conversation-index.json"), "utf8"),
  );
  assert.ok(stored.length >= 3);
  assert.ok(originalCount > 100);
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(
      {
        ok: true,
        requests: requests.length,
        login,
        history: stored.map((s) => ({ title: s.title, count: s.count })),
        errors,
      },
      null,
      2,
    ),
  );
  console.log("PASS: LLM 关怀写入历史，高德预置与加密密钥，无授权时不定位");
  console.log("EXPERIENCE OUTPUT:", output);
} catch (e) {
  if (page)
    await page
      .screenshot({ path: join(output, "failure.png"), fullPage: true })
      .catch(() => {});
  console.error(errors);
  throw e;
} finally {
  await controller?.close().catch(() => {});
  await runtime?.close().catch(() => {});
  mock.closeAllConnections();
  await new Promise((r) => mock.close(r));
}
