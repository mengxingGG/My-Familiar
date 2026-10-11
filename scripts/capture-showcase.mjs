import { _electron as electron } from "playwright/test";
import electronPath from "electron";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { renderShowcase } from "./render-showcase.mjs";

// 只截取应用自己的网页窗口。演示实例使用独立目录，不读取用户配置或桌面。
const root = process.cwd();
const output = resolve(".artifacts", `showcase-${Date.now()}`);
const data = join(output, "user-data");
await mkdir(output, { recursive: true });
const env = {
  ...process.env,
  FAMILIAR_DATA_DIR: data,
  FAMILIAR_HOME: join(data, "home"),
};
delete env.ELECTRON_RUN_AS_NODE;
const reply =
  "太棒啦，终于做完了！\n给今天的自己一点掌声吧。想听你说说，最满意的是哪一部分？";
const mock = createServer(async (req, res) => {
  if (req.url === "/v1/models") {
    res.setHeader("Content-Type", "application/json");
    return res.end(
      JSON.stringify({
        data: [
          { id: "familiar-demo-chat", context_length: 262144 },
          { id: "familiar-demo-reasoning", context_length: 131072 },
        ],
      }),
    );
  }
  if (req.url !== "/v1/chat/completions") {
    res.writeHead(404);
    return res.end();
  }
  for await (const chunk of req) void chunk;
  res.setHeader("Content-Type", "text/event-stream");
  res.end(
    `data: ${JSON.stringify({ choices: [{ delta: { content: reply }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
let runtime, controller;
const errors = [];
const waitFor = async (fn) => {
  const deadline = Date.now() + 15000;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error("等待演示界面超时");
    await new Promise((r) => setTimeout(r, 80));
  }
};
const watch = (page) => {
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => errors.push(e.message));
};
const raw = (name) => join(output, `${name}.png`);
const shots = {};
try {
  runtime = await electron.launch({
    executablePath: electronPath,
    args: [root],
    env,
  });
  console.log("演示宠物已启动");
  const pet = await runtime.firstWindow();
  watch(pet);
  controller = await electron.launch({
    executablePath: electronPath,
    args: [root, "--controller"],
    env,
  });
  const page = await controller.firstWindow();
  watch(page);
  console.log("演示控制器已启动，等待连接");
  await page.waitForFunction(() => document.body.dataset.connected === "true");
  // 固定应用窗口大小，所有页面仍使用产品自身样式。
  const controllerWindow = await controller.browserWindow(page);
  await controllerWindow.evaluate((window) => window.setContentSize(1140, 900));
  const request = (name, params) =>
    page.evaluate(({ name, params }) => window.familiar.request(name, params), {
      name,
      params,
    });
  await request("care.set", {
    ...(await request("care.get")).settings,
    enabled: false,
  });
  const settings = (await request("runtime.status")).settings;
  settings.pet.character = "youzi";
  settings.pet.scale = 1.2;
  settings.pet.quiet = true;
  settings.pet.bubbleSeconds = 0;
  settings.persona.name = "柚子";
  settings.persona.style = "enthusiastic";
  settings.provider.kind = "compatible";
  settings.provider.model = "familiar-demo-chat";
  settings.provider.baseUrl = `http://127.0.0.1:${mock.address().port}/v1`;
  await request("settings.apply", settings);
  await page.locator("#refresh").click();
  console.log("演示角色与本地模型已配置");
  await pet.waitForFunction(() => document.body.dataset.character === "youzi");
  await page.waitForFunction(
    () => document.querySelector("#pet-name").textContent === "柚子",
  );
  const petWindow = await runtime.browserWindow(pet);
  await petWindow.evaluate((window) => window.setPosition(500, 500));

  await request("chat.open");
  await waitFor(() =>
    runtime.windows().some((w) => w.url().endsWith("composer.html")),
  );
  const composer = runtime
    .windows()
    .find((w) => w.url().endsWith("composer.html"));
  const speech = runtime.windows().find((w) => w.url().endsWith("speech.html"));
  watch(composer);
  watch(speech);
  await composer.locator("#input").fill("今天终于把那个小项目做完了！");
  await composer.locator("#send").click();
  await speech.waitForFunction(
    (text) =>
      document.querySelector("#speech").textContent === text &&
      document.body.dataset.busy === "false",
    reply,
  );
  await waitFor(
    async () =>
      (await request("runtime.status")).metrics.windows.find(
        (w) => w.kind === "speech",
      ).visible,
  );
  const captureScene = async (bubble, kind, name) => {
    const status = await request("runtime.status");
    const petBounds = status.metrics.windows.find(
      (w) => w.kind === "pet",
    ).bounds;
    const bubbleBounds = status.metrics.windows.find(
      (w) => w.kind === kind,
    ).bounds;
    assert.ok(
      Math.abs(
        bubbleBounds.y +
          bubbleBounds.height -
          (petBounds.y + petBounds.height * 0.27),
      ) < 3,
    );
    await pet.screenshot({ path: raw(`${name}-pet`), omitBackground: true });
    await bubble.screenshot({ path: raw(name), omitBackground: true });
    // 只保存相对尺寸和位置，发布的素材不会包含实际屏幕坐标。
    const left = Math.min(petBounds.x, bubbleBounds.x),
      top = Math.min(petBounds.y, bubbleBounds.y);
    return {
      width:
        Math.max(
          petBounds.x + petBounds.width,
          bubbleBounds.x + bubbleBounds.width,
        ) - left,
      height:
        Math.max(
          petBounds.y + petBounds.height,
          bubbleBounds.y + bubbleBounds.height,
        ) - top,
      parts: [
        {
          file: `${name}-pet.png`,
          x: petBounds.x - left,
          y: petBounds.y - top,
          width: petBounds.width,
          height: petBounds.height,
        },
        {
          file: `${name}.png`,
          x: bubbleBounds.x - left,
          y: bubbleBounds.y - top,
          width: bubbleBounds.width,
          height: bubbleBounds.height,
        },
      ],
    };
  };
  shots.speech = await captureScene(speech, "speech", "speech");
  await speech.locator("#continue").click();
  await composer
    .locator("#input")
    .fill("今天终于把那个小项目做完了！\n想和你分享一下。");
  shots.composer = await captureScene(composer, "composer", "composer");
  await composer.keyboard.press("Escape");
  await speech.locator("#close").click();
  // 截图结束后恢复默认的 15 秒，在设置图中展示真实默认用法。
  const restoredSettings = (await request("runtime.status")).settings;
  restoredSettings.pet.bubbleSeconds = 15;
  restoredSettings.pet.quiet = false;
  await request("settings.apply", restoredSettings);
  await page.locator("#refresh").click();
  await page.locator('[data-page="home"]').click();
  await page.waitForFunction(
    () =>
      document.querySelector("#character-preview").complete &&
      document.querySelector("#character-preview").naturalWidth > 0,
  );
  await page.screenshot({ path: raw("controller"), fullPage: true });
  await page.locator('[data-page="model"]').click();
  await page.locator("#load-models").click();
  await page.waitForFunction(
    () =>
      !document.querySelector("#load-models").disabled &&
      document.querySelector("#model-list").options.length === 2,
  );
  const modelInput = await page.locator("#model-id").boundingBox();
  await page.screenshot({
    path: raw("models"),
    clip: {
      x: 0,
      y: 0,
      width: await page.evaluate(() => innerWidth),
      height: modelInput.y + modelInput.height + 12,
    },
  });

  // 演示新的记忆分层：核心只放规则，教训与扩展记忆按主题写明何时读。
  const core =
    "# 核心规则\n\n只放用户要求必须遵守的规则和长期偏好，每条一行。\n\n- 称呼我“小林”。\n- 我说“在忙”时安静陪着，不主动打扰。\n- 给建议时先说结论，再一步步拆开。\n- 晚上十一点后提醒我早点休息。\n";
  await request("memory.write", {
    path: "CORE.md",
    text: core,
    revision: (await request("memory.read", { path: "CORE.md" })).revision,
  });
  await request("memory.write", {
    path: "daily/2026/10/2026-10-11.md",
    text: "# 2026-10-11 · 一起度过的一天\n\n## 21:40\n\n一起惦记的小项目终于完成了。比起催着开始下一件事，今天更想陪小林好好庆祝。\n",
  });
  await request("memory.write", {
    path: "lessons/分享好消息.md",
    text: "# 分享好消息\n> 何时读：用户分享开心的小事或进展时\n\n- 先回应感受，再问细节 — 急着给建议会打断分享的心情\n",
  });
  await request("memory.write", {
    path: "topics/周末徒步.md",
    text: "# 周末徒步\n> 何时读：聊到周末计划或户外活动时\n\n- 常走西山步道，单程约两小时\n- 出门前提醒带水和防晒\n",
  });
  await page.locator('[data-page="memories"]').click();
  await page.locator("#memory-files").selectOption("CORE.md");
  await page.waitForFunction(
    (text) => document.querySelector("#memory-editor").value === text,
    core,
  );
  // 只截取文件列表和编辑区域；本机路径显示在上方，不进入截图。
  await page.locator("#memories .split").screenshot({ path: raw("memory") });
  await page.locator('[data-page="voice"]').click();
  await page.waitForFunction(
    () => !document.querySelector("#voice-save").disabled,
  );
  const voiceEnd = await page.locator("#voice-sec-wake").boundingBox();
  await page.screenshot({
    path: raw("voice"),
    clip: {
      x: 0,
      y: 0,
      width: await page.evaluate(() => innerWidth),
      // 停在底部吸附的保存栏上方。
      height: Math.min(voiceEnd.y - 8, (await page.evaluate(() => innerHeight)) - 70),
    },
  });
  assert.deepEqual(errors, [], "演示过程中不能出现页面异常");
  await writeFile(
    join(output, "capture.json"),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        source: "isolated-electron-windows",
        demoData: true,
        shots,
      },
      null,
      2,
    ),
  );
  console.log("已捕获实际宠物、气泡、输入、控制器、模型选择、记忆和语音界面。");
} finally {
  await controller?.close();
  await runtime?.close();
  mock.closeAllConnections();
  await new Promise((r) => mock.close(r));
}
await renderShowcase(output);
console.log(`原始截图与记录：${output}`);
