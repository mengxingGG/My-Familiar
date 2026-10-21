import test from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { Kernel } from "../packages/kernel/index.ts";
import { createDocumentText, PDF_MIME, DOCX_MIME } from "../plugins/document-text/index.ts";
// @ts-expect-error 测试文档生成器为同目录 Node 脚本。
import { pdf, docx } from "./fixtures/documents.mjs";
// @ts-expect-error 工作线程与正式包使用同一构建入口。
import { buildDocumentText } from "../scripts/build-document-text.mjs";

test("共享文档解析：中文 PDF、DOCX 表格，空页/损坏/超限拒绝且无静默截断", async () => {
  const root = await mkdtemp(resolve(".artifacts/documents-test-"));
  await buildDocumentText(root);
  const kernel = new Kernel(); kernel.install(createDocumentText(join(root,"document-worker.cjs"))); await kernel.startAll();
  const parser = kernel.resolve("document.text");
  try {
    assert.match(await parser.extract(pdf(), PDF_MIME), /PDF_FIXTURE\s+中文文档/);
    const word = await parser.extract(docx(), DOCX_MIME); assert.match(word,/DOCX_FIXTURE 中文附件与表格/); assert.match(word,/TABLE_CELL/);
    await assert.rejects(parser.extract(pdf(''), PDF_MIME), /DOCUMENT_EMPTY/);
    await assert.rejects(parser.extract(await readFile('tests/fixtures/password-document.pdf'), PDF_MIME), /DOCUMENT_PASSWORD/);
    await assert.rejects(parser.extract(Buffer.from('bad document'), PDF_MIME), /INVALID_DOCUMENT/);
    await assert.rejects(parser.extract(Buffer.from('bad document'), DOCX_MIME), /INVALID_DOCUMENT/);
    await assert.rejects(parser.extract(pdf('many pages',101), PDF_MIME), /LIMIT/);
    await assert.rejects(parser.extract(docx('汉'.repeat(140000)), DOCX_MIME), /LIMIT/);
    await assert.rejects(parser.extract(docx('zip bomb',{'large.xml':'x'.repeat(17*1024*1024)}), DOCX_MIME), /LIMIT/);
    assert.match(await parser.extract(docx('RECOVERED'), DOCX_MIME), /RECOVERED/);
  } finally { await kernel.dispose(); await rm(root,{recursive:true,force:true}); }
});

test("文档线程有界取消、超时和销毁，忙时拒绝第二份文件，主循环仍响应", async () => {
  const root = await mkdtemp(resolve(".artifacts/documents-cancel-"));
  const path = join(root,'busy.cjs'); await writeFile(path,'while(true) {}');
  const kernel = new Kernel(); kernel.install(createDocumentText(path,300)); await kernel.startAll();
  const parser = kernel.resolve("document.text"), controller = new AbortController();
  try {
    const job = parser.extract(pdf(), PDF_MIME, controller.signal);
    const stopped = assert.rejects(job,/CANCELLED/);
    await assert.rejects(parser.extract(pdf(), PDF_MIME), /BUSY/);
    await new Promise(r=>setTimeout(r,40)); controller.abort(); await stopped;
    await assert.rejects(parser.extract(pdf(), PDF_MIME),/DOCUMENT_TIMEOUT/);
    const pending = assert.rejects(parser.extract(pdf(), PDF_MIME),/CANCELLED/); await kernel.dispose(); await pending;
  } finally { await kernel.dispose(); await rm(root,{recursive:true,force:true}); }
});
