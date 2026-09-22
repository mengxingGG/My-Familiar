import { _electron as electron, chromium } from "playwright/test";
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
    `.artifacts/${packaged ? "packaged-" : ""}integrations-smoke-` + Date.now(),
  ),
  data = join(output, "user-data");
await mkdir(output, { recursive: true });
const requests = [],
  errors = [];
const mock = createServer(async (req, res) => {
  if (req.url === "/v1/models") {
    res.setHeader("Content-Type", "application/json");
    return res.end(
      JSON.stringify({
        data: [{ id: "persona-fixture", context_length: 65536 }],
      }),
    );
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  requests.push(JSON.parse(raw));
  res.setHeader("Content-Type", "text/event-stream");
  res.end(
    "data: " +
      JSON.stringify({
        choices: [{ delta: { content: "我在这里。" }, finish_reason: "stop" }],
      }) +
      "\n\ndata: [DONE]\n\n",
  );
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const env = { ...process.env, FAMILIAR_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let runtime, controller;
const wait = async (fn) => {
  const end = Date.now() + 15000;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 80));
  }
};
try {
  runtime = await electron.launch({
    executablePath,
    args: baseArgs,
    env,
  });
  runtime.process().stderr.on("data", (b) => errors.push(b.toString()));
  const pet = await runtime.firstWindow();
  controller = await electron.launch({
    executablePath,
    args: [...baseArgs, "--controller"],
    env,
  });
  const page = await controller.firstWindow();
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
  const status = await request("runtime.status");
  assert.equal(status.apiVersion, 4);
  assert.equal(status.characters.length, 7);
  assert.equal(status.personas.length, 5);
  const config = status.settings;
  config.provider.model = "persona-fixture";
  config.provider.baseUrl = `http://127.0.0.1:${mock.address().port}/v1`;
  await request("settings.apply", config);
  await page.locator("#refresh").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#model-id")?.value === "persona-fixture" ||
      document
        .querySelector("#model")
        ?.querySelector('input[value="persona-fixture"]'),
  );
  for (const id of ["mianmian", "lili", "fangfang", "youzi", "diandian"]) {
    await page.locator("#character").selectOption(id);
    await wait(
      async () =>
        (await request("runtime.status")).settings.pet.character === id &&
        (await pet.evaluate(
          (id) => document.body.dataset.character === id,
          id,
        )),
    );
    await page.waitForFunction(
      () =>
        document.querySelector("#character-preview").complete &&
        document.querySelector("#character-preview").naturalWidth > 0,
    );
    await page.screenshot({ path: join(output, `controller-${id}.png`) });
    await pet.screenshot({ path: join(output, `pet-${id}.png`) });
  }
  console.log("PASS: 五个新角色实际切换，预览使用真实角色帧");
  await page.locator('[data-page="persona"]').click();
  await page.locator("#persona-style").selectOption("concise");
  await page.locator("#persona .save").click();
  await wait(
    async () =>
      (await request("runtime.status")).settings.persona.style === "concise",
  );
  await page.locator('[data-page="home"]').click();
  await page.locator("#character").selectOption("youzi");
  await wait(
    async () =>
      (await request("runtime.status")).settings.pet.character === "youzi",
  );
  assert.equal(
    (await request("runtime.status")).settings.persona.style,
    "concise",
  );
  const current = (await request("history.state")).current;
  await request("history.send", { id: current, text: "你好" });
  await wait(async () => !(await request("history.state")).busy);
  assert.match(requests.at(-1).messages[0].content, /一到三句/);
  await page.locator('[data-page="persona"]').click();
  await page.locator("#persona-style").selectOption("character");
  await page.locator("#persona .save").click();
  await wait(
    async () =>
      (await request("runtime.status")).settings.persona.style === "character",
  );
  await request("history.send", { id: current, text: "继续" });
  await wait(async () => !(await request("history.state")).busy);
  assert.match(requests.at(-1).messages[0].content, /轻快/);
  await page.screenshot({ path: join(output, "personality.png") });
  console.log("PASS: 固定性格跨形象保持；跟随形象改变实际模型请求");
  await page.locator('[data-page="integrations"]').click();
  await page.locator("#feishu-login").waitFor();
  await page.locator("#feishu-check").click();
  await page.locator("#toast").filter({ hasText: "安装飞书依赖" }).waitFor();
  await page.locator("#github-auth").selectOption("token");
  await page.locator("#github-token").fill("fixture-never-real");
  await page.locator("#github-save").click();
  await wait(async () => (await request("integrations.status")).github.hasKey);
  assert.equal(await page.locator("#github-token").inputValue(), "");
  const saved = await readFile(join(data, "data/model-secret.json"), "utf8");
  assert.ok(!saved.includes("fixture-never-real"));
  await page.screenshot({
    path: join(output, "integrations.png"),
    fullPage: true,
  });
  assert.ok(
    !errors.some((e) => /TypeError|ReferenceError|启动失败|命令不允许/.test(e)),
    errors.join("\n"),
  );
  console.log(
    "PASS: 飞书/GitHub 控制器命令贯通，缺少依赖有明确提示，Token 经系统加密",
  );
  await controller.close();
  controller = undefined;
  await runtime.close();
  runtime = undefined;
  runtime = await electron.launch({
    executablePath,
    args: baseArgs,
    env,
  });
  await runtime.firstWindow();
  controller = await electron.launch({
    executablePath,
    args: [...baseArgs, "--controller"],
    env,
  });
  const reopened = await controller.firstWindow();
  await reopened.waitForFunction(
    () => document.body.dataset.connected === "true",
  );
  const restored = await reopened.evaluate(() =>
    window.familiar.request("integrations.status"),
  );
  assert.equal(restored.github.hasKey, true);
  assert.equal(restored.github.authMode, "token");
  console.log("PASS: 重启保持 GitHub 接入方式和密钥");
  // 单独的角色目录便于人工检查轮廓、面部与透明边缘。
  const html =
    '<html><body style="background:#f4f2e9;font:16px system-ui;display:flex;gap:12px;padding:20px">' +
    status.characters
      .map(
        (c) =>
          `<figure style="margin:0;text-align:center"><img width="160" src="${c.preview}"><figcaption>${c.name}</figcaption></figure>`,
      )
      .join("") +
    "</body></html>";
  const browser = await chromium.launch({ headless: true });
  try {
    const gallery = await browser.newPage({
      viewport: { width: 1300, height: 270 },
    });
    await gallery.setContent(html);
    await gallery.screenshot({ path: join(output, "characters.png") });
  } finally {
    await browser.close();
  }
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      {
        checks: [
          "seven-characters",
          "fixed-personality",
          "recommended-personality-model-prompt",
          "integration-routes",
          "encrypted-token",
          "restart",
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log("OUTPUT: " + output);
} finally {
  await controller?.close().catch(() => {});
  await runtime?.close().catch(() => {});
  mock.closeAllConnections();
  await new Promise((r) => mock.close(r));
}
