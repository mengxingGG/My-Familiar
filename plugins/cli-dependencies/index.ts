import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const dependencies = {
  feishu: {
    version: "1.0.96",
    executable: "lark-cli.exe",
    repo: "larksuite/cli",
    asset: (arch: string) => `lark-cli-1.0.96-windows-${arch}.zip`,
    hashes: {
      amd64: "efd31a894c8b427d209727cb9e140a8b62c7955f404a6e7004e623fc687d42fa",
      arm64: "8ee926bb77f3718dd6d3c657de1cc3ad970180ed74d2f7ee00d3e9247f362dbb",
    },
  },
  github: {
    version: "2.101.0",
    executable: "gh.exe",
    repo: "cli/cli",
    asset: (arch: string) => `gh_2.101.0_windows_${arch}.zip`,
    hashes: {
      amd64: "bc6c814367b193cd8e713611d61e36013c0ef843b8f516458fe3eda039192794",
      arm64: "e6cbb2d4afdad3e70f3d38b8d1ebaa3a0870a897cfc0e4cf569826710b96b4fd",
    },
  },
};
export const exists = async (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
export function redact(text: string) {
  return text
    .replace(
      /("(?:app_?secret|access_?token|refresh_?token|tenant_?access_?token|user_?access_?token|oauth_token|token)"\s*:\s*")[^"]*(")/gi,
      "$1[已隐藏]$2",
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g,
      "[已隐藏]",
    )
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}
export function cliEnvironment(
  config: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(GH_|GITHUB_|LARK_|LARKSUITE_|FEISHU_|OPENCLAW_|HERMES_)/i.test(key))
      delete env[key];
  return { ...env, ...config, NO_COLOR: "1", GH_PROMPT_DISABLED: "1" };
}
export function startCli(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    stdin?: string;
    keepStdin?: boolean;
    timeout?: number;
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
  },
) {
  options.signal.throwIfAborted();
  const child: ChildProcessWithoutNullStreams = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  let output = "",
    errors = "",
    force: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    child.stdin.end();
    force ??= setTimeout(() => child.kill(), 3000);
  };
  const done = new Promise<{
    code: number | null;
    output: string;
    errors: string;
  }>((resolve, reject) => {
    const timer =
      options.timeout === 0
        ? undefined
        : setTimeout(stop, options.timeout ?? 60000);
    child.stdout.setEncoding("utf8").on("data", (text: string) => {
      output = (output + text).slice(-128000);
      options.onStdout?.(text);
    });
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      errors = (errors + text).slice(-32000);
      options.onStderr?.(text);
    });
    child.stdin.on("error", () => {});
    child.on("error", () => reject(new Error("CLI 无法启动，请先安装依赖")));
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(force);
      options.signal.removeEventListener("abort", stop);
      if (options.signal.aborted) reject(new Error("操作已取消"));
      else resolve({ code, output, errors });
    });
    options.signal.addEventListener("abort", stop, { once: true });
    if (options.stdin !== undefined) child.stdin.write(options.stdin);
    if (!options.keepStdin) child.stdin.end();
  });
  return { child, done, stop };
}
export async function installDependency(
  kind: keyof typeof dependencies,
  root: string,
  signal: AbortSignal,
  progress: (message: string) => void,
) {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch))
    throw new Error("自动安装当前支持 Windows x64 / ARM64");
  const spec = dependencies[kind],
    arch = process.arch === "arm64" ? "arm64" : "amd64";
  await mkdir(root, { recursive: true });
  const filename = spec.asset(arch),
    archive = join(root, filename),
    pending = join(root, spec.executable + ".download");
  const url = `https://github.com/${spec.repo}/releases/download/v${spec.version}/${filename}`;
  progress(`正在下载官方 ${spec.executable} v${spec.version}…\n`);
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(600000)]),
  });
  if (!response.ok || !response.body)
    throw new Error(`依赖下载失败（HTTP ${response.status}），可以稍后重试`);
  const chunks: Uint8Array[] = [];
  let length = 0,
    reported = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    length += chunk.length;
    if (length > 180 * 1024 * 1024) throw new Error("下载文件超过预期大小");
    chunks.push(chunk);
    if (length - reported >= 2 * 1024 * 1024) {
      reported = length;
      progress(`已下载 ${Math.round(length / 1024 / 1024)} MB\n`);
    }
  }
  const data = Buffer.concat(chunks);
  if (createHash("sha256").update(data).digest("hex") !== spec.hashes[arch])
    throw new Error("依赖校验失败，未安装；请检查网络后重试");
  await writeFile(archive, data);
  progress("校验通过，正在安装到宠物目录…");
  try {
    // 只提取指定可执行文件与许可证，不按 ZIP 内的路径写文件。
    const script =
      "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead($env:FAMILIAR_CLI_ARCHIVE); try { $entries=@($zip.Entries | Where-Object { $_.Name -eq $env:FAMILIAR_CLI_EXE }); if ($entries.Count -ne 1) { throw 'Invalid executable entry' }; [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0],$env:FAMILIAR_CLI_PENDING,$true); $license=@($zip.Entries | Where-Object { $_.Name -match '^LICENSE(\\.txt)?$' }); if ($license.Count -gt 0) { [IO.Compression.ZipFileExtensions]::ExtractToFile($license[0],$env:FAMILIAR_CLI_LICENSE,$true) } } finally { $zip.Dispose() }";
    const result = await startCli(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        cwd: root,
        signal,
        env: {
          ...process.env,
          FAMILIAR_CLI_ARCHIVE: archive,
          FAMILIAR_CLI_EXE: spec.executable,
          FAMILIAR_CLI_PENDING: pending,
          FAMILIAR_CLI_LICENSE: join(root, "LICENSE.txt"),
        },
      },
    ).done;
    if (result.code !== 0) throw new Error("依赖解压失败，未替换当前程序");
    signal.throwIfAborted();
    await rename(pending, join(root, spec.executable));
    progress(`已安装 ${spec.executable} v${spec.version}`);
  } finally {
    await unlink(archive).catch(() => {});
    await unlink(pending).catch(() => {});
  }
}
