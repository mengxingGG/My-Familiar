import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
const output = ".artifacts/android-media-ui";
await mkdir(output, { recursive: true });
const bundle = await build({ stdin: { contents: `
import { mountApp } from './apps/tauri/ui/app.ts';
import { createPreviewBridge } from './apps/tauri/preview/fixture.ts';
const fixture=createPreviewBridge(); const state=await fixture.request('snapshot.get'); fixture.dispose();
state.provider={kind:'compatible',baseUrl:'https://fixture.invalid/v1',model:'fixture',keyConfigured:true};
let listener; const publish=()=>{state.revision++;listener?.(structuredClone(state));};
window.fixtureSelect=id=>{state.activeConversationId=id;publish();};
window.fixtureCamera=value=>{state.media.camera=value;publish();};
window.fixtureDocuments=value=>{state.media.documents=value;publish();};
window.fixturePasteAvailable=value=>{state.media.paste=value;publish();};
window.pasteRequests=0;
window.sent=[]; window.mediaFiles=new Map();
window.fixturePick=(name='选择的附件.txt')=>{const file={id:crypto.randomUUID(),name,kind:'text',mimeType:'text/plain',bytes:30};window.mediaFiles.set(file.id,file);window.pickResolve([file]);return file.id;};
mountApp({subscribe(fn){listener=fn;publish();return()=>{};}, async request(method,p){
if(method==='snapshot.get')return structuredClone(state);
if(method==='media.choose'||method==='media.camera'||method==='media.paste'){if(method==='media.paste')window.pasteRequests++;return new Promise((resolve,reject)=>{window.pickResolve=resolve;window.pickReject=reject;});}
if(method==='media.preview')return{attachment:window.mediaFiles.get(p.id),text:'<img src=x onerror="window.injected=true">附件是普通资料'};
if(method==='message.send'){window.sent.push(p);return new Promise((resolve,reject)=>{window.sendResolve=resolve;window.sendReject=reject;});}
if(method==='conversation.select'){state.activeConversationId=p.id;publish();return;}
throw Error('unsupported test command');}});`, resolveDir: process.cwd() }, bundle: true, write: false, format: "esm", platform: "browser" });
const server = createServer(async (req, res) => {
  if (req.url === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].contents); }
  else if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(await readFile("apps/tauri/ui/style.css")); }
  else if (/^\/characters\/[a-z]+\/idle-0.svg$/.test(req.url)) { res.setHeader("Content-Type", "image/svg+xml"); res.end(await readFile(req.url.slice(1))); }
  else { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(await readFile("apps/tauri/ui/index.html")); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [], results = [];
page.on("pageerror", e => errors.push(e.message));
const paperclip = () => page.getByRole("button", { name: "添加图片或文本文件", exact: true });
const composer = () => page.getByRole("textbox", { name: "想说的话", exact: true });
const switchTo = async id => { await page.evaluate(id => window.fixtureSelect(id), id); await page.waitForTimeout(80); };
const count = () => page.locator(".tray-item").count();
const pick = async name => { await paperclip().click(); const id = await page.evaluate(name => window.fixturePick(name), name); await page.waitForTimeout(80); return id; };
function pass(name) { results.push(name); console.log(`PASS ${name}`); }
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole("button", { name: "说句话", exact: true }).click();
  await composer().fill("原会话文字");
  await paperclip().click(); await switchTo("yesterday");
  const original = await page.evaluate(() => window.fixturePick("原会话附件.txt")); await page.waitForTimeout(80);
  assert.equal(await count(), 0); await switchTo("welcome"); assert.equal(await count(), 1); assert.equal(await composer().inputValue(), "原会话文字");
  pass("系统选择迟到只归属原会话，文本和附件草稿一起隔离");
  await page.getByRole("button", { name: /^预览 原会话附件.txt/ }).click();
  await page.locator(".media-text").waitFor({ state: "visible" });
  assert((await page.locator(".media-text").textContent()).includes("<img src=x"));
  assert.equal(await page.locator(".media-text img").count(), 0); assert.equal(await page.evaluate(() => window.injected), undefined);
  await page.getByRole("button", { name: "关闭", exact: true }).last().click();
  pass("文本预览按原文显示，不执行 HTML");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  assert.equal(await count(), 0); assert.deepEqual(await page.evaluate(() => window.sent[0].attachments), [original]);
  await composer().fill("下一条草稿"); const next = await pick("下一条附件.txt");
  await switchTo("yesterday"); await composer().fill("另一段对话");
  await page.evaluate(() => window.sendReject(Error("fixture"))); await page.waitForTimeout(100);
  assert.equal(await composer().inputValue(), "另一段对话"); assert.equal(await count(), 0);
  await switchTo("welcome");
  // 沿用现有文本策略：用户已写的新草稿优先，不把失败旧文覆盖或拼入新文。
  assert.equal(await composer().inputValue(), "下一条草稿");
  assert.deepEqual(new Set(await page.locator(".tray-item").evaluateAll(els => els.map(e => e.dataset.id))), new Set([original, next]));
  pass("发送中新增附件保留，迟到失败只恢复原会话且不丢下一条草稿");
  await composer().fill("");
  assert(await page.getByRole("button", { name: "发送", exact: true }).isEnabled());
  await paperclip().click(); await page.evaluate(() => window.pickResolve([])); await page.waitForTimeout(80); assert.equal(await count(), 2);
  await paperclip().click(); await page.evaluate(() => window.pickReject(Error("fixture"))); await page.waitForTimeout(80); assert.equal(await count(), 2);
  pass("附件可独立发送，取消和失败不清空已有附件");
  const camera = page.getByRole('button', { name: '用系统相机拍照', exact: true });
  assert.equal(await camera.count(), 0);
  await page.evaluate(() => window.fixtureCamera(true)); await camera.waitFor();
  await camera.click(); await page.waitForFunction(()=>document.querySelector('.attach-btn')?.disabled); assert(await paperclip().isDisabled());
  await page.evaluate(() => window.pickResolve([])); await page.waitForTimeout(80); assert.equal(await count(), 2);
  await camera.click(); await switchTo('yesterday');
  const photo = await page.evaluate(() => window.fixturePick('照片.jpg')); await page.waitForTimeout(80);
  assert.equal(await count(), 0); await switchTo('welcome');
  assert((await page.locator('.tray-item').evaluateAll(els => els.map(e => e.dataset.id))).includes(photo));
  await page.evaluate(() => window.fixtureCamera(false)); await camera.waitFor({ state: 'hidden' });
  await page.evaluate(() => window.fixtureCamera(true));
  pass('相机按实际能力显示，与文件共用选择锁，取消与迟到照片保留原会话草稿');
  await page.evaluate(()=>window.fixtureDocuments(true));
  const documents = page.getByRole('button',{name:'添加图片、文本或文档',exact:true}); await documents.waitFor();
  const saved = await count();
  for (const [code,text] of [['DOCUMENT_EMPTY','文档没有可提取文字'],['DOCUMENT_PASSWORD','请先解锁文档'],['DOCUMENT_TIMEOUT','文档解析超时'],['INVALID_DOCUMENT','文档无法解析']]) {
    await documents.click(); await page.evaluate(code=>window.pickReject(Object.assign(new Error(code),{code})),code);
    await page.getByText(new RegExp(text)).last().waitFor(); assert.equal(await count(),saved);
  }
  await documents.click(); await page.evaluate(()=>window.fixturePick('报告.pdf（提取文字）')); await page.getByText('报告.pdf（提取文字）',{exact:true}).waitFor();
  pass('文档能力显示 PDF/DOCX 入口；解析错误保留草稿和已有附件，文字附件明确标注');
  const paste = page.getByRole('button',{name:'粘贴剪贴板图片',exact:true});
  assert.equal(await paste.count(),0); await page.evaluate(()=>window.fixturePasteAvailable(true));await paste.waitFor();
  assert.equal(await page.evaluate(()=>window.pasteRequests),0);
  const pasteBefore=await count();await paste.click();assert(await documents.isDisabled());assert(await camera.isDisabled());
  await switchTo('yesterday');await page.evaluate(()=>window.fixturePick('粘贴图片.png'));await page.waitForTimeout(100);
  assert.equal(await count(),0);await switchTo('welcome');assert.equal(await count(),pasteBefore+1);
  await paste.click();await page.evaluate(()=>window.pickReject(Object.assign(Error('empty'),{code:'NOT_FOUND'})));
  await page.getByText(/剪贴板里没有可粘贴的图片/).last().waitFor();assert.equal(await count(),pasteBefore+1);
  pass('粘贴只在点击后请求，与相机和文件互斥；迟到归原会话，空剪贴板保留待发送附件');
  for (const width of [360, 390, 430, 768]) {
    await page.setViewportSize({ width, height: width === 768 ? 1024 : 844 }); await page.waitForTimeout(100);
    const box = await page.getByRole("button", { name: "发送", exact: true }).boundingBox();
    assert(box.x >= 0 && box.x + box.width <= width && box.y + box.height <= (width === 768 ? 1024 : 844));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${output}/tray-${width}.png` });
  }
  pass("360/390/430/768 附件托盘与发送按钮布局可用");
  assert.deepEqual(errors, []);
} finally { await browser.close(); await new Promise(r => server.close(r)); await writeFile(`${output}/result.json`, JSON.stringify({ results, errors }, null, 2)); }
