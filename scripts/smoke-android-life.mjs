import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

// 只在隔离的 debug 安装上运行；消费测试物资，不读取发行包或用户账号。
const device = process.env.ANDROID_SERIAL ?? "emulator-5572";
const adbPath = process.env.ADB ?? "C:/AndroidSDK/platform-tools/adb.exe";
const app = "app.familiar.mobile.debug";
const output =
  process.env.FAMILIAR_ANDROID_SMOKE_OUTPUT ?? ".artifacts/v2/android-life";
await mkdir(output, { recursive: true });
const raw = (...args) =>
  execFileSync(adbPath, ["-s", device, ...args], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
const adb = (...args) =>
  raw(...args)
    .toString("utf8")
    .trim();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser, page, before;
let seq = 0;
const checks = [];
async function attach() {
  await browser?.close();
  adb("shell", "am", "start", "-n", `${app}/app.familiar.mobile.MainActivity`);
  for (let i = 0; i < 100; i++) {
    let pid;
    try {
      pid = adb("shell", "pidof", app);
    } catch {
      await delay(200);
      continue;
    }
    if (
      adb("shell", "cat", "/proc/net/unix").includes(
        `webview_devtools_remote_${pid}`,
      )
    ) {
      adb(
        "forward",
        "tcp:9224",
        `localabstract:webview_devtools_remote_${pid}`,
      );
      browser = await chromium.connectOverCDP("http://127.0.0.1:9224", {
        noDefaults: true,
      });
      page = browser.contexts()[0].pages()[0];
      await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
      return;
    }
    await delay(200);
  }
  throw Error("Android WebView 未启动");
}
async function call(method, params) {
  const reply = await page.evaluate(
    (payload) =>
      window.__TAURI_INTERNALS__.invoke("plugin:familiar-android|invoke", {
        payload,
      }),
    { protocolVersion: 1, id: `life-device-${++seq}`, method, params },
  );
  assert(reply.ok, `${method}: ${reply.error?.code}`);
  return reply.result;
}
const life = () => call("life.get");
const act = (command) =>
  call("life.act", { requestId: randomUUID(), ...command });
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    const s = await call("snapshot.get");
    if (predicate(s)) return s;
    await delay(200);
  }
  throw Error("Native 状态未就绪");
}
const pass = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
try {
  await attach();
  before = await until((s) => s.runtime?.engine === "ready");
  assert(!before.provider.keyConfigured, "需要没有用户凭据的隔离 debug 安装");
  const initial = await life();
  const checkin = { kind: "checkin", requestId: randomUUID() };
  const first = await call("life.act", checkin);
  const second = await call("life.act", checkin);
  assert.equal(second.wallet.stones, first.wallet.stones);
  assert.equal(second.daily.checkedIn, true);
  const bought = await act({ kind: "buy", itemId: "food-basic", quantity: 2 });
  assert.equal(bought.wallet.stones, second.wallet.stones - 8);
  const fed = await act({ kind: "feed", itemId: "food-basic" });
  assert.equal(
    fed.inventory.food.find((f) => f.itemId === "food-basic").quantity,
    bought.inventory.food.find((f) => f.itemId === "food-basic").quantity - 1,
  );
  pass("原生桥签到幂等、购买扣费和进食消耗");
  await call("runtime.set", { enabled: true });
  await until((s) => s.runtime?.overlayVisible);
  for (const characterId of ["deepseek", "gpt", "claude"]) {
    await call("companion.save", { ...before.companion, characterId });
    const s = await until((s) => s.companion.characterId === characterId);
    assert(
      s.characters.find((c) => c.id === characterId)?.animation?.frames.sleep
        .length >= 4,
    );
    assert.equal((await life()).profileId, initial.profileId);
    await act({ kind: "sleep", sleeping: true });
    await until((s) => s.pet?.action === "sleep");
    adb("shell", "input", "keyevent", "KEYCODE_HOME");
    await delay(1000);
    await writeFile(
      `${output}/${characterId}-native-sleep.png`,
      raw("exec-out", "screencap", "-p"),
    );
    // 非聚焦的系统悬浮窗不属于启动器的 UIAutomator 树；核对原生窗口及核心动作，并保留截图人工检查。
    assert.match(adb("shell", "dumpsys", "window", "windows"), /FamiliarPet/);
    await until((s) => s.pet?.action === "sleep" && s.runtime?.overlayVisible);
    await attach();
    await act({ kind: "sleep", sleeping: false });
  }
  pass("三个新角色原生 WebP 睡眠与悬浮视图，切换保持养成档案");
  await call("companion.save", {
    ...before.companion,
    characterId: "deepseek",
  });
  await act({ kind: "sleep", sleeping: true });
  await page.locator(".life-room").waitFor({ state: "visible" });
  await page.waitForFunction(
    () =>
      document
        .querySelector("#familiar-root")
        ?.getAttribute("data-character") === "deepseek",
  );
  await delay(1000);
  await page.screenshot({ path: `${output}/room.png` });
  const persisted = await life();
  adb("shell", "am", "force-stop", app);
  await attach();
  await until((s) => s.runtime?.engine === "ready");
  const restored = await life();
  assert.equal(restored.profileId, persisted.profileId);
  assert.equal(restored.wallet.stones, persisted.wallet.stones);
  assert.deepEqual(restored.inventory, persisted.inventory);
  assert.equal(restored.needs.sleeping, true);
  pass("进程强退后钱包、背包、档案和睡眠恢复");
  await call("runtime.set", { enabled: true });
  const unlocked = await life();
  adb("shell", "input", "keyevent", "223");
  await delay(32000);
  const locked = await life();
  assert(locked.daily.onlineMinutes <= unlocked.daily.onlineMinutes + 0.05);
  adb("shell", "input", "keyevent", "224");
  adb("shell", "wm", "dismiss-keyguard");
  pass("息屏期间后台存活但不累计在线分钟");
  await writeFile(
    `${output}/result.json`,
    JSON.stringify({ passed: true, device, checks }, null, 2),
  );
} finally {
  try {
    adb("shell", "input", "keyevent", "224");
    adb("shell", "wm", "dismiss-keyguard");
    if (before && page) {
      await act({ kind: "sleep", sleeping: false });
      await call("companion.save", before.companion);
      await call("runtime.set", { enabled: before.runtime.running });
    }
  } finally {
    await browser?.close();
    try {
      adb("forward", "--remove", "tcp:9224");
    } catch {}
  }
}
