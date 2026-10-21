import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

// 仅连接用户指定的调试包；夹具只监听本机，不调用真实模型。
const adbPath = process.env.ADB ?? "C:/AndroidSDK/platform-tools/adb.exe";
const device = process.env.ANDROID_SERIAL ?? "emulator-5554";
const app = "app.familiar.mobile.debug";
const output = ".artifacts/android-device";
await mkdir(output, { recursive: true });
const adb = (...args) =>
  execFileSync(adbPath, ["-s", device, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let slow = false;
let authenticated = false;
let toolMode = false;
let toolStep = 0;
let observedScreen;
let actionAccepted = false;
let observedAfterAction = false;
const server = createServer(async (req, res) => {
  if (req.url?.endsWith("/models")) {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        data: [{ id: "arm64-device-fixture", context_window: 32768 }],
      }),
    );
    return;
  }
  authenticated =
    req.headers.authorization === "Bearer isolated-android-test-key";
  let requestText = "";
  for await (const chunk of req) requestText += chunk;
  const request = JSON.parse(requestText);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  if (toolMode) {
    const toolResult = request.messages
      ?.filter((message) => message.role === "tool")
      .at(-1);
    const result = toolResult ? JSON.parse(toolResult.content) : null;
    let name, args;
    if (toolStep === 0) {
      name = "android_screen";
      args = {};
    } else if (toolStep === 1) {
      observedScreen = result;
      name = "android_action";
      args = { snapshotId: result?.snapshotId, action: "home" };
    } else if (toolStep === 2) {
      actionAccepted = result?.accepted === true;
      name = "android_screen";
      args = {};
    } else {
      observedAfterAction = !!result?.nodes?.length && result?.package !== app;
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "已执行操作并重新观察界面" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    toolStep++;
    res.end(
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `android-${toolStep}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  res.write(
    `data: ${JSON.stringify({ choices: [{ delta: { content: "ARM64 核心" } }] })}\n\n`,
  );
  const timer = setTimeout(
    () =>
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "在设备运行成功" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      ),
    slow ? 6000 : 100,
  );
  res.on("close", () => clearTimeout(timer));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
adb("reverse", `tcp:${port}`, `tcp:${port}`);
let browser, page, before, testConversation;
let sequence = 0;
const results = [];
async function attach() {
  await browser?.close();
  adb("shell", "am", "start", "-n", `${app}/app.familiar.mobile.MainActivity`);
  for (let i = 0; i < 60; i++) {
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
        "tcp:9223",
        `localabstract:webview_devtools_remote_${pid}`,
      );
      browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
      page = browser.contexts()[0].pages()[0];
      await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
      return;
    }
    await delay(200);
  }
  throw Error("WebView did not start");
}
async function call(method, params) {
  const reply = await page.evaluate(
    async (payload) =>
      window.__TAURI_INTERNALS__.invoke("plugin:familiar-android|invoke", {
        payload,
      }),
    { protocolVersion: 1, id: `device-test-${++sequence}`, method, params },
  );
  assert(reply.ok, `${method}: ${reply.error?.code}`);
  return reply.result;
}
const snapshot = () => call("snapshot.get");
async function until(predicate, timeout = 20000) {
  const start = Date.now();
  do {
    const state = await snapshot();
    if (predicate(state)) return state;
    await delay(150);
  } while (Date.now() - start < timeout);
  throw Error("Device state deadline exceeded");
}
const last = (state) =>
  state.conversations.find((c) => c.id === testConversation)?.messages.at(-1);
function pass(name) {
  results.push({ name, passed: true });
  console.log(`PASS ${name}`);
}
try {
  await attach();
  before = await until((s) => s.runtime?.engine === "ready");
  assert.equal(before.mode, "live");
  assert.equal(
    before.provider.keyConfigured,
    false,
    "Use a fresh debug install without a user credential",
  );
  assert.equal(
    before.activeReply,
    null,
    "Do not interrupt an existing user reply",
  );
  assert.match(
    adb("shell", "dumpsys", "package", app),
    /primaryCpuAbi=arm64-v8a/,
  );
  pass("ARM64 安装和真实核心连接");
  await call("provider.save", {
    kind: "compatible",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: "arm64-device-fixture",
    apiKey: "isolated-android-test-key",
  });
  const configured = await snapshot();
  assert(configured.provider.keyConfigured);
  assert(!JSON.stringify(configured).includes("isolated-android-test-key"));
  pass("Android Keystore 写入且快照不回填密钥");
  testConversation = (await call("conversation.create")).id;
  await call("message.send", {
    conversationId: testConversation,
    text: "设备验收：普通流式回复",
  });
  let state = await until((s) => last(s)?.status === "complete");
  assert.equal(last(state).text, "ARM64 核心在设备运行成功");
  assert(authenticated);
  pass("设备网络、真实共享 Provider 和流式完成");
  slow = true;
  await call("message.send", {
    conversationId: testConversation,
    text: "设备验收：取消",
  });
  await until(
    (s) => last(s)?.status === "streaming" && last(s).text.length > 0,
  );
  await call("reply.cancel");
  state = await until((s) => last(s)?.status === "stopped");
  assert.equal(last(state).text, "ARM64 核心");
  pass("取消保留已收到的部分回复");
  await call("runtime.set", { enabled: true });
  await until((s) => s.runtime.running);
  await call("message.send", {
    conversationId: testConversation,
    text: "设备验收：离开页面继续回复",
  });
  await until((s) => last(s)?.status === "streaming");
  adb("shell", "input", "keyevent", "KEYCODE_HOME");
  state = await until((s) => last(s)?.status === "complete");
  assert(state.runtime.running);
  assert.equal(last(state).text, "ARM64 核心在设备运行成功");
  assert.match(
    adb("shell", "dumpsys", "activity", "services", app),
    /isForeground=true/,
  );
  pass("回到桌面后前台服务和回复持续运行");
  await attach();
  await call("message.send", {
    conversationId: testConversation,
    text: "设备验收：销毁控制页后继续回复",
  });
  await until(
    (s) => last(s)?.status === "streaming" && last(s).text.length > 0,
  );
  const runtimePid = adb("shell", "pidof", `${app}:runtime`);
  await browser.close();
  browser = undefined;
  let controllerExited = false;
  for (let i = 0; i < 6; i++) {
    adb("shell", "input", "keyevent", "KEYCODE_BACK");
    await delay(200);
    try {
      adb("shell", "pidof", app);
    } catch {
      controllerExited = true;
      break;
    }
  }
  assert(
    controllerExited,
    "Controller process must actually exit, not merely navigate back within the UI",
  );
  assert.equal(adb("shell", "pidof", `${app}:runtime`), runtimePid);
  assert.match(
    adb("shell", "dumpsys", "activity", "services", app),
    /isForeground=true/,
  );
  await delay(5500);
  await attach();
  state = await until((s) => last(s)?.status === "complete");
  assert.equal(last(state).text, "ARM64 核心在设备运行成功");
  assert(state.runtime.running);
  assert.equal(adb("shell", "pidof", `${app}:runtime`), runtimePid);
  pass("销毁并重建控制页，独立运行进程和流式回复不中断");
  if (process.argv.includes("--accessibility")) {
    assert.equal(
      state.capabilities.find((c) => c.id === "accessibility")?.state,
      "granted",
    );
    await call("runtime.set", { enabled: true });
    toolMode = true;
    // 自动化不能操作自己的审批界面；使用无权限夹具作为受控目标。
    adb("shell", "am", "start", "-n", "app.familiar.fixture/.FixtureActivity");
    await delay(500);
    await call("message.send", {
      conversationId: testConversation,
      text: "设备验收：读取当前界面，批准后返回桌面，再观察确认",
    });
    for (let i = 0; i < 3; i++) {
      state = await until((s) =>
        s.tasks.some((task) => task.status === "awaitingApproval"),
      );
      const task = state.tasks.find(
        (task) => task.status === "awaitingApproval",
      );
      await call("task.respond", { id: task.id, action: "approve" });
    }
    state = await until((s) => last(s)?.status === "complete");
    assert(observedScreen?.nodes?.length > 0);
    assert(actionAccepted);
    assert(observedAfterAction);
    pass("无障碍节点读取、逐项批准、真实返回桌面并重新观察");
    toolMode = false;
    await attach();
    // 节点观察产生长工具轨迹；进程恢复用独立短会话，不把夹具当成压缩模型。
    await call("conversation.delete", { id: testConversation });
    testConversation = (await call("conversation.create")).id;
  }
  await call("message.send", {
    conversationId: testConversation,
    text: "设备验收：进程中断后恢复",
  });
  await until(
    (s) => last(s)?.status === "streaming" && last(s).text.length > 0,
  );
  // 等待流式检查点确实写入；强制终止不是正常退出，不能要求未提交字节持久化。
  for (let i = 0; ; i++) {
    const saved = JSON.parse(
      adb("shell", "run-as", app, "cat", "files/data/conversation.json"),
    );
    if (saved.messages.at(-1)?.text === "ARM64 核心") break;
    assert(i < 100, "Streaming checkpoint was not persisted");
    await delay(50);
  }
  adb("shell", "am", "force-stop", app);
  await attach();
  state = await until((s) => s.runtime?.engine === "ready");
  assert.equal(state.provider.keyConfigured, true);
  assert.equal(state.activeReply, null);
  assert.notEqual(last(state)?.status, "streaming");
  assert.equal(last(state)?.text, "ARM64 核心");
  pass("进程重启恢复历史和凭据，中断任务不重放");
  await call("runtime.set", { enabled: true });
  await until((s) => s.runtime.running);
  await call("message.send", {
    conversationId: testConversation,
    text: "设备验收：停止常驻取消回复",
  });
  await until(
    (s) => last(s)?.status === "streaming" && last(s).text.length > 0,
  );
  await call("runtime.set", { enabled: false });
  state = await until(
    (s) => !s.runtime.running && last(s)?.status === "stopped",
  );
  assert.equal(state.runtime.overlayVisible, false);
  pass("停止常驻同时取消回复和收起悬浮窗");
} catch (error) {
  results.push({ name: "设备回归失败", passed: false, reason: String(error) });
  throw error;
} finally {
  if (before && !before.provider.keyConfigured && page) {
    try {
      await call("reply.cancel");
      if (testConversation)
        await call("conversation.delete", { id: testConversation });
      await call("provider.save", {
        kind: "compatible",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "arm64-device-fixture",
        clearApiKey: true,
      });
      await call("provider.save", {
        kind: before.provider.kind,
        baseUrl: before.provider.baseUrl,
        model: before.provider.model,
      });
      if (before.activeConversationId)
        await call("conversation.select", { id: before.activeConversationId });
      await call("runtime.set", { enabled: before.runtime.running });
    } catch (error) {
      results.push({
        name: "恢复测试前配置",
        passed: false,
        reason: String(error),
      });
    }
  }
  await browser?.close();
  adb("reverse", "--remove", `tcp:${port}`);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(
    `${output}/device-smoke.json`,
    JSON.stringify(
      { device, app, runtime: "ARM64 with device native bridge", results },
      null,
      2,
    ),
  );
}
