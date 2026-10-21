import { join, resolve } from "node:path";
import { readFile, stat, rm, mkdir, writeFile, realpath } from "node:fs/promises";
import { definePlugin, type Attachment } from "../../packages/contracts/index.ts";
import type { MobileMediaPreview } from "../../packages/mobile-contracts/index.ts";
import { MAX_ATTACHMENT_BYTES } from "../media-assets/index.ts";
import { documentMime } from "../document-text/index.ts";

declare module "../../packages/kernel/index.ts" {
  interface Services {
    "android.media": {
      import(tokens: string[]): Promise<Attachment[]>;
      preview(id: string): Promise<MobileMediaPreview>;
    };
  }
}
export const publicAttachment = ({ id, name, kind, mimeType, bytes }: Attachment) => ({ id, name, kind, mimeType, bytes });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const createAndroidMedia = (root: string) => definePlugin({
  manifest: { manifestVersion: 1, id: "familiar.media-android", version: "0.3.0", provides: ["platform.media", "android.media"], requires: ["media.assets", "document.text"], permissions: ["storage.app"] },
  start(ctx) {
    ctx.require("storage.app");
    const assets = ctx.use("media.assets");
    const inbox = resolve(root, "media-inbox"), previews = resolve(root, "media-previews");
    const unavailable = async (): Promise<never> => { throw Error("请从聊天界面的系统文件选择器添加附件"); };
    ctx.provide("platform.media", { choose: unavailable, paste: unavailable, capture: unavailable, displays: () => [] });
    let importing = false;
    ctx.provide("android.media", {
      async import(tokens) {
        if (!Array.isArray(tokens) || !tokens.length || tokens.length > 8 || !tokens.every(t => typeof t === "string" && uuid.test(t)) || new Set(tokens).size !== tokens.length) throw Error("INVALID_INPUT");
        if (importing) throw Error("BUSY");
        importing = true;
        const signal = AbortSignal.timeout(22000);
        const results: Attachment[] = [];
        try {
        for (const token of tokens) {
          const directory = join(inbox, token);
          try {
            // 令牌不能指向其他私有文件或链接；导入路径从不来自 WebView。
            const base = await realpath(directory);
            if (base !== join(await realpath(inbox), token)) throw Error("INVALID_INPUT");
            const checked = async (name: string, limit: number) => {
              const path = join(base, name);
              if (await realpath(path) !== path || (await stat(path)).size > limit) throw Error("INVALID_INPUT");
              return readFile(path);
            };
            const meta = JSON.parse((await checked("meta.json", 4096)).toString("utf8"));
            if (typeof meta.name !== "string" || typeof meta.mimeType !== "string") throw Error("INVALID_INPUT");
            let data = await checked("data", MAX_ATTACHMENT_BYTES);
            if (signal.aborted) throw Error("DOCUMENT_TIMEOUT");
            if (documentMime(meta.mimeType)) {
              try { data = Buffer.from(await ctx.use("document.text").extract(data, meta.mimeType, signal)); }
              catch (error) { if (signal.aborted) throw Error("DOCUMENT_TIMEOUT"); throw error; }
              meta.mimeType = "text/plain";
              // 原文件名保留，明确标注进入模型的是提取文字。
              meta.name = meta.name.slice(0, 150) + "（提取文字）";
            }
            if (meta.mimeType === "text/plain") {
              if (data.includes(0)) throw Error("INVALID_INPUT");
              try { new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { throw Error("INVALID_INPUT"); }
            }
            if (meta.source !== undefined && !["file", "screen", "clipboard"].includes(meta.source)) throw Error("INVALID_INPUT");
            if (meta.source === "clipboard" && !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(meta.mimeType)) throw Error("INVALID_INPUT");
            const attachment = await assets.add(meta.name, meta.mimeType, data, meta.source ?? "file");
            try {
              const preview = await checked("preview.jpg", 750000);
              await mkdir(previews, { recursive: true });
              // 系统生成的缩略图与原件分离；模型始终读取媒体库中的完整原件。
              await writeFile(join(previews, `${attachment.id}.jpg`), preview, { mode: 0o600 });
            } catch { /* 缩略图失败不丢弃可发送的原件。 */ }
            results.push(attachment);
          } finally {
            // 只删除此前校验为 UUID 的本应用暂存目录。
            await rm(directory, { recursive: true, force: true }).catch(() => {});
          }
        }
        return results;
        } finally {
          importing = false;
          // 中途解析失败也清除本次选择尚未处理的令牌，不留下文档暂存。
          await Promise.all(tokens.map(token => rm(join(inbox, token), {recursive:true, force:true}).catch(() => {})));
        }
      },
      async preview(id) {
        const result = await assets.preview(id);
        const view: MobileMediaPreview = { ...result, attachment: publicAttachment(result.attachment) };
        if (!view.dataUrl && result.attachment.kind === "image") {
          try {
            const path = join(previews, `${id}.jpg`);
            if ((await stat(path)).size <= 750000) view.dataUrl = `data:image/jpeg;base64,${(await readFile(path)).toString("base64")}`;
          } catch { /* 原件仍可用；UI 显示无缩略图。 */ }
        }
        return view;
      },
    });
  },
});
