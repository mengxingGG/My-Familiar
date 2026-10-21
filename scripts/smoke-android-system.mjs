import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { chromium } from "playwright";

// 只操作本轮专属日历和无持久化笔记靶场；应用配置在 finally 恢复。
const app = "app.familiar.mobile.debug",
  fixture = "familiar-system-" + randomUUID(),
  out = ".artifacts/android-device";
const adb = (...a) =>
  execFileSync(
    "C:/AndroidSDK/platform-tools/adb.exe",
    ["-s", "emulator-5554", ...a],
    { encoding: "utf8", windowsHide: true },
  ).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [],
  proof = {};
let plan = [],
  outputs = [],
  step = 0,
  browser,
  page,
  before,
  advanced,
  conversationId,
  calendarId,
  seq = 0,
  configured = false;
const server = createServer(async (req, res) => {
  if (req.url.endsWith("/models")) {
    res.end(
      JSON.stringify({
        data: [{ id: "system-fixture", context_length: 131072 }],
      }),
    );
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const request = JSON.parse(raw);
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
              id: "system-" + step,
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
    : { delta: { content: "系统工具验收完成。" }, finish_reason: "stop" };
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
adb("reverse", `tcp:${port}`, `tcp:${port}`);
async function call(method, params) {
  const r = await page.evaluate(
    (payload) =>
      window.__TAURI_INTERNALS__.invoke("plugin:familiar-android|invoke", {
        payload,
      }),
    { protocolVersion: 1, id: "system-" + ++seq, method, params },
  );
  assert(r.ok, `${method}: ${JSON.stringify(r)}`);
  return r.result;
}
const snapshot = () => call("snapshot.get"),
  pass = (name) => {
    results.push(name);
    console.log("PASS " + name);
  };
async function tool(name, args, approve = true) {
  if (conversationId) await call("conversation.delete", { id: conversationId });
  conversationId = (await call("conversation.create")).id;
  plan = [{ name, args }];
  outputs = [];
  step = 0;
  await call("message.send", {
    conversationId,
    text: "仅执行本轮隔离系统工具验收。",
  });
  for (let n = 0; n < 200; n++) {
    const state = await snapshot();
    for (const task of state.tasks) {
      assert.equal(
        task.kind,
        name.startsWith("android_notes_") ? "notes" : "calendar",
      );
      await call("task.respond", {
        id: task.id,
        action: approve ? "approve" : "stop",
      });
    }
    const message = state.conversations
      .find((c) => c.id === conversationId)
      ?.messages.at(-1);
    if (message?.role === "assistant" && message.status === "complete") {
      assert.equal(outputs.length, 1);
      return outputs[0];
    }
    assert.notEqual(message?.status, "error", JSON.stringify(message));
    await sleep(100);
  }
  throw Error("Tool deadline: " + name);
}
const read = (eventId) => tool("android_calendar_read", { eventId });
const op = () => fixture + "-" + ++seq;
const utc = (ms) => new Date(ms).toISOString();
const query = (table, projection, where) =>
  adb(
    "shell",
    "content",
    "query",
    "--uri",
    "content://com.android.calendar/" + table,
    "--projection",
    projection,
    ...(where ? ["--where", `'${where}'`] : []),
  );
try {
  adb("shell", "am", "start", "-n", `${app}/app.familiar.mobile.MainActivity`);
  for (let i = 0; i < 60; i++) {
    try {
      adb(
        "forward",
        "tcp:9228",
        `localabstract:webview_devtools_remote_${adb("shell", "pidof", app)}`,
      );
      browser = await chromium.connectOverCDP("http://127.0.0.1:9228");
      page = browser.contexts()[0].pages()[0];
      if (page) break;
      await browser.close();
    } catch {}
    await sleep(250);
  }
  assert(page);
  await page.locator('#familiar-root[data-ready="true"]').waitFor();
  before = await snapshot();
  assert(!before.activeReply);
  assert(before.providers.every((p) => !p.profile.keyConfigured));
  assert.equal(
    before.capabilities.find((c) => c.id === "calendar").state,
    "granted",
  );
  advanced = before.providers.find((p) => p.id === "compatible").profile
    .advanced;
  await writeFile(
    `${out}/system-before.json`,
    JSON.stringify({ before, advanced }, null, 2),
  );
  await call("provider.save", {
    kind: "compatible",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: "system-fixture",
    advanced: { ...advanced, contextTokens: 131072 },
  });
  configured = true;
  const uri = `content://com.android.calendar/calendars?caller_is_syncadapter=true&account_name=${fixture}&account_type=LOCAL`;
  adb(
    "shell",
    `content insert --uri '${uri}' --bind account_name:s:${fixture} --bind account_type:s:LOCAL --bind name:s:${fixture} --bind calendar_displayName:s:${fixture} --bind ownerAccount:s:${fixture} --bind calendar_access_level:i:700 --bind visible:i:1 --bind sync_events:i:1 --bind calendar_timezone:s:UTC --bind maxReminders:i:5 --bind allowedReminders:s:0,1`,
  );
  calendarId = query("calendars", "_id:name")
    .split("\n")
    .find((s) => s.includes("name=" + fixture))
    ?.match(/_id=(\d+)/)?.[1];
  assert(calendarId);
  const startMs = Date.now() + 86400000,
    start = utc(startMs),
    end = utc(startMs + 3600000);
  const created = await tool("android_calendar_create", {
    operationId: op(),
    calendarId,
    title: fixture,
    description: "隔离日历编辑验收",
    location: "测试位置",
    start,
    end,
    timeZone: "UTC",
  });
  assert.equal(created.status, "completed", JSON.stringify(created));
  const id = created.eventId;
  let item = await read(id);
  assert.equal(item.title, fixture);
  assert.equal(item.recurring, false);
  assert.match(item.target.revision, /^[a-f0-9]{64}$/);
  proof.created = item;
  pass("实际创建并读取 CalendarProvider 单个日程与版本目标");
  const edit = {
    operationId: op(),
    target: item.target,
    scope: "event",
    patch: {
      title: "修改后的日程",
      location: "新位置",
      start: utc(startMs + 3600000),
      end: utc(startMs + 7200000),
    },
  };
  const denied = await tool("android_calendar_update", edit, false);
  assert.match(JSON.stringify(denied), /拒绝/);
  assert.equal((await read(id)).title, fixture);
  const updated = await tool("android_calendar_update", edit);
  assert.equal(updated.status, "completed", JSON.stringify(updated));
  assert.equal(updated.event.title, "修改后的日程");
  assert.equal(
    updated.event.start,
    utc(startMs + 3600000).replace(".000Z", "Z"),
  );
  proof.updated = updated;
  const replay = await tool("android_calendar_update", {
    ...edit,
    patch: {
      end: edit.patch.end,
      start: edit.patch.start,
      location: "新位置",
      title: "修改后的日程",
    },
  });
  assert.deepEqual(replay, updated);
  const changed = await tool("android_calendar_update", {
    ...edit,
    patch: { title: "同编号不得改内容" },
  });
  assert.match(JSON.stringify(changed), /INVALID_INPUT/);
  const stale = await tool("android_calendar_update", {
    ...edit,
    operationId: op(),
    patch: { title: "过期目标不得覆盖" },
  });
  assert.match(JSON.stringify(stale), /CONFLICT/);
  assert.equal((await read(id)).title, "修改后的日程");
  pass(
    "修改拒绝无写入，批准后回读；参数顺序无关防重、操作编号冲突与过期目标保护",
  );
  item = await read(id);
  let reminders = await tool("android_calendar_reminders_set", {
    operationId: op(),
    target: item.target,
    scope: "event",
    minutes: [0, 10],
  });
  assert.equal(reminders.status, "completed", JSON.stringify(reminders));
  assert.deepEqual(
    reminders.event.reminders.map((r) => r.minutes).sort((a, b) => a - b),
    [0, 10],
  );
  assert.match(query("events/" + id, "hasAlarm"), /hasAlarm=1/);
  proof.reminders = reminders;
  item = await read(id);
  reminders = await tool("android_calendar_reminders_set", {
    operationId: op(),
    target: item.target,
    scope: "event",
    minutes: [],
  });
  assert.equal(reminders.status, "completed", JSON.stringify(reminders));
  assert.deepEqual(reminders.event.reminders, []);
  assert.match(query("events/" + id, "hasAlarm"), /hasAlarm=0/);
  pass("系统提醒分钟数替换/清空与 hasAlarm 回读一致；未把记录写入当作实际响铃");
  item = await read(id);
  const deletion = { operationId: op(), target: item.target, scope: "event" };
  await tool("android_calendar_delete", deletion, false);
  assert.equal((await read(id)).eventId, id);
  const deleted = await tool("android_calendar_delete", deletion);
  assert.equal(deleted.status, "completed", JSON.stringify(deleted));
  assert.match(
    query("events", "_id", `_id=${id} AND deleted=0`),
    /No result found/,
  );
  assert.deepEqual(await tool("android_calendar_delete", deletion), deleted);
  const recovery = await tool("android_calendar_recovery_read", {
    recoveryId: deleted.recoveryId,
  });
  assert.equal(recovery.title, "修改后的日程");
  assert.equal(recovery.start, item.start);
  proof.recovery = recovery;
  pass("删除拒绝后保留，批准后消失、重复请求不再执行，私有变更前字段可读取");
  // 此组保留外部 CalendarProvider 记录兼容性；产品创建路径另有 recurrence 验收。
  const day = Math.floor(startMs / 86400000) * 86400000;
  adb(
    "shell",
    `content insert --uri content://com.android.calendar/events --bind calendar_id:l:${calendarId} --bind title:s:fixture-all-day --bind dtstart:l:${day} --bind dtend:l:${day + 86400000} --bind eventTimezone:s:UTC --bind allDay:i:1`,
  );
  const allDayId = query("events", "_id:title", `calendar_id=${calendarId}`)
    .split("\n")
    .find((s) => s.includes("title=fixture-all-day"))
    ?.match(/_id=(\d+)/)?.[1];
  assert(allDayId);
  item = await read(allDayId);
  const badDay = await tool("android_calendar_update", {
    operationId: op(),
    target: item.target,
    scope: "event",
    patch: { start: utc(day + 3600000) },
  });
  assert.match(JSON.stringify(badDay), /INVALID_INPUT/);
  const goodDay = await tool("android_calendar_update", {
    operationId: op(),
    target: item.target,
    scope: "event",
    patch: { start: utc(day + 86400000), end: utc(day + 2 * 86400000) },
  });
  assert.equal(goodDay.status, "completed", JSON.stringify(goodDay));
  assert(goodDay.event.allDay);
  adb(
    "shell",
    `content insert --uri content://com.android.calendar/events --bind calendar_id:l:${calendarId} --bind title:s:fixture-series --bind dtstart:l:${day} --bind duration:s:P3600S --bind eventTimezone:s:UTC --bind 'rrule:s:FREQ=DAILY;COUNT=3'`,
  );
  const seriesId = query("events", "_id:title", `calendar_id=${calendarId}`)
    .split("\n")
    .find((s) => s.includes("title=fixture-series"))
    ?.match(/_id=(\d+)/)?.[1];
  assert(seriesId);
  item = await read(seriesId);
  assert(item.recurring);
  assert.equal(item.end, null);
  const badScope = await tool("android_calendar_update", {
    operationId: op(),
    target: item.target,
    scope: "event",
    patch: { title: "wrong scope" },
  });
  assert.match(JSON.stringify(badScope), /INVALID_INPUT/);
  const series = await tool("android_calendar_update", {
    operationId: op(),
    target: item.target,
    scope: "series",
    patch: { title: "整个测试系列" },
  });
  assert.equal(series.status, "completed", JSON.stringify(series));
  assert(series.event.recurring);
  const badTime = await tool("android_calendar_update", {
    operationId: op(),
    target: series.event.target,
    scope: "series",
    patch: { start: utc(day + 3600000) },
  });
  assert.match(JSON.stringify(badTime), /INVALID_INPUT/);
  const badSeriesDelete = await tool("android_calendar_delete", {
    operationId: op(),
    target: series.event.target,
    scope: "series",
  }, false);
  assert.match(JSON.stringify(badSeriesDelete), /拒绝/);
  assert.equal((await read(seriesId)).eventId, seriesId);
  adb(
    "shell",
    `content insert --uri content://com.android.calendar/events --bind calendar_id:l:${calendarId} --bind title:s:fixture-exception --bind dtstart:l:${day + 93600000} --bind dtend:l:${day + 97200000} --bind eventTimezone:s:UTC --bind original_id:l:${seriesId} --bind originalInstanceTime:l:${day + 86400000} --bind originalAllDay:i:0`,
  );
  const exceptionId = query("events", "_id:title", `calendar_id=${calendarId}`)
    .split("\n")
    .find((s) => s.includes("title=fixture-exception"))
    ?.match(/_id=(\d+)/)?.[1];
  assert(exceptionId);
  const exception = await read(exceptionId);
  assert(exception.isException);
  const badException = await tool("android_calendar_delete", {
    operationId: op(),
    target: exception.target,
    scope: "event",
  });
  assert.match(JSON.stringify(badException), /UNAVAILABLE/);
  assert.equal((await read(exceptionId)).eventId, exceptionId);
  const deletedSeries = await tool("android_calendar_delete", { operationId:op(), target:(await read(seriesId)).target, scope:"series" });
  assert.equal(deletedSeries.status,"completed",JSON.stringify(deletedSeries));
  assert.match(JSON.stringify(await read(exceptionId)),/NOT_FOUND/);
  pass("全天 UTC/午夜保护；系列范围、日期修改和重复例外边界已用真实记录验证");
  const targets = await tool("android_notes_targets", {});
  const target = targets.find(
    (t) =>
      t.component ===
        "app.familiar.fixture/app.familiar.fixture.NoteFixtureActivity" &&
      t.mode === "prefilled",
  );
  assert(target, JSON.stringify(targets));
  const note = {
    operationId: op(),
    target,
    title: "模拟器笔记交接",
    text: "标题与正文抵达接收应用。\n保存仍需用户确认。",
  };
  await tool("android_notes_compose", note, false);
  assert(
    !adb("shell", "dumpsys", "activity", "activities").includes(
      "mResumedActivity: ActivityRecord",
    ) ||
      !adb("shell", "dumpsys", "activity", "activities").match(
        /mResumedActivity:.*NoteFixtureActivity/,
      ),
  );
  const handoff = await tool("android_notes_compose", note);
  assert.equal(handoff.status, "handoff", JSON.stringify(handoff));
  assert.equal(handoff.saved, false);
  await sleep(500);
  adb("shell", "uiautomator", "dump", "/sdcard/familiar-system-note.xml");
  const xml = adb("shell", "cat", "/sdcard/familiar-system-note.xml");
  assert(xml.includes("模拟器笔记交接"));
  assert(xml.includes("标题与正文抵达接收应用。"));
  assert(xml.includes("Awaiting user confirmation"));
  proof.note = handoff;
  adb("shell", "screencap", "-p", "/sdcard/familiar-system-note.png");
  adb(
    "pull",
    "/sdcard/familiar-system-note.png",
    `${out}/system-note-handoff.png`,
  );
  adb("shell", "am", "start", "-n", `${app}/app.familiar.mobile.MainActivity`);
  assert.deepEqual(await tool("android_notes_compose", note), handoff);
  assert(
    !adb("shell", "dumpsys", "activity", "activities").match(
      /mResumedActivity:.*NoteFixtureActivity/,
    ),
  );
  const badNote = await tool("android_notes_compose", {
    ...note,
    text: "同编号不同正文",
  });
  assert.match(JSON.stringify(badNote), /INVALID_INPUT/);
  const blank = targets.find(
    (t) => t.component === target.component && t.mode === "blank",
  );
  assert(blank);
  const nonblank = await tool("android_notes_compose", {
    ...note,
    operationId: op(),
    target: blank,
  });
  assert.match(JSON.stringify(nonblank), /INVALID_INPUT/);
  const arbitrary = await tool("android_notes_compose", {
    ...note,
    operationId: op(),
    target: {
      ...target,
      component: "app.familiar.fixture/app.familiar.fixture.FixtureActivity",
    },
  });
  assert.match(JSON.stringify(arbitrary), /UNAVAILABLE/);
  const blankHandoff = await tool("android_notes_compose", {
    operationId: op(),
    target: blank,
    title: "",
    text: "",
  });
  assert.equal(blankHandoff.status, "handoff");
  await sleep(400);
  adb("shell", "uiautomator", "dump", "/sdcard/familiar-system-note.xml");
  const blankXml = adb("shell", "cat", "/sdcard/familiar-system-note.xml");
  assert(blankXml.includes("Title: null") && blankXml.includes("Text: null"));
  adb("shell", "am", "start", "-n", `${app}/app.familiar.mobile.MainActivity`);
  pass(
    "实际笔记 Intent 传递标题正文；拒绝无交接、重复不重开、错误目标/模式受限，结果为待用户保存",
  );
  const apk = await readFile(
    "apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk",
  );
  const sha = createHash("sha256").update(apk).digest("hex");
  const installed = adb("shell", "pm", "path", app)
    .split("\n")
    .find((s) => s.startsWith("package:"))
    .slice(8);
  assert.equal(adb("shell", "sha256sum", installed).split(/\s+/)[0], sha);
  proof.apkSha256 = sha;
  pass("本次安装的 ARM64 APK 与构建哈希一致");
} finally {
  try {
    if (before && configured) {
      await call("reply.cancel");
      if (conversationId)
        await call("conversation.delete", { id: conversationId });
      const compatible = before.providers.find(
        (p) => p.id === "compatible",
      ).profile;
      await call("provider.save", {
        kind: "compatible",
        ...compatible,
        advanced,
      });
      await call("provider.save", { ...before.provider });
      if (before.activeConversationId)
        await call("conversation.select", { id: before.activeConversationId });
    }
    if (
      calendarId &&
      query("calendars/" + calendarId, "name").includes(fixture)
    )
      adb(
        "shell",
        `content delete --uri 'content://com.android.calendar/calendars/${calendarId}?caller_is_syncadapter=true&account_name=${fixture}&account_type=LOCAL'`,
      );
  } catch (e) {
    console.error("RESTORE FAILED", e);
    process.exitCode = 1;
  }
  await browser?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  adb("forward", "--remove", "tcp:9228");
  adb("reverse", "--remove", `tcp:${port}`);
  adb(
    "shell",
    "rm",
    "-f",
    "/sdcard/familiar-system-note.xml",
    "/sdcard/familiar-system-note.png",
  );
  await writeFile(
    `${out}/system-smoke.json`,
    JSON.stringify(
      { date: new Date().toISOString(), fixture, results, proof },
      null,
      2,
    ),
  );
}
