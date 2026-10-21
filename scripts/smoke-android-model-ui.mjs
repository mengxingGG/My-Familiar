import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
const output = ".artifacts/android-model-ui";
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `
import {mountApp} from './apps/tauri/ui/app.ts';import {createPreviewBridge} from './apps/tauri/preview/fixture.ts';
const fixture=createPreviewBridge(),state=await fixture.request('snapshot.get');fixture.dispose();
const advanced={temperature:null,topP:null,maxOutputTokens:4096,contextTokens:null,autoCompactPercent:80,timeoutSeconds:180,thinking:{mode:'auto',effort:'medium',budgetTokens:2048},cache:true};
state.modelManagement=true;state.contextManagement=true;state.provider={kind:'compatible',baseUrl:'https://fixture.test/v1',model:'fixture-model',keyConfigured:true,advanced};for(const p of state.providers){p.profile.advanced=structuredClone(advanced);if(p.id==='compatible')p.profile=structuredClone(state.provider);}
let listener;window.calls=[];window.state=state;const publish=()=>{state.revision++;listener?.(structuredClone(state));};window.tick=publish;
window.context={conversationId:'welcome',active:true,status:{id:'welcome',epoch:2,retainedMessages:6,inputTokens:12000,exact:false,inputBudget:18000,limitSource:'manual',trimmedMessages:8,compactions:2,compactThreshold:14400,usage:{inputTokens:11500,outputTokens:120,cachedInputTokens:6000}},checkpoint:{id:'current-checkpoint',created:Date.now(),compactions:2,truncated:false,summary:{goals:['规划行程'],constraints:['保留原定日期'],facts:['<img src=x onerror=alert(1)>'],decisions:['乘车'],progress:['已查时刻表'],pending:['尚未订票'],uncertainties:['午餐待定'],artifacts:['plan.md']}}};
mountApp({subscribe(fn){listener=fn;return()=>{};},async request(method,p){window.calls.push({method,p});
if(method==='snapshot.get')return structuredClone(state);
if(method==='provider.inspect')return{hasKey:p.baseUrl==='https://fixture.test/v1'&&state.provider.keyConfigured,options:{modes:['auto','off','effort'],efforts:['low','medium','high'],temperature:true,temperatureMax:2,topP:true,topPMin:0,budgetMin:1,hint:'支持强度设置。'},model:{id:p.model,name:p.model,contextWindow:120000,outputLimit:10000}};
if(method==='provider.models'){const items=[{id:'fixture-model',name:'<img src=x onerror=alert(1)>'},{id:'new-model',name:'新模型'}];if(window.delayModels)await new Promise(r=>window.finishModels=r);return{kind:p.kind,baseUrl:p.baseUrl,items};}
if(method==='provider.save'){state.provider={kind:p.kind,baseUrl:p.baseUrl,model:p.model,keyConfigured:!p.clearApiKey,advanced:structuredClone(p.advanced??state.provider.advanced)};state.providers.find(v=>v.id===p.kind).profile=structuredClone(state.provider);publish();return;}
if(method==='provider.test'){if(window.failTest)throw Error('fixture failure');if(window.delayTest)await new Promise((r,j)=>{window.finishTest=r;window.cancelTest=()=>j({code:'CANCELLED'});});return{connected:true,elapsedMs:135};}
if(method==='provider.test.cancel'){window.cancelTest?.();return;}
if(method==='conversation.context')return structuredClone(window.context);
if(method==='context.archive'){const result={text:p.query?'查找到的原文':p.offset?'第二页原文 TAIL':p.checkpoint==='older-checkpoint'?'更早记录':'第一段原文 <script>bad()</script>',nextOffset:!p.offset&&!p.query?16000:null,totalCharacters:20000,previous:p.checkpoint==='current-checkpoint'?'older-checkpoint':undefined};if(window.delayArchive)await new Promise(r=>window.finishArchive=r);return result;}
throw Error(method);}});
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
    res.setHeader("Content-Type", "text/javascript");
    res.end(bundle.outputFiles[0].contents);
  } else if (req.url === "/style.css") {
    res.setHeader("Content-Type", "text/css");
    res.end(await readFile("apps/tauri/ui/style.css"));
  } else if (/^\/characters\/[a-z]+\/idle-0.svg$/.test(req.url)) {
    res.setHeader("Content-Type", "image/svg+xml");
    res.end(await readFile(req.url.slice(1)));
  } else {
    res.setHeader("Content-Type", "text/html;charset=utf-8");
    res.end(await readFile("apps/tauri/ui/index.html"));
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "msedge", headless: true }),
  page = await browser.newPage({ viewport: { width: 390, height: 844 } }),
  results = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const pass = (text) => {
  results.push(text);
  console.log("PASS " + text);
};
const openModel = async () => {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /模型连接/ }).click();
};
const modelPage = () =>
  page.locator(".page").filter({
    has: page.getByRole("heading", { name: "模型连接", exact: true }),
  });
const backModel = () => modelPage().locator(".pagebar button").click();
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await openModel();
  const url = page.getByLabel(/^服务地址/),
    model = page.getByLabel("模型", { exact: true }),
    temperature = page.getByLabel("温度（留空使用模型默认）", { exact: true }),
    test = page.getByRole("button", { name: "测试已保存连接", exact: true });
  await page.locator(".model-tools details summary").click();
  await temperature.fill("0.4");
  await page.evaluate(() => window.tick());
  assert.equal(await temperature.inputValue(), "0.4");
  assert(await test.isDisabled());
  await page.locator('[data-kind="deepseek"] input').check();
  await temperature.fill("0.8");
  await page.locator('[data-kind="compatible"] input').check();
  assert.equal(await temperature.inputValue(), "0.4");
  await page.getByLabel("思考模式", { exact: true }).selectOption("effort");
  await page.getByLabel("思考强度", { exact: true }).selectOption("high");
  await page
    .getByLabel("上下文窗口（留空自动识别）", { exact: true })
    .fill("120000");
  await page.getByLabel("自动压缩阈值（%）", { exact: true }).fill("70");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.waitForFunction(
    () => window.state.provider.advanced.temperature === 0.4,
  );
  assert.equal(
    await page.evaluate(() => window.state.provider.advanced.thinking.effort),
    "high",
  );
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent === "测试已保存连接",
      ).disabled,
  );
  pass("高级参数按类型保留草稿，刷新不覆盖，保存后才可测试");
  await page.getByRole("button", { name: "获取模型列表", exact: true }).click();
  await page
    .getByRole("button", { name: "选择模型 new-model", exact: true })
    .waitFor();
  assert.equal(await page.locator(".model-options img").count(), 0);
  await page.getByLabel("搜索模型", { exact: true }).fill("新模型");
  assert.equal(await page.locator(".model-option").count(), 1);
  await page
    .getByRole("button", { name: "选择模型 new-model", exact: true })
    .click();
  assert.equal(await model.inputValue(), "new-model");
  assert.equal(
    await page.evaluate(() => window.state.provider.model),
    "fixture-model",
  );
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.waitForFunction(() => window.state.provider.model === "new-model");
  pass("模型目录可搜索选择，名称为纯文本，选择仍需保存");
  await page.evaluate(() => (window.delayModels = true));
  await page.getByRole("button", { name: "获取模型列表", exact: true }).click();
  await page.waitForFunction(() => !!window.finishModels);
  await url.fill("https://other.test/v1");
  await page.evaluate(() => {
    window.delayModels = false;
    window.finishModels();
  });
  await page.waitForTimeout(250);
  assert.equal(await page.locator(".model-option").count(), 0);
  await page
    .locator(".model-tools")
    .getByText("当前类型与地址没有密钥，本地或兼容服务可能不需要。", {
      exact: true,
    })
    .waitFor();
  assert(await test.isDisabled());
  await url.fill("https://fixture.test/v1");
  await page.getByLabel("API 密钥", { exact: true }).fill("test-only");
  assert(
    await page
      .getByRole("button", { name: "获取模型列表", exact: true })
      .isDisabled(),
  );
  await page.getByRole("button", { name: "保存", exact: true }).click();
  pass("换地址后拒绝迟到目录与旧密钥提示，输入密钥须先保存");
  await test.click();
  await page.getByText(/连接成功，模型已返回文字/).waitFor();
  assert.equal(
    await page.evaluate(
      () => window.calls.filter((c) => c.method === "chat.send").length,
    ),
    0,
  );
  await page.evaluate(() => (window.failTest = true));
  await test.click();
  await page
    .getByText("连接测试未成功，请检查已保存配置后重试。", { exact: true })
    .waitFor();
  await page.evaluate(() => {
    window.failTest = false;
    window.delayTest = true;
  });
  await test.click();
  await page.waitForFunction(() => !!window.finishTest);
  await page.getByRole("button", { name: "停止连接测试", exact: true }).click();
  await page.getByText("连接测试已停止。", { exact: true }).waitFor();
  await page.evaluate(() => (window.finishTest = null));
  await test.click();
  await page.waitForFunction(() => !!window.finishTest);
  await backModel();
  await page.waitForFunction(
    () =>
      window.calls.filter((c) => c.method === "provider.test.cancel").length ===
      2,
  );
  pass("连接成功、失败、主动取消与离页取消均可见且不进入聊天");
  // 从设置返回聊天后，进入同一会话的上下文页面。
  await page.getByRole("button", { name: "聊天", exact: true }).click();
  await page.getByRole("button", { name: "会话上下文", exact: true }).click();
  await page.getByText("输入 token（保守估算）", { exact: true }).waitFor();
  await page.getByText("11500 / 120", { exact: true }).waitFor();
  assert.equal(await page.locator(".context-page img").count(), 0);
  await page.locator(".context-page details summary").click();
  await page.getByRole("button", { name: "读取本段原文", exact: true }).click();
  await page
    .locator(".context-page pre")
    .getByText("第一段原文 <script>bad()</script>", { exact: true })
    .waitFor();
  assert.equal(await page.locator(".context-page pre script").count(), 0);
  await page.getByRole("button", { name: "下一页原文", exact: true }).click();
  await page.getByText("第二页原文 TAIL", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "更早的压缩记录", exact: true })
    .click();
  await page.getByText("更早记录", { exact: true }).waitFor();
  await page.getByLabel("查找压缩原文", { exact: true }).fill("资料");
  await page.getByRole("button", { name: "查找", exact: true }).click();
  await page.getByText("查找到的原文", { exact: true }).waitFor();
  pass("上下文区分估算与服务用量；摘要和原文可分页、向前回查及搜索");
  await page.evaluate(() => {
    window.delayArchive = true;
    window.finishArchive = null;
  });
  await page.getByRole("button", { name: "读取本段原文", exact: true }).click();
  await page.waitForFunction(() => !!window.finishArchive);
  await page.evaluate(() => {
    window.context.checkpoint.id = "new-checkpoint";
  });
  await page
    .getByRole("button", { name: "刷新上下文状态", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent === "读取本段原文",
      ).disabled,
  );
  await page.evaluate(() => {
    window.delayArchive = false;
    window.finishArchive();
  });
  await page.waitForTimeout(50);
  assert.equal(await page.locator(".context-page pre").innerText(), "");
  pass("刷新到新压缩记录时清除旧原文，迟到读取不会覆盖或锁死按钮");
  for (const width of [360, 390, 430, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator(".context-body").evaluate((el) => (el.scrollTop = 0));
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({ path: `${output}/context-${width}.png` });
  }
  await page.locator(".context-page .pagebar button").click();
  for (const width of [360, 390, 430, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    const b = await page
      .getByRole("button", { name: "会话上下文", exact: true })
      .boundingBox();
    assert(b && b.width >= 44 && b.height >= 44);
    await page.screenshot({ path: `${output}/chat-${width}.png` });
  }
  await page.locator(".page-chat .pagebar button").first().click();
  await openModel();
  for (const width of [360, 390, 430, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await temperature.scrollIntoViewIfNeeded();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({ path: `${output}/model-${width}.png` });
  }
  pass("四种手机/平板宽度无横向溢出，聊天新增入口触摸尺寸合格");
  await page.evaluate(() => {
    window.delayModels = true;
    window.finishModels = null;
  });
  await page.getByRole("button", { name: "获取模型列表", exact: true }).click();
  await page.waitForFunction(() => !!window.finishModels);
  await page.getByRole("button", { name: "清除密钥", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "清除", exact: true })
    .click();
  await page
    .locator(".model-tools")
    .getByText("当前类型与地址没有密钥，本地或兼容服务可能不需要。", {
      exact: true,
    })
    .waitFor();
  await page.evaluate(() => {
    window.delayModels = false;
    window.finishModels();
  });
  await page.waitForTimeout(50);
  assert.equal(await page.locator(".model-option").count(), 0);
  assert.equal(await temperature.inputValue(), "0.4");
  pass("清除密钥更新实际地址提示并废弃旧目录，保留高级参数");
  assert.deepEqual(errors, []);
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` });
  console.error(await page.locator("body").innerText(), errors);
  throw error;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  await writeFile(
    `${output}/result.json`,
    JSON.stringify(
      { date: new Date().toISOString(), results, errors },
      null,
      2,
    ),
  );
}
