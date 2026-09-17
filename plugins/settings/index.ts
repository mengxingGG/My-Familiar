import {
  definePlugin,
  defaults,
  type ConfigSection,
  type Settings,
} from "../../packages/contracts/index.ts";
type Schemas = {
  [K in "pet" | "persona" | "provider"]: ConfigSection<Settings[K]>;
};
export function validateSettings(value: unknown, schemas: Schemas): Settings {
  const v = value as Settings;
  if (
    !v ||
    !Number.isInteger(v.version) ||
    v.version < 0 ||
    !v.pet ||
    !v.persona ||
    !v.provider
  )
    throw new Error("配置结构无效");
  return {
    version: v.version,
    pet: schemas.pet.validate(v.pet),
    persona: schemas.persona.validate(v.persona),
    provider: schemas.provider.validate(v.provider),
  };
}
export const settings = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.settings",
    version: "0.1.0",
    provides: ["settings"],
    requires: [
      "storage.local",
      "character.catalog",
      "platform.surface",
      "config.pet",
      "config.persona",
      "config.provider",
    ],
  },
  async start(ctx) {
    const storage = ctx.use("storage.local"),
      characters = ctx.use("character.catalog"),
      surface = ctx.use("platform.surface");
    const schemas: Schemas = {
      pet: ctx.use("config.pet"),
      persona: ctx.use("config.persona"),
      provider: ctx.use("config.provider"),
    };
    const initial = {
      version: 0,
      pet: schemas.pet.defaults,
      persona: schemas.persona.defaults,
      provider: schemas.provider.defaults,
    };
    let current = validateSettings(
      await storage.read("settings", initial),
      schemas,
    );
    characters.get(current.pet.character);
    let queue = Promise.resolve();
    ctx.provide("settings", {
      get: () => structuredClone(current),
      apply(input) {
        const operation = queue.then(async () => {
          const next = validateSettings(input, schemas);
          if (next.version !== current.version)
            throw new Error("配置已变化，请刷新后重试");
          characters.get(next.pet.character);
          next.version++;
          const previous = current;
          try {
            surface.configurePet(next.pet);
            await storage.write("settings", next);
          } catch (e) {
            surface.configurePet(previous.pet);
            throw e;
          }
          current = next;
          ctx.emit("settings.changed", structuredClone(current));
          return structuredClone(current);
        });
        queue = operation.then(
          () => {},
          () => {},
        );
        return operation;
      },
    });
    ctx.effect(() => queue);
  },
});
