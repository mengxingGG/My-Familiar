import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
const app = "app.familiar.mobile.debug";
const adb = (...args) => execFileSync("C:/AndroidSDK/platform-tools/adb.exe", ["-s", "emulator-5554", ...args], { encoding: "utf8", windowsHide: true }).trim();
const pause = ms => new Promise(r => setTimeout(r, ms));
const results = [], imported = new Set();
let requestCount = 0, received;
const server = createServer(async (req, res) => {
  if (req.url.endsWith("/models")) { res.end(JSON.stringify({ data: [{ id: "android-media-fixture" }] })); return; }
  let body = ""; for await (const chunk of req) body += chunk;
  received = JSON.parse(body); requestCount++;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "图片与文本原件已收到" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
adb("reverse", `tcp:${port}`, `tcp:${port}`);
let browser, page, before, conversation, sequence = 0;
const call = async (method, params) => {
  const reply = await page.evaluate(payload => window.__TAURI_INTERNALS__.invoke("plugin:familiar-android|invoke", { payload }), { protocolVersion: 1, id: `media-${++sequence}`, method, params });
  assert(reply.ok, `${method}: ${reply.error?.code}`); return reply.result;
};
async function attach() {
  await browser?.close(); browser = undefined;
  adb("shell", "am", "start", "-n", `${app}/app.familiar.mobile.MainActivity`);
  for (let i = 0; i < 60; i++) {
    try {
      const pid = adb("shell", "pidof", app); adb("forward", "tcp:9226", `localabstract:webview_devtools_remote_${pid}`);
      browser = await chromium.connectOverCDP("http://127.0.0.1:9226"); break;
    } catch { await pause(200); }
  }
  assert(browser); page = browser.contexts()[0].pages()[0]; await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { const state = await call("snapshot.get"); if (predicate(state)) return state; await pause(100); }
  throw Error("Media device state timed out");
}
function nodes() {
  adb("shell", "uiautomator", "dump", "/sdcard/familiar-media-window.xml");
  const xml = adb("shell", "cat", "/sdcard/familiar-media-window.xml");
  return [...xml.matchAll(/<node\b[^>]+>/g)].map(m => Object.fromEntries([...m[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(a => [a[1], a[2]])));
}
function tap(node) {
  assert(node, "System picker control missing"); const bounds = [...node.bounds.matchAll(/\d+/g)].map(m => Number(m[0]));
  adb("shell", "input", "tap", String(Math.round((bounds[0] + bounds[2]) / 2)), String(Math.round((bounds[1] + bounds[3]) / 2)));
}
async function pick(name) {
  await page.getByRole("button", { name: /^添加图片/ }).click();
  await pause(350);
  let visible = nodes();
  assert(visible.some(n => n.package?.includes("documentsui")), "Must use Android system picker");
  if (!name) {
    // 选择器中的返回先退目录，只有真正关闭系统页面才算取消。
    for (let i = 0; i < 6; i++) {
      adb("shell", "input", "keyevent", "KEYCODE_BACK"); await pause(250);
      if (!nodes().some(n => n.package?.includes("documentsui"))) break;
    }
    await page.getByRole("button", { name: /^添加图片/ }).waitFor();
    assert(!nodes().some(n => n.package?.includes("documentsui")));
    return;
  }
  if (!visible.some(n => n.text === "Download")) {
    tap(visible.find(n => n["content-desc"] === "显示根目录")); await pause(200); visible = nodes();
    tap(visible.find(n => n.text === "下载")); await pause(300); visible = nodes();
  }
  const grid = visible.find(n => n["content-desc"] === "列表视图");
  if (grid) { tap(grid); await pause(200); visible = nodes(); }
  let selected = visible.find(n => n.text === name);
  for (let i = 0; !selected && i < 4; i++) {
    adb("shell", "input", "swipe", "700", "2200", "700", "900", "250"); visible = nodes(); selected = visible.find(n => n.text === name);
  }
  tap(selected);
  await page.getByRole("button", { name: /^添加图片/ }).waitFor();
  for (const id of await page.locator(".tray-item").evaluateAll(els => els.map(e => e.dataset.id))) imported.add(id);
}
function pass(name) { results.push({ name, passed: true }); console.log(`PASS ${name}`); }
try {
  await attach(); before = await until(s => s.runtime.engine === "ready");
  assert(!before.activeReply && before.providers.every(p => !p.profile.keyConfigured)); assert(before.media.choose);
  await call("provider.save", { kind: "compatible", baseUrl: `http://127.0.0.1:${port}/v1`, model: "android-media-fixture", apiKey: "media-test-key" });
  conversation = (await call("conversation.create")).id;
  // 等待新会话成为界面权威快照，避免把测试草稿输入到上一段对话。
  await page.reload(); await page.locator('#familiar-root[data-ready="true"]').waitFor();
  if (!(await page.locator(".page-chat").isVisible())) {
    await page.getByRole("button", { name: "小窝", exact: true }).click();
    await page.getByRole("button", { name: "说句话", exact: true }).click();
  }
  const composer = page.getByRole("textbox", { name: "想说的话", exact: true });
  await composer.fill("取消选择仍应保留的草稿");
  await pick(null); assert.equal(await composer.inputValue(), "取消选择仍应保留的草稿"); assert.equal(requestCount, 0);
  pass("实际系统选择器取消保留草稿且没有发送模型请求");
  await pick("familiar-media-note.txt"); await page.locator(".tray-item").waitFor();
  await pick("familiar-media-large.png");
  for (let i = 0; i < 50 && await page.locator(".tray-item").count() !== 2; i++) await pause(100);
  assert.equal(await page.locator(".tray-item").count(), 2); assert.equal(requestCount, 0);
  const ids = await page.locator(".tray-item").evaluateAll(els => els.map(e => e.dataset.id)); ids.forEach(id => imported.add(id));
  const previews = await Promise.all(ids.map(id => call("media.preview", { id })));
  assert(previews.some(p => p.text?.includes("MEDIA_NOTE_20261019")));
  const image = previews.find(p => p.attachment.kind === "image");
  assert.equal(image.attachment.bytes, 2787744); assert(image.dataUrl.startsWith("data:image/jpeg;base64,")); assert(image.dataUrl.length < 1200000);
  await page.getByRole("button", { name: /^预览 familiar-media-large.png/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".media-img")].some(i => i.naturalWidth > 0));
  await page.screenshot({ path: ".artifacts/android-device/media-preview.png" });
  await page.getByRole("button", { name: "关闭", exact: true }).last().click();
  pass("系统选中文本与 2.79 MB 原图，缩略图本地可见且不上传");
  await pick("familiar-media-oversize.txt");
  await page.getByText(/没能添加附件：/).waitFor();
  assert.equal(await page.locator(".tray-item").count(), 2); assert.equal(requestCount, 0);
  pass("系统选择超限文本被拒绝，保留已有附件且没有网络发送");
  await composer.fill(""); await page.getByRole("button", { name: "发送", exact: true }).click();
  const finished = await until(s => !s.activeReply && s.conversations.find(c => c.id === conversation)?.messages.at(-1)?.role === "assistant");
  assert.equal(requestCount, 1);
  const user = received.messages.filter(m => m.role === "user").at(-1);
  assert(JSON.stringify(user).includes("MEDIA_NOTE_20261019"));
  const picture = user.content.find(part => part.type === "image_url").image_url.url;
  const digest = b => createHash("sha256").update(b).digest("hex");
  assert.equal(digest(Buffer.from(picture.split(",")[1], "base64")), digest(await readFile(".artifacts/android-media-fixtures/familiar-media-large.png")));
  assert.equal(finished.conversations.find(c => c.id === conversation).messages[0].attachments.length, 2);
  await page.getByLabel("对话内容", { exact: true }).getByText("图片与文本原件已收到", { exact: true }).waitFor();
  await pause(200);
  await page.screenshot({ path: ".artifacts/android-device/media-chat.png" });
  pass("附件单独发送，真实 Provider 请求包含完整原图与文本，历史保留引用");
  adb("shell", "am", "force-stop", app); await attach();
  const restored = await until(s => s.runtime.engine === "ready");
  assert.equal(restored.conversations.find(c => c.id === conversation).messages[0].attachments.length, 2);
  assert((await call("media.preview", { id: image.attachment.id })).dataUrl);
  const raw = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:familiar-android|invoke", { payload: { protocolVersion: 1, id: "reject-import", method: "media.import", params: { tokens: ["../../credentials.v1"] } } }));
  assert.equal(raw.ok, false); assert.equal(raw.error.code, "INVALID_INPUT");
  pass("进程重启恢复附件预览；公开桥拒绝内部文件导入命令");
} catch (error) { results.push({ name: "media failure", passed: false, reason: String(error) }); throw error; }
finally {
  if (page && before) {
    await call("reply.cancel").catch(() => {});
    await call("provider.save", { kind: "compatible", baseUrl: `http://127.0.0.1:${port}/v1`, model: "android-media-fixture", clearApiKey: true }).catch(() => {});
    const profile = before.providers.find(p => p.id === "compatible").profile;
    await call("provider.save", { kind: "compatible", baseUrl: profile.baseUrl, model: profile.model }).catch(() => {});
    if (before.provider.kind !== "compatible") await call("provider.save", { kind: before.provider.kind, baseUrl: before.provider.baseUrl, model: before.provider.model }).catch(() => {});
    if (before.activeConversationId) await call("conversation.select", { id: before.activeConversationId }).catch(() => {});
    if (conversation) await call("conversation.delete", { id: conversation }).catch(() => {});
    await call("runtime.set", { enabled: before.runtime.running }).catch(() => {});
    for (const id of imported) if (/^[a-f0-9-]{36}$/.test(id)) {
      adb("shell", "run-as", app, "rm", "-f", `files/data/attachment-${id}.json`, `files/media-previews/${id}.jpg`);
    }
  }
  await browser?.close(); adb("reverse", "--remove", `tcp:${port}`); adb("forward", "--remove", "tcp:9226");
  server.closeAllConnections(); await new Promise(r => server.close(r));
  await writeFile(".artifacts/android-device/media-smoke.json", JSON.stringify({ testedAt: new Date().toISOString(), results }, null, 2));
}
