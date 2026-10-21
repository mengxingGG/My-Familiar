import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
const app='app.familiar.mobile.debug',out='.artifacts/android-device',results=[];
const adb=(...a)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...a],{encoding:'utf8',windowsHide:true}).trim();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let browser,page,before,originalDraft,fixture=false,seq=0;
const raw=(method,params)=>page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:`system-speech-${++seq}`,method,params});
const call=async(method,params)=>{const r=await raw(method,params);assert(r.ok,`${method}: ${r.error?.code}`);return r.result;};
async function until(predicate){for(let i=0;i<60;i++){const state=await call('snapshot.get');if(predicate(state))return state;await delay(150);}throw Error('STATE_TIMEOUT');}
function nodes(){adb('shell','uiautomator','dump','/sdcard/familiar-system-speech.xml');return [...adb('shell','cat','/sdcard/familiar-system-speech.xml').matchAll(/<node\b[^>]+>/g)].map(m=>Object.fromEntries([...m[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],a[2]])));}
function press(label){const n=nodes().find(n=>n.text===label);assert(n,`missing ${label}`);const b=[...n.bounds.matchAll(/\d+/g)].map(m=>Number(m[0]));adb('shell','input','tap',String((b[0]+b[2])/2),String((b[1]+b[3])/2));}
function pass(name){results.push(name);console.log('PASS '+name);}
try{
 assert(!adb('shell','pm','list','packages','app.familiar.fixture'));
 adb('shell','am','start','-n',`${app}/app.familiar.mobile.MainActivity`);
 for(let i=0;i<60;i++)try{const pid=adb('shell','pidof',app);adb('forward','tcp:9241',`localabstract:webview_devtools_remote_${pid}`);browser=await chromium.connectOverCDP('http://127.0.0.1:9241');break;}catch{await delay(250);}
 assert(browser);page=browser.contexts()[0].pages()[0];await page.locator('#familiar-root[data-ready="true"]').waitFor();before=await call('snapshot.get');await writeFile(out+'/system-speech-before.json',JSON.stringify(before));
 assert.equal(before.voice.systemInput,false);assert.equal((await raw('voice.system.input',{conversationId:before.activeConversationId})).error?.code,'UNAVAILABLE');
 if(!await page.locator('.page-chat').isVisible())await page.getByRole('button',{name:'说句话',exact:true}).click();
 const button=page.getByRole('button',{name:'系统语音输入',exact:true}),input=page.getByRole('textbox',{name:'想说的话',exact:true});
 assert(!await button.isVisible());originalDraft=await input.inputValue();await input.fill('原草稿');pass('无系统识别入口时按钮隐藏，直接调用也拒绝');
 adb('install','-r','.artifacts/android-fixture/fixture.apk');fixture=true;await until(s=>s.voice.systemInput);await button.waitFor();
 await button.click();assert(nodes().some(n=>n.text==='系统听写接口已收到'));press('返回识别文字');
 await page.waitForFunction(()=>document.querySelector('.composer-input').value.includes('系统识别测试'));
 const text='原草稿\n系统识别测试 <script>文字不执行</script>';assert.equal(await input.inputValue(),text);
 assert(!adb('shell','cmd','appops','get',app,'RECORD_AUDIO').includes('(running)'));
 const after=await call('snapshot.get');
 const contents=s=>s.conversations.map(({id,title,messages})=>({id,title,messages}));
 assert.deepEqual(contents(after),contents(before));assert(!after.activeReply);
 await page.screenshot({path:out+'/system-speech-draft.png'});pass('真实 Intent 与 Activity 回调返回首条候选，按纯文本追加草稿，不录音或自动发送');
 for(const label of ['取消听写','返回空结果']){await button.click();press(label);await delay(300);assert.equal(await input.inputValue(),text);}
 pass('系统界面取消和空结果保留原草稿');
 await page.evaluate(payload=>{window.systemSpeechReply=window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload});},{protocolVersion:1,id:'system-speech-long',method:'voice.system.input',params:{conversationId:before.activeConversationId}});
 await delay(300);press('返回超长结果');assert.equal((await page.evaluate(()=>window.systemSpeechReply)).error?.code,'INVALID_INPUT');assert.equal(await input.inputValue(),text);pass('超出 8000 字符的外部结果明确拒绝，不截断或覆盖草稿');
 assert(!before.voice.settings.stt.keyConfigured&&!before.voice.settings.tts.keyConfigured);
 await call('voice.save',{...before.voice.settings,stt:{kind:'compatible',baseUrl:'http://127.0.0.1:1234/v1',model:'isolated-input-check'}});
 await call('voice.start',{mode:'dictation',conversationId:before.activeConversationId});await until(s=>s.voice.state.phase==='recording');
 assert.equal((await raw('voice.system.input',{conversationId:before.activeConversationId})).error?.code,'BUSY');await call('voice.stop');await call('voice.save',before.voice.settings);
 adb('shell','input','keyevent','KEYCODE_HOME');assert.equal((await raw('voice.system.input',{conversationId:before.activeConversationId})).error?.code,'UNAVAILABLE');adb('shell','am','start','-n',`${app}/app.familiar.mobile.MainActivity`);pass('已有录音时拒绝交接，后台网页调用不能启动系统输入');
 adb('uninstall','app.familiar.fixture');fixture=false;await until(s=>!s.voice.systemInput);await page.waitForFunction(()=>document.querySelector('.system-speech').hidden);
 pass('卸载识别接收应用后能力与界面恢复不可用');
 const bytes=await readFile('apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk');const sha=createHash('sha256').update(bytes).digest('hex');
 const path=adb('shell','pm','path',app).split('\n').find(x=>x.startsWith('package:')).slice(8);assert.equal(adb('shell','sha256sum',path).split(/\s+/)[0],sha);
 await writeFile(out+'/system-speech-smoke.json',JSON.stringify({date:new Date().toISOString(),apkSha:sha,results,limitations:['isolated recognition Activity returns fixed text; no actual speech engine is installed on this emulator']},null,2));
}finally{
 try{if(before&&page){await call('voice.stop');await call('voice.save',before.voice.settings);if(originalDraft!==undefined)await page.getByRole('textbox',{name:'想说的话',exact:true}).fill(originalDraft);}}
 finally{await browser?.close();if(fixture)adb('uninstall','app.familiar.fixture');adb('forward','--remove','tcp:9241');adb('shell','rm','-f','/sdcard/familiar-system-speech.xml');}
}
