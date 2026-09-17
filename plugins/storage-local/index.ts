import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { definePlugin } from "../../packages/contracts/index.ts";
export function storageLocal(directory: string) {
  return definePlugin({
    manifest: {
      manifestVersion: 1,
      id: "familiar.storage-local",
      version: "0.1.0",
      provides: ["storage.local"],
      requires: [],
      permissions: ["storage.app"],
    },
    async start(ctx) {
      ctx.require("storage.app");
      await mkdir(directory, { recursive: true });
      let queue = Promise.resolve();
      const file = (key: string) => {
        if (!/^[a-z][a-z0-9.-]+$/.test(key)) throw new Error("无效数据键");
        return join(directory, key + ".json");
      };
      ctx.provide("storage.local", {
        async read<T>(key: string, fallback: T): Promise<T> {
          try {
            return JSON.parse(await readFile(file(key), "utf8"));
          } catch (e: any) {
            if (e.code === "ENOENT") return structuredClone(fallback);
            throw new Error(`本地数据读取失败：${key}`);
          }
        },
        async write(key, data) {
          const body = JSON.stringify(data, null, 2);
          const operation = queue.then(async () => {
            const destination = file(key);
            await writeFile(destination + ".tmp", body, { mode: 0o600 });
            await rename(destination + ".tmp", destination);
          });
          queue = operation.catch(() => {});
          return operation;
        },
      });
      ctx.effect(() => queue);
    },
  });
}
