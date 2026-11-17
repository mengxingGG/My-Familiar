import { _electron as electron } from "playwright";
import electronPath from "electron";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createLifeStore,
  validateLifeStore,
} from "../plugins/pet-life/state.ts";

// 独立数据目录；真实 Runtime、IPC、存储与页面，钱包种子仅用于验收。
const packaged = process.argv.includes("--packaged");
const output = resolve(
    packaged
      ? ".artifacts/v2/windows-life-packaged"
      : ".artifacts/v2/windows-life",
  ),
  data = join(output, `data-${Date.now()}`);
await mkdir(join(data, "data"), { recursive: true });
const seed = createLifeStore(Date.now(), randomUUID, "Asia/Taipei");
seed.stones = 1000;
seed.totalXp = 360;
seed.rewardedLevel = 5;
const bed = randomUUID();
seed.inventory.items.push({ instanceId: bed, itemId: "wood-bed" });
seed.room.placements.push({ instanceId: bed, x: 450, y: 420, rotation: 0 });
validateLifeStore(seed);
await writeFile(join(data, "data/pet-life.json"), JSON.stringify(seed));
const env = { ...process.env, FAMILIAR_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let runtime, controller;
const errors = [];
const launch = (role) =>
  electron.launch({
    executablePath: packaged
      ? resolve("release/win-unpacked/Familiar.exe")
      : electronPath,
    args: [
      ...(!packaged ? [process.cwd()] : []),
      ...(role === "controller" ? ["--controller"] : []),
    ],
    env,
    timeout: 30000,
  });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  runtime = await launch("runtime");
  const pet = await runtime.firstWindow();
  await pet.waitForFunction(() => document.body.dataset.character === "mori");
  controller = await launch("controller");
  const page = await controller.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  pet.on("pageerror", (e) => errors.push(e.message));
  await page.waitForFunction(() => document.body.dataset.connected === "true");
  const call = (method, params) =>
    page.evaluate(
      ({ method, params }) => window.familiar.request(method, params),
      { method, params },
    );
  const snap = () => call("life.get");
  await page.locator("#nest .life-room").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "签到", exact: true }).click();
  await page.getByRole("button", { name: "今日已签到", exact: true }).waitFor();
  assert.equal((await snap()).wallet.stones, 1010);
  await page.getByRole("button", { name: "商店", exact: true }).click();
  const food = page.locator(".life-card").filter({ hasText: "基础口粮" });
  await food.getByLabel("基础口粮购买数量").fill("2");
  await food.getByRole("button", { name: /购买/ }).click();
  await page.waitForFunction(() =>
    document.querySelector(".life-feedback")?.textContent.includes("买到了"),
  );
  assert.equal((await snap()).wallet.stones, 1002);
  assert.equal(
    (await snap()).inventory.food.find((f) => f.itemId === "food-basic")
      .quantity,
    10,
  );
  const locked = page.locator(".life-card").filter({ hasText: "贝壳床" });
  assert.equal(await locked.getByRole("button").last().isDisabled(), true);
  await page.getByRole("button", { name: "房间", exact: true }).click();
  const layoutBefore = (await snap()).room;
  await page.getByRole("button", { name: "布置", exact: true }).click();
  await page.getByRole("button", { name: /暖木矮床，.*可拖动/ }).click();
  await page.getByRole("button", { name: "向右移动", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  assert.deepEqual((await snap()).room, layoutBefore);
  await page.getByRole("button", { name: "布置", exact: true }).click();
  await page.getByRole("button", { name: /暖木矮床，.*可拖动/ }).click();
  await page.getByRole("button", { name: "向右移动", exact: true }).click();
  await page.getByRole("button", { name: "保存布置", exact: true }).click();
  await page.getByRole("button", { name: "布置", exact: true }).waitFor();
  const layout = (await snap()).room;
  assert.equal(layout.revision, layoutBefore.revision + 1);
  assert.ok(layout.placements.find((p) => p.instanceId === bed).x > 450);
  const profile = (await snap()).profileId;
  for (const character of [
    "deepseek",
    "gpt",
    "claude",
    "mori",
    "youzi",
    "luna",
    "diandian",
    "fangfang",
    "lili",
    "mianmian",
  ]) {
    const status = await call("runtime.status");
    await call("settings.apply", {
      ...status.settings,
      pet: { ...status.settings.pet, character },
    });
    await pet.waitForFunction(
      (id) => document.body.dataset.character === id,
      character,
    );
    assert.equal((await snap()).profileId, profile);
    assert.equal(
      (await call("runtime.status")).settings.provider.kind,
      status.settings.provider.kind,
    );
  }
  const config = (await call("runtime.status")).settings;
  await call("settings.apply", {
    ...config,
    pet: { ...config.pet, character: "deepseek" },
  });
  // 收回初始软垫，验证购买床具的交互点和前景遮挡。
  const beforeSleep = await snap();
  const mat = beforeSleep.inventory.items.find(
    (i) => i.itemId === "starter-mat",
  );
  if (mat)
    await call("life.act", {
      kind: "room.save",
      expectedRoomRevision: beforeSleep.room.revision,
      placements: beforeSleep.room.placements.filter(
        (p) => p.instanceId !== mat.instanceId,
      ),
      requestId: randomUUID(),
    });
  await page.getByRole("button", { name: "休息", exact: true }).click();
  await pet.waitForFunction(() => document.body.dataset.action === "sleep");
  await wait(1500);
  await page.screenshot({
    path: join(output, "room-sleep.png"),
    fullPage: true,
  });
  await call("life.act", {
    kind: "sleep",
    sleeping: false,
    requestId: randomUUID(),
  });
  await call("life.act", {
    kind: "feed",
    itemId: "food-basic",
    requestId: randomUUID(),
  });
  await pet.waitForFunction(() => document.body.dataset.action === "eat");
  await page.screenshot({ path: join(output, "room-eat.png"), fullPage: true });
  await wait(8500);
  assert.notEqual(await pet.getAttribute("body", "data-action"), "eat");
  const persisted = JSON.parse(
    await readFile(join(data, "data/pet-life.json"), "utf8"),
  );
  assert.equal(persisted.stones, (await snap()).wallet.stones);
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(
      {
        passed: true,
        checks: [
          "UI签到",
          "购买与等级锁",
          "布置取消和保存",
          "十角色切换保持档案与模型",
          "原生桌宠睡眠与进食动作",
          "落盘一致",
          "无页面错误",
        ],
        profileId: profile,
      },
      null,
      2,
    ),
  );
  console.log("PASS: Windows 2.0 小窝真实 Runtime / IPC / 页面闭环");
} finally {
  await controller?.close().catch(() => {});
  await runtime?.close().catch(() => {});
}
