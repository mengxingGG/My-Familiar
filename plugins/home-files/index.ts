import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { definePlugin } from "../../packages/contracts/index.ts";
export function homeFiles(preferred: string, fallback: string) {
  return definePlugin({
    manifest: {
      manifestVersion: 1,
      id: "familiar.home-files",
      version: "0.2.0",
      provides: ["familiar.home"],
      requires: [],
      permissions: ["storage.app"],
    },
    async start(ctx) {
      ctx.require("storage.app");
      let root = resolve(preferred);
      try {
        await mkdir(root, { recursive: true });
        await access(root, constants.W_OK);
      } catch {
        root = resolve(fallback);
        await mkdir(root, { recursive: true });
      }
      for (const name of [
        "memory",
        "memory/lessons",
        "memory/daily",
        "skills",
        "mcp/servers",
        "workspace",
      ])
        await mkdir(join(root, name), { recursive: true });
      ctx.provide("familiar.home", { root });
    },
  });
}
