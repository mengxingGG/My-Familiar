/** 重复计划使用结构化字段，原生端生成 RRULE；不接收任意日历规则字符串。 */
export const calendarRecurrence = {
  type: "object",
  properties: {
    frequency: { enum: ["daily", "weekly", "monthly", "yearly"] },
    interval: { type: "integer", minimum: 1, maximum: 100, description: "间隔，默认 1。" },
    weekDays: { type: "array", items: { enum: ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] }, minItems: 1, maxItems: 7, uniqueItems: true, description: "weekly 用；包含首次星期，省略沿用首次。周一开周。" },
    count: { type: "integer", minimum: 1, maximum: 10000, description: "含首次的次数；与 until 互斥。" },
    until: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", description: "本地截止日（含）；与 count 都省略则无限期。" },
  },
  required: ["frequency"], additionalProperties: false,
  not: { required: ["count", "until"] },
  if: { required: ["weekDays"] }, then: { properties: { frequency: { const: "weekly" } } },
};

/** 审批只解释已验证的创建参数；异常时回退完整原始预览，不能隐藏字段。 */
export function calendarCreatePreview(p: any): string | undefined {
  if (!p || typeof p.title !== "string" || typeof p.calendarId !== "string" || typeof p.start !== "string" || typeof p.end !== "string" || typeof p.timeZone !== "string") return;
  const lines = [`日历编号：${p.calendarId}`, `标题：${p.title}`];
  if (p.allDay) {
    const last = new Date(Date.parse(p.end) - 86400000);if (!Number.isFinite(last.getTime())) return;
    lines.push(`全天：${p.start.slice(0, 10)} 至 ${last.toISOString().slice(0, 10)}（含首尾日期）`);
  } else lines.push(`首次开始：${p.start}`, `首次结束：${p.end}`, `时区：${p.timeZone}`);
  if (p.recurrence) {
    const r = p.recurrence, labels: Record<string,string> = { daily:"天", weekly:"周", monthly:"个月", yearly:"年" };
    if (!labels[r.frequency]) return;
    lines.push(`重复：每 ${r.interval ?? 1} ${labels[r.frequency]}`);
    if (Array.isArray(r.weekDays)) {const days:Record<string,string>={MO:"周一",TU:"周二",WE:"周三",TH:"周四",FR:"周五",SA:"周六",SU:"周日"};lines.push(`星期：${r.weekDays.map((d:string)=>days[d]??d).join("、")}`);}
    lines.push(r.count !== undefined ? `结束：共 ${r.count} 次（包含首次）` : r.until ? `结束：${r.until}，包含当天` : "结束：持续重复，未设结束日期");
    if (r.frequency === "monthly" || r.frequency === "yearly") lines.push("沿用首次的月日；遇到不存在的日期会跳过。");
  } else lines.push("重复：不重复");
  if (p.location) lines.push(`地点：${p.location}`);
  if (p.description) lines.push(`备注：${p.description}`);
  lines.push("批准后写入系统日历。提醒需另设，实际通知由日历应用负责。");
  return lines.join("\n");
}
