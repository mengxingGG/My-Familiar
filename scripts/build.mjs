import { buildLocation } from "./build-location.mjs";
import { buildSpeech } from "./build-speech.mjs";
import { build } from "esbuild";
import { mkdir, cp, rm, open } from "node:fs/promises";
import { resolve, dirname } from "node:path";
const output = resolve("dist");
if (dirname(output) !== process.cwd())
  throw new Error("构建输出必须在当前项目内");
// 唤醒辅助程序常驻时 Windows 禁止覆写；先检查，避免清理一半才报错。
try {
  const file = await open(resolve("dist/native/Familiar.Speech.exe"), "r+");
  await file.close();
} catch (e) {
  if (e.code !== "ENOENT")
    throw new Error(
      "请先从托盘退出 Familiar 再构建，本地唤醒组件仍被占用；尚未清理构建目录。",
    );
}
await rm(output, { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await build({
  entryPoints: {
    runtime: "apps/runtime/main.ts",
    controller: "apps/controller/main.ts",
  },
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron", "pdfjs-dist/legacy/build/pdf.mjs"],
  sourcemap: true,
});
await cp("apps/shared/preload.cjs", "dist/preload.cjs");
await cp("assets", "dist/assets", { recursive: true });
for (const name of [
  "renderer-sprite",
  "bubble-chat",
  "control-center",
  "voice-session",
])
  await cp(`plugins/${name}/ui`, `dist/ui/${name}`, { recursive: true });
await buildLocation();
await buildSpeech();
await cp("characters", "dist/characters", { recursive: true });
console.log("Familiar 已构建：独立 Runtime / Controller + 官方插件");
