import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
const out = ".artifacts/android-care-ui";
await mkdir(out, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `
import {mountApp} from './apps/tauri/ui/app.ts';import {createPreviewBridge} from './apps/tauri/preview/fixture.ts';
const f=createPreviewBridge(),snapshot=await f.request('snapshot.get');f.dispose();snapshot.careManagement=true;let revision=1;window.calls=[];window.care={settings:{enabled:true,location:false,nearby:false,custom:[]},revision:'a'.repeat(64),busy:false,locationPermission:true,locationEnabled:true};
mountApp({subscribe(){return()=>{};},async request(method,p){window.calls.push({method,p});if(method==='snapshot.get')return structuredClone(snapshot);if(method==='care.get')return structuredClone(window.care);
if(method==='care.save'){if(window.conflict)throw {code:'CONFLICT'};if(window.delaySave)await new Promise(r=>window.finishSave=r);window.care.settings=p.settings;window.care.revision=String(++revision).repeat(64);return structuredClone(window.care);}
if(method==='care.preview'){window.care.busy=true;return structuredClone(window.care);}
if(method==='care.stop'){window.care.busy=false;window.care.lastMessage='<img src=x onerror=alert(1)>';return structuredClone(window.care);}
if(method==='care.locate'){await new Promise((r,j)=>{window.finishLocation=r;window.cancelLocation=()=>j({code:'CANCELLED'});});window.care.location={accuracy:1500,time:Date.now(),mock:false};return structuredClone(window.care);}
if(method==='care.locate.cancel'){window.cancelLocation?.();return;}
if(method==='capability.request')return;throw Error(method);}});
`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
});
const server = createServer(async (req, res) => {
  if (req.url === "/app.js") {
    res.setHeader("content-type", "text/javascript");
    res.end(bundle.outputFiles[0].contents);
  } else if (req.url === "/style.css") {
    res.setHeader("content-type", "text/css");
    res.end(await readFile("apps/tauri/ui/style.css"));
  } else if (/^\/characters\/[a-z]+\/idle-0.svg$/.test(req.url)) {
    res.setHeader("content-type", "image/svg+xml");
    res.end(await readFile(req.url.slice(1)));
  } else {
    res.setHeader("content-type", "text/html;charset=utf-8");
    res.end(await readFile("apps/tauri/ui/index.html"));
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "msedge", headless: true }),
  page = await browser.newPage({ viewport: { width: 390, height: 844 } }),
  results = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const pass = (s) => {
  results.push(s);
  console.log("PASS " + s);
};
const ui = page.locator(".care-page"),
  button = (n) => ui.getByRole("button", { name: n, exact: true });
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /日常关怀/ }).click();
  await ui.locator("form:not([hidden])").waitFor();
  await button("添加自定义提醒").click();
  const title = ui.getByLabel("提醒 1 名称", { exact: true });
  await title.fill("喝水");
  await ui.getByLabel("提醒 1 时间", { exact: true }).fill("15:30");
  await ui.getByLabel("提醒 1 内容", { exact: true }).fill("喝杯水，休息一下");
  await page.waitForTimeout(2300);
  assert.equal(await title.inputValue(), "喝水");
  assert(await button("现在问候我").isDisabled());
  pass("提醒草稿不被轮询覆盖，未保存时不使用草稿生成");
  await page.evaluate(() => (window.delaySave = true));
  await button("保存关怀设置").click();
  await page.waitForFunction(() => !!window.finishSave);
  await title.fill("保存期间编辑");
  await page.evaluate(() => {
    window.delaySave = false;
    window.finishSave();
  });
  await page.waitForFunction(() =>
    document
      .querySelector(".care-page .form-status")
      .textContent.includes("之后的编辑"),
  );
  assert.equal(await title.inputValue(), "保存期间编辑");
  await button("保存关怀设置").click();
  await page.waitForFunction(
    () =>
      document.querySelector(".care-page .form-status").textContent ===
      "关怀设置已保存。",
  );
  pass("迟到保存保留新编辑和服务端版本");
  await title.fill("冲突草稿");
  await page.evaluate(() => (window.conflict = true));
  await button("保存关怀设置").click();
  await page.waitForFunction(() =>
    document
      .querySelector(".care-page .form-status")
      .textContent.includes("设置已变化"),
  );
  assert.equal(await title.inputValue(), "冲突草稿");
  await page.evaluate(() => (window.conflict = false));
  await button("重新读取关怀设置").click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await title.inputValue(), "冲突草稿");
  await button("重新读取关怀设置").click();
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector(".care-page input[type=text]")?.value ===
      "保存期间编辑",
  );
  pass("配置冲突保留草稿，重新读取有取消出口");
  await button("现在问候我").click();
  await button("停止生成关怀").waitFor();
  await button("停止生成关怀").click();
  assert((await ui.locator(".care-result").innerText()).includes("<img"));
  assert.equal(await ui.locator(".care-result img").count(), 0);
  pass("问候可以停止，生成内容按纯文本呈现");
  await ui
    .getByLabel("允许关怀使用最近获取的大致位置", { exact: true })
    .check();
  await ui
    .getByLabel("在午间、晚间问候中附上附近建议", { exact: true })
    .check();
  await button("保存关怀设置").click();
  await page.waitForFunction(
    () =>
      document.querySelector(".care-page .form-status").textContent ===
      "关怀设置已保存。",
  );
  await button("刷新大致位置").click();
  await page.waitForFunction(() => !!window.cancelLocation);
  await button("取消定位").click();
  await ui.getByText("定位已取消。", { exact: true }).waitFor();
  await button("刷新大致位置").click();
  await page.waitForTimeout(100);
  await page.evaluate(() => window.finishLocation());
  await ui.getByText("大致位置已刷新。", { exact: true }).waitFor();
  assert((await ui.innerText()).includes("误差约 1500 米"));
  pass("位置显式刷新、取消与精度状态正确显示");
  await ui
    .getByLabel("允许关怀使用最近获取的大致位置", { exact: true })
    .uncheck();
  assert(
    !(await ui
      .getByLabel("在午间、晚间问候中附上附近建议", { exact: true })
      .isChecked()),
  );
  assert(
    await ui
      .getByLabel("在午间、晚间问候中附上附近建议", { exact: true })
      .isDisabled(),
  );
  pass("关闭位置同时关闭附近查询草稿");
  await ui.locator(".pagebar").scrollIntoViewIfNeeded();
  for (const width of [360, 390, 430, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({ path: out + "/care-" + width + ".png" });
  }
  pass("四种手机和平板宽度没有横向溢出");
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  await writeFile(
    out + "/result.json",
    JSON.stringify({ results, errors }, null, 2),
  );
}
