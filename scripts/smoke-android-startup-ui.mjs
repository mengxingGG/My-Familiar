import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const output='.artifacts/android-startup-ui';await mkdir(output,{recursive:true});
const bundle=await build({stdin:{contents:`
import {mountApp} from './apps/tauri/ui/app.ts';import {createPreviewBridge} from './apps/tauri/preview/fixture.ts';
const f=createPreviewBridge({nativeControls:true}),state=await f.request('snapshot.get');f.dispose();let listener;
state.startup={enabled:false,overlayGranted:true,lastResult:'none',lastAttemptAt:0,detail:'尚无开机启动记录。'};
window.calls=[];window.state=state;window.emit=()=>{state.revision++;listener?.(structuredClone(state));};
mountApp({subscribe(fn){listener=fn;return()=>{};},async request(method,p){window.calls.push({method,p});
if(method==='snapshot.get'){state.revision++;return structuredClone(state);}
if(method==='runtime.startup.save'){if(window.fail)throw {code:'UNAVAILABLE'};if(window.delayed)await new Promise(r=>window.finish=r);state.startup.enabled=p.enabled;return structuredClone(state.startup);}
throw Error(method);}});
`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser'});
const server=createServer(async(req,res)=>{if(req.url==='/app.js'){res.setHeader('content-type','text/javascript');res.end(bundle.outputFiles[0].contents);}else if(req.url==='/style.css'){res.setHeader('content-type','text/css');res.end(await readFile('apps/tauri/ui/style.css'));}else if(/^\/characters\/[a-z]+\/idle-0.svg$/.test(req.url)){res.setHeader('content-type','image/svg+xml');res.end(await readFile(req.url.slice(1)));}else{res.setHeader('content-type','text/html;charset=utf-8');res.end(await readFile('apps/tauri/ui/index.html'));}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:390,height:844}}),errors=[],results=[];
page.on('pageerror',e=>errors.push(e.message));const pass=name=>{results.push(name);console.log('PASS '+name);};const checkbox=page.getByLabel('开机启动伙伴',{exact:true});
try{
 await page.goto(`http://127.0.0.1:${server.address().port}`);await checkbox.waitFor();assert(!await checkbox.isChecked());
 await page.evaluate(()=>window.fail=true);await checkbox.click();await page.waitForFunction(()=>document.body.textContent.includes('未能保存开机设置'));assert(!await checkbox.isChecked());await page.evaluate(()=>window.fail=false);pass('默认关闭，保存失败不把偏好显示成已开启');
 await page.evaluate(()=>window.delayed=true);await checkbox.click();await page.waitForFunction(()=>!!window.finish);assert(await checkbox.isDisabled());assert(!await checkbox.isChecked());await page.evaluate(()=>{window.delayed=false;window.finish();});await page.waitForFunction(()=>document.querySelector('[aria-label="开机启动伙伴"]').checked);pass('等待原生保存与快照确认，保存期间锁定开关');
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='runtime.set'||c.method==='voice.start'||c.method==='voice.wake.start').length),0);assert.match(await page.locator('.res-startup').innerText(),/小米/);pass('启用只保存未来开机偏好，当前常驻、麦克风和唤醒不自动启动');
 await page.evaluate(()=>{window.state.startup.overlayGranted=false;window.state.startup.lastResult='permission';window.state.startup.detail='上次开机未启动：悬浮窗权限未开启。';window.emit();});assert(!await checkbox.isDisabled());await checkbox.click();await page.waitForFunction(()=>!document.querySelector('[aria-label="开机启动伙伴"]').checked);assert(await checkbox.isDisabled());assert.match(await page.locator('.res-startup').innerText(),/请先允许悬浮窗/);pass('权限被撤回时仍可关闭偏好，重新开启前提示授权');
 await page.evaluate(()=>{window.state.startup.overlayGranted=true;window.emit();});
 for(let n=0;n<4&&await page.getByRole('button',{name:'关闭提示',exact:true}).count();n++){await page.getByRole('button',{name:'关闭提示',exact:true}).first().click();await page.waitForTimeout(300);}
 for(const width of [360,390,430,768]){await page.setViewportSize({width,height:844});await checkbox.scrollIntoViewIfNeeded();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:output+'/startup-'+width+'.png'});}pass('常驻卡片的四种宽度无横向溢出');
 await page.evaluate(()=>{delete window.state.startup;window.emit();});await page.waitForFunction(()=>document.querySelector('.res-startup').hidden);pass('旧宿主隐藏开机设置');assert.deepEqual(errors,[]);
}finally{await browser.close();await new Promise(r=>server.close(r));await writeFile(output+'/result.json',JSON.stringify({results,errors},null,2));}
