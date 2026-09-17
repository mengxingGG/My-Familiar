import { build } from "esbuild";
import { mkdir, cp, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
const output = resolve("dist");
if (dirname(output) !== process.cwd())
  throw new Error("构建输出必须在当前项目内");
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
  external: ["electron"],
  sourcemap: true,
});
await cp("apps/shared/preload.cjs", "dist/preload.cjs");
for (const name of ["renderer-sprite", "bubble-chat", "control-center"])
  await cp(`plugins/${name}/ui`, `dist/ui/${name}`, { recursive: true });
await cp("characters", "dist/characters", { recursive: true });
console.log("Familiar 已构建：独立 Runtime / Controller + 官方插件");
