import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {liveFixture} from '../tests/fixtures/live-voice.ts';
const app='app.familiar.mobile.debug',out='.artifacts/android-device',results=[];
const adb=(...a)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...a],{encoding:'utf8',windowsHide:true}).trim();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const fixture=await liveFixture();adb('reverse',`tcp:${fixture.port}`,`tcp:${fixture.port}`);
let browser,page,before,conversation,seq=0;
const raw=(method,params)=>page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:`live-${++seq}`,method,params});
const call=async(method,params)=>{const r=await raw(method,params);assert(r.ok,`${method}: ${r.error?.code}`);return r.result;};
async function wait(predicate){for(let i=0;i<100;i++){if(await predicate())return;await delay(100);}throw Error('LIVE_TIMEOUT '+JSON.stringify((await call('snapshot.get')).voice.state));}
const state=()=>call('snapshot.get');
const services=()=>adb('shell','dumpsys','activity','services',app);
const recording=()=>adb('shell','cmd','appops','get',app,'RECORD_AUDIO').includes('(running)');
async function released(){await wait(()=>!services().includes('VoiceService'));assert(!recording());}
function foreground(){adb('shell','am','start','-n',`${app}/app.familiar.mobile.MainActivity`);}
async function attach(){foreground();for(let i=0;i<60;i++)try{const pid=adb('shell','pidof',app);adb('forward','tcp:9242',`localabstract:webview_devtools_remote_${pid}`);browser=await chromium.connectOverCDP('http://127.0.0.1:9242');break;}catch{await delay(250);}assert(browser);page=browser.contexts()[0].pages()[0];await page.locator('#familiar-root[data-ready="true"]').waitFor();await delay(300);}
function nodes(){adb('shell','uiautomator','dump','/sdcard/familiar-live.xml');return [...adb('shell','cat','/sdcard/familiar-live.xml').matchAll(/<node\b[^>]+>/g)].map(m=>Object.fromEntries([...m[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],a[2]])));}
function tap(n){assert(n,'notification stop missing');const b=[...n.bounds.matchAll(/\d+/g)].map(m=>Number(m[0]));adb('shell','input','tap',String((b[0]+b[2])/2),String((b[1]+b[3])/2));}
async function notificationStop(){adb('shell','cmd','statusbar','expand-notifications');await delay(300);let visible=nodes(),stop=visible.find(n=>n.text==='停止语音');if(!stop){const expand=visible.find(n=>n['content-desc']?.includes('展开')&&n.package==='com.android.systemui');if(expand){tap(expand);stop=nodes().find(n=>n.text==='停止语音');}}tap(stop);await wait(async()=>!(await state()).voice.state.active);await released();adb('shell','input','keyevent','KEYCODE_BACK');}
function pass(name){results.push(name);console.log('PASS '+name);}
const config=kind=>({mode:'realtime',kind,baseUrl:fixture.url,model:'fixture-live',voice:'fixture-voice'});
async function start(){const length=fixture.sessions.length;await call('voice.start',{mode:'conversation',conversationId:conversation});await wait(()=>fixture.sessions.length===length+1&&!!fixture.sessions.at(-1).setup);return fixture.sessions.at(-1);}
try{
 await attach();before=await state();await writeFile(out+'/live-before.json',JSON.stringify(before));
 assert(before.voice.live);assert(!before.voice.state.active&&!before.voice.wake.armed);assert(!before.voice.live.profile.keyConfigured);assert(before.providers.every(p=>!p.profile.keyConfigured));
 assert(before.capabilities.some(c=>c.id==='microphone'&&c.state==='granted'));
 await call('provider.save',{kind:'compatible',baseUrl:fixture.url,model:'fixture-chat'});conversation=(await call('conversation.create')).id;
 for(const kind of ['openai','gemini']){
  await call('voice.live.save',{...config(kind),apiKey:'DEVICE_TEST_'+kind});await call('voice.save',before.voice.settings);
  assert.equal((await state()).voice.live.mode,'realtime');assert(!recording());
  const socket=await start();assert.equal(socket.auth,(kind==='openai'?'Bearer ':'')+'DEVICE_TEST_'+kind);
  adb('shell','input','keyevent','KEYCODE_HOME');await wait(()=>services().includes('VoiceService'));
  assert.equal((await state()).voice.state.phase,'connecting');assert.equal(socket.bytes,0);assert(!recording());
  fixture.ready();await wait(()=>socket.bytes>=9600);assert(recording());assert((await state()).voice.state.active);
  assert.equal((await raw('voice.live.save',config(kind))).error?.code,'BUSY');
  const count=fixture.models.length;fixture.ask();fixture.ask();await wait(()=>socket.messages.some(m=>m.toolResponse||m.item?.type==='function_call_output'));
  assert.equal(fixture.models.length,count+1);
  fixture.audio();await wait(async()=>(await state()).voice.state.phase==='speaking');await wait(async()=>(await state()).voice.state.phase==='listening');
  assert(recording());pass(`${kind}: 握手时退桌面，准备阶段不录音；真实 PCM 输入、主模型代理、原生播放回执通过`);
  if(kind==='openai')await notificationStop();else {fixture.disconnect();await wait(async()=>(await state()).voice.state.phase==='error');await released();}
  await wait(()=>socket.closed);assert.equal((await raw('voice.start',{mode:'conversation',conversationId:conversation})).error?.code,'UNAVAILABLE');
  foreground();await delay(300);assert(!(await state()).voice.state.active);
 }
 pass('通知按钮停止及 WebSocket 断线均释放录音和语音服务，后台网页不能重新开麦');
 const late=await start();assert.equal(late.bytes,0);await notificationStop();await wait(()=>late.closed);await delay(400);assert(!recording());foreground();await delay(300);
 pass('握手未完成时通知停止，旧连接关闭且不复活麦克风');
 const socket=await start();fixture.ready();await wait(()=>socket.bytes>0);fixture.slow(4000);const n=fixture.models.length;fixture.ask('cancelled-model');await wait(()=>fixture.models.length>n);await call('voice.stop');await released();await wait(()=>socket.closed);await delay(300);
 assert(!socket.messages.some(m=>m.item?.call_id==='cancelled-model'||m.toolResponse?.functionResponses?.some(f=>f.id==='cancelled-model')));fixture.slow(0);
 pass('主模型生成期间停止取消回答，没有迟到 Live 工具回写');
 await browser.close();browser=undefined;adb('shell','am','force-stop',app);await attach();
 const reboot=await state();assert.equal(reboot.voice.live.mode,'realtime');assert.equal(reboot.voice.live.profile.kind,'gemini');assert(reboot.voice.live.profile.keyConfigured);assert(!reboot.voice.state.active&&!reboot.voice.wake.armed);assert(!recording()&&!services().includes('VoiceService'));
 pass('进程重启保留 Live 模式及加密密钥，不自动连接或录音');
 await page.getByRole('button',{name:'设置',exact:true}).click();const details=page.locator('details').filter({has:page.locator('.live-form')});if(await details.getAttribute('open')===null)await details.locator('summary').click();await page.locator('.live-form').scrollIntoViewIfNeeded();
 assert(await page.locator('.live-form').isVisible());assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:out+'/live-settings-device.png'});
 const bytes=await readFile('apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk');const sha=createHash('sha256').update(bytes).digest('hex');const installed=adb('shell','pm','path',app).split('\n').find(s=>s.startsWith('package:')).slice(8);assert.equal(adb('shell','sha256sum',installed).split(/\s+/)[0],sha);
 await writeFile(out+'/live-smoke.json',JSON.stringify({date:new Date().toISOString(),apkSha:sha,results,sessions:fixture.sessions.map(s=>({kind:s.kind,path:s.path,bytes:s.bytes,closed:s.closed})),modelRequests:fixture.models.length,limitations:['local protocol fixtures, actual AudioRecord and AudioTrack; no real cloud recognition or human voice quality validation']},null,2));
}finally{
 try{if(before&&page){await call('voice.stop');for(const kind of ['openai','gemini'])await call('voice.live.save',{...config(kind),clearApiKey:true});await call('voice.live.save',{mode:before.voice.live.mode,...before.voice.live.profile});await call('voice.save',before.voice.settings);if(before.activeConversationId)await call('conversation.select',{id:before.activeConversationId});if(conversation)await call('conversation.delete',{id:conversation});const prior=before.providers.find(p=>p.id==='compatible').profile;await call('provider.save',prior);if(before.provider.kind!=='compatible')await call('provider.save',before.provider);await call('runtime.set',{enabled:before.runtime.running});await released();}}
 finally{await browser?.close();await fixture.close();adb('reverse','--remove',`tcp:${fixture.port}`);adb('forward','--remove','tcp:9242');adb('shell','rm','-f','/sdcard/familiar-live.xml');}
}
