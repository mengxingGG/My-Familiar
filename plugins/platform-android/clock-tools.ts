const operationId = { type: "string", pattern: "^[A-Za-z0-9_-]{8,80}$" };
const hour = { type: "integer", minimum: 0, maximum: 23 },
  minute = { type: "integer", minimum: 0, maximum: 59 };
const label = { type: "string", minLength: 1, maxLength: 200 };
export const clockTools = [
  {
    name: "android_clock_status",
    method: "clock.status",
    description:
      "查询系统时钟各操作是否支持及下一个响铃时间。Android 不开放跨应用闹钟数据库；完整列表/编辑/启停/删除用 show 后 android_screen/action，逐步回看确认。",
    properties: {},
    required: [],
  },
  {
    name: "android_clock_ringtones",
    method: "clock.ringtones",
    description:
      "列出设备闹钟铃声与 URI，供 alarm_set 选择。不会试听或修改铃声。",
    properties: {},
    required: [],
  },
  {
    name: "android_alarm_set",
    method: "clock.alarm.set",
    description:
      "在系统时钟创建或激活同参数闹钟，24 小时本地时间。重复日为 MO..SU；省略或空数组为一次性。返回 handedOff 后须观察时钟确认，unknown 先观察，不换 operationId 重试。",
    properties: {
      operationId,
      hour,
      minute,
      label,
      weekDays: {
        type: "array",
        items: { enum: ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] },
        uniqueItems: true,
        maxItems: 7,
      },
      vibrate: { type: "boolean" },
      ringtone: {
        type: "string",
        maxLength: 2000,
        description:
          "clock_ringtones 返回的 URI，或 silent。省略沿用系统默认。",
      },
      skipUi: {
        type: "boolean",
        description: "默认 false。true 请求时钟跳过中间表单，仍须回看确认。",
      },
    },
    required: ["operationId", "hour", "minute", "label"],
  },
  {
    name: "android_alarm_dismiss",
    method: "clock.alarm.dismiss",
    description:
      "请求系统时钟解除匹配闹钟的本次响铃；不等于永久删除或关闭重复计划。label 模糊匹配、time 最接近，可能需要用户选定；next 当前/下一项，all 所有项。永久修改/删除用无障碍观察操作。",
    properties: {
      operationId,
      search: { enum: ["label", "time", "next", "all"] },
      label,
      hour,
      minute,
    },
    required: ["operationId", "search"],
  },
  {
    name: "android_alarm_snooze",
    method: "clock.alarm.snooze",
    description:
      "将系统时钟当前正在响的闹钟稍后提醒，durationMinutes 为分钟。会影响当前响铃，先确认对象；不创建新的重复计划。",
    properties: {
      operationId,
      durationMinutes: { type: "integer", minimum: 1, maximum: 1440 },
    },
    required: ["operationId", "durationMinutes"],
  },
  {
    name: "android_timer_set",
    method: "clock.timer.set",
    description:
      "在系统时钟创建并启动倒计时，1..86400 秒。handedOff 后回看确认；同一任务沿用 operationId。",
    properties: {
      operationId,
      seconds: { type: "integer", minimum: 1, maximum: 86400 },
      label,
      skipUi: { type: "boolean" },
    },
    required: ["operationId", "seconds", "label"],
  },
  {
    name: "android_timer_dismiss",
    method: "clock.timer.dismiss",
    description:
      "解除系统时钟所有已经到期的计时器，不停止仍在倒计时的项目。暂停/继续/修改/删除特定计时器须 show 后通过无障碍完成。",
    properties: { operationId },
    required: ["operationId"],
  },
  {
    name: "android_clock_show",
    method: "clock.show",
    description:
      "显示系统时钟的闹钟或计时器列表。随后用 android_screen/action 读取、编辑、启停、删除；必须重新观察验证，不把页面打开当作修改成功。",
    properties: { operationId, view: { enum: ["alarms", "timers"] } },
    required: ["operationId", "view"],
  },
];

export function clockPreview(
  tool: string,
  p: any,
): { title: string; detail: string } | undefined {
  const names: Record<string, string> = {
    android_alarm_set: "设置系统闹钟",
    android_alarm_dismiss: "解除闹钟本次响铃",
    android_alarm_snooze: "闹钟稍后提醒",
    android_timer_set: "启动系统倒计时",
    android_timer_dismiss: "解除已到期计时器",
    android_clock_show: "打开系统时钟",
  };
  if (!names[tool] || !p) return;
  const lines: string[] = [];
  if (tool === "android_alarm_set")
    lines.push(
      `本地时间：${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`,
      `名称：${p.label}`,
      `重复：${p.weekDays?.length ? p.weekDays.join("、") : "一次性"}`,
      `振动：${p.vibrate === undefined ? "系统默认" : p.vibrate ? "开" : "关"}`,
      `铃声：${p.ringtone ?? "系统默认"}`,
    );
  else if (tool === "android_alarm_dismiss")
    lines.push(
      `匹配方式：${p.search}`,
      ...(p.label ? [`名称包含：${p.label}`] : []),
      ...(p.hour !== undefined ? [`时间：${p.hour}:${p.minute}`] : []),
      "只解除本次响铃，不永久删除重复闹钟。多个匹配项可能需你在时钟中选择。",
    );
  else if (tool === "android_alarm_snooze")
    lines.push(`当前正在响的闹钟延后 ${p.durationMinutes} 分钟。`);
  else if (tool === "android_timer_set")
    lines.push(`倒计时：${p.seconds} 秒`, `名称：${p.label}`);
  else if (tool === "android_timer_dismiss")
    lines.push("解除所有已到期计时器；尚未到期的计时器不受影响。");
  else
    lines.push(
      p.view === "alarms" ? "显示系统闹钟列表。" : "显示系统计时器列表。",
    );
  if (p.skipUi !== undefined)
    lines.push(`跳过时钟表单：${p.skipUi ? "是" : "否"}`);
  lines.push("由手机时钟应用处理；是否生效需要回看确认。");
  return { title: names[tool], detail: lines.join("\n") };
}
