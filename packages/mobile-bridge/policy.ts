import {
  MobileBridgeError,
  type ToolPolicy,
} from "../mobile-contracts/index.ts";

/** 白名单只投影公开的摘要和标签；拒绝畸形策略，不信任宿主额外字段。 */
export function projectPolicy(value: unknown): ToolPolicy {
  const p = value as ToolPolicy;
  const categories = [
    "read",
    "search",
    "write",
    "outsideWrite",
    "shell",
    "install",
    "mcp",
  ] as const;
  if (
    !p ||
    !["limited", "auto", "approval", "deny"].includes(p.mode) ||
    !p.defaults ||
    categories.some((k) => !["allow", "ask", "deny"].includes(p.defaults[k])) ||
    !Array.isArray(p.whitelist) ||
    p.whitelist.length > 200 ||
    p.whitelist.some(
      (r) =>
        !r ||
        typeof r.key !== "string" ||
        !/^[a-f0-9]{64}$/.test(r.key) ||
        typeof r.label !== "string" ||
        r.label.length > 10000,
    )
  )
    throw new MobileBridgeError("UNAVAILABLE", "权限设置格式不兼容。");
  return {
    mode: p.mode,
    defaults: Object.fromEntries(
      categories.map((k) => [k, p.defaults[k]]),
    ) as ToolPolicy["defaults"],
    whitelist: p.whitelist.map(({ key, label }) => ({ key, label })),
  };
}
