import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
const output = ".artifacts/android-voice-ui"; await mkdir(output, { recursive: true });
const bundle = await build({ stdin: { contents: `
import { mountApp } from './apps/tauri/ui/app.ts'; import { createPreviewBridge } from './apps/tauri/preview/fixture.ts';
const fixture=createPreviewBridge(); const state=await fixture.request('snapshot.get'); fixture.dispose();
state.provider={kind:'compatible',baseUrl:'https://fixture.invalid/v1',model:'fixture',keyConfigured:true};
state.capabilities.push({id:'microphone',state:'granted',title:'麦克风',description:'测试',detail:'已授权'});
const p={kind:'compatible',baseUrl:'https://fixture.invalid/v1',model:'fixture',keyConfigured:false};
state.voice={localTts:true,settings:{stt:{...p},tts:{...p,voice:'fixture',speed:1},autoRead:false,continuous:true},state:{phase:'off',active:false,dictating:false,message:'语音未开启'},maxRecordingSeconds:90,dictation:{id:'old',text:'上一次识别',conversationId:'welcome'}};
let listener; window.calls=[]; const publish=()=>{state.revision++;listener?.(structuredClone(state));};
window.fixtureSelect=id=>{state.activeConversationId=id;publish();};
window.fixtureResult=(id='fresh')=>{state.voice.state={phase:'off',active:false,dictating:false,message:'识别完成'};state.voice.dictation={id,text:'新识别文字',conversationId:'welcome'};publish();};
window.fixtureState=value=>{state.voice.state=value;publish();};
window.fixtureSystem=value=>{state.voice.systemInput=value;publish();};
window.fixtureLive=()=>{state.voice.live={mode:'chained',profile:{kind:'openai',baseUrl:'https://fixture.invalid/v1',model:'fixture-live',voice:'fixture',keyConfigured:false},configured:true,problems:[],summary:'常规语音'};publish();};
window.finishSystem=text=>window.systemResolve({text});
mountApp({subscribe(fn){listener=fn;publish();return()=>{};},async request(method,p){window.calls.push({method,p});
if(method==='snapshot.get')return structuredClone(state); if(method==='voice.local.catalog')return {voices:[{id:'android:'+ 'a'.repeat(64),name:'中文 · 测试音色'}],note:'已安装的本地音色'};
if(method==='voice.start'){state.voice.state={phase:p.mode==='dictation'?'recording':'listening',active:true,dictating:p.mode==='dictation',sessionMode:p.mode,message:'麦克风正在使用'};publish();return;}
if(method==='voice.system.input')return new Promise(resolve=>{window.systemResolve=resolve;});
if(method==='voice.stop'){state.voice.state={phase:'off',active:false,dictating:false,message:'已停止'};publish();return;}
if(method==='voice.live.save'){state.voice.live={mode:p.mode,profile:{kind:p.kind,baseUrl:p.baseUrl,model:p.model,voice:p.voice,keyConfigured:!!p.apiKey},configured:true,problems:[],summary:'实时语音由主模型回答'};publish();return;}
if(method==='voice.save'){state.voice.settings={stt:{...p.stt,keyConfigured:!!p.stt.apiKey},tts:{...p.tts,keyConfigured:!!p.tts.apiKey},autoRead:p.autoRead,continuous:p.continuous};delete state.voice.settings.stt.apiKey;delete state.voice.settings.tts.apiKey;publish();return;}
throw Error('unsupported fixture command');}});`, resolveDir: process.cwd() }, bundle: true, write: false, format: "esm", platform: "browser" });
const server = createServer(async (req, res) => {
  if (req.url === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].contents); }
  else if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(await readFile("apps/tauri/ui/style.css")); }
  else if (/^\/characters\/[a-z]+\/idle-0.svg$/.test(req.url)) { res.setHeader("Content-Type", "image/svg+xml"); res.end(await readFile(req.url.slice(1))); }
  else { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(await readFile("apps/tauri/ui/index.html")); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "msedge", headless: true }); const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [], results = []; page.on("pageerror", e => errors.push(e.message));
const pause = () => page.waitForTimeout(80), composer = () => page.getByRole("textbox", { name: "想说的话", exact: true });
function pass(name) { results.push(name); console.log(`PASS ${name}`); }
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.getByRole("button", { name: "说句话", exact: true }).click();
  assert.equal(await composer().inputValue(), ''); await composer().fill('原来的草稿');
  await page.getByRole('button', { name: '录音转文字', exact: true }).click(); await page.getByRole('button', { name: '完成录音', exact: true }).waitFor();
  await page.evaluate(() => window.fixtureSelect('yesterday')); await pause(); await composer().fill('另一个草稿');
  await page.evaluate(() => window.fixtureResult()); await pause(); assert.equal(await composer().inputValue(), '另一个草稿');
  await page.evaluate(() => window.fixtureSelect('welcome')); await pause(); assert.equal(await composer().inputValue(), '原来的草稿\n新识别文字');
  await page.evaluate(() => window.fixtureResult()); await pause(); assert.equal(await composer().inputValue(), '原来的草稿\n新识别文字');
  pass('旧转写不重复回填，新转写仅追加原会话草稿且只处理一次');
  const system = page.getByRole('button', {name:'系统语音输入',exact:true}); assert(!(await system.isVisible()));
  await page.evaluate(()=>window.fixtureSystem(true));await pause();await system.click();assert(await system.isDisabled());
  await page.evaluate(()=>window.fixtureSelect('yesterday'));await pause();
  await page.evaluate(()=>window.finishSystem('系统输入 <b>纯文本</b>'));await pause();assert.equal(await composer().inputValue(),'另一个草稿');
  await page.evaluate(()=>window.fixtureSelect('welcome'));await pause();assert.equal(await composer().inputValue(),'原来的草稿\n新识别文字\n系统输入 <b>纯文本</b>');
  await system.click();await page.evaluate(()=>window.finishSystem(null));await pause();assert((await composer().inputValue()).endsWith('系统输入 <b>纯文本</b>'));
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='message.send').length),0);
  pass('系统听写按能力显示，取消保留草稿，返回纯文本只追加原会话且不自动发送');
  await page.getByRole('button', { name: '连续语音', exact: true }).click(); assert(await page.getByRole('button', { name: '发送', exact: true }).isDisabled());
  for (const width of [360, 390, 430, 768]) {
    await page.setViewportSize({ width, height: 844 }); await pause();
    const stop = await page.getByRole('button', { name: '停止语音', exact: true }).boundingBox(); assert(stop && stop.x >= 0 && stop.x + stop.width <= width && stop.y >= 0);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.screenshot({ path: `${output}/voice-${width}.png` });
  }
  await page.getByRole('button', { name: '停止语音', exact: true }).click(); await pause(); assert(!(await page.getByRole('button', { name: '发送', exact: true }).isDisabled()));
  pass('连续语音禁止文本误发，360/390/430/768 状态与停止按钮可见');
  await page.goBack(); await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByText('语音连接', { exact: true }).click();
  await page.getByLabel('识别密钥', { exact: true }).fill('UI_TEST_STT'); await page.getByLabel('朗读密钥', { exact: true }).fill('UI_TEST_TTS');
  await page.getByLabel('朗读音色 ID', { exact: true }).fill('voice-fixture'); await page.getByRole('button', { name: '保存语音设置', exact: true }).click(); await pause();
  const saved = await page.evaluate(() => window.calls.findLast(c => c.method === 'voice.save').p);
  assert.equal(saved.stt.apiKey, 'UI_TEST_STT'); assert.equal(saved.tts.apiKey, 'UI_TEST_TTS'); assert.equal(saved.tts.voice, 'voice-fixture');
  assert.equal(await page.getByLabel('识别密钥', { exact: true }).inputValue(), ''); assert.equal(await page.getByLabel('朗读密钥', { exact: true }).inputValue(), '');
  await page.setViewportSize({ width: 360, height: 844 }); await page.screenshot({ path: `${output}/settings-360.png` });
  await page.getByLabel('朗读密钥', { exact: true }).fill('UNSAVED_CLOUD_KEY');
  await page.locator('[name="tts-kind"]').selectOption('system');
  await page.getByRole('button', { name: '刷新设备音色', exact: true }).click();
  await page.locator('[name="tts-local-voice"]').selectOption('android:' + 'a'.repeat(64));
  assert(!(await page.getByLabel('朗读密钥', { exact: true }).isVisible()));
  await page.evaluate(() => window.fixtureSelect('welcome')); await pause();
  assert.equal(await page.locator('[name="tts-local-voice"]').inputValue(), 'android:' + 'a'.repeat(64));
  await page.getByRole('button', { name: '保存语音设置', exact: true }).click(); await pause();
  const local = await page.evaluate(() => window.calls.findLast(c => c.method === 'voice.save').p.tts);
  assert.equal(local.kind, 'system'); assert.equal(local.voice, 'android:' + 'a'.repeat(64)); assert.equal(local.apiKey, undefined); assert.equal(local.clearApiKey, undefined); assert.equal(local.stream, false);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.screenshot({path:`${output}/local-voice-360.png`});
  await page.locator('[name="tts-kind"]').selectOption('compatible');
  assert.equal(await page.getByLabel('朗读音色 ID', { exact: true }).inputValue(), 'voice-fixture'); assert.equal(await page.getByLabel('朗读密钥', { exact: true }).inputValue(), '');
  pass('本地音色选择保留草稿、隐藏云参数、不提交密钥，切回云朗读保留原音色');
  await page.evaluate(() => window.fixtureState({phase:'speaking',active:false,dictating:false,message:'正在朗读'})); await pause();
  assert(await page.getByRole('button', { name: '停止语音', exact: true }).isVisible()); assert(await page.getByRole('button', { name: '保存语音设置', exact: true }).isDisabled());
  pass('识别和朗读密钥独立提交并清空；设置页保留全局停止入口');
  assert(!await page.locator('.live-form').isVisible());
  await page.getByRole('button',{name:'停止语音',exact:true}).click();await pause();
  await page.getByRole('button',{name:'保存语音设置',exact:true}).click();await pause();
  await page.evaluate(()=>window.fixtureLive());await pause();
  const live=page.locator('.live-form');
  await live.locator('[name="mode"]').selectOption('realtime');await live.locator('[name="kind"]').selectOption('gemini');
  await live.getByLabel('实时模型',{exact:true}).fill('fixture-gemini');await live.getByLabel('实时语音密钥',{exact:true}).fill('UI_TEST_LIVE');
  await page.evaluate(()=>window.fixtureSelect('welcome'));await pause();assert.equal(await live.getByLabel('实时模型',{exact:true}).inputValue(),'fixture-gemini');
  const starts=await page.evaluate(()=>window.calls.filter(c=>c.method==='voice.start').length);
  await live.getByRole('button',{name:'保存语音模式',exact:true}).click();await pause();
  const liveSaved=await page.evaluate(()=>window.calls.findLast(c=>c.method==='voice.live.save').p);
  assert.equal(liveSaved.kind,'gemini');assert.equal(liveSaved.mode,'realtime');assert.equal(liveSaved.apiKey,'UI_TEST_LIVE');
  assert.equal(await live.getByLabel('实时语音密钥',{exact:true}).inputValue(),'');
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='voice.start').length),starts);
  for(const width of [360,430,768]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await live.scrollIntoViewIfNeeded();await page.screenshot({path:`${output}/live-${width}.png`});}
  await page.evaluate(()=>window.fixtureState({phase:'connecting',active:true,dictating:false,sessionMode:'conversation',message:'正在连接实时语音'}));await pause();
  assert(await live.getByRole('button',{name:'保存语音模式',exact:true}).isDisabled());assert(await page.getByRole('button',{name:'停止语音',exact:true}).isVisible());
  pass('Live 按能力展示，草稿抗轮询、独立密钥保存后清空、不自动开麦、活动时锁定配置');
  assert.deepEqual(errors, []);
} finally { await browser.close(); await new Promise(r => server.close(r)); await writeFile(`${output}/result.json`, JSON.stringify({ results, errors }, null, 2)); }
