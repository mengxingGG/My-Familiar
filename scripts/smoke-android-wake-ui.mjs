import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const out='.artifacts/android-wake-ui';await mkdir(out,{recursive:true});
const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`
import {mountApp} from './apps/tauri/ui/app.ts';import {createPreviewBridge} from './apps/tauri/preview/fixture.ts';
const fixture=createPreviewBridge(),s=await fixture.request('snapshot.get');fixture.dispose();
const profile={kind:'compatible',baseUrl:'https://fixture.invalid/v1',model:'test',keyConfigured:false};
s.voice={localTts:true,settings:{stt:profile,tts:{...profile,voice:'test',speed:1},autoRead:false,continuous:true},state:{phase:'off',active:false,dictating:false,message:'语音未开启'},maxRecordingSeconds:90};
s.capabilities=s.capabilities.filter(c=>c.id!=='microphone');s.capabilities.push({id:'microphone',title:'麦克风',state:'notGranted',description:'fixture',detail:'fixture'});
let listener;window.calls=[];const publish=()=>{s.revision++;listener?.(structuredClone(s));};
window.addWake=()=>{s.voice.wake={enabled:false,phrases:[],sensitivity:50,armed:false,listening:false,message:'唤醒待机未开启'};publish();};
window.pulse=publish;
mountApp({subscribe(fn){listener=fn;publish();return()=>{};},async request(method,p){window.calls.push({method,p});
if(method==='snapshot.get')return structuredClone(s);
if(method==='voice.wake.save'){s.voice.wake={...s.voice.wake,...p};publish();return;}
if(method==='capability.request'){s.capabilities.find(c=>c.id==='microphone').state='granted';publish();return;}
if(method==='voice.wake.start'){s.voice.wake.armed=true;s.voice.wake.listening=true;s.voice.wake.message='离线唤醒待机中';s.voice.state={phase:'sleeping',active:false,dictating:false,sessionMode:'conversation',message:'等待唤醒'};publish();return;}
if(method==='voice.stop'){s.voice.wake.armed=false;s.voice.wake.listening=false;s.voice.wake.message='唤醒待机已停止';s.voice.state={phase:'off',active:false,dictating:false,message:'语音已停止'};publish();return;}
throw Error('unsupported fixture method');}});`},bundle:true,write:false,format:'esm',platform:'browser'});
const server=createServer(async(req,res)=>{
 if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].contents);}
 else if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end(await readFile('apps/tauri/ui/style.css'));}
 else if(/^\/characters\/[a-z]+\/idle-0.svg$/.test(req.url)){res.setHeader('Content-Type','image/svg+xml');res.end(await readFile('.'+req.url));}
 else {res.setHeader('Content-Type','text/html');res.end('<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="familiar-root"></div><script type="module" src="/app.js"></script>');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:360,height:640}});const results=[],errors=[];page.on('pageerror',e=>errors.push(String(e)));const pass=s=>{results.push(s);console.log('PASS',s);};
try{
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#familiar-root[data-ready="true"]').waitFor();
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByText('语音连接',{exact:true}).click();
 assert(!(await page.locator('.wake-form').isVisible()));pass('旧宿主没有唤醒能力时不显示入口');
 await page.evaluate(()=>window.addWake());await page.locator('.wake-form').waitFor();
 const form=page.locator('.wake-form');await form.locator('[name=enabled]').check();await form.locator('[name=phrases]').fill('小森\nLIGHT UP');await page.evaluate(()=>window.pulse());assert.equal(await form.locator('[name=phrases]').inputValue(),'小森\nLIGHT UP');assert(await form.locator('.wake-start').isDisabled());pass('编辑草稿不被轮询覆盖，未保存不能启动');
 await form.getByRole('button',{name:'保存唤醒设置',exact:true}).click();await page.waitForFunction(()=>window.calls.some(v=>v.method==='voice.wake.save'));await page.waitForTimeout(100);assert.equal((await page.evaluate(()=>window.calls.filter(v=>v.method==='voice.wake.start'))).length,0);pass('保存唤醒设置不会开启录音');
 await form.locator('.wake-start').click();await page.waitForFunction(()=>window.calls.some(v=>v.method==='capability.request'));assert.equal((await page.evaluate(()=>window.calls.filter(v=>v.method==='voice.wake.start'))).length,0);pass('缺少麦克风权限时只请求授权，需要再次主动启动');
 await form.locator('.wake-start').click();await page.waitForFunction(()=>window.calls.some(v=>v.method==='voice.wake.start'));await page.waitForTimeout(100);
 assert(await form.locator('[name=phrases]').isDisabled());assert(!(await form.locator('.wake-stop').isDisabled()));assert(await page.getByRole('button',{name:'停止语音',exact:true}).isVisible());pass('待机状态显示停止入口，禁止冲突修改');
 await form.locator('.wake-stop').click();await page.waitForFunction(()=>window.calls.some(v=>v.method==='voice.stop'));await page.waitForTimeout(100);assert(!(await form.locator('[name=phrases]').isDisabled()));
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await form.scrollIntoViewIfNeeded();await page.screenshot({path:out+'/wake-settings.png'});assert.deepEqual(errors,[]);pass('停止后恢复编辑，360px 页面无横向溢出');
}finally{await browser.close();await new Promise(r=>server.close(r));await writeFile(out+'/result.json',JSON.stringify({results,errors},null,2));}
