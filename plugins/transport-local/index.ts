import { createServer, type Socket } from "node:net";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { definePlugin } from "../../packages/contracts/index.ts";
import { companionCommands } from "../companion-controls/index.ts";
import {
  endpoint,
  MAX_PACKET,
  PROTOCOL_VERSION,
  rpc,
} from "../../packages/protocol/index.ts";
export function transportServer(directory: string) {
  return definePlugin({
    manifest: {
      manifestVersion: 1,
      id: "familiar.transport-server",
      version: "0.1.0",
      provides: [],
      requires: ["commands"],
      permissions: ["ipc.local"],
    },
    async start(ctx) {
      ctx.require("ipc.local");
      const commands = ctx.use("commands"),
        config = endpoint(directory),
        token = randomBytes(32).toString("hex");
      const sockets = new Set<Socket>();
      const replies = new Map<
        string,
        { signature: string; promise: Promise<unknown> }
      >();
      const server = createServer((socket) => {
        if (sockets.size >= 32) {
          socket.destroy();
          return;
        }
        sockets.add(socket);
        socket.setEncoding("utf8");
        socket.setTimeout(125000, () => socket.destroy());
        let buffer = "",
          received = false;
        socket.on("error", () => {});
        socket.on("close", () => sockets.delete(socket));
        socket.on("data", async (chunk) => {
          if (received) return;
          buffer += chunk;
          if (buffer.length > MAX_PACKET) {
            socket.destroy();
            return;
          }
          if (!buffer.includes("\n")) return;
          received = true;
          let id = "";
          try {
            const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
            id = request.id;
            if (
              request.version !== PROTOCOL_VERSION ||
              typeof id !== "string" ||
              id.length > 100 ||
              typeof request.token !== "string"
            )
              throw new Error("请求无效");
            const a = Buffer.from(request.token),
              b = Buffer.from(token);
            if (a.length !== b.length || !timingSafeEqual(a, b))
              throw new Error("连接认证失败");
            if (
              ![
                ...companionCommands,
                "runtime.status",
                "settings.apply",
                "provider.test",
                "provider.models",
                "provider.inspect",
                "secret.set",
                "pet.reset",
                "pet.show",
                "pet.sleep",
                "chat.open",
                "chat.clear",
                "runtime.stop",
                "autostart.set",
              ].includes(request.method)
            )
              throw new Error("命令不允许");
            const signature = createHash("sha256")
              .update(JSON.stringify([request.method, request.params]))
              .digest("hex");
            let cached = replies.get(id);
            if (cached && cached.signature !== signature)
              throw new Error("重复请求参数不一致");
            if (!cached) {
              cached = {
                signature,
                promise: commands.call(request.method, request.params),
              };
              replies.set(id, cached);
              if (replies.size > 256)
                replies.delete(replies.keys().next().value!);
            }
            const result = await cached.promise;
            socket.end(
              JSON.stringify({ version: 1, id, ok: true, result }) + "\n",
            );
          } catch (e) {
            socket.end(
              JSON.stringify({
                version: 1,
                id,
                ok: false,
                error: e instanceof Error ? e.message : "请求失败",
              }) + "\n",
            );
          }
        });
      });
      ctx.effect(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await unlink(config.discovery).catch(() => {});
      });
      await mkdir(directory, { recursive: true });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.address, () => {
          server.off("error", reject);
          resolve();
        });
      });
      server.on("error", (e) => ctx.report(e));
      await writeFile(config.discovery, JSON.stringify({ version: 1, token }), {
        mode: 0o600,
      });
    },
  });
}
export function transportClient(directory: string) {
  return definePlugin({
    manifest: {
      manifestVersion: 1,
      id: "familiar.transport-client",
      version: "0.1.0",
      provides: ["transport.client"],
      requires: [],
    },
    start(ctx) {
      ctx.provide("transport.client", {
        call: (name, params) => rpc(directory, name, params),
      });
    },
  });
}
