import { build } from "esbuild";
import { mkdir, copyFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";

export async function buildMobileUi({ preview = false } = {}) {
  const output = resolve("dist", preview ? "mobile-preview" : "mobile-ui");
  await mkdir(output, { recursive: true });
  await build({
    entryPoints: [
      preview ? "apps/tauri/preview-entry.ts" : "apps/tauri/entry.ts",
    ],
    outfile: join(output, "app.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: ["chrome110"],
    sourcemap: false,
  });
  // 打包内置角色；外部设计资料授权与本地产品资源打包是不同边界。
  const copyStatic = async (source, target) => {
    for (const item of await readdir(source, { withFileTypes: true })) {
      if (item.isDirectory()) {
        await mkdir(join(target, item.name), { recursive: true });
        await copyStatic(join(source, item.name), join(target, item.name));
      } else if (/\.(html|css|svg|png|webp|woff2)$/.test(item.name))
        await copyFile(join(source, item.name), join(target, item.name));
    }
  };
  await copyStatic("apps/tauri/ui", output);
  for (const character of [
    "mori",
    "youzi",
    "luna",
    "diandian",
    "fangfang",
    "lili",
    "mianmian",
  ]) {
    const target = join(output, "characters", character);
    await mkdir(target, { recursive: true });
    await copyFile(
      `characters/${character}/idle-0.svg`,
      join(target, "idle-0.svg"),
    );
  }
  return output;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  console.log(
    await buildMobileUi({ preview: process.argv.includes("--preview") }),
  );
}
