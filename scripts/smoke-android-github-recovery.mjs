import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';

// 仅在无登录、无模型密钥、无活动任务的开发模拟器运行；逐字备份并恢复本次唯一修改的公开设置。
const app='app.familiar.mobile.debug',out=process.env.FAMILIAR_GITHUB_RECOVERY_REPORT_DIR??'.artifacts/android-startup-resilience/device',port=9281,file='files/data/github-oauth-client.json';
await mkdir(out,{recursive:true});
const adbBytes=(args,options={})=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...args],{windowsHide:true,timeout:30000,maxBuffer:8*1024*1024,...options});
const adb=(...args)=>adbBytes(args).toString('utf8').trim(),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hash=value=>createHash('sha256').update(value).digest('hex');
const exists=()=>adb('shell','run-as',app,'ls','files/data').split(/\s+/).includes('github-oauth-client.json');
const read=()=>adbBytes(['exec-out','run-as',app,'cat',file]);
const write=bytes=>{assert.equal(adbBytes(['shell','-T','run-as',app,'tee',file],{input:bytes}).toString('hex'),bytes.toString('hex'));assert.deepEqual(read(),bytes);};
const checks=[],proof={date:new Date().toISOString(),checks,boots:[]},conversations=[];
let browser,page,before,originalFile,changed=false,restoring=false,sequence=0,modelCalls=0,modelError;
const pass=name=>{checks.push(name);console.log('PASS '+name);};
const server=createServer(async(req,res)=>{try{
 if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'startup-recovery-fixture'}]}));return;}
 assert.equal(req.url,'/v1/chat/completions');let raw='';for await(const chunk of req)raw+=chunk;const request=JSON.parse(raw);assert.equal(request.model,'startup-recovery-fixture');modelCalls++;
 res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:'伙伴继续运行，普通聊天不受影响。'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
}catch(error){modelError=String(error);res.writeHead(500);res.end('fixture failed');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const modelPort=server.address().port;
const raw=(method,params)=>page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:'github-recovery-'+(++sequence),method,params});
const call=async(method,params)=>{const response=await raw(method,params);assert(response.ok,method+': '+response.error?.code);return response.result;};
async function until(check,timeout=30000){for(const end=Date.now()+timeout;Date.now()<end;){if(modelError&&!restoring)throw Error(modelError);if(await check())return;await pause(250);}throw Error('RECOVERY_TIMEOUT');}
async function detach(){await browser?.close().catch(()=>{});browser=page=undefined;if(adb('forward','--list').includes('tcp:'+port))adb('forward','--remove','tcp:'+port);}
async function attach(){
 await detach();adb('shell','am','start','-n',app+'/app.familiar.mobile.MainActivity');
 await until(async()=>{try{const pid=adb('shell','pidof',app);if(!adb('shell','cat','/proc/net/unix').includes('webview_devtools_remote_'+pid))return false;adb('forward','tcp:'+port,'localabstract:webview_devtools_remote_'+pid);browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:1500});page=browser.contexts()[0].pages()[0];return !!page;}catch{await browser?.close().catch(()=>{});browser=page=undefined;return false;}},45000);
 await page.locator('#familiar-root[data-ready="true"]').waitFor({timeout:45000});assert.equal((await call('snapshot.get')).runtime.engine,'ready');
}
async function stop(){await detach();adb('shell','am','force-stop',app);}
async function coldStart(bytes,name){await stop();write(bytes);await attach();await call('runtime.set',{enabled:true});await until(async()=>(await call('snapshot.get')).runtime.overlayVisible);proof.boots.push({name,mainPid:adb('shell','pidof',app),runtimePid:adb('shell','pidof',app+':runtime')});}
async function checkError(bytes){const s=await call('github.auth.status');assert.equal(s.clientId,'');assert.equal(s.phase,'error');assert.equal(s.configurationError,true);assert(!s.connected&&!s.applied&&!s.authorization);assert.match(s.detail,/重新保存/);assert.equal((await raw('github.auth.begin',{revision:s.revision})).error?.code,'UNAVAILABLE');assert.equal((await raw('github.auth.open',{revision:s.revision})).error?.code,'UNAVAILABLE');assert.deepEqual(read(),bytes);return s;}
try{
 assert(!adb('forward','--list').includes('tcp:'+port));await attach();await until(async()=>(await call('snapshot.get')).runtime.overlayVisible,10000);before=await call('snapshot.get');const auth=await call('github.auth.status');
 assert(before.runtime.running&&before.runtime.overlayVisible&&!before.activeReply&&!before.tasks.length&&!before.voice.state.active&&!before.voice.wake.armed);assert(before.providers.every(row=>!row.profile.keyConfigured));assert.equal(auth.clientId,'');assert.equal(auth.phase,'signedOut');assert(!auth.connected&&!auth.applied);
 originalFile=exists()?read():undefined;if(originalFile)assert.equal(JSON.parse(originalFile.toString('utf8')),'');
 await writeFile(out+'/before.json',JSON.stringify({snapshot:before,auth,fileExisted:!!originalFile,ime:adb('shell','settings','get','secure','default_input_method')},null,2));if(originalFile)await writeFile(out+'/original-client.json',originalFile);
 proof.apkSha256=hash(await readFile('release/android/Familiar-0.3.0-arm64-debug.apk'));assert.equal(adb('shell','sha256sum',adb('shell','pm','path',app).replace(/^package:/,'')).split(/\s/)[0],proof.apkSha256);
 changed=true;adb('reverse','tcp:'+modelPort,'tcp:'+modelPort);await call('provider.save',{kind:'compatible',baseUrl:'http://127.0.0.1:'+modelPort+'/v1',model:'startup-recovery-fixture',clearApiKey:true});const conversation=await call('conversation.create');conversations.push(conversation.id);
 const invalid=Buffer.from('"https://invalid.fixture/client"');await coldStart(invalid,'invalid-client');await checkError(invalid);pass('无效登录应用冷启动后核心与宠物运行，原文件保留，不能授权或打开页面');
 await call('message.send',{conversationId:conversation.id,text:'验证可选设置错误时的普通聊天。'});await until(async()=>{const s=await call('snapshot.get');return !s.activeReply&&s.conversations.find(c=>c.id===conversation.id)?.messages.at(-1)?.text==='伙伴继续运行，普通聊天不受影响。';});assert.equal(modelCalls,1);pass('损坏设置下实际共享 Agent 完成普通流式聊天');
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:/网络工具 · MCP/}).click();await page.locator('.mcp-page').getByRole('button',{name:'GitHub 官方',exact:true}).click();
 const panel=page.locator('.github-auth'),save=panel.getByRole('button',{name:'保存登录应用',exact:true});await panel.getByRole('status').filter({hasText:'重新保存'}).waitFor();assert.equal(await panel.getByLabel('GitHub 登录应用 Client ID',{exact:true}).inputValue(),'');assert(await save.isEnabled());assert(await panel.getByRole('button',{name:'获取 GitHub 验证码',exact:true}).isDisabled());await page.screenshot({path:out+'/configuration-error.png'});
 await save.click();let dialog=page.getByRole('alertdialog');await dialog.waitFor();assert.match(await dialog.innerText(),/清除此设备保存的 GitHub 登录/);await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.deepEqual(read(),invalid);
 await save.click();await dialog.getByRole('button',{name:'更换并清除旧登录',exact:true}).click();await until(async()=>(await call('github.auth.status')).phase==='signedOut');assert.equal(JSON.parse(read().toString('utf8')),'');assert(!(await call('github.auth.status')).configurationError);pass('真实设置页可取消修复，明确确认后保存为空并解除错误');
 const malformed=Buffer.from('{broken');await coldStart(malformed,'malformed-json');await checkError(malformed);assert.equal(modelCalls,1);pass('JSON 损坏仍可冷启动，旧聊天不重放，损坏文件不自动覆盖');
}catch(error){proof.error=String(error);console.error(error);process.exitCode=1;}
finally{
 restoring=true;
 try{if(changed){
  let current;if(page)try{current=await call('snapshot.get');}catch{}
  if(current?.activeReply){assert(conversations.includes(current.activeReply.conversationId),'A new user reply must be preserved');await call('reply.cancel');}
  if(current)assert(!current.tasks.length);
  if(exists()){const bytes=read();let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{}assert(bytes.equals(Buffer.from('"https://invalid.fixture/client"'))||bytes.equals(Buffer.from('{broken'))||value===''||originalFile?.equals(bytes),'A new user Client ID must be preserved');}
  await stop();if(originalFile)write(originalFile);else adb('shell','run-as',app,'rm','-f',file);await attach();
  const profile=before.providers.find(row=>row.id==='compatible').profile;await call('provider.save',{kind:'compatible',baseUrl:profile.baseUrl,model:profile.model,clearApiKey:true});if(before.provider.kind!=='compatible')await call('provider.save',{kind:before.provider.kind,baseUrl:before.provider.baseUrl,model:before.provider.model});
  if(before.activeConversationId)await call('conversation.select',{id:before.activeConversationId});for(const id of conversations)await call('conversation.delete',{id});await call('runtime.set',{enabled:before.runtime.running});await until(async()=>(await call('snapshot.get')).runtime.overlayVisible===before.runtime.overlayVisible);
  const s=await call('snapshot.get'),auth=await call('github.auth.status');assert.deepEqual(s.providers,before.providers);assert.equal(s.activeConversationId,before.activeConversationId);assert.deepEqual(s.conversations.map(row=>row.id),before.conversations.map(row=>row.id));for(const key of ['scale','visible','quiet','bubbleSeconds','docking'])assert.deepEqual(s.pet[key],before.pet[key]);assert.equal(auth.phase,'signedOut');assert.equal(auth.clientId,'');assert(!auth.connected&&!auth.applied&&!auth.configurationError);assert(!s.activeReply&&!s.tasks.length);if(!proof.error)assert.equal(modelCalls,1);
  if(originalFile)assert.deepEqual(read(),originalFile);else assert(!exists());proof.configurationRestored=true;proof.modelRequests=modelCalls;proof.accessibility=s.capabilities.find(c=>c.id==='accessibility')?.state;pass('原公开文件、模型、会话和宠物偏好恢复，冷启动不重放聊天');
 }}catch(error){proof.restoreError=String(error);console.error('RESTORE: '+error);process.exitCode=1;}
 await detach();try{if(adb('reverse','--list').includes('tcp:'+modelPort))adb('reverse','--remove','tcp:'+modelPort);}catch{}server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await writeFile(out+'/result.json',JSON.stringify(proof,null,2));
}
