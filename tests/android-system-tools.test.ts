import test from "node:test";
import assert from "node:assert/strict";
import { Kernel } from "../packages/kernel/index.ts";
import { definePlugin } from "../packages/contracts/index.ts";
import { agentTools } from "../plugins/agent-tools/index.ts";
import { androidTools } from "../plugins/platform-android/index.ts";
import { mobileTasks } from "../plugins/platform-android/approvals.ts";
import { nativeError } from "../apps/tauri/runtime/native-errors.ts";

test("原生固定错误码保留冲突与非法参数，其他异常不穿透桥", () => {
  assert.equal(nativeError("CONFLICT").message, "CONFLICT");
  assert.equal(nativeError("INVALID_INPUT").message, "INVALID_INPUT");
  assert.equal(nativeError("NOT_FOUND").message, "NOT_FOUND");
  assert.equal(
    nativeError("/private/calendar-path: sensitive text").message,
    "UNAVAILABLE",
  );
  assert.equal(nativeError({ message: "CONFLICT" }).message, "UNAVAILABLE");
});

test("Android 日历修改与笔记交接：先批准，取消无原生调用，严格限定目标和参数", async () => {
  const kernel = new Kernel({
    grants: {
      "familiar.tools-android": [
        "device.accessibility",
        "device.calendar",
        "device.notes",
      ],
    },
  });
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  kernel.install(
    definePlugin({
      manifest: {
        manifestVersion: 1,
        id: "test.system",
        version: "1",
        provides: ["storage.local", "android.media"],
        requires: [],
      },
      start(ctx) {
        ctx.provide("storage.local", {
          async read(_key, fallback) {
            return fallback;
          },
          async write() {},
        });
        ctx.provide("android.media", {
          async import() {
            return [];
          },
          async preview() {
            throw new Error("Unused fixture");
          },
        });
      },
    }),
  );
  kernel.install(agentTools);
  kernel.install(
    androidTools({
      async call<T>(method: string, params?: Record<string, unknown>) {
        calls.push({ method, params });
        return {
          status: method === "notes.compose" ? "handoff" : "completed",
        } as T;
      },
    }),
  );
  await kernel.startAll();
  const registry = kernel.resolve("agent.tools"),
    owner = kernel.resolve("agent.approvals");
  const args = {
    operationId: "system-test-0001",
    target: {
      eventId: "1",
      title: "日程原标题",
      start: "2026-10-20T00:00:00Z",
      revision: "a".repeat(64),
    },
    scope: "event",
    patch: { title: "新标题" },
  };
  const run = (
    name: string,
    params: unknown,
    signal = new AbortController().signal,
  ) =>
    registry.run(
      { id: "system-test", name, arguments: JSON.stringify(params) },
      signal,
    );
  const wait = async () => {
    for (let i = 0; i < 100 && !owner.list().length; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(owner.list().length, 1);
    return owner.list()[0];
  };
  try {
    assert(!registry.list().some(t=>t.name==="android_calendar_instance_update"));
    assert(registry.list().some(t=>t.name==="android_calendar_tools_search"));
    const directory=JSON.parse(await run("android_calendar_tools_search",{query:"android_calendar_delete"}));
    assert.equal(directory.tools.length,1);const ref=directory.tools[0].ref;
    const schema=JSON.parse(await run("android_calendar_tool_schema",{ref}));assert.equal(JSON.parse(schema.schema).required.includes("target"),true);
    const routed=assert.rejects(run("android_calendar_tool_invoke",{ref,arguments:{...args,patch:undefined}}),/拒绝/);
    const routedApproval=await wait();assert.equal(mobileTasks([routedApproval])[0].kind,"calendar");assert.match(routedApproval.detail,/android_calendar_delete/);
    await owner.decide(routedApproval.id,false,"once");await routed;assert.equal(calls.length,0);
    const pending = run("android_calendar_update", args);
    const approval = await wait();
    assert.equal(calls.length, 0);
    assert.match(approval.detail, /日程原标题/);
    assert.equal(mobileTasks([approval])[0].kind, "calendar");
    await owner.decide(approval.id, true, "once");
    await pending;
    assert.deepEqual(calls[0], { method: "calendar.update", params: args });
    const rejected = assert.rejects(
      run("android_calendar_delete", { ...args, patch: undefined }),
      /拒绝/,
    );
    await owner.decide((await wait()).id, false, "once");
    await rejected;
    assert.equal(calls.length, 1);
    const abort = new AbortController();
    const canceled = assert.rejects(
      run(
        "android_calendar_reminders_set",
        { ...args, patch: undefined, minutes: [5, 10] },
        abort.signal,
      ),
    );
    await wait();
    abort.abort();
    await canceled;
    assert.equal(calls.length, 1);
    assert.equal(owner.list().length, 0);
    for (const bad of [
      { ...args, target: { eventId: "1" } },
      { ...args, patch: { title: "x", calendarId: "2" } },
      { ...args, scope: "instance" },
    ])
      await assert.rejects(run("android_calendar_update", bad));
    await assert.rejects(
      run("android_calendar_reminders_set", {
        ...args,
        patch: undefined,
        minutes: [5, 5],
      }),
    );
    assert.equal(owner.list().length, 0);
    const create = {
      operationId: "calendar-repeat-test", calendarId: "1", title: "每周例会", start: "2026-10-26T10:00:00+08:00", end: "2026-10-26T11:00:00+08:00", timeZone: "Asia/Shanghai",
      recurrence: { frequency: "weekly", interval: 2, weekDays: ["MO", "FR"], count: 6 },
    };
    const totalBeforeCreate = calls.length;
    const createDenied = assert.rejects(run("android_calendar_create", create), /拒绝/);
    const createApproval = await wait();
    const human = mobileTasks([createApproval])[0];
    assert.equal(human.title, "新建系统日程");assert.match(human.detail, /每 2 周/);assert.match(human.detail, /周一、周五/);assert.match(human.detail, /共 6 次/);assert.match(human.detail, /Asia\/Shanghai/);
    await owner.decide(createApproval.id, false, "once");await createDenied;assert.equal(calls.length, totalBeforeCreate);
    const createAllowed = run("android_calendar_create", create);await owner.decide((await wait()).id, true, "once");await createAllowed;
    assert.deepEqual(calls.at(-1), { method: "calendar.create", params: create });
    const fromChannel = mobileTasks([{...createApproval,title:"飞书私聊 · 原工具说明"}])[0];assert.match(fromChannel.title,/^飞书私聊/);
    for (const recurrence of [
      { frequency:"weekly",count:2,until:"2026-12-01" }, { frequency:"daily",weekDays:["MO"] }, { frequency:"weekly",weekDays:["MO","MO"] },
      { frequency:"weekly",weekDays:[] }, { frequency:"hourly" }, { frequency:"daily",interval:0 }, { frequency:"daily",count:1.5 }, { frequency:"daily",rrule:"FREQ=SECONDLY" },
    ]) await assert.rejects(run("android_calendar_create", {...create,recurrence}));
    assert.equal(owner.list().length,0);
    const allDay = {...create,title:"全天出差",start:"2026-10-26T00:00:00Z",end:"2026-10-28T00:00:00Z",timeZone:"UTC",allDay:true,recurrence:{frequency:"yearly",until:"2030-10-26"}};
    const dayPending = run("android_calendar_create",allDay);const dayApproval = await wait();const dayPreview=mobileTasks([dayApproval])[0];
    assert.match(dayPreview.detail,/全天：2026-10-26 至 2026-10-27/);assert.match(dayPreview.detail,/2030-10-26，包含当天/);assert.match(dayPreview.detail,/不存在的日期会跳过/);
    await owner.decide(dayApproval.id,true,"once");await dayPending;assert.deepEqual(calls.at(-1),{method:"calendar.create",params:allDay});
    const singleTarget = { seriesId:"1",originalStart:"2026-10-26T01:00:00Z",revision:"b".repeat(64),title:"这周例会",start:"2026-10-26T02:00:00Z",end:"2026-10-26T03:00:00Z",timeZone:"Asia/Shanghai",allDay:false,cancelled:false };
    const single = {operationId:"calendar-single-test",target:singleTarget};
    const beforeSingle=calls.length;
    const deniedSingle=assert.rejects(run("android_calendar_instance_cancel",single),/拒绝/);
    const cancelApproval=await wait(),cancelPreview=mobileTasks([cancelApproval])[0];
    assert.equal(cancelPreview.title,"取消这一次日程");assert.match(cancelPreview.detail,/范围：仅这一次/);assert.match(cancelPreview.detail,/原定开始：2026-10-26T01/);assert.match(cancelPreview.detail,/当前开始：2026-10-26T02/);
    await owner.decide(cancelApproval.id,false,"once");await deniedSingle;assert.equal(calls.length,beforeSingle);
    for(const [name,method,parameters] of [
      ["android_calendar_instance_read","calendar.instance.read",{seriesId:"1",originalStart:singleTarget.originalStart}],
      ["android_calendar_instance_update","calendar.instance.update",{...single,patch:{location:"新地点",description:""}}],
      ["android_calendar_instance_cancel","calendar.instance.cancel",single],
    ] as const) {
      const result=run(name,parameters);const approval=await wait();assert.equal(calls.length,beforeSingle+(name.endsWith("read")?0:name.endsWith("update")?1:2));
      if(name.endsWith("update"))assert.match(mobileTasks([approval])[0].detail,/新备注：（清空）/);
      await owner.decide(approval.id,true,"once");await result;assert.deepEqual(calls.at(-1),{method,params:parameters});
    }
    for(const bad of [
      {...single,scope:"series",patch:{title:"x"}},
      {...single,patch:{recurrence:{frequency:"daily"}}},
      {...single,patch:{allDay:true}},
      {...single,target:{...singleTarget,originalStart:undefined},patch:{title:"x"}},
    ]) await assert.rejects(run("android_calendar_instance_update",bad));
    assert.equal(owner.list().length,0);
    const seriesDelete=run("android_calendar_delete",{operationId:"calendar-series-delete",target:{...args.target,exceptionCount:2},scope:"series"});
    const seriesApproval=await wait(),seriesPreview=mobileTasks([{...seriesApproval,title:"飞书私聊 · 删除"}])[0];
    assert.match(seriesPreview.title,/^飞书私聊/);assert.match(seriesPreview.detail,/范围：整个重复系列/);assert.match(seriesPreview.detail,/取消：2 次/);assert.match(seriesPreview.detail,/删除全部日期/);
    await owner.decide(seriesApproval.id,true,"once");await seriesDelete;
    const note = {
      operationId: "note-test-0001",
      target: {
        component: "app.notes/.Create",
        label: "我的笔记",
        mode: "prefilled",
      },
      title: "待确认",
      text: "正文",
    };
    const handoff = run("android_notes_compose", note);
    const noteApproval = await wait();
    assert.equal(mobileTasks([noteApproval])[0].kind, "notes");
    assert.match(noteApproval.detail, /我的笔记/);
    await owner.decide(noteApproval.id, true, "once");
    assert.match(await handoff, /handoff/);
    assert.equal(calls.at(-1)?.method, "notes.compose");
    await assert.rejects(
      run("android_notes_compose", {
        ...note,
        target: { ...note.target, action: "SEND" },
      }),
    );
  } finally {
    await kernel.dispose();
  }
});
