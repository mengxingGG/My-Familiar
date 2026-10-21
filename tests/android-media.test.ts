import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, rm, symlink, cp, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { bootstrapAndroid } from "../apps/tauri/runtime/bootstrap.ts";
import { mobileApi } from "../apps/tauri/runtime/mobile-api.ts";
import type { MobileRequest } from "../packages/mobile-bridge/index.ts";
import type { MobileAttachment, MobileSnapshot } from "../packages/mobile-contracts/index.ts";
import type { AndroidNative } from "../plugins/platform-android/index.ts";
import { PDF_MIME, DOCX_MIME } from "../plugins/document-text/index.ts";
// @ts-expect-error 正式工作线程构建与可复现测试文档。
import { buildDocumentText } from "../scripts/build-document-text.mjs";
// @ts-expect-error 仅供测试的 Node 文档生成器。
import { pdf, docx } from "./fixtures/documents.mjs";

test("Android 文档导入与快照互不阻塞，纯文字预览、重启和失败清理", async () => {
  const root = await mkdtemp(resolve('.artifacts/android-documents-')), assets = join(root,'assets');
  await buildDocumentText(assets); await cp('characters',join(assets,'characters'),{recursive:true});
  const native: AndroidNative = {async call<T>(method:string):Promise<T>{return (method==='secrets.readAll'?{}:method==='capabilities.status'?[]:method==='runtime.status'?{running:true,overlayVisible:true,engine:'ready',detail:'fixture'}:null) as T;}};
  let kernel = await bootstrapAndroid(root,assets,native), api = mobileApi(kernel,native);
  const stage = async(data:Buffer,mimeType:string,name:string)=>{
    const token=randomUUID(),path=join(root,'media-inbox',token);await mkdir(path,{recursive:true});
    await writeFile(join(path,'data'),data);await writeFile(join(path,'meta.json'),JSON.stringify({mimeType,name}));return token;
  };
  try {
    const tokens=[await stage(pdf(),PDF_MIME,'中文.pdf'),await stage(docx(),DOCX_MIME,'Word.docx')];
    let finished=false;
    const job=api({protocolVersion:1,id:'documents',method:'media.import',params:{tokens}}).finally(()=>{finished=true;});
    const snapshot=await api({protocolVersion:1,id:'during-import',method:'snapshot.get',params:undefined});
    assert(snapshot.ok);assert(!finished,'快照不得排在耗时文档解析后面');
    const result=await job;assert(result.ok,JSON.stringify(result));const files=result.result as MobileAttachment[];
    assert(files.every(f=>f.kind==='text'&&f.mimeType==='text/plain'&&f.name.endsWith('（提取文字）')));
    assert.match((await kernel.resolve('android.media').preview(files[0].id)).text!,/中文文档/);
    assert.match((await kernel.resolve('android.media').preview(files[1].id)).text!,/TABLE_CELL/);
    const bad=[await stage(Buffer.from('damaged'),PDF_MIME,'bad.pdf'),await stage(docx(),DOCX_MIME,'remaining.docx')];
    const rejected=await api({protocolVersion:1,id:'bad-document',method:'media.import',params:{tokens:bad}});
    assert(!rejected.ok);assert.equal(rejected.error?.code,'INVALID_DOCUMENT');assert.deepEqual(await readdir(join(root,'media-inbox')),[]);
    await kernel.dispose();kernel=await bootstrapAndroid(root,assets,native);api=mobileApi(kernel,native);
    assert.match((await kernel.resolve('android.media').preview(files[0].id)).text!,/中文文档/);
  } finally {await kernel.dispose();await rm(root,{recursive:true,force:true});}
});

test("Android 截图必须逐次批准，拒绝与取消不采集，原图通过共享媒体库返回", async () => {
  await mkdir(".artifacts", { recursive: true });
  const root = await mkdtemp(resolve(".artifacts/android-capture-core-"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9SAAAAAASUVORK5CYII=", "base64");
  let captures = 0;
  const native: AndroidNative = { async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (method === "accessibility.screenshot") {
      assert.equal(params?.snapshotId, "observed-window"); captures++;
      const token = randomUUID(), directory = join(root, "media-inbox", token);
      await mkdir(directory, { recursive: true }); await writeFile(join(directory, "data"), png);
      await writeFile(join(directory, "meta.json"), JSON.stringify({ name: "screen.png", mimeType: "image/png", source: "screen" }));
      return { token } as T;
    }
    return (method === "secrets.readAll" ? {} : null) as T;
  } };
  const kernel = await bootstrapAndroid(root, resolve("."), native);
  const approvals = kernel.resolve("agent.approvals"), tools = kernel.resolve("agent.tools");
  const pending = async () => {
    for (let i = 0; i < 100 && !approvals.list().length; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(approvals.list().length, 1); return approvals.list()[0].id;
  };
  const run = (signal = new AbortController().signal) => tools.runRich!({ id: randomUUID(), name: "android_screenshot", arguments: JSON.stringify({ snapshotId: "observed-window" }) }, signal);
  try {
    const denied = run(), rejection = assert.rejects(denied, /拒绝/);
    const id = await pending(); assert.equal(captures, 0); approvals.decide(id, false); await rejection;
    const controller = new AbortController(), cancelled = run(controller.signal), cancelledAssertion = assert.rejects(cancelled);
    await pending(); controller.abort(); await cancelledAssertion; assert.equal(captures, 0);
    const allowed = run(), approval = await pending(); assert.equal(captures, 0);
    approvals.decide(approval, true); const result = await allowed;
    assert.equal(captures, 1); assert.equal(result.attachments?.length, 1); assert.equal(result.attachments![0].source, "screen");
    const preview = await kernel.resolve("android.media").preview(result.attachments![0].id);
    assert.equal(preview.dataUrl, `data:image/png;base64,${png.toString("base64")}`);
    const again = run(), againRejection = assert.rejects(again); approvals.decide(await pending(), false); await againRejection;
    assert.equal(captures, 1);
  } finally { await kernel.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("Android 系统导入复用媒体库：附件单独发送、模型实际负载、预览和历史恢复", async () => {
  await mkdir(".artifacts", { recursive: true });
  const root = await mkdtemp(resolve(".artifacts/android-media-"));
  let received: any;
  const server = createServer(async (req, res) => {
    if (req.url?.endsWith("/models")) { res.end(JSON.stringify({ data: [{ id: "vision-fixture" }] })); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    received = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "已读取附件" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address(); assert(address && typeof address !== "string");
  const native: AndroidNative = { async call<T>(method: string): Promise<T> {
    return (method === "secrets.readAll" ? {} : method === "capabilities.status" ? [] : method === "runtime.status" ? { running: false, overlayVisible: false, engine: "ready", detail: "test" } : null) as T;
  } };
  let kernel = await bootstrapAndroid(root, resolve("."), native);
  let api = mobileApi(kernel, native), sequence = 0;
  const call = async (method: MobileRequest["method"], params?: unknown) => {
    const result = await api({ protocolVersion: 1, id: String(++sequence), method, params });
    assert(result.ok, JSON.stringify(result)); return result.result;
  };
  const stage = async (data: Buffer, name: string, mimeType: string) => {
    const token = randomUUID(), directory = join(root, "media-inbox", token);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "data"), data);
    await writeFile(join(directory, "meta.json"), JSON.stringify({ name, mimeType }));
    return token;
  };
  try {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9SAAAAAASUVORK5CYII=", "base64");
    const text = "media-fixture-独立附件验证";
    const tokens = [await stage(Buffer.from(text), "笔记.txt", "text/plain"), await stage(png, "图像.png", "image/png")];
    const attachments = await call("media.import", { tokens }) as MobileAttachment[];
    assert.equal(attachments.length, 2); assert(!JSON.stringify(attachments).includes(root));
    for (const token of tokens) await assert.rejects(readFile(join(root, "media-inbox", token, "data")));
    const preview = await call("media.preview", { id: attachments[0].id }) as any;
    assert.equal(preview.text, text);
    await call("provider.save", { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "vision-fixture" });
    const id = (await call("conversation.create") as { id: string }).id;
    await call("message.send", { conversationId: id, text: "", attachments: attachments.map(a => a.id) });
    // message.send 排队启动；尚未进入 busy 不能当作回复已经完成。
    for (let i = 0; i < 100 && (!received || kernel.resolve("conversation").state().busy); i++) await new Promise(r => setTimeout(r, 20));
    assert(received, JSON.stringify(kernel.resolve("conversation").state()));
    const user = received.messages.filter((m: any) => m.role === "user").at(-1);
    assert(JSON.stringify(user).includes(text));
    assert(JSON.stringify(user).includes(`data:image/png;base64,${png.toString("base64")}`));
    const state = await call("snapshot.get") as MobileSnapshot;
    assert.deepEqual(state.conversations.find(c => c.id === id)!.messages[0].attachments, attachments);
    const before = state.conversations.length;
    const invalid = await api({ protocolVersion: 1, id: "invalid-ref", method: "message.send", params: { conversationId: null, text: "", attachments: [randomUUID()] } });
    assert.equal(invalid.ok, false); assert.equal((await call("snapshot.get") as MobileSnapshot).conversations.length, before);
    await assert.rejects(kernel.resolve("android.media").import(["../../credentials.v1"]));
    const huge = await stage(Buffer.alloc(12 * 1024 * 1024 + 1), "oversize.png", "image/png");
    await assert.rejects(kernel.resolve("android.media").import([huge]));
    const outside = join(root, "outside"); await mkdir(outside); await writeFile(join(outside, "data"), "protected");
    const link = randomUUID(); await symlink(outside, join(root, "media-inbox", link), "junction");
    await assert.rejects(kernel.resolve("android.media").import([link]));
    assert.equal(await readFile(join(outside, "data"), "utf8"), "protected");
    await kernel.dispose(); kernel = await bootstrapAndroid(root, resolve("."), native); api = mobileApi(kernel, native);
    assert.equal((await call("media.preview", { id: attachments[0].id }) as any).text, text);
    assert.deepEqual((await call("snapshot.get") as MobileSnapshot).conversations.find(c => c.id === id)!.messages[0].attachments, attachments);
  } finally {
    await kernel.dispose(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});
