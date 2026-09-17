import { app } from "electron";
import { definePlugin } from "../../packages/contracts/index.ts";
export const autostartWindows = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.autostart-windows",
    version: "0.1.0",
    provides: ["platform.autostart"],
    requires: ["commands"],
    permissions: ["system.login-item"],
  },
  start(ctx) {
    ctx.require("system.login-item");
    const options = {
      path: process.execPath,
      args: app.isPackaged ? [] : [app.getAppPath()],
    };
    const get = () => app.getLoginItemSettings(options).openAtLogin;
    const set = (enabled: boolean) => {
      if (process.platform !== "win32")
        throw new Error("当前只支持 Windows 登录启动");
      if (typeof enabled !== "boolean") throw new Error("自启动参数无效");
      app.setLoginItemSettings({
        ...options,
        name: "Familiar",
        openAtLogin: enabled,
      });
      const actual = get();
      if (actual !== enabled) throw new Error("系统未应用登录启动设置");
      return actual;
    };
    ctx.provide("platform.autostart", { get, set });
    ctx.effect(
      ctx
        .use("commands")
        .register("autostart.set", (value) => set(value as boolean)),
    );
  },
});
