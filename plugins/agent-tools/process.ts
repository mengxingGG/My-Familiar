import { spawn } from "node:child_process";
export function runProcess(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; output: string }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let output = "",
      settled = false,
      killed = false,
      truncated = false,
      deadline: ReturnType<typeof setTimeout> | undefined;
    const done = (error?: Error, code: number | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(deadline);
      signal.removeEventListener("abort", stop);
      if (error) reject(new Error("程序无法启动，请检查命令或 Node.js 安装"));
      else if (signal.aborted) reject(new Error("命令已取消"));
      else
        resolve({
          code,
          output:
            output +
            (truncated ? "\n[输出已截断]" : "") +
            (killed ? "\n[执行超时，已请求终止进程树]" : ""),
        });
    };
    const stop = () => {
      if (killed || settled) return;
      killed = true;
      if (child.pid) {
        if (process.platform === "win32") {
          const killer = spawn(
            "taskkill.exe",
            ["/pid", String(child.pid), "/t", "/f"],
            { windowsHide: true, stdio: "ignore" },
          );
          killer.on("error", () => child.kill());
          killer.on("exit", (code) => {
            if (code !== 0) child.kill();
          });
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill();
          }
        }
      }
      deadline = setTimeout(() => {
        child.kill();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        done();
      }, 5000);
    };
    const timer = setTimeout(stop, 60000),
      consume = (chunk: string) => {
        const remaining = 32000 - output.length;
        if (chunk.length > remaining) truncated = true;
        output += chunk.slice(0, remaining);
      };
    child.stdout.setEncoding("utf8").on("data", consume);
    child.stderr.setEncoding("utf8").on("data", consume);
    child.on("error", (e) => done(e));
    child.on("close", (code) => done(undefined, code));
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
}
