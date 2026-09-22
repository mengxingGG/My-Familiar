import { definePlugin } from "../../packages/contracts/index.ts";
export const integrationCommands = [
  "integrations.status",
  "feishu.install",
  "feishu.configure",
  "feishu.createApp",
  "feishu.authorize",
  "feishu.authorizeOffice",
  "feishu.check",
  "feishu.save",
  "feishu.cancel",
  "feishu.pair",
  "feishu.openAuthorization",
  "github.install",
  "github.login",
  "github.save",
  "github.connect",
  "github.cancel",
  "github.openAuthorization",
];
export const integrationControls = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.integration-controls",
    version: "0.1.0",
    provides: [],
    requires: ["commands", "feishu.cli", "github.integration"],
  },
  start(ctx) {
    const feishu = ctx.use("feishu.cli"),
      github = ctx.use("github.integration");
    const routes = {
      "integrations.status": async () => ({
        feishu: await feishu.status(),
        github: await github.status(),
      }),
      "feishu.install": () => feishu.install(),
      "feishu.configure": (p: any) => feishu.configure(p?.appId, p?.appSecret),
      "feishu.createApp": () => feishu.createApp(),
      "feishu.authorize": (p: any) => feishu.authorize(p?.scope),
      "feishu.authorizeOffice": () => feishu.authorizeOffice(),
      "feishu.check": () => feishu.check(),
      "feishu.save": (p: any) => feishu.save(p),
      "feishu.cancel": () => feishu.cancelJob(),
      "feishu.pair": () => feishu.pair(),
      "feishu.openAuthorization": () => feishu.openAuthorization(),
      "github.install": () => github.install(),
      "github.login": () => github.login(),
      "github.save": (p: any) => github.save(p),
      "github.connect": () => github.connect(),
      "github.cancel": () => github.cancelJob(),
      "github.openAuthorization": () => github.openAuthorization(),
    };
    for (const [name, route] of Object.entries(routes))
      ctx.effect(ctx.use("commands").register(name, route));
  },
});
