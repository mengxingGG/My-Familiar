import {
  definePlugin,
  defaults,
  type ConfigSection,
  type Settings,
} from "../../packages/contracts/index.ts";
export const petSchema: ConfigSection<Settings["pet"]> = {
  defaults: defaults.pet,
  validate(value) {
    const v = value as Settings["pet"];
    if (!v || !Number.isFinite(v.scale) || v.scale < 0.65 || v.scale > 1.6)
      throw new Error("宠物大小需要在 65%—160% 之间");
    for (const key of ["topmost", "quiet", "visible"] as const)
      if (typeof v[key] !== "boolean") throw new Error("宠物开关配置无效");
    if (typeof v.character !== "string" || v.character.length > 80)
      throw new Error("角色标识无效");
    return {
      scale: v.scale,
      topmost: v.topmost,
      quiet: v.quiet,
      character: v.character,
      visible: v.visible,
    };
  },
};
export const petConfig = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.pet-config",
    version: "0.1.0",
    provides: ["config.pet"],
    requires: [],
  },
  start(ctx) {
    ctx.provide("config.pet", petSchema);
  },
});
