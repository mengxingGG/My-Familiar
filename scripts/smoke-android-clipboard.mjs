import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
const app='app.familiar.mobile.debug',fixture='app.familiar.fixture',out='.artifacts/android-device';
const adb=(...a)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...a],{encoding:'utf8',windowsHide:true}).trim();
const delay=ms=>new Promise(r=>setTimeout(r,ms)),digest=b=>createHash('sha256').update(b).digest('hex');
let browser,page,before,careBefore,seq=0,conversation,originalHash,clipboardBackedUp=false,fixtureInstalled=false,received,requestCount=0;
const results=[],conversations=[],imported=new Set();
const server=createServer(async(req,res)=>{if(req.url.endsWith('/models')){res.end(JSON.stringify({data:[{id:'clipboard-fixture',context_window:32768}]}));return;}let body='';for await(const chunk of req)body+=chunk;received=JSON.parse(body);requestCount++;res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:'已收到粘贴的完整原图'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;adb('reverse',`tcp:${port}`,`tcp:${port}`);
const raw=(method,params)=>page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:`clipboard-${++seq}`,method,params});
const call=async(method,params)=>{const r=await raw(method,params);assert(r.ok,`${method}: ${r.error?.code}`);return r.result;};
const state=()=>call('snapshot.get');
async function wait(predicate,ms=15000){for(let end=Date.now()+ms;Date.now()<end;){const s=await state();if(await predicate(s))return s;await delay(100);}throw Error('CLIPBOARD_TIMEOUT');}
async function foreground(){adb('shell','am','start','-n',`${app}/app.familiar.mobile.MainActivity`);for(let i=0;i<60;i++){if(/mCurrentFocus=.*app\.familiar\.mobile\.debug.*MainActivity/.test(adb('shell','dumpsys','window')))break;assert(i<59,'Native activity has not received focus');await delay(100);}}
async function attach(){await browser?.close();browser=undefined;page=undefined;await foreground();for(let i=0;i<60;i++)try{adb('forward','tcp:9245',`localabstract:webview_devtools_remote_${adb('shell','pidof',app)}`);browser=await chromium.connectOverCDP('http://127.0.0.1:9245');page=browser.contexts()[0].pages()[0];break;}catch{await delay(200);}assert(page);await page.locator('#familiar-root[data-ready="true"]').waitFor();}
function nodes(){adb('shell','uiautomator','dump','/sdcard/familiar-clipboard.xml');return [...adb('shell','cat','/sdcard/familiar-clipboard.xml').matchAll(/<node\b[^>]+>/g)].map(m=>Object.fromEntries([...m[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],a[2]])));}
function tap(node){assert(node,'fixture control missing');const p=[...node.bounds.matchAll(/\d+/g)].map(m=>+m[0]);adb('shell','input','tap',String(Math.round((p[0]+p[2])/2)),String(Math.round((p[1]+p[3])/2)));}
async function copy(mode){adb('shell','am','start','-n',`${fixture}/.ClipboardFixtureActivity`,'--es','mode',mode);tap(nodes().find(n=>n.text==='复制测试内容'));clipboardBackedUp=true;const label=nodes().find(n=>n.text.includes('SHA256='));assert(label, 'clipboard fixture copy failed');originalHash=label.text.match(/SHA256=([a-f0-9]{64})/)[1];await foreground();}
async function chat(){if(!await page.locator('.page-chat').isVisible()){await page.getByRole('button',{name:'小窝',exact:true}).click();await page.getByRole('button',{name:'说句话',exact:true}).click();}}
const paste=()=>page.getByRole('button',{name:'粘贴剪贴板图片',exact:true});
const count=()=>page.locator('.tray-item').count();
const ids=()=>page.locator('.tray-item').evaluateAll(els=>els.map(e=>e.dataset.id));
function pass(name){results.push(name);console.log('PASS '+name);}
try{
 assert(!adb('shell','pm','list','packages',fixture));adb('install','-r','.artifacts/android-fixture/fixture.apk');fixtureInstalled=true;
 await attach();before=await wait(s=>s.runtime.engine==='ready');await writeFile(out+'/clipboard-before.json',JSON.stringify(before));
 assert(!before.activeReply&&!before.voice.state.active&&before.providers.every(p=>!p.profile.keyConfigured));assert(before.media.paste);
 careBefore=await call('care.get');await writeFile(out+'/clipboard-care-before.json',JSON.stringify(careBefore));await call('care.save',{revision:careBefore.revision,settings:{...careBefore.settings,enabled:false}});
 await call('provider.save',{kind:'compatible',baseUrl:`http://127.0.0.1:${port}/v1`,model:'clipboard-fixture'});
 conversation=(await call('conversation.create')).id;conversations.push(conversation);await page.reload();await page.locator('#familiar-root[data-ready="true"]').waitFor();await chat();
 const composer=page.getByRole('textbox',{name:'想说的话',exact:true});await composer.fill('粘贴前草稿');
 await copy('empty');await paste().click();await page.getByText(/剪贴板里没有可粘贴的图片/).last().waitFor();assert.equal(await count(),0);assert.equal(await composer.inputValue(),'粘贴前草稿');assert.equal(requestCount,0);pass('空剪贴板提示明确，保留文字草稿且不发送模型请求');
 await copy('image');const direct=await raw('media.paste');assert(direct.ok,JSON.stringify(direct));for(const a of direct.result)imported.add(a.id);await paste().click();await page.locator('.tray-item').waitFor();assert.equal(await count(),1);assert.equal(requestCount,0);
 const first=(await ids())[0];imported.add(first);await page.getByRole('button',{name:/^预览 剪贴板图片/}).click();await page.locator('.media-img').waitFor();assert(await page.locator('.media-img').evaluate(e=>e.complete&&e.naturalWidth>0));await delay(350);await page.screenshot({path:out+'/clipboard-preview.png'});await page.getByRole('button',{name:'关闭',exact:true}).last().click();pass('跨应用复制的真实 content URI 图片进入本地待发送区，预览可见且未上传');
 for(const [mode,code] of [['plain','NOT_FOUND'],['https','INVALID_INPUT'],['intent','INVALID_INPUT'],['many','INVALID_INPUT'],['text','INVALID_INPUT'],['corrupt','INVALID_INPUT'],['large','INVALID_INPUT'],['missing','UNAVAILABLE']]){
  await copy(mode);const r=await raw('media.paste');assert(!r.ok,mode);assert.equal(r.error.code,code,mode);assert.equal(await count(),1);assert.equal(requestCount,0);
 }
 assert(!adb('shell','run-as',app,'ls','files/media-inbox'));pass('文字、网络链接、Intent、超量、非图片、损坏、超限及失效 URI 均拒绝，暂存已清理');
 await copy('image');assert.equal((await raw('media.paste',{uri:'content://arbitrary'})).error.code,'INVALID_INPUT');
 adb('shell','input','keyevent','KEYCODE_HOME');for(let i=0;/mCurrentFocus=.*app\.familiar\.mobile\.debug.*MainActivity/.test(adb('shell','dumpsys','window'));i++){assert(i<60,'Home has not received focus');await delay(100);}assert.equal((await raw('media.paste')).error.code,'UNAVAILABLE');
 adb('shell','input','keyevent','KEYCODE_SLEEP');await delay(250);assert.equal((await raw('media.paste')).error.code,'UNAVAILABLE');adb('shell','input','keyevent','KEYCODE_WAKEUP');adb('shell','wm','dismiss-keyguard');await foreground();assert.equal(await count(),1);pass('拒绝外部传入 URI、后台和熄屏读取，恢复前台后不补执行');
 await copy('slow');await paste().click();await page.waitForFunction(()=>document.querySelector('.paste-btn')?.getAttribute('aria-busy')==='true');assert(await page.getByRole('button',{name:/^添加图片/}).isDisabled());assert.equal((await raw('media.paste')).error.code,'BUSY');
 const other=(await call('conversation.create')).id;conversations.push(other);await wait(s=>s.activeConversationId===other);await page.waitForFunction(()=>document.querySelector('.paste-btn')?.getAttribute('aria-busy')==='false');assert.equal(await count(),0);
 await call('conversation.select',{id:conversation});for(let i=0;i<80&&await count()!==2;i++)await delay(100);assert.equal(await count(),2);for(const id of await ids())imported.add(id);assert.equal(await composer.inputValue(),'粘贴前草稿');assert.equal(requestCount,0);pass('读取互斥，切换会话期间迟到图片只回原会话，原文字保留');
 const second=(await ids()).find(id=>id!==first);await page.locator(`.tray-item[data-id="${second}"] .tray-remove`).click();assert.equal(await count(),1);
 await composer.fill('');await page.getByRole('button',{name:'发送',exact:true}).click();const done=await wait(s=>requestCount===1&&!s.activeReply&&s.conversations.find(c=>c.id===conversation)?.messages.at(-1)?.role==='assistant');
 const user=received.messages.filter(m=>m.role==='user').at(-1),image=user.content.find(c=>c.type==='image_url').image_url.url;assert.equal(digest(Buffer.from(image.split(',')[1],'base64')),originalHash);assert.equal(done.conversations.find(c=>c.id===conversation).messages[0].attachments[0].id,first);pass('点击发送才调用共享 Provider，实际负载为完整原图，历史保存附件引用');
 adb('shell','am','force-stop',app);await attach();const restored=await wait(s=>s.runtime.engine==='ready');assert.equal(restored.conversations.find(c=>c.id===conversation).messages[0].attachments[0].id,first);assert((await call('media.preview',{id:first})).dataUrl);assert.equal((await raw('media.import',{tokens:[]})).error.code,'INVALID_INPUT');pass('进程重启后图片历史和预览恢复；公开网页桥仍拒绝私有导入');
 const apk=await readFile('apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk'),sha=digest(apk),installed=adb('shell','pm','path',app).split('\n').find(s=>s.startsWith('package:')).slice(8);assert.equal(adb('shell','sha256sum',installed).split(/\s+/)[0],sha);
 await writeFile(out+'/clipboard-smoke.json',JSON.stringify({date:new Date().toISOString(),apkSha:sha,results,limitations:['actual ClipboardManager and cross-UID content provider; compatibility with individual third-party image apps requires separate verification']},null,2));
}catch(error){console.error('CHECK_FAILED',error);throw error;}finally{
 try{
  try{if(clipboardBackedUp){adb('shell','am','start','-n',`${fixture}/.ClipboardFixtureActivity`,'--es','mode','restore');tap(nodes().find(n=>n.text==='恢复原剪贴板'));assert(nodes().some(n=>n.text==='已恢复原剪贴板'));clipboardBackedUp=false;console.log('RESTORED original device clipboard');}}finally{
  if(page&&before){await foreground();await call('reply.cancel');if(careBefore){const now=await call('care.get');await call('care.save',{revision:now.revision,settings:careBefore.settings});}if(before.activeConversationId)await call('conversation.select',{id:before.activeConversationId});for(const id of conversations)await call('conversation.delete',{id});await call('provider.save',before.providers.find(p=>p.id==='compatible').profile);if(before.provider.kind!=='compatible')await call('provider.save',before.provider);await call('runtime.set',{enabled:before.runtime.running});for(const id of imported)if(/^[a-f0-9-]{36}$/.test(id))adb('shell','run-as',app,'rm','-f',`files/data/attachment-${id}.json`,`files/media-previews/${id}.jpg`);}
  }
 }finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));adb('reverse','--remove',`tcp:${port}`);adb('forward','--remove','tcp:9245');adb('shell','rm','-f','/sdcard/familiar-clipboard.xml');if(fixtureInstalled&&!clipboardBackedUp)adb('uninstall',fixture);}
}
