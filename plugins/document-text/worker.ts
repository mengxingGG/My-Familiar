import { parentPort, workerData } from "node:worker_threads";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fromBufferPromise } from "yauzl";
import mammoth from "mammoth";
import DOMMatrix from "@thednp/dommatrix";

const MAX_TEXT = 400000;
const checkText = (text: string) => { if (Buffer.byteLength(text) > MAX_TEXT) throw Error("LIMIT"); return text; };

async function docx(data: Buffer): Promise<string> {
  // 先流式校验解压后的真实大小，再交给既有 Word 解析器；不向磁盘解压。
  const zip = await fromBufferPromise(data, { lazyEntries: true, validateEntrySizes: true });
  let total = 0;
  const names = new Set<string>();
  try {
    if (zip.entryCount > 1024) throw Error("LIMIT");
    for await (const entry of zip.eachEntry()) {
      if (entry.isEncrypted()) throw Error("DOCUMENT_PASSWORD");
      if (entry.uncompressedSize > 16 * 1024 * 1024 || names.has(entry.fileName)) throw Error("LIMIT");
      names.add(entry.fileName);
      const stream = await zip.openReadStreamPromise(entry);
      let bytes = 0;
      for await (const chunk of stream) {
        bytes += chunk.length; total += chunk.length;
        if (bytes > 16 * 1024 * 1024 || total > 48 * 1024 * 1024) throw Error("LIMIT");
      }
    }
    if (!names.has("[Content_Types].xml")) throw Error("INVALID_DOCUMENT");
  } finally { zip.close(); }
  // extractRawText 不执行 HTML/宏，也不启用 externalFileAccess。
  const text = checkText((await mammoth.extractRawText({ buffer: data })).value);
  if (!text.trim()) throw Error("DOCUMENT_EMPTY");
  return text;
}

async function pdf(data: Buffer): Promise<string> {
  if (!data.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw Error("INVALID_DOCUMENT");
  // PDF.js 的模块初始化需要矩阵类；文本提取不依赖原生 Canvas 或任何图片渲染。
  Object.assign(globalThis, { DOMMatrix });
  const root = join(__dirname, "pdfjs");
  const pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs") = await import(pathToFileURL(join(root, "pdf.mjs")).href);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(join(root, "pdf.worker.mjs")).href;
  // PDF.js 6 已移除 eval 编译器及 isEvalSupported；继续只提取文字，不启用图像渲染。
  const task = pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: false,
    stopAtErrors: true, useWorkerFetch: false, cMapUrl: join(root, "cmaps") + "/", cMapPacked: true,
    standardFontDataUrl: join(root, "standard_fonts") + "/", wasmUrl: join(root, "wasm") + "/",
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false, disableFontFace: true, verbosity: 0 });
  try {
    const document = await task.promise;
    if (document.numPages > 100) throw Error("LIMIT");
    const pages: string[] = []; let size = 0, hasText = false;
    for (let n = 1; n <= document.numPages; n++) {
      const page = await document.getPage(n);
      const content = await page.getTextContent();
      const body = content.items.map(v => "str" in v ? v.str + (v.hasEOL ? "\n" : " ") : "").join("").trim();
      hasText ||= !!body;
      const text = `[第 ${n} 页]\n${body}`;
      size += Buffer.byteLength(text) + 2; if (size > MAX_TEXT) throw Error("LIMIT");
      pages.push(text); page.cleanup();
    }
    if (!hasText) throw Error("DOCUMENT_EMPTY");
    return pages.join("\n\n");
  } finally { await task.destroy(); }
}

void (async () => {
  try {
    const data = Buffer.from(workerData.data);
    if (!data.length || data.length > 12 * 1024 * 1024) throw Error("LIMIT");
    const text = workerData.mime === "application/pdf" ? await pdf(data) : await docx(data);
    parentPort!.postMessage({ ok: true, text });
  } catch (error) {
    const code = error instanceof Error && error.name === "PasswordException" ? "DOCUMENT_PASSWORD"
      : error instanceof Error && ["LIMIT", "DOCUMENT_EMPTY", "DOCUMENT_PASSWORD"].includes(error.message) ? error.message : "INVALID_DOCUMENT";
    parentPort!.postMessage({ ok: false, code });
  }
})();
