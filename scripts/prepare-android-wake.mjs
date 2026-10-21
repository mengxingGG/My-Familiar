import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, copyFile, rename } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cache = resolve(project, ".artifacts/android-wake");
const model = "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20";
const archives = [
  { name: "sherpa-onnx-v1.13.8-android.tar.bz2", hash: "2ff63469a71cb6009aa2e3ed5f4a670f8abdcbe4bb9ffd23776afc792a6b4f44", bytes: 46093321, release: "v1.13.8" },
  { name: `${model}.tar.bz2`, hash: "68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6", bytes: 32885699, release: "kws-models" },
];
const digest = data => createHash("sha256").update(data).digest("hex");
const vendor = resolve(project, "plugins/platform-android/android/vendor/sherpa-onnx");

async function archive(info) {
  const path = resolve(cache, info.name);
  let data;
  try { data = await readFile(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (data) {
    if (data.length !== info.bytes || digest(data) !== info.hash) throw Error(`离线唤醒缓存校验失败：${info.name}`);
    return path;
  }
  const response = await fetch(`https://github.com/k2-fsa/sherpa-onnx/releases/download/${info.release}/${info.name}`, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw Error(`离线唤醒资源下载失败：HTTP ${response.status}`);
  const parts = []; let bytes = 0;
  for await (const part of response.body) { bytes += part.length; if (bytes > info.bytes) throw Error("离线唤醒下载大小不符"); parts.push(part); }
  data = Buffer.concat(parts);
  if (bytes !== info.bytes || digest(data) !== info.hash) throw Error(`离线唤醒下载校验失败：${info.name}`);
  await writeFile(`${path}.part`, data); await rename(`${path}.part`, path);
  return path;
}

/** 固定来源和摘要；只复制 JNI、ONNX Runtime 与 chunk-16 量化模型，不引入其他 ABI。 */
export async function prepareAndroidWake({ fixtures = false } = {}) {
  await mkdir(cache, { recursive: true });
  const sources = JSON.parse(await readFile(resolve(vendor, "sources.json"), "utf8"));
  for (const source of sources.files) if (digest(await readFile(resolve(vendor, source.file))) !== source.sha256) throw Error(`离线唤醒 Kotlin 源码校验失败：${source.file}`);
  const nativeArchive = await archive(archives[0]), modelArchive = await archive(archives[1]);
  const nativeRoot = resolve(cache, "native"), modelRoot = resolve(cache, "models");
  await mkdir(nativeRoot, { recursive: true }); await mkdir(modelRoot, { recursive: true });
  const libraries = ["libsherpa-onnx-jni.so", "libonnxruntime.so"];
  execFileSync("tar", ["-xf", nativeArchive, "-C", nativeRoot, ...libraries.map(name => `./jniLibs/arm64-v8a/${name}`)], { windowsHide: true });
  const selected = ["encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx", "decoder-epoch-13-avg-2-chunk-16-left-64.onnx", "joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx", "tokens.txt"];
  execFileSync("tar", ["-xf", modelArchive, "-C", modelRoot, ...selected.map(name => `${model}/${name}`), `${model}/en.phone`, ...(fixtures ? [`${model}/test_wavs`] : [])], { windowsHide: true });
  const assets = resolve(project, ".artifacts/android-assets/wake");
  const jni = resolve(project, ".artifacts/android-wake/jniLibs/arm64-v8a");
  const runtime = resolve(project, ".artifacts/android-assets/runtime/wake");
  await mkdir(runtime, { recursive: true });
  for (const name of ["tokens.txt", "en.phone"]) await copyFile(resolve(modelRoot, model, name), resolve(runtime, name));
  await copyFile(resolve(project, "node_modules/pinyin-pro/LICENSE"), resolve(runtime, "PINYIN-PRO-LICENSE"));
  await mkdir(assets, { recursive: true }); await mkdir(jni, { recursive: true });
  for (const name of libraries) await copyFile(resolve(nativeRoot, "jniLibs/arm64-v8a", name), resolve(jni, name));
  const fileNames = ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"];
  for (let i = 0; i < selected.length; i++) await copyFile(resolve(modelRoot, model, selected[i]), resolve(assets, fileNames[i]));
  // 默认词表必须为空；上游 createStream 会合并默认词，避免残留隐藏的固定唤醒词。
  await writeFile(resolve(assets, "empty-keywords.txt"), "\n");
  const files = [];
  for (const file of [...fileNames, "empty-keywords.txt"]) { const data = await readFile(resolve(assets, file)); files.push({ file, bytes: data.length, sha256: digest(data) }); }
  await writeFile(resolve(assets, "manifest.json"), JSON.stringify({ version: 1, runtime: sources.version, model, files }, null, 2));
  for (const name of ["LICENSE", "NOTICE.md", "ONNXRUNTIME-LICENSE", "ONNXRUNTIME-ThirdPartyNotices.txt"]) await copyFile(resolve(vendor, name), resolve(assets, name));
  if (fixtures) {
    const target = resolve(cache, "test-assets/wake-fixtures"); await mkdir(target, { recursive: true });
    for (const name of ["zh_3.wav", "zh_4.wav", "zh_5.wav", "en_0.wav", "en_1.wav", "keywords.txt"]) await copyFile(resolve(modelRoot, model, "test_wavs", name), resolve(target, name));
  }
  console.log(`离线关键词资源已校验：${files.reduce((n, f) => n + f.bytes, 0)} 字节模型/词表、${libraries.length} 个 ARM64 原生库。`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareAndroidWake({ fixtures: process.argv.includes("--fixtures") });
