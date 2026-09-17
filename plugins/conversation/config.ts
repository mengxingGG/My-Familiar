import {
  definePlugin,
  defaults,
  type ConfigSection,
  type Settings,
} from "../../packages/contracts/index.ts";
export const personaSchema: ConfigSection<Settings["persona"]> = {
  defaults: defaults.persona,
  validate(value) {
    const v = value as Settings["persona"];
    if (
      !v ||
      typeof v.name !== "string" ||
      !v.name.trim() ||
      v.name.length > 40
    )
      throw new Error("名字需要 1—40 个字符");
    if (typeof v.instruction !== "string" || v.instruction.length > 6000)
      throw new Error("人格设定过长");
    return { name: v.name.trim(), instruction: v.instruction };
  },
};
export const personaConfig = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.persona-config",
    version: "0.1.0",
    provides: ["config.persona"],
    requires: [],
  },
  start(ctx) {
    ctx.provide("config.persona", personaSchema);
  },
});
