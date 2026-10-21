import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

// 只在用户已授权的调试模拟器中使用本地模型夹具；日历只创建和清理本次专属容器。
const device = process.env.ANDROID_SERIAL ?? "emulator-5554";
const app = "app.familiar.mobile.debug";
const adb = (...args) =>
  execFileSync(
    process.env.ADB ?? "C:/AndroidSDK/platform-tools/adb.exe",
    ["-s", device, ...args],
    { encoding: "utf8", windowsHide: true },
  ).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fixture = "familiar-" + randomUUID();
const notesPath = `notes/${fixture}.md`;
const results = [];
let plan = [],
  outputs = [],
  step = 0;
let browser, page, before, conversationId, calendarId;
const server = createServer(async (req, res) => {
  if (req.url.endsWith("/models")) {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        data: [{ id: "parity-fixture", context_window: 131072 }],
      }),
    );
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (step > 0) {
    const message = request.messages.filter((m) => m.role === "tool").at(-1);
    try {
      outputs.push(JSON.parse(message.content));
    } catch {
      outputs.push(message?.content);
    }
  }
  const item = plan[step++];
  const choice = item
    ? {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: `fixture-${step}`,
              type: "function",
              function: {
                name: item.name,
                arguments: JSON.stringify(item.args),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      }
    : { delta: { content: "设备工具验收完成" }, finish_reason: "stop" };
  res.end(`data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
adb("reverse", `tcp:${port}`, `tcp:${port}`);
let seq = 0;
const call = async (method, params) => {
  const result = await page.evaluate(
    (payload) =>
      window.__TAURI_INTERNALS__.invoke("plugin:familiar-android|invoke", {
        payload,
      }),
    { protocolVersion: 1, id: `parity-${++seq}`, method, params },
  );
  assert(result.ok, `${method}: ${result.error?.code}`);
  return result.result;
};
const snapshot = () => call("snapshot.get");
const pass = (name) => {
  results.push({ name, passed: true });
  console.log("PASS " + name);
};
async function scenario(items, approve = true) {
  if (conversationId) await call("conversation.delete", { id: conversationId });
  conversationId = (await call("conversation.create")).id;
  plan = items;
  outputs = [];
  step = 0;
  await call("message.send", {
    conversationId,
    text: "仅执行当前本地设备验收夹具指定的测试任务。",
  });
  for (let n = 0; n < 180; n++) {
    const state = await snapshot();
    for (const task of state.tasks)
      await call("task.respond", {
        id: task.id,
        action: approve ? "approve" : "stop",
      });
    const message = state.conversations
      .find((c) => c.id === conversationId)
      ?.messages.at(-1);
    if (message?.role === "assistant" && message.status === "complete") {
      assert.equal(outputs.length, plan.length);
      return outputs;
    }
    if (message?.status === "error") throw Error("Fixture conversation failed");
    await sleep(150);
  }
  throw Error("Fixture deadline exceeded");
}
try {
  adb("shell", "am", "start", "-n", `${app}/app.familiar.mobile.MainActivity`);
  for (let n = 0; n < 80; n++) {
    let pid;
    try {
      pid = adb("shell", "pidof", app);
    } catch {
      await sleep(200);
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
      browser = await chromium.connectOverCDP("http://127.0.0.1:9224");
      page = browser.contexts()[0].pages()[0];
      await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
      break;
    }
    await sleep(200);
  }
  assert(page, "WebView not ready");
  before = await snapshot();
  assert(!before.activeReply, "Do not interrupt a user reply");
  assert(
    before.providers?.length === 7 &&
      before.providers.every((p) => !p.profile.keyConfigured),
    "Use a debug install without real credentials",
  );
  const kinds = [
    "compatible",
    "openai",
    "deepseek",
    "gemini",
    "claude",
    "openrouter",
    "llamacpp",
  ];
  assert.deepEqual(before.providers.map((p) => p.id).sort(), kinds.sort());
  for (const kind of kinds) {
    await call("provider.save", {
      kind,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: `fixture-${kind}`,
    });
    assert.equal((await snapshot()).provider.kind, kind);
  }
  await call("provider.save", {
    kind: "compatible",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: "parity-fixture",
    apiKey: "local-fixture-only",
  });
  await call("provider.save", {
    kind: "openai",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: "fixture-openai",
  });
  assert.equal((await snapshot()).provider.keyConfigured, false);
  await call("provider.save", {
    kind: "compatible",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: "parity-fixture",
  });
  assert.equal((await snapshot()).provider.keyConfigured, true);
  pass("七类供应商切换与同地址跨协议密钥隔离");
  assert.equal(before.characters.length, 7);
  for (const character of before.characters) {
    await call("companion.save", {
      ...before.companion,
      characterId: character.id,
    });
    assert.equal((await snapshot()).companion.characterId, character.id);
  }
  pass("七个角色经真实配置持久化与原生宠物同步");
  const local = await scenario([
    {
      name: "files_write",
      args: { path: notesPath, text: "ARM64 工作笔记验收" },
    },
    { name: "files_read", args: { path: notesPath } },
    { name: "memory_search", args: { query: fixture } },
    { name: "skill_read", args: { id: "companion-memory" } },
  ]);
  assert.equal(local[1].text, "ARM64 工作笔记验收");
  assert(Array.isArray(local[2]));
  assert.match(local[3], /memory_diary/);
  pass("本地笔记文件写入回读、记忆检索和 Skill 读取");
  if (process.argv.includes("--calendar")) {
    assert.equal(
      before.capabilities.find((c) => c.id === "calendar")?.state,
      "granted",
      "Enable calendar permission through Android UI first",
    );
    const uri = `content://com.android.calendar/calendars?caller_is_syncadapter=true&account_name=${fixture}&account_type=LOCAL`;
    adb(
      "shell",
      `content insert --uri '${uri}' --bind account_name:s:${fixture} --bind account_type:s:LOCAL --bind name:s:${fixture} --bind calendar_displayName:s:${fixture} --bind ownerAccount:s:${fixture} --bind calendar_access_level:i:700 --bind visible:i:1 --bind sync_events:i:1 --bind calendar_timezone:s:UTC`,
    );
    const inserted = adb(
      "shell",
      "content",
      "query",
      "--uri",
      "content://com.android.calendar/calendars",
      "--projection",
      "_id:name",
    );
    calendarId = inserted
      .split("\n")
      .find((line) => line.includes(`name=${fixture}`))
      ?.match(/_id=(\d+)/)?.[1];
    assert(calendarId, "Test calendar was not created");
    const start = new Date(Date.now() + 3600000).toISOString();
    const end = new Date(Date.now() + 7200000).toISOString();
    const args = {
      operationId: fixture,
      calendarId,
      title: fixture,
      description: "隔离日历回读验证",
      location: "本地模拟器",
      start,
      end,
      timeZone: "UTC",
    };
    await scenario([{ name: "android_calendar_create", args }], false);
    const empty = adb(
      "shell",
      "content",
      "query",
      "--uri",
      "content://com.android.calendar/events",
      "--projection",
      "_id",
      "--where",
      `calendar_id=${calendarId}`,
    );
    assert.match(empty, /No result found/);
    pass("拒绝日历任务后系统日历没有写入");
    const data = await scenario([
      { name: "android_calendar_list", args: {} },
      { name: "android_calendar_create", args },
      { name: "android_calendar_create", args },
      {
        name: "android_calendar_create",
        args: { ...args, title: "同编号不同内容必须被拒绝" },
      },
      { name: "android_calendar_query", args: { start, end } },
    ]);
    assert(data[0].some((c) => c.id === calendarId && c.writable));
    assert.equal(data[1].status, "completed");
    assert.equal(data[1].eventId, data[2].eventId);
    assert.equal(
      data[4].events.filter((event) => event.calendarId === calendarId).length,
      1,
    );
    assert.notEqual(data[3]?.status, "completed");
    pass("CalendarProvider 创建回读、重复及冲突操作防重与时段查询");
  }
} catch (error) {
  results.push({
    name: "Android 功能对齐回归失败",
    passed: false,
    reason: String(error),
  });
  throw error;
} finally {
  if (
    before &&
    page &&
    !before.activeReply &&
    before.providers?.every((p) => !p.profile.keyConfigured)
  ) {
    try {
      await call("reply.cancel");
      if (conversationId)
        await call("conversation.delete", { id: conversationId });
      await call("provider.save", {
        kind: "compatible",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "parity-fixture",
        clearApiKey: true,
      });
      for (const option of before.providers)
        await call("provider.save", {
          kind: option.id,
          baseUrl: option.profile.baseUrl,
          model: option.profile.model,
        });
      await call("provider.save", {
        kind: before.provider.kind,
        baseUrl: before.provider.baseUrl,
        model: before.provider.model,
      });
      await call("companion.save", before.companion);
      if (before.activeConversationId)
        await call("conversation.select", { id: before.activeConversationId });
      adb(
        "shell",
        "run-as",
        app,
        "rm",
        "-f",
        `files/home/workspace/${notesPath}`,
      );
    } catch (error) {
      results.push({
        name: "恢复测试前配置",
        passed: false,
        reason: String(error),
      });
    }
  }
  if (calendarId) {
    const identity = adb(
      "shell",
      "content",
      "query",
      "--uri",
      `content://com.android.calendar/calendars/${calendarId}`,
      "--projection",
      "name",
    );
    if (identity.includes(fixture))
      adb(
        "shell",
        `content delete --uri 'content://com.android.calendar/calendars/${calendarId}?caller_is_syncadapter=true&account_name=${fixture}&account_type=LOCAL'`,
      );
  }
  await browser?.close();
  adb("forward", "--remove", "tcp:9224");
  adb("reverse", "--remove", `tcp:${port}`);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await mkdir(".artifacts/android-device", { recursive: true });
  await writeFile(
    ".artifacts/android-device/parity-smoke.json",
    JSON.stringify({ device, results }, null, 2),
  );
}
