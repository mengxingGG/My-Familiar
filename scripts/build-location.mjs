import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
export async function buildLocation() {
  if (process.platform !== "win32") return;
  const framework = join(
    process.env.WINDIR || "C:/Windows",
    "Microsoft.NET/Framework64/v4.0.30319",
  );
  const metadataRoot = join(
    process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)",
    "Windows Kits/10/UnionMetadata",
  );
  const versions = (await readdir(metadataRoot))
    .filter((v) => /^10\./.test(v))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  if (!versions.length) throw new Error("编译定位组件需要 Windows 10/11 SDK");
  const metadata = join(metadataRoot, versions[0], "Windows.winmd");
  await mkdir("dist/native", { recursive: true });
  const references = [
    "System.dll",
    "System.Core.dll",
    "System.Windows.Forms.dll",
    "System.Drawing.dll",
    "System.Web.Extensions.dll",
    "System.Runtime.WindowsRuntime.dll",
    "System.Runtime.InteropServices.WindowsRuntime.dll",
  ];
  const facadeRoot = join(
    process.env.WINDIR || "C:/Windows",
    "Microsoft.NET/assembly/GAC_MSIL/System.Runtime",
  );
  const facade = join(
    facadeRoot,
    (await readdir(facadeRoot))[0],
    "System.Runtime.dll",
  );
  try {
    await promisify(execFile)(
      join(framework, "csc.exe"),
      [
        "/nologo",
        "/reference:" + facade,
        "/target:exe",
        "/out:" + resolve("dist/native/Familiar.Location.exe"),
        ...references.map((p) => "/reference:" + join(framework, p)),
        "/reference:" + metadata,
        resolve("plugins/location-windows/Location.cs"),
      ],
      { windowsHide: true },
    );
  } catch (e) {
    throw new Error("定位组件编译失败：" + (e.stdout || e.message));
  }
}
