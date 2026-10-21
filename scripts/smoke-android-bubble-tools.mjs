import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
const app='app.familiar.mobile.debug',fixture='app.familiar.fixture',out=process.env.FAMILIAR_BUBBLE_TOOLS_REPORT_DIR??'.artifacts/android-bubble-tools',mainPort=9269,overlayPort=9270;
await mkdir(out,{recursive:true});
const adb=(...a)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...a],{encoding:'utf8',windowsHide:true,timeout:30000}).trim();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const results=[],conversations=[];let browser,overlay,page,before,changed=false,fixtureInstalled=false,seq=0,mode,stage=0,screen,actionResult,release,modelError;
const proof={date:new Date().toISOString(),results};
const pass=name=>{results.push(name);console.log('PASS '+name);};
const json=text=>{try{return JSON.parse(text);}catch{return {error:String(text)}}};
const server=createServer(async(req,res)=>{
 try{
  if(req.url.endsWith('/models')){res.end(JSON.stringify({data:[{id:'bubble-tools-fixture'}]}));return;}
  let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw),tool=body.messages.filter(m=>m.role==='tool').at(-1);
  let name,args;
  if(stage===0){await new Promise(r=>release=r);name='android_screen';args={};}
  else if(stage===1){screen=json(tool.content);assert.equal(screen.package,fixture,'Bubble focus must yield to the underlying app before observation');const node=screen.nodes.find(n=>n.text.toLowerCase()==='increment counter');assert(node);name='android_action';args={snapshotId:screen.snapshotId,nodeId:node.id,action:'click'};}
  else{actionResult=json(tool.content);res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content:mode==='allow'?'手机操作完成，继续在气泡里聊。':'这一步未执行，继续在气泡里聊。'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);return;}
  assert(body.tools.some(t=>t.function.name===name),'Expected fixture tool in active catalog');stage++;
  res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'bubble-tool-'+stage,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);
 }catch(error){modelError=String(error);res.writeHead(500);res.end('fixture error');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
const call=async(method,params)=>{const r=await page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:'bubble-tool-'+(++seq),method,params});assert(r.ok,method+': '+r.error?.code);return r.result;};
async function until(check,timeout=25000){for(const end=Date.now()+timeout;Date.now()<end;){if(modelError)throw Error(modelError);if(await check())return;await delay(180);}throw Error('Bubble tool deadline');}
function box(title){const block=adb('shell','dumpsys','window','windows').split(/  Window #/).find(b=>b.includes(`u0 ${title}}`)&&b.includes('mHasSurface=true'));const m=block?.match(/Frames:.*? frame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);return m?{x:+m[1],y:+m[2],w:+m[3]-m[1],h:+m[4]-m[2]}:null;}
async function ui(){adb('shell','uiautomator','dump','/sdcard/familiar-bubble-tools.xml');return adb('shell','cat','/sdcard/familiar-bubble-tools.xml');}
async function tap(label){const xml=await ui(),node=[...xml.matchAll(/<node\b[^>]+>/g)].map(m=>m[0]).find(s=>s.toLowerCase().includes(`content-desc="${label.toLowerCase()}"`)||s.toLowerCase().includes(`text="${label.toLowerCase()}"`));assert(node,'Missing native control '+label);const m=node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);adb('shell','input','tap',String(Math.round((+m[1]+ +m[3])/2)),String(Math.round((+m[2]+ +m[4])/2)));await delay(250);}
async function pet(){const b=box('FamiliarPet');assert(b);adb('shell','input','tap',String(b.x+b.w/2),String(b.y+b.h/2));await until(()=>!!box('FamiliarChat'));await delay(700);}
async function type(text){await tap('气泡聊天输入');adb('shell','input','text',text);await delay(250);}
async function approve(allow){
 if(!overlay){
  await until(()=>adb('shell','cat','/proc/net/unix').includes('webview_devtools_remote_'+adb('shell','pidof',app+':runtime')));
  adb('forward','tcp:'+overlayPort,'localabstract:webview_devtools_remote_'+adb('shell','pidof',app+':runtime'));
  await until(async()=>{try{overlay=await chromium.connectOverCDP('http://127.0.0.1:'+overlayPort,{timeout:5000});return true;}catch{return false;}});
 }
 let p;await until(async()=>{p=overlay.contexts()[0].pages().find(p=>p.url().includes('/approval/index.html'));return !!p;});await p.locator('.approval[data-ready="true"]').waitFor();
 const b=p.getByRole('button',{name:allow?/^允许这一步/:/^拒绝这一步/});await until(()=>b.isEnabled());const rect=await b.boundingBox(),v=await p.evaluate(()=>({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})),size=adb('shell','wm','size').match(/Physical size: (\d+)x(\d+)/);
 adb('shell','input','tap',String(Math.round((+size[1]-v.w*v.dpr)/2+(rect.x+rect.width/2)*v.dpr)),String(Math.round(+size[2]-24*v.dpr-v.h*v.dpr+(rect.y+rect.height/2)*v.dpr)));await delay(300);
}
async function screenshot(name){await writeFile(out+'/'+name+'.png',execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554','exec-out','screencap','-p'],{windowsHide:true,maxBuffer:16*1024*1024}));}
try{
 assert(!adb('shell','pm','list','packages',fixture).includes('package:'+fixture),'A fixture is already installed; preserve it');
 assert.equal(adb('install','.artifacts/android-fixture/fixture.apk').split(/\r?\n/).at(-1),'Success');fixtureInstalled=true;
 adb('shell','am','start','-n',app+'/app.familiar.mobile.MainActivity');await delay(800);adb('forward','tcp:'+mainPort,'localabstract:webview_devtools_remote_'+adb('shell','pidof',app));browser=await chromium.connectOverCDP('http://127.0.0.1:'+mainPort);page=browser.contexts()[0].pages()[0];await page.locator('#familiar-root[data-ready="true"]').waitFor();
 before=await call('snapshot.get');assert(before.providers.every(p=>!p.profile.keyConfigured)&&!before.activeReply&&!before.tasks.length&&!before.voice.state.active&&!before.voice.wake.armed);assert.equal(before.capabilities.find(c=>c.id==='accessibility').state,'granted');assert(!before.pet.docking.snapToEdge);
 await writeFile(out+'/before.json',JSON.stringify(before,null,2));proof.apkSha256=createHash('sha256').update(await readFile('release/android/Familiar-0.3.0-arm64-debug.apk')).digest('hex');assert.equal(adb('shell','sha256sum',adb('shell','pm','path',app).replace(/^package:/,'')).split(/\s/)[0],proof.apkSha256);
 changed=true;adb('reverse','tcp:'+port,'tcp:'+port);await call('runtime.set',{enabled:true});await call('pet.settings.save',{scale:before.pet.scale,visible:true,quiet:true,bubbleSeconds:2});await call('provider.save',{kind:'compatible',baseUrl:`http://127.0.0.1:${port}/v1`,model:'bubble-tools-fixture',clearApiKey:true});
 for(mode of ['allow','deny','stale']){
  stage=0;screen=null;actionResult=null;release=null;modelError=null;
  const id=(await call('conversation.create')).id;conversations.push(id);proof.conversations=[...conversations];
  adb('shell','am','force-stop',fixture);adb('shell','am','start','-n',fixture+'/.FixtureActivity');await delay(500);await pet();await type('task_'+mode);await tap('发送气泡消息');await until(()=>!!release);
  await type('draft_'+mode);release();
  await until(async()=>(await call('snapshot.get')).tasks.length===1);await until(()=>!box('FamiliarChat'));const first=(await call('snapshot.get')).tasks[0].id;
  const focus=adb('shell','dumpsys','window').split(/\r?\n/).find(line=>line.includes('mCurrentFocus='));assert(focus?.includes(fixture),focus??'No focused native window');await approve(true);
  await until(async()=>{const s=await call('snapshot.get');return s.tasks.length===1&&s.tasks[0].id!==first;});assert.equal(screen.package,fixture);
  if(mode==='stale')await tap('Change target label');
  await approve(mode!=='deny');await until(async()=>{const s=await call('snapshot.get');return !s.activeReply&&!s.tasks.length;});
  const target=await ui();assert(target.includes(mode==='allow'?'Counter: 1':'Counter: 0'));if(mode==='stale')assert(target.toLowerCase().includes('changed target'));
  assert.equal(actionResult?.accepted===true,mode==='allow');await until(()=>!!box('FamiliarChat'));await pet();const rendered=await ui();assert(rendered.includes('draft_'+mode));assert(rendered.includes(mode==='allow'?'手机操作完成':'这一步未执行'));await screenshot(mode);
  assert(!/mResumedActivity:.*app\.familiar\.mobile\.debug/.test(adb('shell','dumpsys','activity','activities')));await tap('收起');await until(()=>!box('FamiliarChat'));
  pass({allow:'气泡发起操作，逐项触摸批准后只点击一次，草稿与回复回到气泡',deny:'气泡操作被拒绝后无点击，草稿保留，主应用不进入前台',stale:'用户接管更改目标后旧操作拒绝，重新回到原气泡和草稿'}[mode]);
 }
}catch(error){proof.error=String(error);console.error(String(error));try{await screenshot('failure');await writeFile(out+'/failure-ui.xml',await ui());}catch{}process.exitCode=1;}
finally{
 try{if(changed){
  await call('reply.cancel');adb('shell','am','start','-n',app+'/app.familiar.mobile.MainActivity');await delay(500);await call('snapshot.get');
  const p=before.providers.find(p=>p.id==='compatible').profile;await call('provider.save',{kind:'compatible',baseUrl:p.baseUrl,model:p.model,clearApiKey:true});if(before.provider.kind!=='compatible')await call('provider.save',{kind:before.provider.kind,baseUrl:before.provider.baseUrl,model:before.provider.model});
  if(before.activeConversationId)await call('conversation.select',{id:before.activeConversationId});for(const id of conversations)await call('conversation.delete',{id});await call('pet.settings.save',{scale:before.pet.scale,visible:before.pet.visible,quiet:before.pet.quiet,bubbleSeconds:before.pet.bubbleSeconds});
  const s=await call('snapshot.get');assert.deepEqual(s.providers,before.providers);assert.equal(s.activeConversationId,before.activeConversationId);assert.deepEqual(s.conversations.map(c=>c.id),before.conversations.map(c=>c.id));proof.restored=true;pass('已清理本轮模型与会话，恢复原宠物设置');
 }}catch(error){proof.restoreError=String(error);console.error('RESTORE: '+String(error));process.exitCode=1;}
 release?.();await overlay?.close();await browser?.close();for(const p of [mainPort,overlayPort])try{if(adb('forward','--list').includes('tcp:'+p))adb('forward','--remove','tcp:'+p);}catch{}try{if(adb('reverse','--list').includes('tcp:'+port))adb('reverse','--remove','tcp:'+port);}catch{}
 if(fixtureInstalled)try{assert.equal(adb('uninstall',fixture),'Success');proof.fixtureRemoved=true;}catch(error){proof.cleanupError=String(error);process.exitCode=1;}
 server.closeAllConnections();await new Promise(r=>server.close(r));await writeFile(out+'/result.json',JSON.stringify(proof,null,2));
}
