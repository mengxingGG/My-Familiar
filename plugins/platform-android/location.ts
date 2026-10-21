import {
  definePlugin,
  type DeviceLocation,
} from "../../packages/contracts/index.ts";
import type { AndroidNative } from "./index.ts";
export const locationMaxAge = 10 * 60 * 1000;
export function androidLocationValue(v: DeviceLocation): DeviceLocation {
  if (
    !v ||
    !Number.isFinite(v.latitude) ||
    Math.abs(v.latitude) > 90 ||
    !Number.isFinite(v.longitude) ||
    Math.abs(v.longitude) > 180 ||
    !Number.isFinite(v.accuracy) ||
    v.accuracy < 0 ||
    v.accuracy > 10000 ||
    !Number.isFinite(v.time) ||
    Date.now() - v.time > locationMaxAge ||
    v.time > Date.now() + 10000 ||
    !["Android/fused", "Android/network", "Android/gps"].includes(v.source) ||
    typeof v.mock !== "boolean"
  )
    throw Error("UNAVAILABLE");
  return {
    latitude: v.latitude,
    longitude: v.longitude,
    accuracy: v.accuracy,
    time: v.time,
    source: v.source,
    mock: v.mock,
  };
}
declare module "../../packages/kernel/index.ts" {
  interface Services {
    "android.location": {
      accept(value: DeviceLocation): void;
      clear(): void;
      peek(): DeviceLocation | undefined;
    };
  }
}
/** 定位只由前台原生动作采集；共享关怀读取短时内存缓存，不在后台启动定位。 */
export const androidLocation = (native: AndroidNative) =>
  definePlugin({
    manifest: {
      manifestVersion: 1,
      id: "familiar.location-android",
      version: "0.3.0",
      provides: ["platform.location", "android.location"],
      requires: [],
      permissions: ["device.location"],
    },
    start(ctx) {
      ctx.require("device.location");
      let cache: DeviceLocation | undefined;
      const peek = () => {
        try {
          return cache
            ? structuredClone(androidLocationValue(cache))
            : undefined;
        } catch {
          cache = undefined;
          return undefined;
        }
      };
      ctx.provide("android.location", {
        accept(v) {
          cache = androidLocationValue(v);
        },
        clear() {
          cache = undefined;
        },
        peek,
      });
      ctx.provide("platform.location", {
        async locate(_prompt, signal) {
          signal.throwIfAborted();
          const status = await native.call<{
            permission: boolean;
            enabled: boolean;
          }>("location.status");
          signal.throwIfAborted();
          if (!status?.permission || !status.enabled) {
            cache = undefined;
            throw Error("请先在前台授权并刷新大致位置");
          }
          const value = peek();
          if (!value)
            throw Error("位置已过期，请打开关怀页刷新；本次仅作普通问候");
          return value;
        },
      openSettings() { void native.call('location.settings').catch(()=>{}); },
      });
      ctx.effect(() => {
        cache = undefined;
      });
    },
  });
