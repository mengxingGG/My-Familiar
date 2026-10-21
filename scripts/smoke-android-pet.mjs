import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
const app='app.familiar.mobile.debug',output='.artifacts/android-device';
const adb=(...a)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...a],{encoding:'utf8',windowsHide:true}).trim();
const delay=ms=>new Promise(r=>setTimeout(r,ms));let browser,page,seq=0,before,conversation,port;
const results=[];function pass(name){results.push(name);console.log('PASS '+name);}
const server=createServer(async(req,res)=>{for await(const chunk of req){} if(req.url.endsWith('/models')){res.end(JSON.stringify({data:[{id:'pet-fixture'}]}));return;}res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`data: ${JSON.stringify({choices:[{delta:{content:'停靠测试：'},finish_reason:null}]})}\n\n`);const timer=setTimeout(()=>res.end(`data: ${JSON.stringify({choices:[{delta:{content:'回复仍然可见。'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`),3500);res.on('close',()=>clearTimeout(timer));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;adb('reverse',`tcp:${port}`,`tcp:${port}`);
async function connect(){
 await browser?.close();browser=null;adb('shell','am','start','-n',`${app}/app.familiar.mobile.MainActivity`);
 for(let i=0;i<60;i++){try{adb('forward','tcp:9223',`localabstract:webview_devtools_remote_${adb('shell','pidof',app)}`);browser=await chromium.connectOverCDP('http://127.0.0.1:9223');page=browser.contexts()[0].pages()[0];if(page)break;await browser.close();browser=null;}catch{}await delay(250);}
 assert(browser&&page,'Main WebView failed to reconnect');await page.locator('#familiar-root[data-ready="true"]').waitFor();
}
async function call(method,params){const r=await page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:`pet-test-${++seq}`,method,params});assert(r.ok,JSON.stringify(r));return r.result;}
const snapshot=()=>call('snapshot.get');
function windowBox(title='FamiliarPet'){const block=adb('shell','dumpsys','window','windows').split(/  Window #/).find(b=>b.includes(`u0 ${title}}`)&&b.includes('mHasSurface=true'));const m=block?.match(/Frames:.*? frame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);return m?{x:+m[1],y:+m[2],w:+m[3]-m[1],h:+m[4]-m[2]}:null;}
async function waitBox(check,timeout=6000){for(let until=Date.now()+timeout;Date.now()<until;){const b=windowBox();if(b&&check(b))return b;await delay(200);}throw Error('Unexpected pet window '+JSON.stringify(windowBox()));}
async function drag(cx,cy){const b=windowBox();assert(b);adb('shell','input','swipe',String(b.x+b.w/2),String(b.y+b.h/2),String(cx),String(cy),'350');await delay(350);return windowBox();}
async function shot(name){adb('shell','screencap','-p','/sdcard/familiar-pet-test.png');adb('pull','/sdcard/familiar-pet-test.png',`${output}/${name}.png`);}
async function home(){adb('shell','input','keyevent','KEYCODE_HOME');await delay(400);await snapshot();}
try{
 await connect();before=await snapshot();await writeFile(`${output}/pet-before.json`,JSON.stringify(before));assert(before.pet?.docking);assert(!before.provider.keyConfigured,'fixture refuses to replace configured provider key');
 await call('pet.settings.save',{scale:1,visible:true,quiet:true,bubbleSeconds:0});await call('runtime.set',{enabled:true});await call('pet.docking.save',{snapToEdge:false,hideWhenIdle:true,delaySeconds:10});await call('pet.interact',{action:'reset-position'});await home();
 await waitBox(b=>b.w===448);const free=await drag(720,1200);assert(Math.abs(free.x-496)<=3&&Math.abs(free.y-976)<=3,JSON.stringify(free));await delay(11000);assert.equal(windowBox().w,448);pass('关闭吸附：自由拖动位置保留，闲置不收起');
 await call('pet.docking.save',{snapToEdge:true,hideWhenIdle:false,delaySeconds:10});await drag(900,1200);await waitBox(b=>b.x===960&&b.w===448);await drag(1320,360);const corner=await waitBox(b=>b.x===960&&b.y===128);await shot('pet-corner');
 await drag(1400,corner.y+224);await waitBox(b=>b.w===192);assert((await snapshot()).pet.docking.tucked);await shot('pet-head');pass('最近边缘与角落吸附；向外滑只留下 48dp 小脑袋窗口');
 let b=windowBox();adb('shell','input','tap',String(b.x+b.w/2),String(b.y+b.h/2));await waitBox(b=>b.w===448);assert(/mCurrentFocus=.*com.android.launcher3/.test(adb('shell','dumpsys','window')));assert(!(await snapshot()).pet.docking.tucked);
 await drag(1400,windowBox().y+224);await waitBox(b=>b.w===192);await drag(900,1000);await waitBox(b=>b.w===448);pass('点击小脑袋和向内拖动均展开');
 // 闲置开关关闭时保持完整形象；开启后按指定时间收起。
 await delay(11000);assert.equal(windowBox().w,448);await call('pet.docking.save',{snapToEdge:true,hideWhenIdle:true,delaySeconds:10});await waitBox(b=>b.w===192,13000);pass('闲置收起独立开关与 10 秒定时生效');
 await delay(400);b=windowBox();adb('shell','input','tap',String(b.x+b.w/2),String(b.y+b.h/2));await waitBox(b=>b.w===448);
 const saved=windowBox();adb('shell','am','force-stop',app);await connect();assert.equal((await snapshot()).pet.docking.delaySeconds,10);assert((await snapshot()).pet.docking.snapToEdge);await call('runtime.set',{enabled:true});await home();await waitBox(b=>Math.abs(b.x-saved.x)<=1&&Math.abs(b.y-saved.y)<=1);pass('进程重启后停靠设置与归一化位置恢复');
 await call('pet.docking.save',{snapToEdge:true,hideWhenIdle:false,delaySeconds:10});await call('pet.interact',{action:'reset-position'});assert((await snapshot()).pet.docking.snapToEdge);await call('pet.interact',{action:'sleep'});assert.equal((await snapshot()).pet.action,'sleep');await shot('pet-sleep');
 b=windowBox();adb('shell','input','swipe',String(b.x+b.w/2),String(b.y+b.h/2),String(b.x+b.w/2),String(b.y+b.h/2),'800');await delay(300);assert(windowBox('FamiliarSpeech'));await shot('pet-menu');
 // 点击菜单“醒来”，确保菜单通过共享行为核心操作。
 const menu=windowBox('FamiliarSpeech');adb('shell','input','tap',String(Math.round(menu.x+menu.w*.5)),String(menu.y+menu.h-96));await delay(400);assert.equal((await snapshot()).pet.action,'idle');pass('休息动作与原生长按菜单连接共享核心');
 await call('provider.save',{kind:'compatible',baseUrl:`http://127.0.0.1:${port}/v1`,model:'pet-fixture'});conversation=(await call('conversation.create')).id;
 await call('pet.docking.save',{snapToEdge:true,hideWhenIdle:true,delaySeconds:10});await drag(900,1200);await waitBox(b=>b.w===192,13000);
 await call('message.send',{conversationId:conversation,text:'停靠气泡测试'});await waitBox(b=>b.w===448);assert.equal((await snapshot()).pet.action,'think');
 for(let i=0;i<30&&!windowBox('FamiliarSpeech');i++)await delay(100);assert(windowBox('FamiliarSpeech'));await shot('pet-thinking');await delay(4300);assert(!(await snapshot()).activeReply);assert(windowBox('FamiliarSpeech'));await shot('pet-reply');pass('收起时新回复自动展开，思考动画和真实流式气泡同步');
 const speech=windowBox('FamiliarSpeech');adb('shell','input','tap',String(Math.round(speech.x+speech.w*.75)),String(speech.y+speech.h-96));await delay(300);assert(!windowBox('FamiliarSpeech'));
 adb('shell','input','keyevent','KEYCODE_SLEEP');await delay(500);assert(!windowBox());assert(!windowBox('FamiliarSpeech'));adb('shell','input','keyevent','KEYCODE_WAKEUP');adb('shell','wm','dismiss-keyguard');await delay(600);await waitBox(b=>b.w===448);pass('收起气泡与熄屏移除全部宠物窗口，亮屏后恢复');
}finally{
 try {
  if (before) {
   if (!browser?.isConnected() || page?.isClosed()) await connect();
   await call('reply.cancel');
   // 先切回原会话，避免删除当前测试会话时由核心额外创建空会话。
   if (before.activeConversationId) await call('conversation.select', {id: before.activeConversationId});
   if (conversation) await call('conversation.delete', {id: conversation});
   await call('provider.save', {...before.provider, clearApiKey: false});
   await call('pet.settings.save', {scale: before.pet.scale, visible: before.pet.visible, quiet: before.pet.quiet, bubbleSeconds: before.pet.bubbleSeconds});
   await call('pet.docking.save', before.pet.docking);
   await call('pet.interact', {action: 'reset-position'});
  }
 } catch(e) {console.error('RESTORE FAILED', e); process.exitCode = 1;}
 await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));adb('reverse','--remove',`tcp:${port}`);await writeFile(`${output}/pet-smoke.json`,JSON.stringify({date:new Date().toISOString(),results},null,2));
}
