import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {pdf,docx} from '../tests/fixtures/documents.mjs';
const app='app.familiar.mobile.debug',out='.artifacts/android-device',fixtures='.artifacts/android-document-fixtures';
const adb=(...args)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...args],{encoding:'utf8',windowsHide:true}).trim();
const pause=ms=>new Promise(r=>setTimeout(r,ms)),results=[],ids=new Set();
const samples={
 'familiar-documents-chinese.pdf':pdf(), 'familiar-documents-word.docx':docx(),
 'familiar-documents-empty.pdf':pdf(''), 'familiar-documents-broken.pdf':Buffer.from('Not a PDF'),
 'familiar-documents-limit.pdf':pdf('Too many pages',101),
 'familiar-documents-password.pdf':await readFile('tests/fixtures/password-document.pdf')
};
await mkdir(fixtures,{recursive:true});
for(const [name,data] of Object.entries(samples)){await writeFile(`${fixtures}/${name}`,data);adb('push',`${fixtures}/${name}`,`/sdcard/Download/${name}`);}
let received,requests=0,browser,page,before,conversation,sequence=0,apkSha;
const server=createServer(async(req,res)=>{
 if(req.url.endsWith('/models')){res.end(JSON.stringify({data:[{id:'document-fixture'}]}));return;}
 let body='';for await(const chunk of req)body+=chunk;received=JSON.parse(body);requests++;
 res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content:'已收到本地提取的文档文字。'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;adb('reverse',`tcp:${port}`,`tcp:${port}`);
async function connect(){
 await browser?.close();browser=undefined;adb('shell','am','start','-n',`${app}/app.familiar.mobile.MainActivity`);
 for(let i=0;i<60;i++){try{adb('forward','tcp:9238',`localabstract:webview_devtools_remote_${adb('shell','pidof',app)}`);browser=await chromium.connectOverCDP('http://127.0.0.1:9238');page=browser.contexts()[0].pages()[0];if(page)break;}catch{}await pause(250);}
 assert(browser&&page);await page.locator('#familiar-root[data-ready="true"]').waitFor();
}
async function call(method,params){const r=await page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:`document-${++sequence}`,method,params});assert(r.ok,`${method}: ${JSON.stringify(r.error)}`);return r.result;}
async function until(check){for(let i=0;i<100;i++){const s=await call('snapshot.get');if(check(s))return s;await pause(100);}throw Error('Document state timeout');}
function nodes(){adb('shell','uiautomator','dump','/sdcard/familiar-documents-ui.xml');const xml=adb('shell','cat','/sdcard/familiar-documents-ui.xml');return [...xml.matchAll(/<node\b[^>]+>/g)].map(m=>Object.fromEntries([...m[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],a[2]])));}
function tap(n){assert(n,'Picker node missing');const b=[...n.bounds.matchAll(/\d+/g)].map(m=>+m[0]);adb('shell','input','tap',String(Math.round((b[0]+b[2])/2)),String(Math.round((b[1]+b[3])/2)));}
async function pick(name,errorText){
 const countBefore=await page.locator('.tray-item').count();
 await page.locator('.attach-btn:not(.camera-btn):not(.paste-btn)').click();await pause(350);let visible=nodes();assert(visible.some(n=>n.package?.includes('documentsui')));
 if(!name){for(let i=0;i<6;i++){adb('shell','input','keyevent','KEYCODE_BACK');await pause(200);if(!nodes().some(n=>n.package?.includes('documentsui')))break;}}
 else {
  if(!visible.some(n=>n.text==='Download')){tap(visible.find(n=>n['content-desc']==='显示根目录'));visible=nodes();tap(visible.find(n=>n.text==='下载'));visible=nodes();}
  const grid=visible.find(n=>n['content-desc']==='列表视图');if(grid){tap(grid);visible=nodes();}
  // 通过系统搜索定位本轮自造文件，不改变排序或依赖旧列表位置。
  const search=visible.find(n=>n['content-desc']==='搜索');
  if(search){tap(search);adb('shell','input','text',name);adb('shell','input','keyevent','KEYCODE_ENTER');await pause(500);visible=nodes();}
  let selected=visible.find(n=>n.text===name&&n['resource-id']==='android:id/title');
  for(let i=0;!selected&&i<6;i++){adb('shell','input','swipe','700','2200','700','900','250');visible=nodes();selected=visible.find(n=>n.text===name&&n['resource-id']==='android:id/title');}
  tap(selected);
 }
 if(name){
  if(errorText)await page.getByText(new RegExp(errorText)).last().waitFor({timeout:30000});
  else await page.waitForFunction(count=>document.querySelectorAll('.tray-item').length===count+1,countBefore,{timeout:30000});
 }
 await page.waitForFunction(()=>document.querySelector('.attach-btn:not(.camera-btn):not(.paste-btn)')?.getAttribute('aria-busy')==='false',{},{timeout:30000});
 for(const id of await page.locator('.tray-item').evaluateAll(els=>els.map(e=>e.dataset.id)))ids.add(id);
}
const pass=name=>{results.push(name);console.log('PASS '+name);};
try{
 await connect();before=await until(s=>s.runtime.engine==='ready');await writeFile(`${out}/documents-before.json`,JSON.stringify(before,null,2));
 assert(before.media.documents);assert(!before.activeReply&&!before.voice.state.active&&before.providers.every(p=>!p.profile.keyConfigured));
 const apk=adb('shell','pm','path',app).split('\n').find(s=>s.startsWith('package:')).slice(8);apkSha=adb('shell','sha256sum',apk).split(/\s+/)[0];
 const built=await readFile('apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk');assert.equal(apkSha,createHash('sha256').update(built).digest('hex'));
 await call('pet.settings.save',{...before.pet,visible:false});await call('provider.save',{kind:'compatible',baseUrl:`http://127.0.0.1:${port}/v1`,model:'document-fixture'});
 conversation=(await call('conversation.create')).id;await page.reload();await page.locator('#familiar-root[data-ready="true"]').waitFor();
 if(!(await page.locator('.page-chat').isVisible())){await page.getByRole('button',{name:'小窝',exact:true}).click();await page.getByRole('button',{name:'说句话',exact:true}).click();}
 const composer=page.getByRole('textbox',{name:'想说的话',exact:true});await composer.fill('文档测试草稿');await pick(null);assert.equal(await composer.inputValue(),'文档测试草稿');assert.equal(requests,0);pass('系统选择取消保留草稿，没有模型请求');
 await pick('familiar-documents-chinese.pdf');await page.locator('.tray-item').waitFor();
 await pick('familiar-documents-word.docx');assert.equal(await page.locator('.tray-item').count(),2);assert.equal(requests,0);
 const previews=await Promise.all([...ids].map(id=>call('media.preview',{id})));assert(previews.some(v=>/PDF_FIXTURE\s+中文文档/.test(v.text)));assert(previews.some(v=>v.text?.includes('TABLE_CELL')));
 assert(previews.every(v=>v.attachment.kind==='text'&&v.attachment.name.endsWith('（提取文字）')));pass('ARM64 运行时独立线程提取中文 PDF、Word 段落与表格，选择时不上传');
 await page.getByRole('button',{name:/^预览 familiar-documents-chinese.pdf/}).click();await page.locator('.media-text').waitFor({state:'visible'});assert((await page.locator('.media-text').textContent()).includes('中文文档'));await page.screenshot({path:`${out}/documents-preview.png`});await page.getByRole('button',{name:'关闭',exact:true}).last().click();pass('设备上中文纯文本预览可读，明确标注提取文字');
 for(const [name,text] of [['empty','文档没有可提取文字'],['broken','文档无法解析'],['limit','文档超过解析上限'],['password','请先解锁文档']]){
  await pick(`familiar-documents-${name}.pdf`,text);assert.equal(await page.locator('.tray-item').count(),2);assert.equal(await composer.inputValue(),'文档测试草稿');assert.equal(requests,0);
 }
 assert.equal(adb('shell','run-as',app,'ls','files/media-inbox'),'');pass('空页、损坏、超页数与加密文档分别提示，保留草稿且清理暂存');
 await composer.fill('');await page.getByRole('button',{name:'发送',exact:true}).click();
 await until(s=>!s.activeReply&&s.conversations.find(c=>c.id===conversation)?.messages.at(-1)?.role==='assistant');assert.equal(requests,1);
 const user=received.messages.filter(m=>m.role==='user').at(-1);assert(/PDF_FIXTURE\s+中文文档/.test(JSON.stringify(user)));assert(JSON.stringify(user).includes('TABLE_CELL'));assert(!JSON.stringify(user).includes('data:application/pdf'));
 await page.screenshot({path:`${out}/documents-chat.png`});pass('附件单独发送经真实 Provider 请求携带两份文档的提取文字');
 adb('shell','am','force-stop',app);await connect();const restored=await until(s=>s.runtime.engine==='ready');assert.equal(restored.conversations.find(c=>c.id===conversation).messages[0].attachments.length,2);
 for(const id of ids)assert((await call('media.preview',{id})).text);pass('进程重启恢复文档历史与预览');
}catch(error){results.push({failed:String(error),ui:await page?.locator('[role="alert"], [role="status"], .tray-item').allTextContents().catch(()=>[])});throw error;}
finally{
 for(let i=0;i<6&&nodes().some(n=>n.package?.includes('documentsui'));i++){adb('shell','input','keyevent','KEYCODE_BACK');await pause(200);}
 try{if(before){if(!browser?.isConnected()||page?.isClosed())await connect();await call('reply.cancel');if(before.activeConversationId)await call('conversation.select',{id:before.activeConversationId});if(conversation)await call('conversation.delete',{id:conversation});
  const original=before.providers.find(p=>p.id==='compatible').profile;await call('provider.save',{...original,kind:'compatible'});if(before.provider.kind!=='compatible')await call('provider.save',before.provider);
  await call('pet.settings.save',before.pet);if(before.pet.action==='sleep')await call('pet.interact',{action:'sleep'});await call('runtime.set',{enabled:before.runtime.running});
  for(const id of ids)if(/^[a-f0-9-]{36}$/.test(id))adb('shell','run-as',app,'rm','-f',`files/data/attachment-${id}.json`);
 }}catch(error){console.error('RESTORE FAILED',error);process.exitCode=1;}
 await browser?.close();adb('reverse','--remove',`tcp:${port}`);adb('forward','--remove','tcp:9238');
 for(const name of Object.keys(samples))adb('shell','rm','-f',`/sdcard/Download/${name}`);adb('shell','rm','-f','/sdcard/familiar-documents-ui.xml');
 server.closeAllConnections();await new Promise(r=>server.close(r));await writeFile(`${out}/documents-smoke.json`,JSON.stringify({date:new Date().toISOString(),apkSha,results},null,2));
}
