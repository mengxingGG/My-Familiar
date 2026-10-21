import { definePlugin } from "../../packages/contracts/index.ts";
import type { Approval } from "../../packages/contracts/index.ts";
import type { MobileTask } from "../../packages/mobile-contracts/index.ts";
import type { AndroidNative } from "./index.ts";
import { calendarCreatePreview } from "./calendar-create.ts";
import { calendarChangePreview } from "./calendar-preview.ts";
import { clockPreview } from "./clock-tools.ts";

function appPreview(a: Approval): { title: string; detail: string } {
  try {
    const parsed = JSON.parse(a.detail), p = parsed.arguments;
    const clock = clockPreview(parsed.tool, p);
    if (clock) return { title: (a.title.startsWith("飞书私聊 · ") ? "飞书私聊 · " : "") + clock.title, detail: clock.detail };
    if (parsed.tool === "feishu_cli" && Array.isArray(p?.args) && p.args.every((arg: unknown) => typeof arg === "string")) {
      const scope = JSON.parse(a.rule ?? "[]");
      return { title: (a.title.startsWith("飞书私聊 · ") ? "飞书私聊 · " : "") + "飞书办公操作", detail: `身份：${scope[1] === "user" ? `个人账号（${typeof scope[5] === "string" ? scope[5] : "已登录用户"}）` : "机器人"}\n应用：${typeof scope[0] === "string" ? scope[0] : "已连接应用"}\n操作参数：\n${JSON.stringify(p.args, null, 2)}\n文件仅可访问灵伴工作区。` };
    }
    if (parsed.tool === "android_calendar_create") {
      const detail = calendarCreatePreview(p);
      if (detail) return { title: (a.title.startsWith("飞书私聊 · ") ? "飞书私聊 · " : "") + "新建系统日程", detail };
    }
    const calendar = calendarChangePreview(parsed.tool, p);
    if (calendar) return { title: (a.title.startsWith("飞书私聊 · ") ? "飞书私聊 · " : "") + calendar.title, detail: calendar.detail };
    if (parsed.tool === "android_apps" && typeof p?.query === "string") return { title: "查找手机应用", detail: `按名称或包名查找：${p.query}\n仅把匹配的应用名称和包名交给当前模型；不会打开应用。` };
    if (parsed.tool === "android_open_app" && typeof p?.target?.label === "string" && typeof p.target.packageName === "string") return { title: "打开手机应用", detail: `应用：${p.target.label}\n包名：${p.target.packageName}\n只打开桌面入口；后续读取页面和操作仍需批准。` };
  } catch { /* 非应用工具保持原有任务预览。 */ }
  return { title: a.title, detail: a.detail };
}

export const mobileTasks = (approvals: Approval[], conversationId = ""): MobileTask[] =>
  approvals.map((a) => ({
    id: a.id, ...appPreview(a),
    kind: a.detail.includes('"tool": "android_calendar_') ? "calendar"
      : a.detail.includes('"tool": "android_notes_') ? "notes"
      : a.detail.includes('"tool": "android_') ? "accessibility" : "tool",
    status: "awaitingApproval", conversationId, choices: a.choices ?? ["once"],
  }));

/** 只向原生审批表面推送最小任务数据，复用共享审批所有者。 */
export const androidApprovals = (native: AndroidNative) => definePlugin({
  manifest: { manifestVersion: 1, id: "familiar.approvals-android", version: "0.3.0", provides: [], requires: ["agent.approvals"] },
  start(ctx) {
    let revision = Date.now() * 1000;
    const publish = () => native.call<void>("approvals.update", {
      protocolVersion: 1, revision: ++revision,
      tasks: mobileTasks(ctx.use("agent.approvals").list()),
    }).catch(() => {});
    ctx.on("agent.approvals", publish);
    void publish();
  },
});
