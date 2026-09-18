import type { CareSettings } from "../../packages/contracts/index.ts";
export const careDefaults: CareSettings = {
  enabled: true,
  custom: [],
  location: false,
  nearby: false,
};
export function validateCare(v: CareSettings): CareSettings {
  if (!v) throw new Error("关怀设置无效");
  for (const k of ["enabled", "location", "nearby"] as const)
    if (typeof v[k] !== "boolean") throw new Error("关怀开关无效");
  const custom = v.custom ?? [];
  if (
    !Array.isArray(custom) ||
    custom.length > 30 ||
    new Set(custom.map((r) => r.id)).size !== custom.length
  )
    throw new Error("自定义提醒最多 30 条且 ID 不能重复");
  for (const r of custom)
    if (
      !r ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(r.id) ||
      typeof r.label !== "string" ||
      !r.label.trim() ||
      r.label.length > 60 ||
      typeof r.prompt !== "string" ||
      !r.prompt.trim() ||
      r.prompt.length > 2000 ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time) ||
      typeof r.enabled !== "boolean"
    )
      throw new Error("自定义提醒需填写名称、时间和内容");
  return {
    enabled: v.enabled,
    location: v.location,
    nearby: v.nearby,
    custom: custom.map(({ id, label, prompt, time, enabled }) => ({
      id,
      label: label.trim(),
      prompt: prompt.trim(),
      time,
      enabled,
    })),
  };
}
export function localDay(now: Date) {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}
export function quietTime(_c: CareSettings, now: Date) {
  const h = now.getHours();
  return h >= 22 || h < 8;
}
export function careSlot(
  c: CareSettings,
  now: Date,
  elapsed: number,
  used: string[],
): string | undefined {
  if (!c.enabled) return;
  const minutes = now.getHours() * 60 + now.getMinutes();
  for (const r of c.custom) {
    const [h, m] = r.time.split(":").map(Number),
      start = h * 60 + m;
    if (
      r.enabled &&
      minutes >= start &&
      minutes < start + 30 &&
      !used.includes("custom:" + r.id)
    )
      return "custom:" + r.id;
  }
  if (quietTime(c, now)) return;
  if (elapsed >= 15000 && elapsed < 10 * 60000 && !used.includes("greeting"))
    return "greeting";
  if (
    elapsed >= 20 * 60000 &&
    elapsed < 90 * 60000 &&
    !used.includes("work") &&
    !used.includes("planning")
  )
    return "work";
  for (const [id, start, end] of [
    ["morning", 8 * 60 + 30, 11 * 60],
    ["noon", 11 * 60 + 40, 14 * 60],
    ["evening", 18 * 60 + 20, 21 * 60],
  ] as const)
    if (minutes >= start && minutes < end && !used.includes(id)) return id;
}
