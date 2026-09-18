import { definePlugin } from "../../packages/contracts/index.ts";
import { credentialScope, validateProfile } from "../llm-shared/config.ts";
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
      "llm.registry",
      "llm.management",
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
        apiVersion: 3,
        settings: settings.get(),
        hasKey: secrets.has(credentialScope(settings.get().provider)),
        providers: ctx.use("llm.registry").list(),
        session: ctx.use("conversation").state().session,
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
      "settings.pet": (patch: any) => settings.patchPet(patch),
      "settings.apply": (input: any) => {
        const profile = ctx.use("llm.management").validate(input?.provider);
        const previous = settings.get().provider;
        return settings.apply({
          ...input,
          provider: {
            ...profile,
            savedProfiles: {
              ...previous.savedProfiles,
              [previous.kind]: validateProfile(previous),
              [profile.kind]: profile,
            },
          },
        });
      },
      "secret.set": (input: any) => {
        const config = validateProfile(
          typeof input === "string" ? settings.get().provider : input?.config,
        );
        ctx.use("llm.registry").get(config.kind);
        return secrets.set(
          credentialScope(config),
          typeof input === "string" ? input : input.key,
        );
      },
      "provider.models": (input: any) =>
        ctx
          .use("llm.management")
          .models(input?.config ?? settings.get().provider, !!input?.refresh),
      "provider.inspect": (input: any) =>
        ctx
          .use("llm.management")
          .inspect(input?.config ?? settings.get().provider),
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
