import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const app='app.familiar.mobile.debug',fixture='app.familiar.fixture',out='.artifacts/android-device';
const adb=(...a)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...a],{encoding:'utf8',windowsHide:true}).trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let mode,step,screen,gestureArgs,toolResults=[],browser,overlayBrowser,page,before,careBefore,seq=0;
const conversations=[],results=[];
const server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  if(req.url.endsWith('/models')){res.end(JSON.stringify({data:[{id:'gesture-fixture',context_window:32768}]}));return;}
  const request=JSON.parse(body),last=request.messages.filter(m=>m.role==='tool').at(-1);
  res.writeHead(200,{'Content-Type':'text/event-stream'});let name,args;
  if(step===0){name='android_screen';args={};}
  else if(step===1){
    screen=JSON.parse(last.content);const pad=screen.nodes.find(n=>n.description==='Gesture pad');assert(pad,JSON.stringify(screen));
    gestureArgs={snapshotId:screen.snapshotId,nodeId:pad.id,gesture:['longPress','swipe'].includes(mode)?mode:'tap',start:{x:.3,y:.5}};
    if(mode==='swipe'){gestureArgs.end={x:.8,y:.5};gestureArgs.durationMs=500;}
    name=mode==='node'?'android_action':'android_gesture';args=mode==='node'?{snapshotId:screen.snapshotId,nodeId:pad.id,action:'click'}:gestureArgs;
  }else{
    toolResults.push(JSON.parse(last.content));
    if(mode==='replay'&&step===2){name='android_gesture';args=gestureArgs;}
    else{res.end('data: '+JSON.stringify({choices:[{delta:{content:'手势测试结束'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');return;}
  }
  step++;res.end('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'gesture-'+step,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;adb('reverse',`tcp:${port}`,`tcp:${port}`);
async function call(method,params){const r=await page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:'gesture-'+ ++seq,method,params});assert(r.ok,JSON.stringify(r));return r.result;}
const state=()=>call('snapshot.get');
async function until(check,timeout=20000){for(const end=Date.now()+timeout;Date.now()<end;){const s=await state();if(await check(s))return s;await sleep(100);}throw Error('gesture timed out: '+mode+' '+JSON.stringify(await state()));}
async function overlay(){
  if(!overlayBrowser){for(let i=0;i<60;i++){try{adb('forward','tcp:9236',`localabstract:webview_devtools_remote_${adb('shell','pidof',app+':runtime')}`);overlayBrowser=await chromium.connectOverCDP('http://127.0.0.1:9236');break;}catch{await sleep(200);}}}
  assert(overlayBrowser);
  for(let i=0;i<60;i++){const p=overlayBrowser.contexts()[0].pages().find(p=>p.url().includes('/approval/index.html'));if(p){await p.locator('.approval[data-ready="true"]').waitFor();return p;}await sleep(100);}throw Error('Approval missing');
}
async function approve(allow=true){
  const p=await overlay(),button=p.getByRole('button',{name:allow?/^允许这一步/:/^拒绝这一步/});await button.waitFor();
  for(let i=0;i<40&&!(await button.isEnabled());i++)await sleep(100);
  assert(await button.isEnabled());const b=await button.boundingBox(),v=await p.evaluate(()=>({w:innerWidth,h:innerHeight,dpr:devicePixelRatio}));
  const size=adb('shell','wm','size').match(/Physical size: (\d+)x(\d+)/);
  adb('shell','input','tap',String(Math.round((+size[1]-v.w*v.dpr)/2+(b.x+b.width/2)*v.dpr)),String(Math.round(+size[2]-24*v.dpr-v.h*v.dpr+(b.y+b.height/2)*v.dpr)));
}
function xml(){for(let i=0;i<5;i++){const dump=adb('shell','uiautomator','dump','/sdcard/familiar-gesture.xml');if(dump.includes('dumped to'))return adb('shell','cat','/sdcard/familiar-gesture.xml');}throw Error('UI dump unavailable');}
function foreground(){return adb('shell','dumpsys','activity','activities').split('\n').find(l=>/(?:topResumedActivity|mResumedActivity)/.test(l));}
function petVisible(){return adb('shell','dumpsys','window','windows').split(/  Window #/).some(b=>b.includes('u0 FamiliarPet}')&&b.includes('mHasSurface=true'));}
function pass(name){results.push({name,passed:true});console.log('PASS '+name);}
try{
  adb('shell','am','start','-n',`${app}/app.familiar.mobile.MainActivity`);
  for(let i=0;i<60;i++){try{adb('forward','tcp:9235',`localabstract:webview_devtools_remote_${adb('shell','pidof',app)}`);browser=await chromium.connectOverCDP('http://127.0.0.1:9235');page=browser.contexts()[0].pages()[0];if(page)break;await browser.close();}catch{}await sleep(250);}
  assert(page);await page.locator('#familiar-root[data-ready="true"]').waitFor();before=await until(s=>s.runtime.engine==='ready');
  assert(!before.activeReply&&!before.tasks.length&&!before.voice.state.active&&before.providers.every(p=>!p.profile.keyConfigured));assert.equal(before.capabilities.find(c=>c.id==='accessibility').state,'granted');
  careBefore=await call('care.get');await call('care.save',{revision:careBefore.revision,settings:{...careBefore.settings,enabled:false}});
  await call('provider.save',{...before.providers.find(p=>p.id==='compatible').profile,baseUrl:`http://127.0.0.1:${port}/v1`,model:'gesture-fixture'});
  await call('runtime.set',{enabled:true});await call('pet.settings.save',{scale:1,visible:true,quiet:false,bubbleSeconds:1});
  // 原生任意调用不能通过公开 WebView 桥绕过工具批准。
  const privateCall=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload:{protocolVersion:1,id:'private-gesture',method:'accessibility.gesture',params:{}}}));assert(!privateCall.ok);
  const modes=process.argv.find(a=>a.startsWith('--cases='))?.slice(8).split(',')??['node','tap','longPress','swipe','deny','stale','window','cancel','replay','locked','cancel-start','obstructed'];
  for(mode of modes){
    step=0;screen=null;toolResults=[];adb('shell','am','force-stop',fixture);adb('shell','am','start','-n',fixture+'/.GestureFixtureActivity','--ez','obstruct',String(mode==='obstructed'));await sleep(400);
    const id=(await call('conversation.create')).id;conversations.push(id);await call('message.send',{conversationId:id,text:'本机隔离手势验收 '+mode});
    const read=await until(s=>s.tasks.length===1);await approve();
    const action=await until(s=>s.tasks.length===1&&s.tasks[0].id!==read.tasks[0].id);assert.equal(action.tasks[0].kind,'accessibility');assert.equal(screen.package,fixture);
    const pad=screen.nodes.find(n=>n.description==='Gesture pad');assert.equal(pad.clickable,false);assert.match(foreground(),/GestureFixtureActivity/);
    if(mode==='stale'){
      const button=screen.nodes.find(n=>n.text.toLowerCase()==='change gesture target');assert(button);const [l,t,r,b]=button.bounds;
      // 测试页按钮可能在审批窗之下；先收起再真实触摸，之后通过宠物重开。
      const p=await overlay();await p.getByRole('button',{name:'收起卡片，不批准也不拒绝'}).click();await sleep(200);
      adb('shell','input','tap',String((l+r)/2),String((t+b)/2));await sleep(200);
      const pet=adb('shell','dumpsys','window','windows').split(/  Window #/).find(b=>b.includes('u0 FamiliarPet}')&&b.includes('mHasSurface=true'));
      const box=pet?.match(/Frames:.*? frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);assert(box);adb('shell','input','tap',String((+box[1]+ +box[3])/2),String((+box[2]+ +box[4])/2));await sleep(200);
    }
    if(mode==='window'){adb('shell','am','start','-n',fixture+'/.FixtureActivity');await sleep(300);}
    if(mode==='cancel'){await call('reply.cancel');}
    else if(mode==='locked'){
      adb('shell','input','keyevent','KEYCODE_SLEEP');await sleep(200);await call('task.respond',{id:action.tasks[0].id,action:'approve'});
    }else { await approve(mode!=='deny'); if(mode==='cancel-start') await call('reply.cancel'); }
    if(mode==='replay'){await until(s=>s.tasks.length===1&&s.tasks[0].id!==action.tasks[0].id);await approve();}
    await until(s=>!s.activeReply&&!s.tasks.length);
    if(mode==='locked'){adb('shell','input','keyevent','KEYCODE_WAKEUP');adb('shell','wm','dismiss-keyguard');await sleep(400);}
    if(mode==='window'){
      assert.match(foreground(),/FixtureActivity/);assert(!toolResults.some(r=>r.dispatched));assert(xml().includes('Counter: 0'));
    }else{
      const content=xml();const successful=['tap','longPress','swipe','replay'].includes(mode);
      const expected=mode==='longPress'?'Tap: 0 Hold: 1 Swipe: 0':mode==='swipe'?'Tap: 0 Hold: 0 Swipe: 1':successful?'Tap: 1 Hold: 0 Swipe: 0':'Tap: 0 Hold: 0 Swipe: 0';
      assert(content.includes(expected),mode+' '+content);
      if(successful){assert.equal(toolResults[0]?.dispatched,true,JSON.stringify(toolResults));assert.equal(toolResults[0]?.status,'completed');assert.equal(toolResults[0]?.requiresObservation,true);}
      else if(mode==='node')assert.equal(toolResults[0]?.accepted,false);
      else assert(!toolResults.some(r=>r.dispatched));
      if(mode==='replay')assert(toolResults.length===2&&!toolResults[1].dispatched);
    }
    await until(()=>petVisible());
    if(mode==='swipe'){adb('shell','screencap','-p','/sdcard/familiar-gesture.png');adb('pull','/sdcard/familiar-gesture.png',out+'/gesture-swipe.png');}
    pass({node:'自绘画布无节点点击动作，原节点点击不假报成功',tap:'实体批准后真实点击到达自绘画布，宠物窗口恢复',longPress:'长按由真实触摸时长识别，完成状态回传',swipe:'滑动到达自绘画布，坐标按目标节点换算',deny:'拒绝手势后零触摸',stale:'目标内容改变后旧引用被拒绝',window:'切换窗口后不向新页面注入旧手势',cancel:'批准前取消回复，不执行手势',replay:'执行消费旧观察，同一 snapshotId 不能再次触摸',locked:'熄屏时拒绝手势，亮屏后宠物恢复','cancel-start':'批准后准备注入时取消，画布零触摸',obstructed:'目标被另一窗口遮挡时拒绝注入'}[mode]);
  }
}finally{
  try{if(page&&before){await call('reply.cancel');if(careBefore){const current=await call('care.get');await call('care.save',{revision:current.revision,settings:careBefore.settings});}await call('provider.save',{...before.providers.find(p=>p.id==='compatible').profile});await call('provider.save',{...before.provider});for(const id of conversations)await call('conversation.delete',{id});if(before.activeConversationId)await call('conversation.select',{id:before.activeConversationId});await call('pet.settings.save',{scale:before.pet.scale,visible:before.pet.visible,quiet:before.pet.quiet,bubbleSeconds:before.pet.bubbleSeconds});await call('runtime.set',{enabled:before.runtime.running});}}catch(e){console.error('RESTORE FAILED',e);process.exitCode=1;}
  await overlayBrowser?.close();await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));adb('reverse','--remove',`tcp:${port}`);adb('forward','--remove','tcp:9235');adb('forward','--remove','tcp:9236');adb('shell','rm','-f','/sdcard/familiar-gesture.xml','/sdcard/familiar-gesture.png');
  const path=adb('shell','pm','path',app).split('\n').find(s=>s.startsWith('package:')).slice(8);const sha=adb('shell','sha256sum',path).split(/\s+/)[0];
  const suffix=process.argv.some(a=>a.startsWith('--cases='))?'-extra':'';
  await writeFile(out+'/gesture-smoke'+suffix+'.json',JSON.stringify({date:new Date().toISOString(),results,apkSha256:sha},null,2));
}
