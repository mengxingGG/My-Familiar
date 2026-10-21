import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const out='.artifacts/release-1.1.0/update-ui';await mkdir(out,{recursive:true});
const base={currentVersion:'1.1.0',platform:'android-arm64',phase:'available',latestVersion:'1.2.0',assetName:'Familiar-1.2.0-arm64.apk',downloadedBytes:0,totalBytes:10000000,checkedAt:Date.now(),error:null};
const result=await build({stdin:{contents:`import {UpdateView} from './apps/tauri/ui/updates.ts';window.calls=[];let state=${JSON.stringify(base)};const view=new UpdateView({request:async(method)=>{window.calls.push(method);state={...state,phase:method==='updates.download'?'downloading':method==='updates.cancel'?'available':state.phase};return state;}});window.publish=s=>{state={...state,...s};view.sync(state)};document.querySelector('#familiar-root').append(view.root);view.sync(state);`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser'});
const files={'/mobile.js':result.outputFiles[0].contents,'/style.css':await readFile('apps/tauri/ui/style.css'),'/pet.js':await readFile('plugins/renderer-sprite/ui/pet.js'),'/pet.css':await readFile('plugins/renderer-sprite/ui/style.css')};
const server=createServer(async(req,res)=>{const u=new URL(req.url,'http://localhost');if(files[u.pathname]){res.setHeader('content-type',u.pathname.endsWith('.css')?'text/css':'text/javascript');res.end(files[u.pathname]);return;}res.setHeader('content-type','text/html; charset=utf-8');if(u.pathname==='/pet'){res.end((await readFile('plugins/renderer-sprite/ui/index.html','utf8')).replace('href="style.css"','href="pet.css"'));return;}res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="style.css"><div id="familiar-root" style="padding:16px"></div><script type="module" src="mobile.js"></script>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({channel:'msedge',headless:true}),checks=[],errors=[];
try{
 for(const [width,height] of [[320,700],[360,760],[800,390]]){
  const page=await browser.newPage({viewport:{width,height}});page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await page.getByText('发现新版本 1.2.0').waitFor();
  await page.getByRole('button',{name:'下载更新',exact:true}).click();await page.getByText(/下载中 0%/).waitFor();assert.deepEqual(await page.evaluate(()=>window.calls),['updates.download']);
  await page.evaluate(()=>window.publish({phase:'downloading',downloadedBytes:5000000}));await page.getByText(/下载中 50%/).waitFor();
  await page.getByRole('button',{name:'取消下载'}).click();assert((await page.evaluate(()=>window.calls)).includes('updates.cancel'));
  await page.evaluate(()=>window.publish({phase:'ready',downloadedBytes:10000000}));await page.getByRole('button',{name:'安装更新'}).click();assert.equal((await page.evaluate(()=>window.calls)).at(-1),'updates.open');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:out+`/android-${width}x${height}.png`});await page.close();
 }
 checks.push('Android 更新提醒在窄屏、竖屏及横屏显示，下载/进度/取消/安装命令正确');
 const page=await browser.newPage({viewport:{width:260,height:300}});page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(state=>{window.calls=[];window.handlers={};window.familiar={on:(name,fn)=>window.handlers[name]=fn,request:async(method)=>{window.calls.push(method);return method.startsWith('updates.')?state:undefined;}};}, {...base,platform:'windows-x64',assetName:'Familiar-1.2.0-Setup-x64.exe'});
 await page.goto(url+'/pet');await page.getByRole('button',{name:'发现 1.2.0 · 点击更新'}).click();assert((await page.evaluate(()=>window.calls)).includes('updates.download'));
 await page.evaluate(state=>window.handlers['familiar:update']({...state,phase:'ready',downloadedBytes:10000000}),{...base,platform:'windows-x64',assetName:'Familiar-1.2.0-Setup-x64.exe'});await page.getByRole('button',{name:'更新已下载 · 打开安装包'}).click();assert.equal((await page.evaluate(()=>window.calls)).at(-1),'updates.open');await page.screenshot({path:out+'/windows-pet.png'});await page.close();
 checks.push('Windows 宠物主动显示新版入口，点击下载及完成后打开安装包位置');
 assert.deepEqual(errors,[]);for(const c of checks)console.log('PASS '+c);
}finally{await browser.close();await new Promise(r=>server.close(r));await writeFile(out+'/result.json',JSON.stringify({checks,errors},null,2));}
