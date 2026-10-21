import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { validateOfficeArgs } from "../feishu-cli/validation.ts";
import { redact } from "../cli-dependencies/index.ts";

export interface ManagedFeishuRequest {
  args: string[];
  appId: string;
  identity: "user" | "bot";
  token?: string;
  stdin?: string;
}
export interface ManagedFeishuResult {
  code: number | null;
  output: string;
  errors: string;
  /** 超时、取消、崩溃或输出截断都不能证明外部写入没有发生。 */
  interrupted?: "cancelled" | "timeout" | "output-limit" | "process-failed";
}
export interface ManagedFeishuOptions {
  executable: string;
  workspace: string;
  configuration: string;
  temporary: string;
  timeoutMs?: number;
  launch?: (executable: string, options: Parameters<typeof spawn>[2]) => ChildProcessWithoutNullStreams;
}

/** 两种执行器共享参数、身份和 UTF-8 信封边界；排队后不再读取调用方对象。 */
export function managedFeishuPayload(input: ManagedFeishuRequest, workspace: string) {
  const args = validateOfficeArgs(input.args);
  if (!(input.appId === "" || /^cli_[0-9a-fA-F]{16}$/.test(input.appId)) || !["user", "bot"].includes(input.identity) ||
      input.token !== undefined && (typeof input.token !== "string" || input.token.length > 16384 || /[\s\x00-\x1f]/.test(input.token)) ||
      input.stdin !== undefined && (typeof input.stdin !== "string" || input.stdin.length > 64000)) throw Error("INVALID_INPUT");
  const request = { args, appId: input.appId, identity: input.identity, token: input.token ?? "", stdin: input.stdin ?? "", workspace };
  const payload = JSON.stringify(request);
  if (Buffer.byteLength(payload) > 131072) throw Error("INVALID_INPUT");
  return { request, payload };
}

/** 路径只来自可信宿主装配；不接受网页提供的程序、环境或任意 shell 命令。 */
export function managedFeishuRunner(options: ManagedFeishuOptions) {
  if (![options.executable, options.workspace, options.configuration, options.temporary].every(isAbsolute)) throw Error("INVALID_RUNTIME_PATH");
  let queue = Promise.resolve();
  return (input: ManagedFeishuRequest, signal: AbortSignal): Promise<ManagedFeishuResult> => {
    const { request, payload } = managedFeishuPayload(input, options.workspace);
    const task = queue.then(async () => {
      signal.throwIfAborted();
      await Promise.all([options.workspace, options.configuration, options.temporary].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
      signal.throwIfAborted();
      const environment = { ...process.env };
      for (const key of Object.keys(environment)) if (/^(?:LARK_|LARKSUITE_|FEISHU_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|GODEBUG$)/i.test(key)) delete environment[key];
      Object.assign(environment, { LARKSUITE_CLI_CONFIG_DIR: options.configuration, TMPDIR: options.temporary, NO_COLOR: "1" });
      return new Promise<ManagedFeishuResult>((resolve, reject) => {
        let child: ChildProcessWithoutNullStreams;
        try {
          const config = { cwd: options.workspace, env: environment, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };
          child = options.launch ? options.launch(options.executable, config) : spawn(options.executable, [], config);
        } catch { reject(Error("FEISHU_RUNTIME_UNAVAILABLE")); return; }
        let output = "", errors = "", outputBytes = 0, errorBytes = 0;
        let interrupted: ManagedFeishuResult["interrupted"], force: ReturnType<typeof setTimeout> | undefined, settled = false;
        const clean = (text: string) => redact(request.token ? text.split(request.token).join("[已隐藏]") : text);
        const stop = (reason: NonNullable<typeof interrupted>) => {
          if (settled || interrupted) return;
          interrupted = reason;
          child.stdin.destroy();
          child.kill("SIGTERM");
          force = setTimeout(() => child.kill("SIGKILL"), 500); force.unref();
        };
        const abort = () => stop("cancelled");
        const timer = setTimeout(() => stop("timeout"), options.timeoutMs ?? 30000); timer.unref();
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        child.stdout.setEncoding("utf8").on("data", (value: string) => { outputBytes += Buffer.byteLength(value); if (outputBytes > 1024 * 1024) { stop("output-limit"); return; } output += value; });
        child.stderr.setEncoding("utf8").on("data", (value: string) => { errorBytes += Buffer.byteLength(value); if (errorBytes > 64000) { stop("output-limit"); return; } errors += value; });
        child.stdin.on("error", () => { if (!interrupted) stop("process-failed"); });
        child.on("error", () => { interrupted ??= "process-failed"; });
        child.once("close", (code, exitSignal) => {
          settled = true; clearTimeout(timer); clearTimeout(force); signal.removeEventListener("abort", abort);
          // Go 的 panic/fatal 默认也可能退出 2；此时不能当作普通参数失败，外部写入结果仍未知。
          const goFatal = code === 2 && /^(?:(?:fatal error|panic):[ \t]|SIG(?:ABRT|BUS|FPE|ILL|QUIT|SEGV|SYS|TRAP):[ \t])/m.test(errors);
          if (exitSignal || code === null || code >= 128 || goFatal) interrupted ??= "process-failed";
          resolve({ code, output: clean(output), errors: clean(errors), ...(interrupted ? { interrupted } : {}) });
        });
        if (!interrupted) child.stdin.end(payload);
      });
    });
    queue = task.then(() => {}, () => {});
    return task;
  };
}
