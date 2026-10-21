import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, unlink, lstat } from "node:fs/promises";
import { replaceFile } from "../../../plugins/storage-local/rename.ts";
import { dirname, join } from "node:path";
import type { Kernel } from "../../../packages/kernel/index.ts";
import type { Settings } from "../../../packages/contracts/index.ts";
import type { AndroidNative } from "../../../plugins/platform-android/index.ts";
import type { BackupPreview } from "../../../packages/mobile-contracts/backup.ts";
import { validateSettings } from "../../../plugins/settings/index.ts";
import { credentialScope } from "../../../plugins/llm-shared/config.ts";
import {
  encryptBackup,
  decryptBackup,
  BACKUP_LIMIT,
} from "../../../plugins/data-transfer/codec.ts";

interface Transfer {
  format: "familiar.data";
  version: 1;
  appVersion: string;
  createdAt: string;
  settings: Settings;
  memory: { path: string; text: string }[];
  keys: Record<string, string>;
}
const input: (v: unknown) => asserts v = (v) => {
  if (!v) throw Error("INVALID_BACKUP");
};
export const validMemoryPath = (p: unknown): p is string =>
  typeof p === "string" &&
  p.length <= 500 &&
  p.endsWith(".md") &&
  !/[\\:\x00-\x1f]/.test(p) &&
  p.split("/").every((n) => !!n && !n.startsWith(".") && !/[. ]$/.test(n)) &&
  (p.toLowerCase() !== "core.md" || p === "CORE.md");
const tokenPattern = /^[a-f0-9-]{36}$/;
const profiles = (s: Settings) =>
  [s.provider, ...Object.values(s.provider.savedProfiles)].filter(
    (p, i, a) =>
      a.findIndex((v) => credentialScope(v) === credentialScope(p)) === i,
  );

/** 备份只由设置页显式调用，不注册成模型工具。私有目录只保存加密文件。 */
export function mobileBackup(kernel: Kernel, native: AndroidNative) {
  const settings = kernel.resolve("settings"),
    memory = kernel.resolve("memory.files"),
    secrets = kernel.resolve("secrets.local");
  const root = join(dirname(kernel.resolve("familiar.home").root), "transfer");
  const recovery = join(root, "previous.familiar");
  let plan:
    | {
        id: string;
        data: Transfer;
        password: Buffer;
        baseline: string;
        rollback: boolean;
        expires: ReturnType<typeof setTimeout>;
      }
    | undefined;
  const clear = () => {
    if (plan) {
      clearTimeout(plan.expires);
      plan.password.fill(0);
      plan = undefined;
    }
  };
  const idle = () => {
    if (
      kernel.resolve("conversation").state().busy ||
      kernel.resolve("agent.approvals").list().length ||
      kernel.resolve("voice.session").state().active ||
      kernel.resolve("voice.session").state().dictating
    )
      throw Error("BUSY");
  };
  const collect = async (includeKeys = true): Promise<Transfer> => {
    const config = settings.get(),
      files = await memory.list();
    if (files.length > 5000) throw Error("LIMIT");
    const docs: Transfer["memory"] = [];
    let bytes = 0;
    for (const path of files) {
      input(validMemoryPath(path));
      const text = (await memory.read(path)).text;
      bytes += Buffer.byteLength(text);
      if (bytes > 20 * 1024 * 1024 || Buffer.byteLength(text) > 2 * 1024 * 1024)
        throw Error("LIMIT");
      docs.push({ path, text });
    }
    const keys: Record<string, string> = {};
    if (includeKeys)
      for (const p of profiles(config)) {
        const scope = credentialScope(p);
        if (secrets.has(scope)) keys[scope] = secrets.get(scope);
      }
    return {
      format: "familiar.data",
      version: 1,
      appVersion: (await native.call<string | null>("app.version")) ?? "1.0.0",
      createdAt: new Date().toISOString(),
      settings: config,
      memory: docs,
      keys,
    };
  };
  const validate = (value: unknown): Transfer => {
    const t = value as Transfer;
    input(
      t &&
        t.format === "familiar.data" &&
        t.version === 1 &&
        typeof t.appVersion === "string" &&
        t.appVersion.length <= 80 &&
        typeof t.createdAt === "string" &&
        Number.isFinite(Date.parse(t.createdAt)),
    );
    const config = validateSettings(t.settings, {
      pet: kernel.resolve("config.pet"),
      persona: kernel.resolve("config.persona"),
      provider: kernel.resolve("config.provider"),
    });
    kernel.resolve("character.catalog").get(config.pet.character);
    input(
      Array.isArray(t.memory) &&
        t.memory.length <= 5000 &&
        new Set(t.memory.map((f) => f?.path)).size === t.memory.length,
    );
    let bytes = 0;
    for (const f of t.memory) {
      input(
        f &&
          validMemoryPath(f.path) &&
          typeof f.text === "string" &&
          Buffer.byteLength(f.text) <= 2 * 1024 * 1024,
      );
      if (f.path === "CORE.md" && Array.from(f.text).length > 2000)
        throw Error("LIMIT");
      bytes += Buffer.byteLength(f.text);
    }
    if (bytes > 20 * 1024 * 1024) throw Error("LIMIT");
    input(
      t.keys &&
        typeof t.keys === "object" &&
        !Array.isArray(t.keys) &&
        Object.keys(t.keys).length <= 33,
    );
    const allowed = new Set(profiles(config).map(credentialScope));
    for (const [scope, key] of Object.entries(t.keys))
      input(
        allowed.has(scope) && typeof key === "string" && key.length <= 16384,
      );
    return {
      format: "familiar.data",
      version: 1,
      appVersion: t.appVersion,
      createdAt: t.createdAt,
      settings: config,
      memory: t.memory.map(({ path, text }) => ({ path, text })),
      keys: { ...t.keys },
    };
  };
  const fingerprint = (data: Transfer) =>
    createHash("sha256")
      .update(
        JSON.stringify({
          settings: data.settings,
          memory: data.memory,
          keys: data.keys,
        }),
      )
      .digest("hex");
  const preview = async (
    data: Transfer,
    password: string,
    rollback: boolean,
  ): Promise<BackupPreview> => {
    clear();
    const current = await collect();
    const id = randomUUID();
    const expires = setTimeout(clear, 5 * 60 * 1000);
    expires.unref();
    plan = {
      id,
      data,
      password: Buffer.from(password),
      baseline: fingerprint(current),
      rollback,
      expires,
    };
    return {
      id,
      sourceVersion: data.appVersion,
      createdAt: data.createdAt,
      memoryFiles: data.memory.length,
      conflicts: data.memory.filter((f) =>
        current.memory.some((v) => v.path === f.path && v.text !== f.text),
      ).length,
      modelKeys: Object.values(data.keys).filter(Boolean).length,
      models: profiles(data.settings).map(({ kind, baseUrl, model }) => ({
        kind,
        baseUrl,
        model,
      })),
      rollback,
    };
  };
  const restore = async (data: Transfer, exact = false) => {
    await memory.restore(data.memory, exact);
    for (const [scope, key] of Object.entries(data.keys))
      await secrets.set(scope, key);
    await settings.apply({ ...data.settings, version: settings.get().version });
    await memory.context();
  };
  return async (
    method: string,
    p: Record<string, unknown> = {},
  ): Promise<unknown> => {
    if (method === "backup.cancel") {
      if (plan?.id === p.id) clear();
      return;
    }
    if (method === "backup.apply") {
      idle();
      const currentPlan = plan;
      if (!currentPlan || currentPlan.id !== p.id) throw Error("NOT_FOUND");
      clearTimeout(currentPlan.expires);
      plan = undefined;
      try {
        const before = await collect();
        if (fingerprint(before) !== currentPlan.baseline)
          throw Error("CONFLICT");
        // 目标配置里尚不存在的凭据，也在恢复点记录空值，以便回滚时删除新导入的密钥。
        const rollback = structuredClone(before);
        for (const scope of Object.keys(currentPlan.data.keys))
          if (!(scope in rollback.keys))
            rollback.keys[scope] = secrets.get(scope);
        await mkdir(root, { recursive: true });
        const encrypted = await encryptBackup(rollback, currentPlan.password);
        await writeFile(recovery + ".tmp", encrypted, { mode: 0o600 });
        await replaceFile(recovery + ".tmp", recovery);
        kernel.resolve("companion.care").stop();
        kernel.resolve("agent.policy").resetSession();
        try {
          await restore(currentPlan.data, currentPlan.rollback);
        } catch {
          try {
            await restore(rollback, true);
          } catch {
            throw Error("BACKUP_RECOVERY");
          }
          throw Error("STORAGE");
        }
        return { imported: true, recoveryAvailable: true };
      } finally {
        currentPlan.password.fill(0);
      }
    }
    if (method === "backup.export") {
      idle();
      input(
        typeof p.password === "string" && typeof p.includeKeys === "boolean",
      );
      const encrypted = await encryptBackup(
        await collect(p.includeKeys),
        p.password,
      );
      const token = randomUUID();
      await mkdir(root, { recursive: true });
      await writeFile(join(root, token + ".familiar"), encrypted, {
        mode: 0o600,
        flag: "wx",
      });
      return { token };
    }
    if (method === "backup.inspect" || method === "backup.recovery") {
      idle();
      input(typeof p.password === "string");
      const rollback = method === "backup.recovery";
      input(
        rollback || (typeof p.token === "string" && tokenPattern.test(p.token)),
      );
      const path = rollback
        ? recovery
        : await native.call<string>("backup.path", { token: p.token });
      const info = await lstat(path);
      input(
        info.isFile() && !info.isSymbolicLink() && info.size <= BACKUP_LIMIT,
      );
      const raw = await decryptBackup(await readFile(path), p.password);
      // 恢复点可以带需要删除的新模型凭据；仅允许摘要形式的作用域，不接受第三方登录令牌。
      const extras: Record<string, string> = {};
      if (rollback && raw && typeof raw === "object") {
        const data = raw as Transfer;
        for (const [key, value] of Object.entries(data.keys ?? {}))
          if (
            !profiles(data.settings).some((v) => credentialScope(v) === key)
          ) {
            input(
              /^[a-f0-9]{64}$/.test(key) &&
                typeof value === "string" &&
                value.length <= 16384,
            );
            extras[key] = value;
            delete data.keys[key];
          }
      }
      const data = validate(raw);
      Object.assign(data.keys, extras);
      const result = await preview(data, p.password, rollback);
      if (!rollback) await unlink(path);
      return result;
    }
    throw Error("UNAVAILABLE");
  };
}
