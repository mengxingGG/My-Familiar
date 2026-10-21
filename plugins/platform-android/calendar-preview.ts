import { calendarCreatePreview } from "./calendar-create.ts";

/** 审批明确标明单次与整个系列；标题/日期仍由原生快照逐项核验。 */
export function calendarChangePreview(tool: string, p: any): { title: string; detail: string } | undefined {
  const names: Record<string,string> = {
    android_calendar_update: "修改系统日程", android_calendar_delete: "删除系统日程",
    android_calendar_attendees_set: "设置日程参会人", android_calendar_reminders_set: "设置日程提醒", android_calendar_instance_update: "修改这一次日程",
    android_calendar_instance_cancel: "取消这一次日程",
  };
  if (!names[tool] || typeof p?.target?.title !== "string" || typeof p.target.start !== "string") return;
  const t = p.target, single = tool.startsWith("android_calendar_instance_"), series = p.scope === "series";
  const lines = [`范围：${single ? "仅这一次" : series ? "整个重复系列" : "普通日程"}`, `原标题：${t.title}`];
  if (single) {
    lines.push(`系列编号：${t.seriesId}`, `原定开始：${t.originalStart}`, `当前开始：${t.start}`, `当前结束：${t.end}`, `时区：${t.timeZone}`);
    if (t.allDay) lines.push("全天事件；结束日期为最后一天的次日。");
  } else {
    lines.push(`日程编号：${t.eventId}`, `系列/事件起点：${t.start}`);
    if (series) lines.push(`已单独调整或取消：${t.exceptionCount ?? "未确认"} 次`);
  }
  if (tool === "android_calendar_delete") lines.push(series ? "删除全部日期及已有单次改期、取消记录。" : "删除此日程。");
  else if (tool === "android_calendar_instance_cancel") lines.push("仅取消上述这一次，其他日期不变。恢复取消需在日历应用处理。");
  else if (tool === "android_calendar_attendees_set") {
    if (!Array.isArray(p.attendees)) return;
    lines.push("替换所有非组织者参会人（现有单次例外保持原样）：");
    for (const g of p.attendees) lines.push(`${g.name} <${g.email}> · ${g.type} · ${g.status}`);
    if(!p.attendees.length) lines.push("移除全部非组织者参会人。");
    lines.push("同步日历可能发送邀请；本地记录写入不代表邀请送达。");
  } else if (tool === "android_calendar_reminders_set") {
    if (!Array.isArray(p.minutes)) return;
    lines.push(p.minutes.length ? `替换提醒：${p.minutes.map((m:number)=>m === 0 ? "开始时" : `提前 ${m} 分钟`).join("、")}` : "关闭此日程提醒。");
    if (p.method) lines.push(`提醒方式：${p.method}`);
    if (series) lines.push("已有单次例外保留原提醒。");
    lines.push("实际通知由系统日历应用负责。");
  } else {
    if (!p.patch || typeof p.patch !== "object") return;
    const labels: Record<string,string> = { title:"新标题",description:"新备注",location:"新地点",start:"新开始",end:"新结束",timeZone:"新时区", availability:"忙闲状态", visibility:"可见级别" };
    for (const [key, value] of Object.entries(p.patch)) {
      if (labels[key]) lines.push(`${labels[key]}：${value === "" ? "（清空）" : value}`);
      else if (key !== "recurrence") return;
    }
    if (p.patch.recurrence) {
      const full = calendarCreatePreview({...p.patch, title:t.title, calendarId:t.eventId});
      if (!full) return;
      lines.push(...full.split("\n").filter(line => /^(重复|星期|结束|沿用首次)/.test(line)));
    }
    if (series) lines.push(p.patch.recurrence || ["start","end","timeZone"].some(k=>k in p.patch)
      ? "按新的首次时间和重复计划重排整个系列（含历史日期）。若已有单次例外或排除规则，本操作拒绝。"
      : "只改系列主记录；已有单次例外保留其单独内容。");
  }
  lines.push("执行前再次核对日程；期间发生变化则拒绝。恢复资料仅含字段与提醒，不是完整备份。");
  return { title:names[tool], detail:lines.join("\n") };
}
