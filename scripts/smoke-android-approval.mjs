import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const app = "app.familiar.mobile.debug", fixture = "app.familiar.fixture";
const adb = (...args) => execFileSync("C:/AndroidSDK/platform-tools/adb.exe", ["-s", "emulator-5554", ...args], { encoding: "utf8", windowsHide: true }).trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let mode, step, screen, actionResult;
const server = createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  if (req.url.endsWith("/models")) { res.end(JSON.stringify({ data: [{ id: "approval-fixture" }] })); return; }
  const request = JSON.parse(body);
  const tool = request.messages.filter(m => m.role === "tool").at(-1);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  let name, args;
  if (step === 0) { name = "android_screen"; args = {}; }
  else if (step === 1) {
    screen = JSON.parse(tool.content);
    const target = screen.nodes?.find(n => n.text.toLowerCase() === "increment counter");
    name = "android_action"; args = { snapshotId: screen.snapshotId, nodeId: target?.id ?? "missing", action: "click" };
  } else {
    actionResult = JSON.parse(tool.content);
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "审批场景已结束" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`); return;
  }
  step++;
  res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
adb("reverse", `tcp:${port}`, `tcp:${port}`);
let browser, overlayBrowser, page, before, sequence = 0;
const conversations = [], results = [];
const call = async (method, params) => {
  const reply = await page.evaluate(payload => window.__TAURI_INTERNALS__.invoke("plugin:familiar-android|invoke", { payload }), { protocolVersion: 1, id: `approval-test-${++sequence}`, method, params });
  assert(reply.ok, `${method}: ${reply.error?.code}`); return reply.result;
};
const state = () => call("snapshot.get");
async function until(test, timeout = 25000) {
  const end = Date.now() + timeout;
  do { const s = await state(); if (test(s)) return s; await sleep(150); } while (Date.now() < end);
  throw Error("Approval scenario timed out");
}
async function overlayPage() {
  if (!overlayBrowser) {
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const pid = adb("shell", "pidof", `${app}:runtime`);
        adb("forward", "tcp:9225", `localabstract:webview_devtools_remote_${pid}`);
        overlayBrowser = await chromium.connectOverCDP("http://127.0.0.1:9225"); break;
      } catch { await sleep(200); }
    }
    assert(overlayBrowser, "Approval WebView failed to connect");
  }
  for (let i = 0; i < 60; i++) {
    const p = overlayBrowser.contexts()[0].pages().find(p => p.url().includes("/approval/index.html"));
    if (p) { await p.waitForSelector('.approval[data-ready="true"]'); return p; }
    await sleep(100);
  }
  throw Error("Approval overlay missing");
}
async function physicalButton(name) {
  const p = await overlayPage();
  const button = p.getByRole("button", { name });
  await button.waitFor();
  for (let i = 0; i < 30 && !(await button.isEnabled()); i++) await sleep(100);
  assert(await button.isEnabled());
  const box = await button.boundingBox();
  const viewport = await p.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
  const display = adb("shell", "wm", "size").match(/Physical size: (\d+)x(\d+)/);
  // 原生窗口按屏幕居中、底部 24dp 布局；这里真正发送设备触摸，不调用批准接口。
  const x = (Number(display[1]) - viewport.width * viewport.dpr) / 2 + (box.x + box.width / 2) * viewport.dpr;
  const y = Number(display[2]) - 24 * viewport.dpr - viewport.height * viewport.dpr + (box.y + box.height / 2) * viewport.dpr;
  adb("shell", "input", "tap", String(Math.round(x)), String(Math.round(y)));
  await sleep(350);
}
const foreground = () => adb("shell", "dumpsys", "activity", "activities").split("\n").find(l => /(?:topResumedActivity|mResumedActivity)/.test(l));
const counterXml = () => { adb("shell", "uiautomator", "dump", "/sdcard/familiar-approval-test.xml"); return adb("shell", "cat", "/sdcard/familiar-approval-test.xml"); };
function pass(name) { results.push({ name, passed: true }); console.log(`PASS ${name}`); }
try {
  adb("shell", "am", "start", "-n", `${app}/app.familiar.mobile.MainActivity`);
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const pid = adb("shell", "pidof", app);
      adb("forward", "tcp:9223", `localabstract:webview_devtools_remote_${pid}`);
      browser = await chromium.connectOverCDP("http://127.0.0.1:9223"); break;
    } catch { await sleep(250); }
  }
  assert(browser, "Main WebView failed to connect"); page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  before = await until(s => s.runtime?.engine === "ready");
  assert(!before.activeReply && before.providers.every(p => !p.profile.keyConfigured));
  assert.equal(before.capabilities.find(c => c.id === "accessibility").state, "granted");
  await call("runtime.set", { enabled: true });
  await call("provider.save", { kind: "compatible", baseUrl: `http://127.0.0.1:${port}/v1`, model: "approval-fixture", apiKey: "local-fixture-key" });
  for (mode of ["allow", "deny", "stale", "cancel"]) {
    step = 0; screen = null; actionResult = null;
    adb("shell", "am", "force-stop", fixture);
    adb("shell", "am", "start", "-n", `${fixture}/.FixtureActivity`);
    await sleep(500);
    const id = (await call("conversation.create")).id; conversations.push(id);
    await call("message.send", { conversationId: id, text: `本地审批验证 ${mode}` });
    const initial = await until(s => s.tasks.length === 1);
    assert.match(foreground(), new RegExp(fixture));
    if (mode === "allow") {
      await physicalButton("收起卡片，不批准也不拒绝");
      assert.equal((await state()).tasks[0].id, initial.tasks[0].id);
      const petWindow = adb("shell", "dumpsys", "window", "windows").split(/  Window #/).find(b => b.includes("u0 FamiliarPet}") && b.includes("mHasSurface=true"));
      const petBounds = petWindow?.match(/Frames:.*? frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      assert(petBounds, "Pet window missing while approval is hidden");
      adb("shell", "input", "tap", String(Math.round((+petBounds[1] + +petBounds[3]) / 2)), String(Math.round((+petBounds[2] + +petBounds[4]) / 2)));
      await sleep(500);
      await (await overlayPage()).screenshot({ path: ".artifacts/android-device/approval-card.png" });
    }
    await physicalButton(/^允许这一步/);
    const pending = await until(s => s.tasks.length === 1 && s.tasks[0].id !== initial.tasks[0].id);
    assert.equal(screen.package, fixture); assert(screen.nodes.some(n => n.text.toLowerCase() === "increment counter"), JSON.stringify(screen));
    assert.match(foreground(), new RegExp(fixture));
    if (mode === "stale") {
      // 改动位于卡片上方的目标文字；旧节点即使仍可见也不能执行。
      adb("shell", "input", "tap", "700", "600"); await sleep(300);
    }
    if (mode === "cancel") {
      await call("reply.cancel"); await until(s => s.tasks.length === 0 && !s.activeReply);
    } else {
      await physicalButton(mode === "deny" ? /^拒绝这一步/ : /^允许这一步/);
      await until(s => !s.activeReply && s.tasks.length === 0);
    }
    await sleep(400);
    const xml = counterXml();
    if (mode === "allow") { assert.equal(actionResult?.accepted, true, JSON.stringify(actionResult)); assert(xml.includes("Counter: 1")); }
    else { assert.notEqual(actionResult?.accepted, true); assert(xml.includes("Counter: 0")); }
    if (mode === "stale") assert(xml.toLowerCase().includes("changed target"), "stale fixture did not mutate");
    assert.match(foreground(), new RegExp(fixture));
    pass({ allow: "实体触摸收起/重开/批准，底层窗口不切换且计数增加", deny: "实体触摸拒绝，目标没有被点击", stale: "目标内容改变后拒绝旧节点", cancel: "取消回复清除悬浮待办且没有执行" }[mode]);
  }
} finally {
  if (page && before) {
    await call("reply.cancel").catch(() => {});
    await call("provider.save", { kind: "compatible", baseUrl: `http://127.0.0.1:${port}/v1`, model: "approval-fixture", clearApiKey: true }).catch(() => {});
    const profile = before.providers.find(p => p.id === "compatible").profile;
    await call("provider.save", { kind: "compatible", baseUrl: profile.baseUrl, model: profile.model, clearApiKey: true }).catch(() => {});
    if (before.provider.kind !== "compatible") await call("provider.save", { kind: before.provider.kind, baseUrl: before.provider.baseUrl, model: before.provider.model }).catch(() => {});
    if (before.activeConversationId) await call("conversation.select", { id: before.activeConversationId }).catch(() => {});
    for (const id of conversations) await call("conversation.delete", { id }).catch(() => {});
    await call("runtime.set", { enabled: before.runtime.running }).catch(() => {});
  }
  await overlayBrowser?.close(); await browser?.close();
  adb("reverse", "--remove", `tcp:${port}`);
  server.closeAllConnections(); await new Promise(r => server.close(r));
  await writeFile(process.env.FAMILIAR_APPROVAL_REPORT ?? ".artifacts/android-device/approval-smoke.json", JSON.stringify({ testedAt: new Date().toISOString(), results }, null, 2));
}
