import {
  definePlugin,
  defaults,
  type ConfigSection,
  type Settings,
} from "../../packages/contracts/index.ts";
export const providerSchema: ConfigSection<Settings["provider"]> = {
  defaults: defaults.provider,
  validate(value) {
    const v = value as Settings["provider"];
    if (!v || typeof v.baseUrl !== "string") throw new Error("模型配置无效");
    const url = new URL(v.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("模型地址需要是无凭据、无查询参数的 HTTP(S) 地址");
    if (typeof v.model !== "string" || v.model.length > 200)
      throw new Error("模型名称无效");
    if (
      !Number.isFinite(v.temperature) ||
      v.temperature < 0 ||
      v.temperature > 2
    )
      throw new Error("温度需要在 0—2 之间");
    return {
      baseUrl: url.href.replace(/\/$/, ""),
      model: v.model.trim(),
      temperature: v.temperature,
    };
  },
};
export const providerConfig = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.provider-config",
    version: "0.1.0",
    provides: ["config.provider"],
    requires: [],
  },
  start(ctx) {
    ctx.provide("config.provider", providerSchema);
  },
});
