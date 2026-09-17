import { definePlugin } from "../../packages/contracts/index.ts";
export const runtimeControls = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.runtime-controls",
    version: "0.1.0",
    provides: [],
    requires: [
      "commands",
      "settings",
      "platform.surface",
      "secrets.local",
      "character.catalog",
      "behavior.pet",
      "conversation",
      "llm.chat",
      "platform.autostart",
    ],
  },
  start(ctx) {
    const commands = ctx.use("commands"),
      settings = ctx.use("settings"),
      surface = ctx.use("platform.surface"),
      secrets = ctx.use("secrets.local");
    const routes = {
      "runtime.status": () => ({
        connected: true,
        settings: settings.get(),
        hasKey: secrets.has(),
        autostart: ctx.use("platform.autostart").get(),
        characters: ctx
          .use("character.catalog")
          .list()
          .map(({ id, name, description }) => ({ id, name, description })),
        plugins: ctx.kernel.snapshot(),
        diagnostics: ctx.kernel.diagnostics,
        behavior: ctx.use("behavior.pet").state(),
        metrics: surface.metrics(),
      }),
      "settings.apply": (input: unknown) => settings.apply(input as any),
      "secret.set": (key: unknown) => secrets.set(key as string),
      "provider.test": () => ctx.use("llm.chat").test(),
      "pet.reset": () => surface.resetPosition(),
      "pet.show": async (visible: unknown) => {
        if (typeof visible !== "boolean") throw new Error("显示参数无效");
        const next = settings.get();
        next.pet.visible = visible;
        return settings.apply(next);
      },
      "pet.sleep": () => ctx.use("behavior.pet").interact("sleep"),
      "controller.open": () => surface.openController(),
      "runtime.stop": () => {
        ctx.timeout(() => surface.quit(), 100);
        return true;
      },
    };
    for (const [name, command] of Object.entries(routes))
      ctx.effect(commands.register(name, command));
  },
});
