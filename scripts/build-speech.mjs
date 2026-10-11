import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
export async function buildSpeech() {
  if (process.platform !== "win32") return;
  const framework = join(
    process.env.WINDIR || "C:/Windows",
    "Microsoft.NET/Framework64/v4.0.30319",
  );
  const speechRoot = join(
    process.env.WINDIR || "C:/Windows",
    "Microsoft.NET/assembly/GAC_MSIL/System.Speech",
  );
  const version = (await readdir(speechRoot))[0];
  await mkdir("dist/native", { recursive: true });
  try {
    await promisify(execFile)(
      join(framework, "csc.exe"),
      [
        "/nologo",
        "/target:exe",
        "/out:" + resolve("dist/native/Familiar.Speech.exe"),
        "/reference:" + join(speechRoot, version, "System.Speech.dll"),
        ...["System.dll", "System.Core.dll", "System.Web.Extensions.dll"].map(
          (v) => "/reference:" + join(framework, v),
        ),
        resolve("plugins/voice-windows/Speech.cs"),
      ],
      { windowsHide: true },
    );
  } catch (e) {
    throw new Error("语音组件编译失败：" + (e.stdout || e.message));
  }
}
