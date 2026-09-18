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
      // Electron 44 写入时自行转义参数，不重复给目录加引号。
      args: app.isPackaged ? [] : [app.getAppPath()],
    };
    const get = () => {
      // 44 的 path 查询走命令行解析；openAtLogin 又只查 AppUserModelID，
      // 因而读取明确命名的启动项，不能拿它判断自定义 name 的状态。
      const status = app.getLoginItemSettings({
        ...options,
        path: `"${options.path}"`,
      });
      return status.launchItems.some(
        (item) =>
          item.name === "Familiar" &&
          item.scope === "user" &&
          item.enabled &&
          JSON.stringify(item.args) === JSON.stringify(options.args),
      );
    };
    const set = (enabled: boolean) => {
      if (process.platform !== "win32")
        throw new Error("当前只支持 Windows 登录启动");
      if (typeof enabled !== "boolean") throw new Error("自启动参数无效");
      app.setLoginItemSettings({
        ...options,
        name: "Familiar",
        openAtLogin: enabled,
        enabled,
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
