import type { DeviceLocation } from "../../packages/contracts/index.ts";
export function trustedLocation(value: DeviceLocation): DeviceLocation {
  if (
    !value ||
    !["Satellite", "WiFi", "Cellular"].includes(value.source) ||
    !Number.isFinite(value.latitude) ||
    Math.abs(value.latitude) > 90 ||
    !Number.isFinite(value.longitude) ||
    Math.abs(value.longitude) > 180 ||
    !Number.isFinite(value.accuracy) ||
    value.accuracy < 0 ||
    value.accuracy > 2000 ||
    !Number.isFinite(value.time) ||
    Math.abs(Date.now() - value.time) > 10 * 60000
  )
    throw new Error(
      "未取得可信的设备位置（IP、默认位置及来源不明均不使用），继续普通问候",
    );
  return value;
}
