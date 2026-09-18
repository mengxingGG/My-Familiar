import { app, shell } from "electron";
import { join } from "node:path";
import {
  definePlugin,
  type DeviceLocation,
} from "../../packages/contracts/index.ts";
import { runProcess } from "../agent-tools/process.ts";
import { trustedLocation } from "./validation.ts";
export const locationWindows = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.location-windows",
    version: "0.3.0",
    provides: ["platform.location"],
    requires: [],
    permissions: ["device.location"],
  },
  start(ctx) {
    ctx.require("device.location");
    ctx.provide("platform.location", {
      async locate(prompt, signal) {
        if (process.platform !== "win32")
          throw new Error("设备定位当前仅支持 Windows");
        const directory = app.isPackaged
          ? join(process.resourcesPath, "app.asar.unpacked", "dist", "native")
          : join(app.getAppPath(), "dist", "native");
        const result = await runProcess(
          join(directory, "Familiar.Location.exe"),
          [prompt ? "--prompt" : "--read"],
          directory,
          signal,
        );
        let value;
        try {
          value = JSON.parse(result.output.trim());
        } catch {
          throw new Error("设备定位暂不可用，将使用普通问候");
        }
        if (value.error) throw new Error(value.error);
        return trustedLocation(value);
      },
      openSettings() {
        void shell.openExternal("ms-settings:privacy-location");
      },
    });
  },
});
