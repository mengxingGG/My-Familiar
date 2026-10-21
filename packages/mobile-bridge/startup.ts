import { MobileBridgeError, type MobileStartup } from "../mobile-contracts/index.ts";
export function validStartup(value: unknown): value is MobileStartup {
  const s = value as MobileStartup;
  return !!s && typeof s.enabled === "boolean" && typeof s.overlayGranted === "boolean" &&
    ["none", "requested", "started", "permission", "restricted", "cancelled", "failed"].includes(s.lastResult) &&
    Number.isSafeInteger(s.lastAttemptAt) && s.lastAttemptAt >= 0 && typeof s.detail === "string" && s.detail.length <= 300;
}
export function projectStartup(value: unknown): MobileStartup {
  if (!validStartup(value)) throw new MobileBridgeError("UNAVAILABLE", "开机设置状态不兼容");
  return { enabled: value.enabled, overlayGranted: value.overlayGranted, lastResult: value.lastResult, lastAttemptAt: value.lastAttemptAt, detail: value.detail };
}
