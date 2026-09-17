import { createHash, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
export const PROTOCOL_VERSION = 1;
export const MAX_PACKET = 2 * 1024 * 1024;
export function endpoint(directory: string) {
  const id = createHash("sha256")
    .update(directory + (process.env.SESSIONNAME ?? ""))
    .digest("hex")
    .slice(0, 24);
  return {
    address:
      process.platform === "win32"
        ? `\\\\.\\pipe\\familiar-${id}`
        : join(directory, "runtime.sock"),
    discovery: join(directory, `connection-${id}.json`),
  };
}
export async function rpc(
  directory: string,
  method: string,
  params?: unknown,
): Promise<any> {
  const config = endpoint(directory);
  let token: string;
  try {
    token = JSON.parse(await readFile(config.discovery, "utf8")).token;
  } catch {
    throw new Error("宠物未运行，请先启动宠物");
  }
  return new Promise((resolve, reject) => {
    const socket = connect(config.address);
    let buffer = "",
      settled = false;
    const id = randomUUID();
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(
      () => finish(new Error("宠物响应超时")),
      method === "provider.test" ? 25000 : 10000,
    );
    socket.setEncoding("utf8");
    socket.on("connect", () =>
      socket.write(
        JSON.stringify({
          version: PROTOCOL_VERSION,
          id,
          token,
          method,
          params,
        }) + "\n",
      ),
    );
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_PACKET) return finish(new Error("响应过大"));
      if (!buffer.includes("\n")) return;
      try {
        const value = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        if (value.id !== id || value.version !== PROTOCOL_VERSION)
          throw new Error("协议响应不匹配");
        value.ok
          ? finish(undefined, value.result)
          : finish(new Error(value.error ?? "请求失败"));
      } catch (e) {
        finish(e as Error);
      }
    });
    socket.on("error", () => finish(new Error("宠物未连接，请重新启动宠物")));
    socket.on("close", () => {
      if (!settled) finish(new Error("宠物连接已关闭"));
    });
  });
}
