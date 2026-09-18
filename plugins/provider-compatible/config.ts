import {
  definePlugin,
  defaults,
  type ConfigSection,
  type Settings,
} from "../../packages/contracts/index.ts";
import { validateProviderSettings } from "../llm-shared/config.ts";
export const providerSchema: ConfigSection<Settings["provider"]> = {
  defaults: defaults.provider,
  validate: validateProviderSettings,
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
