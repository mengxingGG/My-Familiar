import { definePlugin, type Settings } from "../../packages/contracts/index.ts";
export const rendererSprite = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.renderer-sprite",
    version: "0.1.0",
    provides: ["renderer.pet"],
    requires: ["platform.surface", "character.catalog", "settings", "commands"],
  },
  async start(ctx) {
    const surface = ctx.use("platform.surface"),
      catalog = ctx.use("character.catalog"),
      settings = ctx.use("settings"),
      commands = ctx.use("commands");
    let character = catalog.get(settings.get().pet.character);
    const send = () => surface.send("pet", "familiar:character", character);
    ctx.provide("renderer.pet", {
      async setCharacter(id) {
        const next = catalog.get(id);
        if (!next.representations.sprite)
          throw new Error("当前渲染器不支持该角色");
        character = next;
        send();
      },
      act(action) {
        surface.send(
          "pet",
          "familiar:action",
          character.actions.includes(action) ? action : "idle",
        );
      },
      say(text) {
        ctx.emit("pet.speech", text.slice(0, 100));
      },
    });
    for (const [name, handler] of Object.entries({
      "pet.ready": () => {
        send();
        surface.configurePet(settings.get().pet);
      },
      "pet.click": () => ctx.emit("pet.interaction", "click"),
      "pet.drag-start": () => surface.interaction("drag-start"),
      "pet.drag-end": () => surface.interaction("drag-end"),
      "pet.hit": (data: unknown) => surface.interaction("hit", data),
    }))
      ctx.effect(commands.register(name, handler));
    ctx.on<Settings>("settings.changed", async (config) => {
      await ctx.use("renderer.pet").setCharacter(config.pet.character);
    });
    ctx.effect(() => surface.close("pet"));
    await surface.create("pet", "ui/renderer-sprite/index.html");
    surface.configurePet(settings.get().pet);
    send();
  },
});
