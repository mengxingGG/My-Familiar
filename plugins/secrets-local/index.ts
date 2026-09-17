import { safeStorage } from "electron";
import { definePlugin } from "../../packages/contracts/index.ts";
export const secretsLocal = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.secrets-local",
    version: "0.1.0",
    provides: ["secrets.local"],
    requires: ["storage.local"],
    permissions: ["secrets.model"],
  },
  async start(ctx) {
    ctx.require("secrets.model");
    const storage = ctx.use("storage.local");
    let encoded = await storage.read<string>("model-secret", "");
    let queue = Promise.resolve();
    ctx.provide("secrets.local", {
      has: () => !!encoded,
      get() {
        if (!encoded) return "";
        if (!safeStorage.isEncryptionAvailable())
          throw new Error("系统密钥存储不可用");
        return safeStorage.decryptString(Buffer.from(encoded, "base64"));
      },
      set(value) {
        const operation = queue.then(async () => {
          if (typeof value !== "string" || value.length > 8192)
            throw new Error("API Key 无效");
          if (value && !safeStorage.isEncryptionAvailable())
            throw new Error("系统密钥存储不可用");
          const next = value
            ? safeStorage.encryptString(value).toString("base64")
            : "";
          await storage.write("model-secret", next);
          encoded = next;
        });
        queue = operation.catch(() => {});
        return operation;
      },
    });
    ctx.effect(() => queue);
  },
});
