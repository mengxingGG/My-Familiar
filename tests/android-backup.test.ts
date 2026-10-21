import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  readdir,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { bootstrapAndroid } from "../apps/tauri/runtime/bootstrap.ts";
import { mobileBackup } from "../apps/tauri/runtime/mobile-backup.ts";
import {
  encryptBackup,
  decryptBackup,
} from "../plugins/data-transfer/codec.ts";
import { credentialScope } from "../plugins/llm-shared/config.ts";
import type { AndroidNative } from "../plugins/platform-android/index.ts";

const password = "fixture backup 密码 2026!";
test("单文件加密：随机盐/IV、错误密码、篡改与未知格式均不返回数据", async () => {
  const payload = { memory: "迁移记忆", key: "isolated-secret" };
  const a = await encryptBackup(payload, password),
    b = await encryptBackup(payload, password);
  assert(!a.equals(b));
  assert(!a.includes(Buffer.from(payload.key)));
  assert.deepEqual(await decryptBackup(a, password), payload);
  await assert.rejects(decryptBackup(a, password + "wrong"), /BACKUP_DECRYPT/);
  for (const i of [8, 24, 38, a.length - 1]) {
    const damaged = Buffer.from(a);
    damaged[i] ^= 1;
    await assert.rejects(decryptBackup(damaged, password), /BACKUP_DECRYPT/);
  }
  const unsupported = Buffer.from(a);
  unsupported[0] = 0;
  await assert.rejects(decryptBackup(unsupported, password), /INVALID_BACKUP/);
  await assert.rejects(encryptBackup(payload, "short"), /BACKUP_PASSWORD/);
});

async function fixture(root: string) {
  const keys: Record<string, string> = {};
  const native: AndroidNative = {
    async call<T>(method: string, params: Record<string, unknown> = {}) {
      const p = params as Record<string, unknown>;
      let value: unknown = null;
      if (method === "secrets.readAll") value = { ...keys };
      if (method === "secrets.write") {
        if (p.value) keys[String(p.name)] = String(p.value);
        else delete keys[String(p.name)];
      }
      if (method === "backup.path")
        value = join(root, "transfer", String(p.token) + ".familiar");
      if (method === "capabilities.status") value = [];
      if (method === "runtime.status")
        value = {
          running: false,
          overlayVisible: false,
          engine: "ready",
          detail: "isolated",
        };
      return value as T;
    },
  };
  const kernel = await bootstrapAndroid(root, resolve("."), native);
  const run = mobileBackup(kernel, native);
  const call = async <T>(method: string, params?: Record<string, unknown>) =>
    (await run(method, params)) as T;
  return { kernel, call, keys };
}
test("Android 跨安装迁移保留记忆/模型密钥，预览不回填密钥；冲突和失败可恢复", async () => {
  await mkdir(".artifacts", { recursive: true });
  const root = await mkdtemp(resolve(".artifacts/backup-tests-"));
  const source = await fixture(join(root, "source")),
    target = await fixture(join(root, "target"));
  const memory = target.kernel.resolve("memory.files"),
    settings = target.kernel.resolve("settings");
  const initial = settings.get();
  const sourceMemory = source.kernel.resolve("memory.files");
  const transfer = async () => {
    const e = await source.call<{ token: string }>("backup.export", {
      password,
      includeKeys: true,
    });
    const token = randomUUID();
    await mkdir(join(root, "target/transfer"), { recursive: true });
    await copyFile(
      join(root, "source/transfer", e.token + ".familiar"),
      join(root, "target/transfer", token + ".familiar"),
    );
    return token;
  };
  try {
    await sourceMemory.write("CORE.md", "- 用户喜欢午后散步。\n");
    await sourceMemory.write("daily/2026-10-21.md", "迁移日记正文");
    const owner = source.kernel.resolve("settings");
    await owner.apply({
      ...owner.get(),
      provider: {
        ...owner.get().provider,
        baseUrl: "https://source.example/v1",
        model: "migration-model",
      },
    });
    const scope = credentialScope(owner.get().provider);
    await source.kernel
      .resolve("secrets.local")
      .set(scope, "fixture-model-secret");
    await memory.write("CORE.md", "- 目标原有规则。\n");
    await memory.write("topics/only-target.md", "目标独有资料");
    const token = await transfer();
    await assert.rejects(
      target.call("backup.inspect", { token, password: password + "wrong" }),
      /BACKUP_DECRYPT/,
    );
    assert.equal(settings.get().provider.baseUrl, initial.provider.baseUrl);
    const preview = await target.call<any>("backup.inspect", {
      token,
      password,
    });
    assert.equal(preview.modelKeys, 1);
    assert(preview.conflicts >= 1);
    assert(!JSON.stringify(preview).includes("fixture-model-secret"));
    await target.call("backup.apply", { id: preview.id });
    assert.match((await memory.read("CORE.md")).text, /午后散步/);
    assert.equal(
      (await memory.read("daily/2026-10-21.md")).text,
      "迁移日记正文",
    );
    assert.equal(
      (await memory.read("topics/only-target.md")).text,
      "目标独有资料",
    );
    assert.equal(target.keys[scope], "fixture-model-secret");
    assert.equal(settings.get().provider.model, "migration-model");
    await assert.rejects(
      target.call("backup.apply", { id: preview.id }),
      /NOT_FOUND/,
    );
    const recoveryBytes = await readFile(
      join(root, "target/transfer/previous.familiar"),
    );
    assert(!recoveryBytes.includes(Buffer.from("目标原有")));
    assert(!recoveryBytes.includes(Buffer.from("fixture-model-secret")));
    const recovery = await target.call<any>("backup.recovery", { password });
    await target.call("backup.apply", { id: recovery.id });
    assert.match((await memory.read("CORE.md")).text, /目标原有/);
    assert(!(await memory.list()).includes("daily/2026-10-21.md"));
    assert.equal(target.keys[scope], undefined);
    assert.equal(settings.get().provider.baseUrl, initial.provider.baseUrl);
    const token2 = await transfer(),
      plan = await target.call<any>("backup.inspect", {
        token: token2,
        password,
      });
    await memory.write("topics/changed.md", "预览后改动");
    await assert.rejects(
      target.call("backup.apply", { id: plan.id }),
      /CONFLICT/,
    );
    assert.match((await memory.read("CORE.md")).text, /目标原有/);
    const token3 = await transfer(),
      data = (await decryptBackup(
        await readFile(join(root, "target/transfer", token3 + ".familiar")),
        password,
      )) as any;
    data.memory.push({ path: "../escape.md", text: "must not write" });
    await writeFile(
      join(root, "target/transfer", token3 + ".familiar"),
      await encryptBackup(data, password),
    );
    await assert.rejects(
      target.call("backup.inspect", { token: token3, password }),
      /INVALID_BACKUP/,
    );
    assert(!JSON.stringify(await readdir(root)).includes("escape"));
  } finally {
    await source.kernel.dispose();
    await target.kernel.dispose();
  }
});
