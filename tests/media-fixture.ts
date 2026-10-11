import { definePlugin } from "../packages/contracts/index.ts";
export { mediaAssets } from "../plugins/media-assets/index.ts";
export const mediaFixture = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "test.media-input",
    version: "1",
    provides: ["media.input"],
    requires: ["media.assets"],
  },
  start(ctx) {
    ctx.provide("media.input", {
      get: () => ({
        screenEnabled: false,
        autoScreen: false,
        displayId: "cursor",
      }),
      set: async (v) => v,
      async prepare(v) {
        const p = typeof v === "string" ? { text: v } : v;
        if (!p || typeof p.text !== "string" || !p.text.trim())
          throw new Error("请输入文字");
        return {
          text: p.text,
          attachments: await ctx.use("media.assets").get(p.attachments ?? []),
          origin: p.origin ?? "text",
        };
      },
    });
  },
});
