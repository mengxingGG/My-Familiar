import { readFile, readdir } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import {
  definePlugin,
  type Character,
  type SpriteRepresentation,
} from "../../packages/contracts/index.ts";
export function characterPack(directory: string) {
  return definePlugin({
    manifest: {
      manifestVersion: 1,
      id: "familiar.character-pack",
      version: "0.1.0",
      provides: ["character.catalog"],
      requires: [],
      permissions: ["assets.read"],
    },
    async start(ctx) {
      ctx.require("assets.read");
      const entries: Character[] = [];
      for (const name of await readdir(directory)) {
        try {
          const pack = JSON.parse(
            await readFile(join(directory, name, "character.json"), "utf8"),
          );
          if (
            pack.manifestVersion !== 1 ||
            pack.id !== name ||
            typeof pack.name !== "string" ||
            !Array.isArray(pack.actions) ||
            !pack.actions.includes("idle")
          )
            throw new Error("角色清单无效");
          const sprite = pack.representations?.sprite as SpriteRepresentation;
          if (
            !sprite?.frames?.idle?.length ||
            !Number.isFinite(sprite.fps) ||
            sprite.fps < 1 ||
            sprite.fps > 30
          )
            throw new Error("精灵资源无效");
          const frames: Record<string, string[]> = {};
          for (const [action, paths] of Object.entries(sprite.frames)) {
            if (!Array.isArray(paths) || paths.length > 60)
              throw new Error("帧列表无效");
            frames[action] = [];
            for (const path of paths) {
              const root = resolve(directory, name),
                target = resolve(root, path),
                delta = relative(root, target);
              if (
                delta.startsWith("..") ||
                isAbsolute(delta) ||
                !/\.(svg|png|webp)$/.test(target)
              )
                throw new Error("角色资源路径无效");
              const data = await readFile(target);
              if (data.length > 2 * 1024 * 1024) throw new Error("角色帧过大");
              const mime = target.endsWith(".svg")
                ? "image/svg+xml"
                : target.endsWith(".png")
                  ? "image/png"
                  : "image/webp";
              frames[action].push(
                `data:${mime};base64,${data.toString("base64")}`,
              );
            }
          }
          entries.push({
            id: pack.id,
            name: pack.name,
            description: pack.description,
            actions: pack.actions,
            representations: { sprite: { fps: sprite.fps, frames } },
          });
        } catch (e) {
          ctx.report(
            new Error(
              `角色包 ${name} 加载失败：${e instanceof Error ? e.message : "未知错误"}`,
            ),
          );
        }
      }
      if (!entries.length) throw new Error("没有可用角色");
      ctx.provide("character.catalog", {
        list: () => structuredClone(entries),
        get(id) {
          const c = entries.find((c) => c.id === id);
          if (!c) throw new Error("角色不可用");
          return structuredClone(c);
        },
      });
    },
  });
}
