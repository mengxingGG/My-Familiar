import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { bootstrapAndroid } from "../apps/tauri/runtime/bootstrap.ts";
import type { AndroidNative } from "../plugins/platform-android/index.ts";
import { createPreviewBridge } from "../apps/tauri/preview/fixture.ts";
import { isMobileSnapshot } from "../packages/mobile-bridge/index.ts";

test("Android 剪贴板图片进入共享媒体库并在重启后保留来源，拒绝非图片及清理暂存", async () => {
  const root = await mkdtemp(resolve(".artifacts/android-clipboard-"));
  const native: AndroidNative = { async call<T>(method: string) { return (method === "secrets.readAll" ? {} : null) as T; } };
  let kernel = await bootstrapAndroid(root, resolve("."), native);
  const stage = async (mimeType: string, data: Buffer) => {
    const token = randomUUID(), path = join(root, "media-inbox", token); await mkdir(path, { recursive: true });
    await writeFile(join(path, "data"), data); await writeFile(join(path, "meta.json"), JSON.stringify({ name: "粘贴图片.png", mimeType, source: "clipboard" })); return token;
  };
  try {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9SAAAAAASUVORK5CYII=", "base64");
    const [attachment] = await kernel.resolve("android.media").import([await stage("image/png", png)]);
    assert.equal(attachment.source, "clipboard"); assert.equal(attachment.kind, "image");
    await assert.rejects(kernel.resolve("android.media").import([await stage("text/plain", Buffer.from("不应导入剪贴板文字"))]), /INVALID_INPUT/);
    assert.deepEqual(await readdir(join(root, "media-inbox")), []);
    await kernel.dispose(); kernel = await bootstrapAndroid(root, resolve("."), native);
    assert.equal((await kernel.resolve("media.assets").get([attachment.id]))[0].source, "clipboard");
    assert.equal((await kernel.resolve("android.media").preview(attachment.id)).dataUrl, `data:image/png;base64,${png.toString("base64")}`);
  } finally { await kernel.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("剪贴板能力保持旧宿主兼容，不能把非布尔声明当成可用", async () => {
  const preview = createPreviewBridge();
  try {
    const state = await preview.request("snapshot.get", undefined);
    delete state.media!.paste; assert(isMobileSnapshot(state));
    state.media!.paste = true; assert(isMobileSnapshot(state));
    (state.media as unknown as { paste: string }).paste = "true"; assert(!isMobileSnapshot(state));
  } finally { preview.dispose(); }
});
