import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
const app='app.familiar.mobile.debug', fixture='app.familiar.fixture';
const adb=(...args)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...args],{encoding:'utf8',windowsHide:true}).trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let mode='camera',step=0,observed,received,requestCount=0;
const server=createServer(async(req,res)=>{
 if(req.url.endsWith('/models')){res.end(JSON.stringify({data:[{id:'capture-fixture'}]}));return;}
 let body='';for await(const chunk of req)body+=chunk;received=JSON.parse(body);requestCount++;
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 let delta,finish='stop';
 if(mode!=='camera'&&step<2){
  let name='android_screen',args={};
  if(step===1){observed=JSON.parse(received.messages.filter(m=>m.role==='tool').at(-1).content);name='android_screenshot';args={snapshotId:observed.snapshotId};}
  delta={tool_calls:[{index:0,id:`capture-${++step}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]};finish='tool_calls';
 }else delta={content:'本地采集验证完成'};
 res.end(`data: ${JSON.stringify({choices:[{delta,finish_reason:finish}]})}\n\ndata: [DONE]\n\n`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;adb('reverse',`tcp:${port}`,`tcp:${port}`);
let browser,overlayBrowser,page,before,sequence=0;const conversations=[],assets=new Set(),results=[]; const previousAssets=new Set(adb('shell','run-as',app,'ls','files/data').split(/\r?\n/));
const call=async(method,params)=>{const reply=await page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:`capture-${++sequence}`,method,params});assert(reply.ok,`${method}: ${reply.error?.code}`);return reply.result;};
async function until(predicate){const end=Date.now()+30000;do{const state=await call('snapshot.get');if(predicate(state))return state;await sleep(100);}while(Date.now()<end);throw Error('capture device timeout');}
function nodes(){adb('shell','uiautomator','dump','/sdcard/familiar-capture-window.xml');return [...adb('shell','cat','/sdcard/familiar-capture-window.xml').matchAll(/<node\b[^>]+>/g)].map(m=>Object.fromEntries([...m[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],a[2]])));}
function tapText(text){const n=nodes().find(n=>n.text?.toLowerCase()===text.toLowerCase());assert(n,`Missing ${text}`);const b=[...n.bounds.matchAll(/\d+/g)].map(m=>Number(m[0]));adb('shell','input','tap',String(Math.round((b[0]+b[2])/2)),String(Math.round((b[1]+b[3])/2)));}
async function approve(name){
 if(!overlayBrowser){for(let i=0;i<60;i++){try{const pid=adb('shell','pidof',`${app}:runtime`);adb('forward','tcp:9225',`localabstract:webview_devtools_remote_${pid}`);overlayBrowser=await chromium.connectOverCDP('http://127.0.0.1:9225');break;}catch{await sleep(200);}}assert(overlayBrowser);}
 let p;for(let i=0;i<60;i++){p=overlayBrowser.contexts()[0].pages().find(p=>p.url().includes('/approval/index.html'));if(p)break;await sleep(100);}assert(p);
 const button=p.getByRole('button',{name});await button.waitFor();for(let i=0;i<40&&!(await button.isEnabled());i++)await sleep(100);
 const box=await button.boundingBox(),view=await p.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}));
 const display=adb('shell','wm','size').match(/Physical size: (\d+)x(\d+)/);
 const x=(Number(display[1])-view.width*view.dpr)/2+(box.x+box.width/2)*view.dpr,y=Number(display[2])-24*view.dpr-view.height*view.dpr+(box.y+box.height/2)*view.dpr;
 adb('shell','input','tap',String(Math.round(x)),String(Math.round(y)));await sleep(400);
}
function images(){return [...JSON.stringify(received).matchAll(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g)].map(m=>m[0]);}
function pass(name){results.push({name,passed:true});console.log(`PASS ${name}`);}
try{
 adb('shell','am','start','-n',`${app}/app.familiar.mobile.MainActivity`);
 for(let i=0;i<60;i++){try{const pid=adb('shell','pidof',app);adb('forward','tcp:9223',`localabstract:webview_devtools_remote_${pid}`);browser=await chromium.connectOverCDP('http://127.0.0.1:9223');break;}catch{await sleep(200);}}
 assert(browser);page=browser.contexts()[0].pages()[0];await page.waitForFunction(()=>!!window.__TAURI_INTERNALS__);
 before=await until(s=>s.runtime.engine==='ready');assert(!before.activeReply&&before.providers.every(p=>!p.profile.keyConfigured));assert.equal(before.capabilities.find(c=>c.id==='accessibility').state,'granted');
 await call('provider.save',{kind:'compatible',baseUrl:`http://127.0.0.1:${port}/v1`,model:'capture-fixture',apiKey:'capture-fixture-key'});await call('runtime.set',{enabled:true});
 if(!(await page.locator('.page-chat').isVisible())){await page.getByRole('button',{name:'小窝',exact:true}).click();await page.getByRole('button',{name:'说句话',exact:true}).click();}
 assert.equal(before.media.camera,false);assert.equal(await page.getByRole('button',{name:'用系统相机拍照',exact:true}).count(),0);
 pass('无系统相机时 capability/media 均不可用且 UI 不显示拍照入口');
 for(mode of ['allow','deny','stale','secure']){
  step=0;received=undefined;observed=undefined;
  adb('shell','am','force-stop',fixture);adb('shell','am','start','-n',`${fixture}/.FixtureActivity`);await sleep(500);
  if(mode==='secure'){tapText('Protect window');await sleep(400);}
  const conversation=(await call('conversation.create')).id;conversations.push(conversation);await call('message.send',{conversationId:conversation,text:`窗口截图验收 ${mode}`});
  const first=await until(s=>s.tasks.length===1);await approve(/^允许这一步/);
  await until(s=>s.tasks.length===1&&s.tasks[0].id!==first.tasks[0].id);assert.equal(observed.package,fixture);
  if(mode==='stale'){adb('shell','input','keyevent','KEYCODE_HOME');await sleep(600);}
  await approve(mode==='deny'?/^拒绝这一步/:/^允许这一步/);await until(s=>!s.activeReply&&s.tasks.length===0);
  assert.equal(received.messages.filter(m=>m.role==='tool').at(-1)?.tool_call_id, 'capture-2', '模型必须收到截图执行结果，取消回复不算拒绝/失效窗口验证');
  const captured=images();
  if(mode==='allow'){
   assert.equal(captured.length,1,JSON.stringify(received).slice(-1500));
   const stats=await page.evaluate(async url=>{const image=new Image();image.src=url;await image.decode();const c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;const x=c.getContext('2d');x.drawImage(image,0,0);const d=x.getImageData(0,Math.floor(c.height/2),c.width,Math.floor(c.height/2)).data;let blue=0;for(let i=0;i<d.length;i+=4)if(Math.abs(d[i]-25)<15&&Math.abs(d[i+1]-115)<15&&Math.abs(d[i+2]-175)<15)blue++;return{width:c.width,height:c.height,blue:blue/(d.length/4)};},captured[0]);
   assert(stats.width>500&&stats.height>500);assert(stats.blue>0.96,JSON.stringify(stats));
   const bytes=Buffer.from(captured[0].split(',')[1],'base64');await writeFile('.artifacts/android-device/captured-window.jpg',bytes);
   results.push({name:'截图像素证据',...stats,sha256:createHash('sha256').update(bytes).digest('hex'),passed:true});
  }else assert.equal(captured.length,0,`${mode} unexpectedly uploaded a screenshot`);
  pass({allow:'实体批准后收到应用窗口原图，下半屏超过 96% 靶场蓝色，宠物和审批层未混入',deny:'拒绝截图没有图片进入模型',stale:'审批期间窗口改变，旧 snapshotId 截图失败',secure:'FLAG_SECURE 受保护窗口拒绝截图，模型未收到图片'}[mode]);
 }
}finally{
 if(page&&before){
  await call('reply.cancel').catch(()=>{});await call('provider.save',{kind:'compatible',baseUrl:`http://127.0.0.1:${port}/v1`,model:'capture-fixture',clearApiKey:true}).catch(()=>{});
  const profile=before.providers.find(p=>p.id==='compatible').profile;await call('provider.save',{kind:'compatible',baseUrl:profile.baseUrl,model:profile.model,clearApiKey:true}).catch(()=>{});
  if(before.provider.kind!=='compatible')await call('provider.save',{kind:before.provider.kind,baseUrl:before.provider.baseUrl,model:before.provider.model}).catch(()=>{});
  for(const id of conversations)await call('conversation.delete',{id}).catch(()=>{});if(before.activeConversationId)await call('conversation.select',{id:before.activeConversationId}).catch(()=>{});
  await call('runtime.set',{enabled:before.runtime.running}).catch(()=>{});
  // 只清理本次靶场截图：目录差集、UUID 文件名、screen 来源同时吻合。
  for(const file of adb('shell','run-as',app,'ls','files/data').split(/\r?\n/))if(!previousAssets.has(file)&&/^attachment-[a-f0-9-]{36}\.json$/.test(file)){
   const stored=JSON.parse(adb('shell','run-as',app,'cat',`files/data/${file}`));
   if(stored.attachment?.source==='screen'&&/^屏幕-\d+\.jpg$/.test(stored.attachment.name))assets.add(stored.attachment.id);
  }
  for(const id of assets)if(/^[a-f0-9-]{36}$/.test(id))for(const path of [`files/data/attachment-${id}.json`,`files/media-previews/${id}.jpg`])adb('shell','run-as',app,'rm','-f',path);
 }
 await overlayBrowser?.close();await browser?.close();adb('reverse','--remove',`tcp:${port}`);server.closeAllConnections();await new Promise(r=>server.close(r));
 await writeFile('.artifacts/android-device/capture-smoke.json',JSON.stringify({testedAt:new Date().toISOString(),camera:'unavailable: no preinstalled system camera; live capture and physical lens not verified',results},null,2));
}
