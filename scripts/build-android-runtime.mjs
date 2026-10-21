import { build } from "esbuild";
import { cp, mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildDocumentText } from "./build-document-text.mjs";
import { prepareAndroidWake } from "./prepare-android-wake.mjs";

await prepareAndroidWake();
const root = resolve(".artifacts/android-assets");
await mkdir(`${root}/runtime`, { recursive: true });
await build({
  entryPoints: ["apps/tauri/runtime/entry.ts"],
  outfile: `${root}/runtime/main.cjs`,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  banner: { js: "(async () => {" },
  footer: {
    js: "})().catch(() => console.error('FAMILIAR_RUNTIME_BOOT_FAILED'));",
  },
});
await cp("characters", `${root}/characters`, { recursive: true });
await cp("characters", `${root}/runtime/characters`, { recursive: true });
await mkdir(`${root}/runtime/licenses`, { recursive: true });
await cp(".artifacts/android-feishu/LARK-CLI-LICENSE", `${root}/runtime/licenses/LARK-CLI-LICENSE`);
await cp('.artifacts/android-feishu-wasm/assets', `${root}/runtime/feishu`, {recursive:true});
await buildDocumentText(`${root}/runtime`);
await mkdir(`${root}/approval`, { recursive: true });
await build({ entryPoints: ["apps/tauri/approval-entry.ts"], outfile: `${root}/approval/app.js`, bundle: true, platform: "browser", format: "esm", target: ["chrome110"] });
await cp("apps/tauri/ui/style.css", `${root}/approval/style.css`);
const approvalHtml = (await readFile("apps/tauri/ui/index.html", "utf8")).replace('<meta charset="UTF-8" />', '<meta charset="UTF-8" /><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\'; img-src \'self\' data:; connect-src \'none\'; frame-src \'none\'; base-uri \'none\'; form-action \'none\'" />');
await writeFile(`${root}/approval/index.html`, approvalHtml);
await writeFile(
  `${root}/runtime/build.json`,
  JSON.stringify({
    protocol: 1,
    built: new Date().toISOString(),
    abi: "arm64-v8a",
  }),
);
console.log(root);
