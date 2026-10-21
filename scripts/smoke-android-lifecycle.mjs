import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';

const app='app.familiar.mobile.debug',fixture='app.familiar.fixture',mainPort=9275,approvalPort=9276;
const out=process.env.FAMILIAR_LIFECYCLE_REPORT_DIR??'.artifacts/android-lifecycle';
const phase=process.argv.find(a=>a.startsWith('--phase='))?.slice(8)??'all';assert(['all','notification','overlay','task-manager','accessibility'].includes(phase));
await mkdir(out,{recursive:true});
const adb=(...a)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...a],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:8*1024*1024}).trim();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const proof={date:new Date().toISOString(),phase,checks:[],events:[]},conversations=[],requests=[];
let browser,overlay,page,before,originalBox,seq=0,changed=false,fixtureInstalled=false,overlayTouched=false,modelMode='hold',phoneStep=0,screen,phoneResult,modelError;
const pass=name=>{proof.checks.push(name);console.log('PASS '+name);};
const server=createServer(async(req,res)=>{
 try{
  if(req.url.endsWith('/models')){res.end(JSON.stringify({data:[{id:'lifecycle-fixture'}]}));return;}
  let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw),record={mode:modelMode,closed:false};requests.push(record);res.on('close',()=>record.closed=true);
  res.writeHead(200,{'content-type':'text/event-stream'});
  if(modelMode==='hold'){res.write(`data: ${JSON.stringify({choices:[{delta:{content:'常驻与权限检查正在等待。'},finish_reason:null}]})}\n\n`);return;}
  const previous=body.messages.filter(m=>m.role==='tool').at(-1);let name,args;
  if(phoneStep===0){name='android_screen';args={};}
  else if(phoneStep===1){screen=JSON.parse(previous.content);assert.equal(screen.package,fixture);const node=screen.nodes.find(n=>n.text.toLowerCase()==='increment counter');assert(node);name='android_action';args={snapshotId:screen.snapshotId,nodeId:node.id,action:'click'};}
  else{phoneResult=JSON.parse(previous.content);res.end(`data: ${JSON.stringify({choices:[{delta:{content:phoneResult.accepted?'重新观察后操作完成。':'旧操作没有执行。'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);return;}
  phoneStep++;res.end(`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'lifecycle-'+phoneStep,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);
 }catch(error){modelError=String(error);res.end('data: [DONE]\n\n');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const httpPort=server.address().port;
const pid=name=>{try{return adb('shell','pidof',name);}catch{return '';}};
async function until(check,timeout=25000){let last;for(const end=Date.now()+timeout;Date.now()<end;){if(modelError)throw Error(modelError);last=await check();if(last)return last;await delay(200);}throw Error('Lifecycle deadline');}
async function detach(){await overlay?.close().catch(()=>{});overlay=undefined;await browser?.close().catch(()=>{});browser=undefined;page=undefined;for(const p of [mainPort,approvalPort])try{if(adb('forward','--list').includes('tcp:'+p))adb('forward','--remove','tcp:'+p);}catch{}}
async function attach(){
 await detach();adb('shell','am','start','-n',app+'/app.familiar.mobile.MainActivity');
 await until(()=>{const current=pid(app);return current&&adb('shell','cat','/proc/net/unix').includes('webview_devtools_remote_'+current);},45000);
 adb('forward','tcp:'+mainPort,'localabstract:webview_devtools_remote_'+pid(app));browser=await chromium.connectOverCDP('http://127.0.0.1:'+mainPort);page=browser.contexts()[0].pages()[0];await page.locator('#familiar-root[data-ready="true"]').waitFor();
}
async function call(method,params){let timer;try{const reply=await Promise.race([page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:'lifecycle-'+(++seq),method,params}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Controller request deadline: '+method)),60000);})]);assert(reply.ok,method+': '+reply.error?.code);return reply.result;}finally{clearTimeout(timer);}}
const snapshot=()=>call('snapshot.get');
function box(title='FamiliarPet'){const block=adb('shell','dumpsys','window','windows').split(/  Window #/).find(b=>b.includes(`u0 ${title}}`)&&b.includes('mHasSurface=true'));const m=block?.match(/Frames:.*? frame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);return m?{x:+m[1],y:+m[2],w:+m[3]-m[1],h:+m[4]-m[2]}:null;}
const service=()=>adb('shell','dumpsys','activity','services',app).split(/\* ServiceRecord/).find(b=>b.includes('app.familiar.platform.PetService'))??'';
function noAudio(){assert(!adb('shell','dumpsys','activity','services',app).includes('VoiceService'));assert(!adb('shell','cmd','appops','get',app,'RECORD_AUDIO').includes('(running)'));}
async function ui(){adb('shell','uiautomator','dump','/sdcard/familiar-lifecycle.xml');return adb('shell','cat','/sdcard/familiar-lifecycle.xml');}
const nodes=xml=>[...xml.matchAll(/<node\b[^>]+>/g)].map(m=>Object.fromEntries([...m[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],a[2]])));
function tapNode(n){assert(n,'Expected actual native control');const p=[...n.bounds.matchAll(/\d+/g)].map(m=>+m[0]);assert.equal(p.length,4);adb('shell','input','tap',String(Math.round((p[0]+p[2])/2)),String(Math.round((p[1]+p[3])/2)));}
async function shot(name){await writeFile(out+'/'+name+'.png',execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554','exec-out','screencap','-p'],{windowsHide:true,maxBuffer:16*1024*1024}));}
async function homeView(){
 for(let i=0;i<4&&await page.locator('.page:not([hidden])').count();i++)await page.locator('.page:not([hidden])').last().getByRole('button',{name:'返回',exact:true}).click();
 await page.getByRole('button',{name:'小窝',exact:true}).click();await page.locator('.resident').waitFor();
}
async function startFromUi(){await homeView();const state=await snapshot();if(!state.runtime.running){await page.getByRole('button',{name:'开启常驻',exact:true}).click();await until(async()=>(await snapshot()).runtime.running);}await until(()=>box());noAudio();}
async function held(label){modelMode='hold';const id=(await call('conversation.create')).id;conversations.push(id);const count=requests.length;await call('message.send',{conversationId:id,text:label});await until(async()=>requests.length===count+1&&(await snapshot()).activeReply);return {id,record:requests.at(-1),count:count+1};}
async function overlayPermission(enabled){
 overlayTouched=true;adb('shell','am','start','-f','0x10008000','-a','android.settings.action.MANAGE_OVERLAY_PERMISSION','-d','package:'+app);let list=nodes(await ui());
 if(!list.some(n=>n.checkable==='true')){tapNode(list.find(n=>n.text==='Familiar'));list=nodes(await ui());}
 assert(list.some(n=>n.text==='Familiar'));const toggles=list.filter(n=>n.checkable==='true');assert.equal(toggles.length,1);if(toggles[0].checked!==String(enabled))tapNode(toggles[0]);assert.equal(nodes(await ui()).find(n=>n.checkable==='true')?.checked,String(enabled));
}
async function accessibilityPermission(enabled){
 adb('shell','am','start','-f','0x10008000','-a','android.settings.ACCESSIBILITY_SETTINGS');let list=nodes(await ui());
 if(!list.some(n=>n.text==='使用“灵伴手机操作”')){tapNode(list.find(n=>n.text==='灵伴手机操作'));list=nodes(await ui());}
 assert(list.some(n=>n.text==='使用“灵伴手机操作”'));const toggle=list.find(n=>n['resource-id']==='android:id/switch_widget');assert(toggle);
 if(toggle.checked!==String(enabled)){
  tapNode(toggle);list=nodes(await ui());const confirm=list.find(n=>n.text===(enabled?'允许':'停止'));if(confirm)tapNode(confirm);
 }
 assert.equal(nodes(await ui()).find(n=>n['resource-id']==='android:id/switch_widget')?.checked,String(enabled));
}
async function approve(){
 if(!overlay){
  await until(()=>{const current=pid(app+':runtime');return current&&adb('shell','cat','/proc/net/unix').includes('webview_devtools_remote_'+current);});
  adb('forward','tcp:'+approvalPort,'localabstract:webview_devtools_remote_'+pid(app+':runtime'));
  await until(async()=>{try{overlay=await chromium.connectOverCDP('http://127.0.0.1:'+approvalPort,{timeout:5000});return true;}catch{return false;}});
 }
 let p;await until(()=>{p=overlay.contexts()[0].pages().find(p=>p.url().includes('/approval/index.html'));return p;});await p.locator('.approval[data-ready="true"]').waitFor();const button=p.getByRole('button',{name:/^允许这一步/});await until(()=>button.isEnabled());const b=await button.boundingBox(),v=await p.evaluate(()=>({w:innerWidth,h:innerHeight,dpr:devicePixelRatio}));const size=adb('shell','wm','size').match(/Physical size: (\d+)x(\d+)/);
 adb('shell','input','tap',String(Math.round((+size[1]-v.w*v.dpr)/2+(b.x+b.width/2)*v.dpr)),String(Math.round(+size[2]-24*v.dpr-v.h*v.dpr+(b.y+b.height/2)*v.dpr)));await delay(250);
}
async function phone(){
 modelMode='phone';phoneStep=0;phoneResult=undefined;screen=undefined;const id=(await call('conversation.create')).id;conversations.push(id);adb('shell','am','start','-n',fixture+'/.FixtureActivity');await delay(400);await call('message.send',{conversationId:id,text:'仅在本地靶场观察后点击一次。'});await until(async()=>(await snapshot()).tasks.length===1);const first=(await snapshot()).tasks[0].id;await approve();await until(async()=>{const s=await snapshot();return s.tasks.length===1&&s.tasks[0].id!==first;});return id;
}
try{
 assert(!adb('forward','--list').includes('tcp:'+mainPort));assert(!adb('forward','--list').includes('tcp:'+approvalPort));await attach();before=await snapshot();originalBox=box();
 assert(before.runtime.running&&before.runtime.overlayVisible&&originalBox);assert(before.providers.every(p=>!p.profile.keyConfigured)&&!before.activeReply&&!before.tasks.length&&!before.voice.state.active&&!before.voice.wake.armed);for(const cap of ['overlay','accessibility','notifications'])assert.equal(before.capabilities.find(c=>c.id===cap).state,'granted');
 proof.originalIme=adb('shell','settings','get','secure','default_input_method');proof.apkSha256=createHash('sha256').update(await readFile('release/android/Familiar-0.3.0-arm64-debug.apk')).digest('hex');assert.equal(adb('shell','sha256sum',adb('shell','pm','path',app).replace(/^package:/,'')).split(/\s/)[0],proof.apkSha256);await writeFile(out+'/before.json',JSON.stringify({before,box:originalBox},null,2));
 changed=true;adb('reverse','tcp:'+httpPort,'tcp:'+httpPort);await call('pet.settings.save',{scale:before.pet.scale,visible:true,quiet:true,bubbleSeconds:0});await call('provider.save',{kind:'compatible',baseUrl:`http://127.0.0.1:${httpPort}/v1`,model:'lifecycle-fixture',clearApiKey:true});
 if(phase==='all'||phase==='notification'){
  const heldRequest=await held('通知停止测试');adb('shell','input','keyevent','KEYCODE_HOME');adb('shell','cmd','statusbar','expand-notifications');
  const notification=nodes(await ui());assert(notification.some(n=>n.text==='Familiar · 灵伴'));const stop=notification.find(n=>n['resource-id']==='android:id/action0'&&n.text==='停止伙伴');assert(stop);await shot('notification-stop');const start=Date.now();tapNode(stop);
  await until(()=>!service().includes('isForeground=true')&&!box());await until(()=>heldRequest.record.closed);proof.events.push({name:'notification-stop',elapsedMs:Date.now()-start});assert(!box('FamiliarChat')&&!box('FamiliarSpeech'));adb('shell','cmd','statusbar','collapse');await attach();
  const stopped=await snapshot();assert(!stopped.runtime.running&&!stopped.activeReply&&!stopped.tasks.length);assert.equal(requests.length,heldRequest.count);noAudio();pass('实体通知栏停止伙伴会取消后台流式回复并移除宠物窗口');
  await startFromUi();await delay(1000);assert.equal(requests.length,heldRequest.count);pass('小窝重新开启常驻，已停止的回复不会自动重放');
 }
 if(phase==='all'||phase==='overlay'){
  const heldRequest=await held('撤回悬浮窗权限测试'),oldRuntime=pid(app+':runtime');await overlayPermission(false);await until(()=>!box()&&!box('FamiliarChat')&&!box('FamiliarSpeech'));await attach();
  const denied=await snapshot(),newRuntime=pid(app+':runtime');assert.equal(denied.capabilities.find(c=>c.id==='overlay').state,'notGranted');assert(!denied.runtime.overlayVisible);if(oldRuntime!==newRuntime)assert(!denied.activeReply);proof.events.push({name:'overlay-revoked',oldRuntime,newRuntime,continuedReply:!!denied.activeReply});assert.equal(requests.length,heldRequest.count);await call('reply.cancel');await until(()=>heldRequest.record.closed);noAudio();pass('可见系统设置撤回悬浮窗后窗口消失，状态反映真实权限且不重放请求');
  await overlayPermission(true);await attach();await startFromUi();await delay(800);assert.equal((await snapshot()).capabilities.find(c=>c.id==='overlay').state,'granted');assert.equal(requests.length,heldRequest.count);pass('重新授权后手动恢复常驻，原回复保持停止');
 }
 if(phase==='all'||phase==='task-manager'){
  const heldRequest=await held('系统活动应用停止测试');adb('shell','input','keyevent','KEYCODE_HOME');await detach();const oldRuntime=pid(app+':runtime');adb('shell','cmd','activity','stop-app',app);
  await until(()=>!service().includes('isForeground=true')&&!box());await until(()=>heldRequest.record.closed);await delay(3000);assert(!box()&&!service().includes('isForeground=true'));noAudio();proof.events.push({name:'task-manager-stop',oldRuntime,afterRuntime:pid(app+':runtime')});await attach();
  const restarted=await snapshot();assert(!restarted.activeReply&&!restarted.tasks.length&&!restarted.voice.state.active&&!restarted.voice.wake.armed);assert.equal(requests.length,heldRequest.count);pass('Android 官方 stop-app 路径停止整个应用，重新打开不重放中断回复或自动录音');await startFromUi();
  const enabledServices=adb('shell','settings','get','secure','enabled_accessibility_services').split(':'),cap=(await snapshot()).capabilities.find(c=>c.id==='accessibility');
  const ownEnabled=enabledServices.some(value=>value===app+'/app.familiar.platform.FamiliarAccessibility');proof.events.push({name:'accessibility-after-system-stop',ownEnabled,state:cap.state});
  if(ownEnabled&&cap.state!=='granted'){
   assert.equal(cap.state,'disconnected');assert(cap.detail.includes('无法运行'));await page.getByRole('button',{name:/^能力/}).click();
   const card=page.locator('.cap[data-id="accessibility"]');await card.scrollIntoViewIfNeeded();await card.getByText('已断开',{exact:true}).waitFor();await card.getByText(cap.detail,{exact:true}).waitFor();await shot('accessibility-disconnected');
   await card.locator('.cap-detail').click();const sheet=page.locator('.sheet-capability');await sheet.locator('.cap-sheet-explain').waitFor();assert.match(await sheet.locator('.cap-sheet-explain').innerText(),/开关已开启.*无法运行.*先关闭再重新开启/);await shot('accessibility-recovery-detail');await sheet.getByRole('button',{name:'关闭',exact:true}).click();
   pass('已启用却断开的无障碍显示已断开和系统恢复提示');
  }
 }
 if(phase==='all'||phase==='accessibility'){
  if((await snapshot()).capabilities.find(c=>c.id==='accessibility').state!=='granted'){
   await accessibilityPermission(false);await accessibilityPermission(true);await attach();await until(async()=>(await snapshot()).capabilities.find(c=>c.id==='accessibility').state==='granted');
  }
  assert(!adb('shell','pm','list','packages',fixture).includes('package:'+fixture));assert.equal(adb('install','.artifacts/android-fixture/fixture.apk').split(/\r?\n/).at(-1),'Success');fixtureInstalled=true;
  await phone();await accessibilityPermission(false);await attach();assert.equal((await snapshot()).capabilities.find(c=>c.id==='accessibility').state,'notGranted');
  await accessibilityPermission(true);await attach();await until(async()=>(await snapshot()).capabilities.find(c=>c.id==='accessibility').state==='granted');adb('shell','am','start','-n',fixture+'/.FixtureActivity');await delay(400);await approve();await until(async()=>!(await snapshot()).activeReply);assert(!phoneResult.accepted);assert((await ui()).includes('Counter: 0'));await shot('revoked-old-action');pass('无障碍撤回再授权后旧观察不能执行，靶场计数保持零');
  await phone();await approve();await until(async()=>!(await snapshot()).activeReply);assert(phoneResult.accepted);assert((await ui()).includes('Counter: 1'));await shot('fresh-action');pass('重新观察并逐项批准后手机操作恢复，只点击一次');
 }
}catch(error){proof.error=String(error);console.error(error);process.exitCode=1;try{await shot('failure');await writeFile(out+'/failure-ui.xml',await ui());}catch{}}
finally{
 modelError=undefined;
 try{if(changed){
  adb('shell','cmd','statusbar','collapse');await attach();await call('reply.cancel');const restoredCaps=(await snapshot()).capabilities;
  if(overlayTouched&&restoredCaps.find(c=>c.id==='overlay').state!=='granted')await overlayPermission(true);
  if(before.capabilities.find(c=>c.id==='accessibility').state==='granted'&&restoredCaps.find(c=>c.id==='accessibility').state!=='granted'){await accessibilityPermission(false);await accessibilityPermission(true);}
  await attach();
  if(before.activeConversationId)await call('conversation.select',{id:before.activeConversationId});for(const id of conversations)await call('conversation.delete',{id});const p=before.providers.find(p=>p.id==='compatible').profile;await call('provider.save',{kind:'compatible',baseUrl:p.baseUrl,model:p.model,clearApiKey:true});if(before.provider.kind!=='compatible')await call('provider.save',{kind:before.provider.kind,baseUrl:before.provider.baseUrl,model:before.provider.model});
  await call('pet.settings.save',before.pet);await call('runtime.set',{enabled:before.runtime.running});await until(()=>box());const after=await snapshot();assert.deepEqual(after.providers,before.providers);assert.equal(after.activeConversationId,before.activeConversationId);assert.deepEqual(after.conversations.map(c=>c.id),before.conversations.map(c=>c.id));for(const key of ['scale','visible','quiet','bubbleSeconds','docking'])assert.deepEqual(after.pet[key],before.pet[key]);for(const id of ['overlay','accessibility','notifications'])assert.equal(after.capabilities.find(c=>c.id===id).state,before.capabilities.find(c=>c.id===id).state);assert.deepEqual(box(),originalBox);assert(!after.activeReply&&!after.tasks.length&&!after.voice.state.active&&!after.voice.wake.armed);assert.equal(adb('shell','settings','get','secure','default_input_method'),proof.originalIme);noAudio();proof.restored=true;proof.finalRuntime=after.runtime;pass('原权限、模型、会话、宠物位置和输入法已恢复');
 }}catch(error){proof.restoreError=String(error);console.error('RESTORE: '+String(error));process.exitCode=1;}
 await detach();if(fixtureInstalled)try{assert.equal(adb('uninstall',fixture),'Success');proof.fixtureRemoved=true;}catch(error){proof.cleanupError=String(error);process.exitCode=1;}
 try{if(adb('reverse','--list').includes('tcp:'+httpPort))adb('reverse','--remove','tcp:'+httpPort);adb('shell','rm','-f','/sdcard/familiar-lifecycle.xml');adb('shell','input','keyevent','KEYCODE_HOME');}catch{}
 server.closeAllConnections();await new Promise(r=>server.close(r));proof.requestCount=requests.length;await writeFile(out+'/result.json',JSON.stringify(proof,null,2));
}
