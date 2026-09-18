import { createHash } from "node:crypto";
import {
  profileDefaults,
  type ProviderProfile,
  type ProviderSettings,
} from "../../packages/contracts/index.ts";
const modes = ["auto", "off", "effort", "budget", "adaptive"];
const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
function integer(
  value: unknown,
  min: number,
  max: number,
  name: string,
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    throw new Error(`${name}需为 ${min}—${max} 的整数`);
  return value as number;
}
export function validateProfile(value: unknown): ProviderProfile {
  if (!value || typeof value !== "object") throw new Error("模型配置无效");
  const input = value as Partial<ProviderProfile>;
  const v = {
    ...structuredClone(profileDefaults),
    ...input,
    thinking: { ...profileDefaults.thinking, ...input.thinking },
  };
  if (typeof v.kind !== "string" || !/^[a-z][a-z0-9-]{0,49}$/.test(v.kind))
    throw new Error("供应商标识无效");
  if (typeof v.baseUrl !== "string" || v.baseUrl.length > 2048)
    throw new Error("模型地址无效");
  const url = new URL(v.baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("模型地址需要是无凭据、无查询参数的 HTTP(S) 地址");
  if (
    typeof v.model !== "string" ||
    v.model.length > 200 ||
    /[\r\n]/.test(v.model)
  )
    throw new Error("模型名称无效");
  if (
    v.temperature !== null &&
    (!Number.isFinite(v.temperature) || v.temperature < 0 || v.temperature > 2)
  )
    throw new Error("温度需要在 0—2 之间，或使用默认");
  if (
    v.topP !== null &&
    (!Number.isFinite(v.topP) || v.topP <= 0 || v.topP > 1)
  )
    throw new Error("Top P 需要大于 0 且不超过 1");
  if (!modes.includes(v.thinking.mode) || !efforts.includes(v.thinking.effort))
    throw new Error("思考设置无效");
  if (typeof v.cache !== "boolean") throw new Error("缓存设置无效");
  return {
    kind: v.kind,
    baseUrl: url.href.replace(/\/$/, ""),
    model: v.model.trim(),
    temperature: v.temperature,
    topP: v.topP,
    maxOutputTokens: integer(v.maxOutputTokens, 128, 262144, "输出上限"),
    contextTokens:
      v.contextTokens === null
        ? null
        : integer(v.contextTokens, 1024, 2097152, "上下文窗口"),
    timeoutSeconds: integer(v.timeoutSeconds, 10, 900, "请求超时"),
    thinking: {
      mode: v.thinking.mode,
      effort: v.thinking.effort,
      budgetTokens: integer(v.thinking.budgetTokens, 1, 262144, "思考预算"),
    },
    cache: v.cache,
  };
}
export function validateProviderSettings(value: unknown): ProviderSettings {
  const profile = validateProfile(value);
  const saved = (value as ProviderSettings).savedProfiles ?? {};
  if (
    !saved ||
    typeof saved !== "object" ||
    Array.isArray(saved) ||
    Object.keys(saved).length > 32
  )
    throw new Error("供应商配置档案无效");
  const savedProfiles: Record<string, ProviderProfile> = {};
  for (const [key, entry] of Object.entries(saved)) {
    const p = validateProfile(entry);
    if (key !== p.kind) throw new Error("供应商档案不匹配");
    Object.defineProperty(savedProfiles, key, {
      value: p,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { ...profile, savedProfiles };
}
export const credentialScope = (
  config: Pick<ProviderProfile, "kind" | "baseUrl">,
) =>
  createHash("sha256")
    .update(
      `${config.kind}\n${new URL(config.baseUrl).href.replace(/\/$/, "")}`,
    )
    .digest("hex");
