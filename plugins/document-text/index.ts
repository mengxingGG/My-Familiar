import { Worker } from "node:worker_threads";
import { definePlugin } from "../../packages/contracts/index.ts";

export const PDF_MIME = "application/pdf";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const documentMime = (mime: string) => mime === PDF_MIME || mime === DOCX_MIME;
export const documentErrors = ["DOCUMENT_EMPTY", "DOCUMENT_PASSWORD", "DOCUMENT_TIMEOUT", "INVALID_DOCUMENT", "LIMIT", "CANCELLED", "BUSY"];

declare module "../../packages/kernel/index.ts" {
  interface Services {
    "document.text": { extract(data: Uint8Array, mime: string, signal?: AbortSignal): Promise<string> };
  }
}

/** 解析器独立于宿主；每次使用可终止的工作线程，不阻塞聊天、停止按钮和宠物。 */
export const createDocumentText = (workerPath: string, timeoutMs = 20000) => definePlugin({
  manifest: { manifestVersion: 1, id: "familiar.document-text", version: "0.3.0", provides: ["document.text"], requires: [] },
  start(ctx) {
    let active: { worker: Worker; cancel(): void } | undefined;
    let disposed = false;
    ctx.effect(async () => { disposed = true; const job = active; job?.cancel(); await job?.worker.terminate(); });
    ctx.provide("document.text", {
      async extract(data, mime, signal) {
        if (disposed || signal?.aborted) throw Error("CANCELLED");
        if (!documentMime(mime) || !data.length) throw Error("INVALID_DOCUMENT");
        if (data.length > 12 * 1024 * 1024) throw Error("LIMIT");
        if (active) throw Error("BUSY");
        const bytes = Uint8Array.from(data);
        const worker = new Worker(workerPath, { workerData: { data: bytes, mime }, transferList: [bytes.buffer],
          resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32 }, stdout: true, stderr: true });
        // 第三方解析日志可能包含文档内容，只丢弃输出，不转发到公共日志。
        worker.stdout?.resume(); worker.stderr?.resume();
        try {
          return await new Promise<string>((resolve, reject) => {
            let settled = false;
            const finish = (error?: string, text?: string) => {
              if (settled) return; settled = true;
              clearTimeout(timer); signal?.removeEventListener("abort", abort);
              error ? reject(Error(error)) : resolve(text!);
            };
            const abort = () => finish("CANCELLED");
            const timer = setTimeout(() => finish("DOCUMENT_TIMEOUT"), timeoutMs);
            active = { worker, cancel: abort };
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
            worker.once("message", (message) => {
              if (message?.ok && typeof message.text === "string" && Buffer.byteLength(message.text) <= 400000) finish(undefined, message.text);
              else finish(documentErrors.includes(message?.code) ? message.code : "INVALID_DOCUMENT");
            });
            worker.once("error", () => finish("INVALID_DOCUMENT"));
            worker.once("exit", () => finish("INVALID_DOCUMENT"));
          });
        } finally {
          await worker.terminate();
          active = undefined;
        }
      },
    });
  },
});
