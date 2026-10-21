import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
const app='app.familiar.mobile.debug',out=process.env.FAMILIAR_BUBBLE_CHAT_REPORT_DIR??'.artifacts/android-bubble-chat',cdp=9266;
await mkdir(out,{recursive:true});
const adb=(...a)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...a],{encoding:'utf8',windowsHide:true,timeout:30000}).trim();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const requests=[],checks=[],conversations=[];let hold=false,browser,page,before,changed=false,seq=0,initialIme;
const proof={date:new Date().toISOString(),checks};
const pass=name=>{checks.push(name);console.log('PASS '+name);};
const server=createServer(async(req,res)=>{
 if(req.url.endsWith('/models')){res.end(JSON.stringify({data:[{id:'bubble-device-fixture'}]}));return;}
 let body='';for await(const chunk of req)body+=chunk;const data=JSON.parse(body);requests.push(data);
 const user=data.messages.filter(m=>m.role==='user').at(-1).content;
 res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${JSON.stringify({choices:[{delta:{content:'气泡收到：'+user},finish_reason:null}]})}\n\n`);
 if(!hold){const timer=setTimeout(()=>res.end(`data: ${JSON.stringify({choices:[{delta:{content:'。我们接着聊。'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`),1000);res.on('close',()=>clearTimeout(timer));}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
const raw=(method,params)=>page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:'bubble-'+(++seq),method,params});
const call=async(method,params)=>{const r=await raw(method,params);assert(r.ok,JSON.stringify(r));return r.result;};
async function until(check,timeout=20000){for(const end=Date.now()+timeout;Date.now()<end;){if(await check())return;await pause(180);}throw Error('Bubble device timeout');}
function box(title){const w=adb('shell','dumpsys','window','windows').split(/  Window #/).find(b=>b.includes(`u0 ${title}}`)&&b.includes('mHasSurface=true'));const m=w?.match(/Frames:.*? frame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);return m?{x:+m[1],y:+m[2],w:+m[3]-m[1],h:+m[4]-m[2]}:null;}
async function xml(){adb('shell','uiautomator','dump','/sdcard/familiar-bubble-check.xml');return adb('shell','cat','/sdcard/familiar-bubble-check.xml');}
function element(data,name){const parts=[...data.matchAll(/<node\b[^>]+>/g)].map(m=>m[0]);const item=parts.find(s=>s.includes(`content-desc="${name}"`)||s.includes(`text="${name}"`));assert(item,'Missing actual native control '+name);const m=item.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);assert(m);return {x:(+m[1]+ +m[3])/2,y:(+m[2]+ +m[4])/2,raw:item};}
async function tap(name){const p=element(await xml(),name);adb('shell','input','tap',String(Math.round(p.x)),String(Math.round(p.y)));await pause(250);}
async function pet(){const b=box('FamiliarPet');assert(b);adb('shell','input','tap',String(b.x+b.w/2),String(b.y+b.h/2));await until(()=>!!box('FamiliarChat'));await pause(800);}
async function type(value){await tap('气泡聊天输入');adb('shell','input','text',value);await pause(200);}
async function shot(name){await writeFile(out+'/'+name+'.png',execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554','exec-out','screencap','-p'],{windowsHide:true,maxBuffer:16*1024*1024}));}
try{
 initialIme=adb('shell','settings','get','secure','default_input_method');
 adb('shell','am','start','-n',app+'/app.familiar.mobile.MainActivity');
 for(const end=Date.now()+45000;Date.now()<end&&!page;){
  try{const pid=adb('shell','pidof',app);if(adb('shell','cat','/proc/net/unix').includes('webview_devtools_remote_'+pid)){
   adb('forward','tcp:'+cdp,'localabstract:webview_devtools_remote_'+pid);browser=await chromium.connectOverCDP('http://127.0.0.1:'+cdp,{timeout:1500});page=browser.contexts()[0].pages()[0];
  }}catch{await browser?.close();browser=null;}if(!page)await pause(300);
 }assert(page,'WebView did not become available');await page.locator('#familiar-root[data-ready="true"]').waitFor();
 before=await call('snapshot.get');assert(before.providers.every(p=>!p.profile.keyConfigured)&&!before.activeReply&&!before.tasks.length&&!before.voice.state.active&&!before.voice.wake.armed);await writeFile(out+'/before.json',JSON.stringify(before,null,2));
 proof.apkSha256=createHash('sha256').update(await readFile('apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk')).digest('hex');assert.equal(adb('shell','sha256sum',adb('shell','pm','path',app).replace(/^package:/,'')).split(/\s/)[0],proof.apkSha256);
 adb('reverse','tcp:'+port,'tcp:'+port);changed=true;
 await call('runtime.set',{enabled:true});await call('pet.settings.save',{scale:before.pet.scale,visible:true,quiet:true,bubbleSeconds:2});await call('pet.docking.save',{snapToEdge:false,hideWhenIdle:true,delaySeconds:10});
 await call('provider.save',{kind:'compatible',baseUrl:`http://127.0.0.1:${port}/v1`,model:'bubble-device-fixture',clearApiKey:true});const id=(await call('conversation.create')).id;conversations.push(id);
 adb('shell','input','keyevent','KEYCODE_HOME');await pause(700);await pet();
 assert(!/mResumedActivity:.*app\.familiar\.mobile\.debug/.test(adb('shell','dumpsys','activity','activities')));assert.match(await xml(),/气泡聊天输入/);await shot('chat-open');pass('轻点完整宠物打开原生气泡输入，主应用未进入前台');
 await type('hello');adb('shell','input','keyevent','KEYCODE_ENTER');adb('shell','input','text','again');assert.equal(requests.length,0);await tap('发送气泡消息');
 await until(async()=>requests.length===1&&!(await call('snapshot.get')).activeReply);assert.equal(requests[0].messages.filter(m=>m.role==='user').at(-1).content,'hello\nagain');
 await pause(3000);assert(box('FamiliarChat'));assert.match(await xml(),/气泡收到/);pass('真实输入回车换行、实体发送及流式回复，回复结束后保持气泡');
 await type('continue');await tap('发送气泡消息');await until(async()=>requests.length===2&&!(await call('snapshot.get')).activeReply);assert(requests[1].messages.some(m=>m.role==='assistant'&&String(m.content).includes('hello\nagain')));await shot('chat-continuous');pass('气泡中连续第二轮使用同一会话及完整上一轮上下文');
 hold=true;await type('slow');await tap('发送气泡消息');await until(()=>requests.length===3);await tap('停止回复');await until(async()=>!(await call('snapshot.get')).activeReply);assert(box('FamiliarChat'));pass('气泡内实体停止流式回复，无需打开应用');
 await type('keep_draft');await tap('收起');await until(()=>!box('FamiliarChat'));await pause(500);await pet();assert.match(element(await xml(),'气泡聊天输入').raw,/keep_draft/);pass('收起后再次点宠物，原输入草稿保留');
 const next=(await call('conversation.create')).id;conversations.push(next);await pause(1000);assert.match(await xml(),/切换到当前对话/);assert.match(element(await xml(),'气泡聊天输入').raw,/keep_draft/);assert.equal(requests.length,3);
 await pet();assert.match(await xml(),/切换到当前对话/);assert.match(element(await xml(),'气泡聊天输入').raw,/keep_draft/);pass('会话冲突时再次点宠物，切换提示重新获得焦点且保留草稿');
 await tap('切换到当前对话');await pause(900);assert(!element(await xml(),'气泡聊天输入').raw.includes('keep_draft'));
 await call('conversation.select',{id});await pause(800);await tap('切换到当前对话');await pause(900);assert.match(element(await xml(),'气泡聊天输入').raw,/keep_draft/);await shot('chat-restored-draft');pass('应用切换会话时保留原草稿，明确切换后按会话恢复，不串发');
 adb('shell','input','keyevent','KEYCODE_BACK');await pause(600);assert(box('FamiliarChat'));assert.equal(adb('shell','settings','get','secure','default_input_method'),initialIme);pass('返回释放输入焦点并保留气泡，使用原有设备输入法');
 await pet();await tap('收起');await until(()=>!box('FamiliarChat'));
}catch(error){proof.error=String(error);console.error(error);try{await shot('failure');await writeFile(out+'/failure-ui.xml',await xml());}catch{}process.exitCode=1;}
finally{
 try{if(changed){
  await call('reply.cancel');await call('snapshot.get',{controllerActive:true});await pause(500);
  const profile=before.providers.find(p=>p.id==='compatible').profile;await call('provider.save',{kind:'compatible',baseUrl:profile.baseUrl,model:profile.model,clearApiKey:true});if(before.provider.kind!=='compatible')await call('provider.save',{kind:before.provider.kind,baseUrl:before.provider.baseUrl,model:before.provider.model});
  if(before.activeConversationId)await call('conversation.select',{id:before.activeConversationId});for(const id of conversations)await call('conversation.delete',{id});
  await call('pet.settings.save',{scale:before.pet.scale,visible:before.pet.visible,quiet:before.pet.quiet,bubbleSeconds:before.pet.bubbleSeconds});await call('pet.docking.save',{snapToEdge:before.pet.docking.snapToEdge,hideWhenIdle:before.pet.docking.hideWhenIdle,delaySeconds:before.pet.docking.delaySeconds});
  const after=await call('snapshot.get');assert.deepEqual(after.providers,before.providers);assert.equal(after.activeConversationId,before.activeConversationId);assert.deepEqual(after.conversations.map(c=>c.id),before.conversations.map(c=>c.id));proof.restored=true;pass('测试会话与模型已清理，原配置恢复');
 }}catch(error){proof.restoreError=String(error);console.error(error);process.exitCode=1;}
 await browser?.close();try{if(adb('forward','--list').includes('tcp:'+cdp))adb('forward','--remove','tcp:'+cdp);if(adb('reverse','--list').includes('tcp:'+port))adb('reverse','--remove','tcp:'+port);}catch{}server.closeAllConnections();await new Promise(r=>server.close(r));await writeFile(out+'/result.json',JSON.stringify(proof,null,2));
}
