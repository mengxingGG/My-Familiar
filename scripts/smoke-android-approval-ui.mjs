import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
const output = ".artifacts/android-approval-ui";
await mkdir(output, { recursive: true });
const bundle = await build({ stdin: { contents: `
import { mountApproval } from './apps/tauri/ui/app.ts';
window.calls=[]; window.taskClosed=0;
window.publish = () => {};
mountApproval({ subscribe(listener) { window.publish=listener; return () => {}; },
respond(id,action,choice) { window.calls.push({id,action,choice}); return new Promise((resolve,reject)=>{window.finish=resolve;window.fail=()=>reject(Error('fixture'));}); },
close() { window.taskClosed++; } });`, resolveDir: process.cwd() }, bundle: true, write: false, format: "esm", platform: "browser" });
const server = createServer(async (req, res) => {
  if (req.url === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].contents); }
  else if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(await readFile("apps/tauri/ui/style.css")); }
  else { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(await readFile("apps/tauri/ui/index.html")); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 336, height: 420 } });
const errors = [], results = [];
page.on("pageerror", e => errors.push(e.message));
const task = { id: "one", kind: "accessibility", title: "点击测试目标", detail: '<img src=x onerror="window.injected=true">\n' + "完整参数必须保留 ".repeat(300), status: "awaitingApproval", conversationId: "", choices: ["once","session","whitelist"] };
let revision = 0;
const publish = tasks => page.evaluate(s => window.publish(s), { protocolVersion: 1, revision: ++revision, tasks });
const allow = () => page.getByRole("button", { name: /^允许一次/ });
function pass(name) { results.push(name); console.log(`PASS ${name}`); }
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => typeof window.publish === "function");
  await publish([task]);
  for (const width of [280, 336]) {
    await page.setViewportSize({ width, height: 420 });
    await page.waitForTimeout(700);
    const box = await allow().boundingBox();
    assert(box.height >= 48 && box.x >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= 420);
    assert.equal(await page.locator(".ap-detail").textContent(), task.detail);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.equal(await page.locator(".ap-detail img").count(), 0);
    await page.screenshot({ path: `${output}/card-${width}.png` });
  }
  for (const name of ["添加白名单","允许当前会话全部"]) { const box=await page.getByRole("button",{name,exact:true}).boundingBox(); assert(box && box.height>=48 && box.y+box.height<=420); }
  pass("280/336 卡片布局、四个固定操作与不可信详情纯文本");
  await page.getByRole("button", { name: "收起卡片，不批准也不拒绝" }).click();
  assert.equal(await page.evaluate(() => window.taskClosed), 1); assert.equal(await page.evaluate(() => window.calls.length), 0);
  pass("收起不提交任何批准或拒绝");
  await allow().click();
  await page.waitForTimeout(50); assert.equal(await allow().isEnabled(), false);
  await page.evaluate(() => window.finish()); await page.waitForTimeout(50);
  assert.equal(await allow().isEnabled(), false); assert.equal(await page.evaluate(() => window.calls.length), 1);
  await publish([{ ...task, id: "two" }]); await page.waitForTimeout(700);
  assert.equal(await allow().isEnabled(), true);
  pass("提交期间禁止重复，成功等待核心快照再转下一项");
  await allow().click(); await page.evaluate(() => window.fail()); await page.waitForTimeout(50);
  assert.equal(await allow().isEnabled(), true); assert(await page.locator(".ap-status").isVisible());
  await allow().click(); await publish([]); await page.evaluate(() => window.finish());
  await page.getByText("都处理好了", { exact: true }).waitFor();
  pass("失败可重试，迟到结果不恢复已结束任务");
  assert.deepEqual(errors, []);
} finally {
  await browser.close(); await new Promise(r => server.close(r));
  await writeFile(`${output}/result.json`, JSON.stringify({ testedAt: new Date().toISOString(), results, errors }, null, 2));
}
