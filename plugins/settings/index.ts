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
/** 宿主可注入宠物配置承载，避免移动设置依赖完整桌面窗口接口。 */
export function createSettings(
  presentPet?: (pet: Settings["pet"]) => void | Promise<void>,
) {
  return definePlugin({
    manifest: {
      manifestVersion: 1,
      id: "familiar.settings",
      version: "0.1.0",
      provides: ["settings"],
      requires: [
        "storage.local",
        "character.catalog",
        ...(presentPet ? [] : ["platform.surface" as const]),
        "config.pet",
        "config.persona",
        "config.provider",
      ],
    },
    async start(ctx) {
      const storage = ctx.use("storage.local"),
        characters = ctx.use("character.catalog"),
        configurePet =
          presentPet ??
          ((pet: Settings["pet"]) =>
            ctx.use("platform.surface").configurePet(pet));
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
      const update = (input: Settings | (() => Settings)) => {
        const operation = queue.then(async () => {
          const next = validateSettings(
            typeof input === "function" ? input() : input,
            schemas,
          );
          if (next.version !== current.version)
            throw new Error("配置已变化，请刷新后重试");
          characters.get(next.pet.character);
          next.version++;
          const previous = current;
          try {
            await configurePet(next.pet);
            await storage.write("settings", next);
          } catch (e) {
            await configurePet(previous.pet);
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
      };
      ctx.provide("settings", {
        get: () => structuredClone(current),
        apply: update,
        patchPet(patch) {
          if (
            !patch ||
            Object.keys(patch).some(
              (k) =>
                ![
                  "scale",
                  "character",
                  "topmost",
                  "quiet",
                  "visible",
                  "bubbleSeconds",
                ].includes(k),
            )
          )
            throw new Error("宠物设置字段无效");
          return update(() => ({
            ...current,
            pet: { ...current.pet, ...patch },
          }));
        },
      });
      ctx.effect(() => queue);
    },
  });
}
export const settings = createSettings();
