import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
const app='app.familiar.mobile.debug',out='.artifacts/android-device';await mkdir(out,{recursive:true});
const adb=(...a)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...a],{encoding:'utf8',windowsHide:true}).trim();
const delay=ms=>new Promise(r=>setTimeout(r,ms));const results=[],requests=[];
const server=createServer(async(req,res)=>{
 const parts=[];for await(const part of req)parts.push(part);const body=Buffer.concat(parts);
 requests.push({path:req.url,bytes:body.length});res.setHeader('Content-Type','application/json');
 if(req.url.endsWith('/models'))res.end(JSON.stringify({data:[{id:'wake-device-fixture',context_length:32768}]}));
 else if(req.url.endsWith('/transcriptions'))res.end(JSON.stringify({text:''}));
 else{res.statusCode=400;res.end('{}');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;adb('reverse',`tcp:${port}`,`tcp:${port}`);
let browser,page,before,conversation,sequence=0,installedFixture=false;
const raw=(method,params)=>page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:`wake-device-${++sequence}`,method,params});
const call=async(method,params)=>{const r=await raw(method,params);assert(r.ok,`${method}: ${r.error?.code}`);return r.result;};
async function connect(){await browser?.close();browser=null;adb('shell','am','start','-n',`${app}/app.familiar.mobile.MainActivity`);for(let i=0;i<60;i++){try{adb('forward','tcp:9240',`localabstract:webview_devtools_remote_${adb('shell','pidof',app)}`);browser=await chromium.connectOverCDP('http://127.0.0.1:9240');page=browser.contexts()[0].pages()[0];if(page)break;}catch{}await delay(250);}assert(browser&&page);await page.locator('#familiar-root[data-ready="true"]').waitFor();}
async function until(predicate){const end=Date.now()+25000;let s;while(Date.now()<end){s=await call('snapshot.get');if(predicate(s))return s;await delay(200);}throw Error('Wake device timeout '+JSON.stringify(s?.voice));}
const service=()=>adb('shell','dumpsys','activity','services',app).includes('VoiceService');
const recording=()=>adb('shell','cmd','appops','get',app,'RECORD_AUDIO').includes('running');
async function released(){await until(s=>!s.voice.wake.armed&&!s.voice.state.active);for(let i=0;i<30&&(service()||recording());i++)await delay(100);assert(!service(),'VoiceService remains');assert(!recording(),'microphone remains');}
function nodes(){adb('shell','uiautomator','dump','/sdcard/familiar-wake-window.xml');return [...adb('shell','cat','/sdcard/familiar-wake-window.xml').matchAll(/<node\b[^>]+>/g)].map(m=>Object.fromEntries([...m[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],a[2]])));}
function tap(n){assert(n,'visible notification control missing');const b=[...n.bounds.matchAll(/\d+/g)].map(v=>+v[0]);adb('shell','input','tap',String((b[0]+b[2])/2),String((b[1]+b[3])/2));}
const pass=text=>{results.push(text);console.log('PASS',text);};
try{
 await connect();before=await call('snapshot.get');await writeFile(out+'/wake-before.json',JSON.stringify(before));
 assert(before.voice?.wake&&!before.voice.wake.armed&&!before.voice.state.active);assert(before.providers.every(p=>!p.profile.keyConfigured));assert(!before.voice.settings.stt.keyConfigured&&!before.voice.settings.tts.keyConfigured);
 assert(before.capabilities.some(c=>c.id==='microphone'&&c.state==='granted'));
 const baseUrl=`http://127.0.0.1:${port}/v1`;
 await call('voice.save',{stt:{kind:'compatible',baseUrl,model:'wake-stt'},tts:{kind:'compatible',baseUrl,model:'wake-tts',voice:'test',speed:1},autoRead:false,continuous:true});
 await call('provider.save',{kind:'compatible',baseUrl,model:'wake-device-fixture'});conversation=(await call('conversation.create')).id;
 if(await page.locator('.page-chat').isVisible()){await page.locator('.page-chat').getByRole('button',{name:'返回',exact:true}).click();await page.locator('.page-chat').waitFor({state:'hidden'});}
 await page.getByRole('button',{name:'设置',exact:true}).click();const details=page.locator('details').filter({has:page.locator('.wake-form')});if(await details.getAttribute('open')===null)await details.locator('summary').click();
 const form=page.locator('.wake-form');await form.locator('[name=enabled]').check();await form.locator('[name=phrases]').fill('灵伴离线测试');await form.getByRole('button',{name:'保存唤醒设置',exact:true}).click();await until(s=>s.voice.wake.enabled&&s.voice.wake.phrases[0]==='灵伴离线测试');
 assert(!recording()&&!service());pass('真实页面保存唤醒词，不启动录音或语音服务');
 await form.locator('.wake-start').click();await until(s=>s.voice.wake.listening&&s.voice.state.phase==='sleeping');assert(service()&&recording());await page.screenshot({path:out+'/wake-listening.png'});
 adb('shell','input','keyevent','KEYCODE_HOME');await delay(1500);assert((await call('snapshot.get')).voice.wake.listening);assert(recording());assert(!requests.some(r=>!r.path.endsWith('/models')));pass('真实 ARM64 模型和 AudioRecord 待机，退到桌面仍运行，未命中不发音频网络请求');
 adb('shell','cmd','statusbar','expand-notifications');await delay(400);let ui=nodes(),stop=ui.find(n=>n.text==='停止语音');
 if(!stop){const expand=ui.find(n=>n['content-desc']?.includes('展开')&&n.package==='com.android.systemui');if(expand){tap(expand);await delay(300);stop=nodes().find(n=>n.text==='停止语音');}}
 tap(stop);await released();await delay(800);assert(!service()&&!recording());adb('shell','input','keyevent','KEYCODE_BACK');pass('通知栏真实停止按钮释放麦克风和前台服务，不自动重开');
 adb('shell','input','keyevent','KEYCODE_HOME');const denied=await raw('voice.wake.start',{conversationId:conversation,foregroundAt:Date.now()});assert.equal(denied.error?.code,'UNAVAILABLE');assert(!recording());
 assert.equal((await raw('voice.wake.host',{type:'ready'})).ok,false);pass('后台伪造前台时间不能启动，页面不能注入原生唤醒事件');
 adb('shell','am','start','-n',`${app}/app.familiar.mobile.MainActivity`);await delay(300);await call('voice.wake.start',{conversationId:conversation});await call('voice.stop');await released();await delay(800);assert(!recording());pass('启动后立即停止，迟到初始化不能恢复录音');
 await call('voice.wake.start',{conversationId:conversation});await until(s=>s.voice.wake.listening);
 assert.equal((await raw('conversation.create')).error?.code,'BUSY');assert.equal((await raw('voice.wake.save',{enabled:false,phrases:[],sensitivity:50})).error?.code,'BUSY');
 if(!adb('shell','pm','list','packages','app.familiar.fixture').includes('package:app.familiar.fixture')){adb('install','-r','.artifacts/android-fixture/fixture.apk');installedFixture=true;}
 adb('shell','am','start','-n','app.familiar.fixture/.FixtureActivity','--ez','takeAudioFocus','true');await released();adb('shell','am','force-stop','app.familiar.fixture');adb('shell','am','start','-n',`${app}/app.familiar.mobile.MainActivity`);await delay(500);assert(!recording());pass('会话和配置在待机时锁定；其他应用抢占音频焦点后停止，焦点归还不自启');
 await call('voice.wake.start',{conversationId:conversation});await until(s=>s.voice.wake.listening);adb('shell','am','force-stop',app);await connect();const reboot=await call('snapshot.get');assert(reboot.voice.wake.enabled&&!reboot.voice.wake.armed&&!reboot.voice.state.active);assert(!service()&&!recording());pass('进程重启保留唤醒设置，但不自动打开麦克风');
 const path=adb('shell','pm','path',app).split('\n').find(v=>v.startsWith('package:')).slice(8);const bytes=await readFile('apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk');const hash=createHash('sha256').update(bytes).digest('hex');assert.equal(adb('shell','sha256sum',path).split(/\s+/)[0],hash);
 await writeFile(out+'/wake-device-smoke.json',JSON.stringify({date:new Date().toISOString(),apkSha:hash,results,requests,limitations:['actual microphone lifecycle tested; no claim of live human keyword recall or noise accuracy']},null,2));
}finally{
 try{if(before&&page){await call('voice.stop');await call('voice.wake.save',{enabled:before.voice.wake.enabled,phrases:before.voice.wake.phrases,sensitivity:before.voice.wake.sensitivity});await call('voice.save',before.voice.settings);if(before.activeConversationId)await call('conversation.select',{id:before.activeConversationId});if(conversation)await call('conversation.delete',{id:conversation});await call('provider.save',before.providers.find(p=>p.id==='compatible').profile);if(before.provider.kind!=='compatible')await call('provider.save',before.provider);await call('runtime.set',{enabled:before.runtime.running});}}
 finally{await browser?.close();adb('forward','--remove','tcp:9240');adb('reverse','--remove',`tcp:${port}`);adb('shell','rm','-f','/sdcard/familiar-wake-window.xml');if(installedFixture)adb('uninstall','app.familiar.fixture');server.closeAllConnections();await new Promise(r=>server.close(r));}
}
