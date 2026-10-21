import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
const app='app.familiar.mobile.debug',out=process.env.FAMILIAR_BUBBLE_LAYOUT_REPORT_DIR??'.artifacts/android-bubble-refine/layout',cdp=9273;
await mkdir(out,{recursive:true});
const adb=(...a)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...a],{encoding:'utf8',windowsHide:true,timeout:30000}).trim();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const checks=[],conversations=[],proof={date:new Date().toISOString(),checks,geometry:[]};
let browser,page,before,originalBox,changed=false,seq=0;
const longReply=Array.from({length:18},(_,i)=>`${String(i+1).padStart(2,'0')} · 今天也慢慢来，想说的话我都在听。`).join('\n');
const server=createServer(async(req,res)=>{
 if(req.url.endsWith('/models')){res.end(JSON.stringify({data:[{id:'bubble-layout-fixture'}]}));return;}
 let raw='';for await(const chunk of req)raw+=chunk;const b=JSON.parse(raw);
 const last=b.messages.filter(m=>m.role==='user').at(-1).content;
 res.writeHead(200,{'content-type':'text/event-stream'});
 res.end(`data: ${JSON.stringify({choices:[{delta:{content:last==='long'?longReply:'在呢，慢慢说。'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
const pass=name=>{checks.push(name);console.log('PASS '+name);};
const call=async(method,params)=>{const r=await page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:'bubble-layout-'+(++seq),method,params});assert(r.ok,method+': '+r.error?.code);return r.result;};
async function until(check,timeout=20000){for(const end=Date.now()+timeout;Date.now()<end;){if(await check())return;await delay(200);}throw Error('Layout timeout');}
function box(name){const b=adb('shell','dumpsys','window','windows').split(/  Window #/).find(b=>b.includes(`u0 ${name}}`)&&b.includes('mHasSurface=true'));const m=b?.match(/Frames:.*? frame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);return m?{x:+m[1],y:+m[2],w:+m[3]-m[1],h:+m[4]-m[2]}:null;}
async function ui(){adb('shell','uiautomator','dump','/sdcard/familiar-bubble-layout.xml');return adb('shell','cat','/sdcard/familiar-bubble-layout.xml');}
function nodes(xml){return [...xml.matchAll(/<node\b[^>]+>/g)].map(m=>Object.fromEntries([...m[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],a[2]])));}
function bounds(n){assert(n);const p=[...n.bounds.matchAll(/\d+/g)].map(m=>+m[0]);return {x:p[0],y:p[1],w:p[2]-p[0],h:p[3]-p[1]};}
async function tap(label){const p=bounds(nodes(await ui()).find(n=>n['content-desc']===label||n.text===label));adb('shell','input','tap',String(Math.round(p.x+p.w/2)),String(Math.round(p.y+p.h/2)));await delay(250);}
async function pet(){const p=box('FamiliarPet');assert(p);adb('shell','input','tap',String(p.x+p.w/2),String(p.y+p.h/2));await until(()=>!!box('FamiliarChat'));await delay(700);}
async function drag(x,y){const p=box('FamiliarPet');assert(p);adb('shell','input','swipe',String(p.x+p.w/2),String(p.y+p.h/2),String(x),String(y),'400');await delay(750);}
async function shot(name){await writeFile(out+'/'+name+'.png',execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554','exec-out','screencap','-p'],{windowsHide:true,maxBuffer:16*1024*1024}));}
function geometry(name){const chat=box('FamiliarChat'),pet=box('FamiliarPet');assert(chat&&pet);assert(chat.x>=32&&chat.y>=128&&chat.x+chat.w<=1408&&chat.y+chat.h<=2528,JSON.stringify(chat));assert(!/mResumedActivity:.*app\.familiar\.mobile\.debug/.test(adb('shell','dumpsys','activity','activities')));proof.geometry.push({name,chat,pet});return {chat,pet};}
try{
 adb('shell','am','start','-n',app+'/app.familiar.mobile.MainActivity');
 for(const end=Date.now()+45000;Date.now()<end&&!page;){
  try{const pid=adb('shell','pidof',app);if(adb('shell','cat','/proc/net/unix').includes('webview_devtools_remote_'+pid)){
   adb('forward','tcp:'+cdp,'localabstract:webview_devtools_remote_'+pid);browser=await chromium.connectOverCDP('http://127.0.0.1:'+cdp,{timeout:1500});page=browser.contexts()[0].pages()[0];
  }}catch{await browser?.close();browser=null;}if(!page)await delay(300);
 }assert(page,'WebView did not become available');await page.locator('#familiar-root[data-ready="true"]').waitFor();
 before=await call('snapshot.get');originalBox=box('FamiliarPet');assert(originalBox&&!before.pet.docking.snapToEdge&&before.pet.scale===1);assert(before.providers.every(p=>!p.profile.keyConfigured)&&!before.activeReply&&!before.tasks.length&&!before.voice.state.active&&!before.voice.wake.armed);
 await writeFile(out+'/before.json',JSON.stringify({before,originalBox},null,2));proof.apkSha256=createHash('sha256').update(await readFile('release/android/Familiar-0.3.0-arm64-debug.apk')).digest('hex');assert.equal(adb('shell','sha256sum',adb('shell','pm','path',app).replace(/^package:/,'')).split(/\s/)[0],proof.apkSha256);
 changed=true;adb('reverse','tcp:'+port,'tcp:'+port);await call('pet.settings.save',{scale:1,visible:true,quiet:true,bubbleSeconds:0});await call('pet.docking.save',{snapToEdge:false,hideWhenIdle:false,delaySeconds:30});await call('provider.save',{kind:'compatible',baseUrl:`http://127.0.0.1:${port}/v1`,model:'bubble-layout-fixture',clearApiKey:true});const id=(await call('conversation.create')).id;conversations.push(id);
 adb('shell','input','keyevent','KEYCODE_HOME');await delay(500);await drag(1200,1500);await pet();await tap('气泡聊天输入');adb('shell','input','text','short');await tap('发送气泡消息');await until(async()=>!(await call('snapshot.get')).activeReply);await delay(700);assert.match(await ui(),/在呢，慢慢说/);
 const short=geometry('short-right');assert(short.chat.h<650);
 let shortNodes=nodes(await ui());const shortEdit=bounds(shortNodes.find(n=>n['content-desc']==='气泡聊天输入')),shortReply=bounds(shortNodes.find(n=>n.text==='在呢，慢慢说。'));
 assert(shortEdit.y+shortEdit.h<=shortReply.y,'回复应贴近宠物，输入气泡在外侧');assert(shortEdit.w<800,'空输入气泡不应是一条固定宽表单');
 await shot('short-right');pass('短回复按文字收紧，输入气泡紧凑错位，回复贴近宠物且尾巴不被隔开');
 await tap('气泡聊天输入');adb('shell','input','text','long');await tap('发送气泡消息');await until(async()=>!(await call('snapshot.get')).activeReply);await delay(800);const long=geometry('long-right');assert(long.chat.h>short.chat.h&&long.chat.h<=1200);assert(nodes(await ui()).some(n=>n.class==='android.widget.ScrollView'&&n.scrollable==='true'));await shot('long-right');pass('十八段长回复在有界气泡内滚动，输入和关闭仍可见');
 await tap('气泡聊天输入');adb('shell','input','text','tomorrow');adb('shell','input','keyevent','KEYCODE_ENTER');adb('shell','input','text','together');await delay(700);
 let n=nodes(await ui());const edit=bounds(n.find(n=>n['content-desc']==='气泡聊天输入'));assert(edit.h>192);for(const label of ['发送气泡消息','收起']){const b=bounds(n.find(n=>n['content-desc']===label));assert(b.w>=192&&b.h>=192);}await shot('multiline-draft');pass('无下划线输入随两行草稿伸展，小图标保留 48dp 点击范围');
 await drag(250,350);const lower=geometry('below-left');assert(lower.chat.y>=lower.pet.y+lower.pet.h);
 // 拖动按外部触摸释放输入焦点；再次轻点宠物后才读取输入窗口的可访问树。
 await pet();const restoredNodes=nodes(await ui()),restored=restoredNodes.find(n=>n['content-desc']==='气泡聊天输入');assert(restored?.text.includes('tomorrow')&&restored.text.includes('together'));
 assert(bounds(restoredNodes.find(n=>n['content-desc']==='收起')).y<bounds(restored).y,'下方气泡的回复应位于靠近宠物的一侧');
 await shot('below-left');pass('宠物位于左上角时气泡移到下方，顺序与尾巴翻转，输入焦点和草稿保留');
 await drag(1200,2300);const upper=geometry('above-right');assert(upper.chat.y+upper.chat.h<=upper.pet.y);await pet();await shot('above-right');pass('宠物位于右下角时气泡移到上方，回复和输入完整可见');
 await tap('收起');await until(()=>!box('FamiliarChat'));await call('message.send',{conversationId:id,text:'short'});await until(async()=>!(await call('snapshot.get')).activeReply);await until(()=>!!box('FamiliarSpeech'));await shot('speech-only');proof.speech=box('FamiliarSpeech');assert(proof.speech.h<650);pass('普通输出也使用随内容收紧的尾巴气泡');
}catch(error){proof.error=String(error);console.error(error);try{await shot('failure');await writeFile(out+'/failure-ui.xml',await ui());}catch{}process.exitCode=1;}
finally{
 try{if(changed){
  await call('reply.cancel');adb('shell','am','start','-n',app+'/app.familiar.mobile.MainActivity');await delay(500);await call('snapshot.get');
  const p=before.providers.find(p=>p.id==='compatible').profile;await call('provider.save',{kind:'compatible',baseUrl:p.baseUrl,model:p.model,clearApiKey:true});if(before.provider.kind!=='compatible')await call('provider.save',{kind:before.provider.kind,baseUrl:before.provider.baseUrl,model:before.provider.model});
  if(before.activeConversationId)await call('conversation.select',{id:before.activeConversationId});for(const id of conversations)await call('conversation.delete',{id});
  await call('pet.docking.save',{snapToEdge:false,hideWhenIdle:false,delaySeconds:30});await drag(originalBox.x+originalBox.w/2,originalBox.y+originalBox.h/2);await call('pet.settings.save',{scale:before.pet.scale,visible:before.pet.visible,quiet:before.pet.quiet,bubbleSeconds:before.pet.bubbleSeconds});await call('pet.docking.save',before.pet.docking);await delay(600);
  // action 是行为引擎的瞬时输出；夜间休息或触摸唤醒不应被误判为用户偏好未恢复。
  const after=await call('snapshot.get');assert.deepEqual(after.providers,before.providers);for(const key of ['scale','visible','quiet','bubbleSeconds','docking'])assert.deepEqual(after.pet[key],before.pet[key]);proof.transientAction={before:before.pet.action,after:after.pet.action};assert.deepEqual(box('FamiliarPet'),originalBox);assert.equal(after.activeConversationId,before.activeConversationId);assert.deepEqual(after.conversations.map(c=>c.id),before.conversations.map(c=>c.id));proof.restored=true;pass('原会话、模型、宠物偏好和位置已恢复');
 }}catch(error){proof.restoreError=String(error);console.error('RESTORE: '+String(error));process.exitCode=1;}
 await browser?.close();try{if(adb('forward','--list').includes('tcp:'+cdp))adb('forward','--remove','tcp:'+cdp);if(adb('reverse','--list').includes('tcp:'+port))adb('reverse','--remove','tcp:'+port);adb('shell','rm','-f','/sdcard/familiar-bubble-layout.xml');}catch{}server.closeAllConnections();await new Promise(r=>server.close(r));await writeFile(out+'/result.json',JSON.stringify(proof,null,2));
}
