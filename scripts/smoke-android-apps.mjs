import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
const app='app.familiar.mobile.debug',fixture='app.familiar.fixture',out='.artifacts/android-device';
const adb=(...a)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...a],{encoding:'utf8',windowsHide:true}).trim();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let browser,overlayBrowser,page,before,careBefore,mode,step,target,seq=0,toolResults=[],fixtureInstalled=false;
const results=[],conversations=[];
const server=createServer(async(req,res)=>{
 if(req.url.endsWith('/models')){res.end(JSON.stringify({data:[{id:'apps-fixture',context_window:32768}]}));return;}
 let body='';for await(const c of req)body+=c;const request=JSON.parse(body),last=request.messages.filter(m=>m.role==='tool').at(-1);
 res.writeHead(200,{'Content-Type':'text/event-stream'});let name,args;
 if(step>0){try{toolResults.push(JSON.parse(last.content));}catch{toolResults.push(last?.content);}}
 if(step===0){name='android_apps';args={query:mode==='empty'?'not-installed-familiar-unique':'Familiar Test Fixture'};}
 else if(step===1&&mode!=='empty'){
  const found=toolResults.at(-1);assert.equal(found.total,1,JSON.stringify(found));assert.equal(found.matches[0].packageName,fixture);target=found.matches[0];
  name='android_open_app';args={target:mode==='tamper'?{...target,label:'错误应用名'}:target};
 }else if(mode==='success'&&step===2){name='android_screen';args={};}
 else if(mode==='success'&&step===3){const screen=toolResults.at(-1);assert.equal(screen.package,fixture);const button=screen.nodes.find(n=>n.text.toLowerCase()==='increment counter');assert(button);name='android_action';args={snapshotId:screen.snapshotId,nodeId:button.id,action:'click'};}
 else if(mode==='success'&&step===4){name='android_screen';args={};}
 else if(mode==='replay'&&step===2){name='android_open_app';args={target};}
 else{res.end('data: '+JSON.stringify({choices:[{delta:{content:'本机应用操作测试结束'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');return;}
 step++;res.end('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'apps-'+step,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;adb('reverse',`tcp:${port}`,`tcp:${port}`);
const raw=(method,params)=>page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:`apps-${++seq}`,method,params});
const call=async(method,params)=>{const r=await raw(method,params);assert(r.ok,`${method}: ${r.error?.code}`);return r.result;};
const state=()=>call('snapshot.get');
async function wait(predicate,ms=20000){for(const end=Date.now()+ms;Date.now()<end;){const s=await state();if(await predicate(s))return s;await delay(100);}throw Error(`APPS_TIMEOUT ${mode} `+JSON.stringify((await state()).tasks));}
function top(){return adb('shell','dumpsys','activity','activities').split('\n').find(l=>/(?:topResumedActivity|mResumedActivity)/.test(l))??'';}
async function overlay(){if(!overlayBrowser){for(let i=0;i<60;i++)try{adb('forward','tcp:9244',`localabstract:webview_devtools_remote_${adb('shell','pidof',app+':runtime')}`);overlayBrowser=await chromium.connectOverCDP('http://127.0.0.1:9244');break;}catch{await delay(200);}}assert(overlayBrowser);for(let i=0;i<60;i++){const p=overlayBrowser.contexts()[0].pages().find(p=>p.url().includes('/approval/index.html'));if(p){await p.locator('.approval[data-ready="true"]').waitFor();return p;}await delay(100);}throw Error('APPROVAL_MISSING');}
async function approve(allow=true){const p=await overlay(),b=p.getByRole('button',{name:allow?/^允许这一步/:/^拒绝这一步/});await b.waitFor();for(let i=0;i<50&&!await b.isEnabled();i++)await delay(100);assert(await b.isEnabled());const rect=await b.boundingBox(),v=await p.evaluate(()=>({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})),size=adb('shell','wm','size').match(/Physical size: (\d+)x(\d+)/);adb('shell','input','tap',String(Math.round((+size[1]-v.w*v.dpr)/2+(rect.x+rect.width/2)*v.dpr)),String(Math.round(+size[2]-24*v.dpr-v.h*v.dpr+(rect.y+rect.height/2)*v.dpr)));}
function pass(name){results.push(name);console.log('PASS '+name);}
try{
 assert(!adb('shell','pm','list','packages',fixture));adb('install','-r','.artifacts/android-fixture/fixture.apk');fixtureInstalled=true;
 adb('shell','am','start','-n',`${app}/app.familiar.mobile.MainActivity`);
 for(let i=0;i<60;i++)try{adb('forward','tcp:9243',`localabstract:webview_devtools_remote_${adb('shell','pidof',app)}`);browser=await chromium.connectOverCDP('http://127.0.0.1:9243');page=browser.contexts()[0].pages()[0];break;}catch{await delay(250);}
 assert(page);await page.locator('#familiar-root[data-ready="true"]').waitFor();before=await wait(s=>s.runtime.engine==='ready');await writeFile(out+'/apps-before.json',JSON.stringify(before));
 assert(!before.activeReply&&!before.voice.state.active&&before.providers.every(p=>!p.profile.keyConfigured));assert(before.capabilities.some(c=>c.id==='accessibility'&&c.state==='granted'));
 careBefore=await call('care.get');await call('care.save',{revision:careBefore.revision,settings:{...careBefore.settings,enabled:false}});
 await call('provider.save',{kind:'compatible',baseUrl:`http://127.0.0.1:${port}/v1`,model:'apps-fixture'});await call('runtime.set',{enabled:true});
 assert(!(await raw('apps.open',{target:{}})).ok);assert(!(await raw('apps.search',{query:'app'})).ok);pass('原生应用查询和启动不能经公开网页桥绕过审批');
 const cases=process.argv.find(a=>a.startsWith('--cases='))?.slice(8).split(',')??['success','empty','deny','cancel','tamper','removed','replay','locked','expired'];
 for(mode of cases){
  step=0;target=undefined;toolResults=[];adb('shell','am','force-stop',fixture);adb('shell','input','keyevent','KEYCODE_HOME');await delay(250);
  const id=(await call('conversation.create')).id;conversations.push(id);await call('message.send',{conversationId:id,text:'本机隔离应用启动验收 '+mode});
  const search=await wait(s=>s.tasks.length===1);assert.equal(search.tasks[0].title,'查找手机应用');await approve();
  if(mode!=='empty'){
   const open=await wait(s=>s.tasks.length===1&&s.tasks[0].id!==search.tasks[0].id);assert.equal(open.tasks[0].title,'打开手机应用');assert(!open.tasks[0].detail.includes(target.ref));assert(!top().includes(fixture));
   if(mode==='removed'){adb('uninstall',fixture);fixtureInstalled=false;}
   if(mode==='expired'){console.log('WAIT observed target reference expiry: 121 seconds');await delay(121000);assert((await state()).tasks.some(t=>t.id===open.tasks[0].id));}
   if(mode==='cancel')await call('reply.cancel');
   else if(mode==='locked'){adb('shell','input','keyevent','KEYCODE_SLEEP');await delay(200);await call('task.respond',{id:open.tasks[0].id,action:'approve'});}
   else await approve(mode!=='deny');
   if(mode==='success'){
    let previous=open.tasks[0].id;for(let i=0;i<3;i++){const next=await wait(s=>s.tasks.length===1&&s.tasks[0].id!==previous);previous=next.tasks[0].id;await approve();}
   }else if(mode==='replay'){await wait(s=>s.tasks.length===1&&s.tasks[0].id!==open.tasks[0].id);await approve();}
  }
  await wait(s=>!s.activeReply&&!s.tasks.length);
  if(mode==='locked'){adb('shell','input','keyevent','KEYCODE_WAKEUP');adb('shell','wm','dismiss-keyguard');await delay(400);}
  if(mode==='removed'){adb('install','-r','.artifacts/android-fixture/fixture.apk');fixtureInstalled=true;}
  if(mode==='success'){
   assert.equal(toolResults[1].status,'visible');assert(toolResults[1].submitted&&toolResults[1].requiresObservation);assert.equal(toolResults[3].accepted,true);assert(toolResults[4].nodes.some(n=>n.text==='Counter: 1'));assert(top().includes(fixture));
   adb('shell','screencap','-p','/sdcard/familiar-apps.png');adb('pull','/sdcard/familiar-apps.png',out+'/apps-success.png');
  }else if(mode==='replay'){assert.equal(toolResults[1].status,'visible');assert.notEqual(toolResults[2].status,'visible');}
  else{assert(!top().includes(fixture));assert(!toolResults.some(r=>r?.submitted));if(mode==='empty')assert.equal(toolResults[0].total,0);}
  pass({success:'真实桌面查找 → 启动 → 观察 → 点击 → 再观察，目标计数只增加一次',empty:'没有匹配的可启动应用时返回空列表',deny:'拒绝打开审批不会启动目标应用',cancel:'批准前取消回复不会打开应用',tamper:'批准的名称与原生引用不符时拒绝',removed:'审批期间应用被移除，执行前重新核验并拒绝',replay:'启动消耗引用，重复工具请求不再次启动',locked:'熄屏时拒绝启动，亮屏后不补执行',expired:'超过120秒的应用引用不能用于启动'}[mode]);
 }
 const bytes=await readFile('apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk'),sha=createHash('sha256').update(bytes).digest('hex');const installed=adb('shell','pm','path',app).split('\n').find(s=>s.startsWith('package:')).slice(8);assert.equal(adb('shell','sha256sum',installed).split(/\s+/)[0],sha);
 await writeFile(out+'/apps-smoke.json',JSON.stringify({date:new Date().toISOString(),apkSha:sha,results,limitations:['isolated launcher fixture; OEM launcher restrictions and third-party application workflows require separate validation']},null,2));
}finally{
 try{if(page&&before){await call('reply.cancel');if(careBefore){const now=await call('care.get');await call('care.save',{revision:now.revision,settings:careBefore.settings});}if(before.activeConversationId)await call('conversation.select',{id:before.activeConversationId});for(const id of conversations)await call('conversation.delete',{id});await call('provider.save',before.providers.find(p=>p.id==='compatible').profile);if(before.provider.kind!=='compatible')await call('provider.save',before.provider);await call('runtime.set',{enabled:before.runtime.running});}}
 finally{await overlayBrowser?.close();await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));adb('reverse','--remove',`tcp:${port}`);adb('forward','--remove','tcp:9243');adb('forward','--remove','tcp:9244');adb('shell','rm','-f','/sdcard/familiar-apps.png');if(fixtureInstalled)adb('uninstall',fixture);}
}
