import { createServer, type Socket } from "node:net";
import { rm, chmod } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { bootstrapAndroid } from "./bootstrap.ts";
import { mobileApi } from "./mobile-api.ts";
import { nativeError } from "./native-errors.ts";
import type { AndroidNative } from "../../../plugins/platform-android/index.ts";
import type { MobileRequest } from "../../../packages/mobile-bridge/index.ts";

// 私有应用目录内 Unix socket；不监听网络端口、不向页面提供原生任意调用。
const [root, socketPath, nativeLibraryDir] = process.argv.slice(2);
if (!root || !socketPath || dirname(socketPath) !== root || !nativeLibraryDir || !isAbsolute(nativeLibraryDir))
  throw Error("INVALID_BOOT");
let channel: Socket | undefined;
let sequence = 0;
const pending = new Map<
  string,
  {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
function send(value: unknown) {
  if (!channel || channel.destroyed) throw Error("UNAVAILABLE");
  const text = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw Error("INVALID_INPUT");
  channel.write(text);
}
const native: AndroidNative = {
  call<T>(method: string, params = {}): Promise<T> {
    const id = String(++sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error("UNAVAILABLE"));
      }, 20000);
      pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        send({ kind: "native", id, method, params });
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        reject(Error("UNAVAILABLE"));
      }
    });
  },
};
let api: ReturnType<typeof mobileApi>;
let startup: Promise<void> | undefined;
const cleaned = rm(socketPath, { force: true });
const server = createServer((socket) => {
  if (channel && !channel.destroyed) {
    socket.destroy();
    return;
  }
  channel = socket;
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) {
      socket.destroy();
      return;
    }
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const value = JSON.parse(line);
        if (value.kind === "nativeResult") {
          const item = pending.get(value.id);
          if (item) {
            pending.delete(value.id);
            clearTimeout(item.timer);
            value.error
              ? item.reject(nativeError(value.error))
              : item.resolve(value.result);
          }
        } else if (value.kind === "request") {
          void startup!
            .then(() => api(value.request as MobileRequest))
            .then((response) =>
              send({ kind: "response", id: value.id, response }),
            )
            .catch(() => {
              try {
                send({
                  kind: "response",
                  id: value.id,
                  response: {
                    protocolVersion: 1,
                    id: value.request?.id ?? "",
                    ok: false,
                    error: { code: "UNAVAILABLE" },
                  },
                });
              } catch {}
            });
        }
      } catch {
        socket.destroy();
      }
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(Error("UNAVAILABLE"));
    }
    pending.clear();
  });
  startup ??= bootstrapAndroid(root, dirname(process.argv[1]!), native, { feishuOffice: { wasm: { assets:join(dirname(process.argv[1]!), 'feishu'),addon:join(nativeLibraryDir,'libfamiliar_workspace.so') } } }).then(
    async (kernel) => {
      api = mobileApi(kernel, native);
      await native.call("runtime.coreStatus", { state: "ready" });
    },
  );
  void startup.catch(() => native.call("runtime.coreStatus", { state: "failed" }).catch(() => {}));
});
void cleaned
  .then(() =>
    server.listen(socketPath, () => {
      void chmod(socketPath, 0o600);
    }),
  )
  .catch(() => console.error("FAMILIAR_SOCKET_FAILED"));
