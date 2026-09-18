import { safeStorage } from "electron";
import { definePlugin } from "../../packages/contracts/index.ts";
import { credentialScope } from "../llm-shared/config.ts";
export const secretsLocal = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.secrets-local",
    version: "0.1.0",
    provides: ["secrets.local"],
    requires: ["storage.local", "settings"],
    permissions: ["secrets.model"],
  },
  async start(ctx) {
    ctx.require("secrets.model");
    const storage = ctx.use("storage.local");
    const saved = await storage.read<
      string | { version: number; entries: Record<string, string> }
    >("model-secret", "");
    let entries: Record<string, string> = {};
    if (typeof saved === "string") {
      if (saved) {
        entries[credentialScope(ctx.use("settings").get().provider)] = saved;
        await storage.write("model-secret", { version: 2, entries });
      }
    } else if (
      saved?.version === 2 &&
      saved.entries &&
      typeof saved.entries === "object"
    ) {
      for (const [scope, value] of Object.entries(saved.entries)) {
        if (/^[a-f0-9]{64}$/.test(scope) && typeof value === "string")
          entries[scope] = value;
      }
    } else throw new Error("密钥存储格式无效");
    let queue = Promise.resolve();
    ctx.provide("secrets.local", {
      has: (scope) => !!entries[scope],
      get(scope) {
        const encoded = entries[scope];
        if (!encoded) return "";
        if (!safeStorage.isEncryptionAvailable())
          throw new Error("系统密钥存储不可用");
        try {
          return safeStorage.decryptString(Buffer.from(encoded, "base64"));
        } catch {
          throw new Error(
            "已保存的密钥无法解密，原密文仍保留。请在对应设置页重新保存 API Key；迁移数据时需一并保留 Runtime 的 Local State。",
          );
        }
      },
      set(scope, value) {
        const operation = queue.then(async () => {
          if (
            !/^[a-f0-9]{64}$/.test(scope) ||
            typeof value !== "string" ||
            value.length > 8192 ||
            /[\r\n]/.test(value)
          )
            throw new Error("API Key 无效");
          if (value && !safeStorage.isEncryptionAvailable())
            throw new Error("系统密钥存储不可用");
          const next = value
            ? safeStorage.encryptString(value).toString("base64")
            : "";
          const updated = { ...entries };
          if (next) updated[scope] = next;
          else delete updated[scope];
          await storage.write("model-secret", { version: 2, entries: updated });
          entries = updated;
          ctx.emit("secrets.changed", scope);
        });
        queue = operation.catch(() => {});
        return operation;
      },
    });
    ctx.effect(() => queue);
  },
});
