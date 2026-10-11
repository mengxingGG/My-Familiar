import {
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  nativeImage,
  screen,
} from "electron";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
  definePlugin,
  type Attachment,
} from "../../packages/contracts/index.ts";
import { MAX_ATTACHMENT_BYTES } from "../media-assets/index.ts";

export const platformMedia = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.platform-media",
    version: "0.3.0",
    provides: ["platform.media"],
    requires: ["media.assets"],
    permissions: ["desktop.capture", "files.picker"],
  },
  start(ctx) {
    const assets = ctx.use("media.assets");
    let capturing = Promise.resolve();
    const addImage = (
      name: string,
      data: Uint8Array,
      source: Attachment["source"],
    ) => {
      const image = nativeImage.createFromBuffer(Buffer.from(data));
      if (image.isEmpty()) throw new Error("图片无法解码");
      const { width, height } = image.getSize();
      if (width * height > 64_000_000)
        throw new Error("图片尺寸过大，请缩小后添加");
      const resized =
        Math.max(width, height) > 2560
          ? image.resize(width > height ? { width: 2560 } : { height: 2560 })
          : image;
      return assets.add(name, "image/png", resized.toPNG(), source);
    };
    ctx.provide("platform.media", {
      displays: () => [
        { id: "cursor", name: "鼠标所在的显示器" },
        ...screen
          .getAllDisplays()
          .map((d, i) => ({
            id: String(d.id),
            name:
              d.label || `显示器 ${i + 1}（${d.size.width}×${d.size.height}）`,
          })),
      ],
      async choose() {
        ctx.require("files.picker");
        const result = await dialog.showOpenDialog({
          title: "给宠物添加图片或文件",
          properties: ["openFile", "multiSelections"],
          filters: [
            {
              name: "图片与文档",
              extensions: [
                "png",
                "jpg",
                "jpeg",
                "webp",
                "gif",
                "bmp",
                "txt",
                "md",
                "csv",
                "json",
                "log",
                "pdf",
                "docx",
                "js",
                "ts",
                "py",
                "yaml",
                "yml",
              ],
            },
            { name: "所有文件", extensions: ["*"] },
          ],
        });
        if (result.canceled) return [];
        if (result.filePaths.length > 8)
          throw new Error("每次最多选择 8 个附件");
        const files: Attachment[] = [];
        for (const path of result.filePaths) {
          if ((await stat(path)).size > MAX_ATTACHMENT_BYTES)
            throw new Error(`${basename(path)} 超过 12 MB`);
          const bytes = await readFile(path),
            ext = extname(path).toLowerCase();
          if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"].includes(ext))
            files.push(await addImage(basename(path), bytes, "file"));
          else {
            let text: string;
            if (ext === ".docx") {
              const mammoth = await import("mammoth");
              text = (await mammoth.extractRawText({ buffer: bytes })).value;
            } else if (ext === ".pdf") {
              const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
              const doc = await pdfjs.getDocument({
                data: new Uint8Array(bytes),
                isEvalSupported: false,
                useSystemFonts: false,
              }).promise;
              try {
                if (doc.numPages > 100)
                  throw new Error("PDF 超过 100 页，请拆分后添加");
                const pages: string[] = [];
                for (let n = 1; n <= doc.numPages; n++) {
                  const page = await doc.getPage(n),
                    content = await page.getTextContent();
                  pages.push(
                    `[第 ${n} 页]\n` +
                      content.items
                        .map((v) => ("str" in v ? v.str : ""))
                        .join(" "),
                  );
                  if (pages.join("").length > 200000)
                    throw new Error("PDF 文字过多，请拆分后添加");
                }
                text = pages.join("\n\n");
                if (!text.replace(/\[第 \d+ 页\]/g, "").trim())
                  throw new Error(
                    "此 PDF 没有可提取文字，请将需要的页面作为图片添加",
                  );
              } finally {
                await doc.destroy();
              }
            } else {
              if (bytes.includes(0))
                throw new Error(
                  `${basename(path)} 不是支持的文本文件，请转换为 UTF-8 文本或图片`,
                );
              text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            }
            files.push(
              await assets.add(
                basename(path),
                "text/plain",
                Buffer.from(text),
                "file",
              ),
            );
          }
        }
        return files;
      },
      async paste() {
        ctx.require("files.picker");
        for (const item of await clipboard.read()) {
          const type = item.types.find((t) => /^image\//.test(t));
          if (!type) continue;
          const blob = await item.getType(type);
          if (!(blob instanceof Blob) || blob.size > MAX_ATTACHMENT_BYTES)
            throw new Error("剪贴板图片超过 12 MB");
          return addImage(
            "粘贴的图片.png",
            new Uint8Array(await blob.arrayBuffer()),
            "clipboard",
          );
        }
        throw new Error("剪贴板没有图片");
      },
      capture(displayId) {
        ctx.require("desktop.capture");
        const operation = capturing.then(async () => {
          const d =
            displayId === "cursor"
              ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
              : screen.getAllDisplays().find((v) => String(v.id) === displayId);
          if (!d) throw new Error("选择的显示器已断开，请重新选择");
          const windows = BrowserWindow.getAllWindows().filter(
            (w) => !w.isDestroyed(),
          );
          for (const w of windows) w.setContentProtection(true);
          try {
            // 单次采集，不创建录屏流；每个请求使用自己的不可变附件。
            const sources = await desktopCapturer.getSources({
              types: ["screen"],
              thumbnailSize: {
                width: Math.round(d.size.width * d.scaleFactor),
                height: Math.round(d.size.height * d.scaleFactor),
              },
            });
            const source = sources.find((v) => v.display_id === String(d.id));
            if (!source || source.thumbnail.isEmpty())
              throw new Error("当前屏幕无法截图，可能已锁屏或受保护");
            return await addImage(
              `屏幕-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
              source.thumbnail.toPNG(),
              "screen",
            );
          } finally {
            for (const w of windows)
              if (!w.isDestroyed()) w.setContentProtection(false);
          }
        });
        capturing = operation.then(
          () => {},
          () => {},
        );
        return operation;
      },
    });
    ctx.effect(() => capturing);
  },
});
