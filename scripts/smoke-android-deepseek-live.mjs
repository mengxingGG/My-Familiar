import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,createDecipheriv,randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {join} from 'node:path';
import {homedir} from 'node:os';

// 仅在用户明确同意后使用：只解密 Familiar 自身、指定 DeepSeek 地址的单个凭据。
// 明文仅经过内存和本机 CDP；不写入文件、命令参数、日志或测试报告。
const approved=process.argv.includes('--import-approved-windows-deepseek');
const app='app.familiar.mobile.debug',out=process.env.FAMILIAR_DEEPSEEK_REPORT_DIR??'.artifacts/android-deepseek-live',port=9285;
const root=join(process.env.APPDATA??join(homedir(),'AppData','Roaming'),'Familiar'),sourcePaths=[join(root,'data/settings.json'),join(root,'data/model-secret.json'),join(root,'runtime/Local State')];
await mkdir(out,{recursive:true});
const hash=data=>createHash('sha256').update(data).digest('hex');
const adb=(...args)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...args],{encoding:'utf8',windowsHide:true,timeout:30000}).trim();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const proof={date:new Date().toISOString(),checks:[],service:'https://api.deepseek.com',model:'deepseek-flash',realModelVerified:false,credentialsLogged:false};
let browser,page,before,originalIme,conversationId,sequence=0,changed=false,keySaved=false,sourceHashes,secretBytes;
const pass=name=>{proof.checks.push(name);console.log('PASS '+name);};
const profile=p=>({kind:p.kind,baseUrl:p.baseUrl,model:p.model,advanced:p.advanced});
const project=s=>({provider:s.provider,providers:s.providers,activeConversationId:s.activeConversationId,conversationIds:s.conversations.map(c=>c.id),pet:s.pet,runtime:s.runtime});
async function call(method,params){
 let response;try{response=await page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:'deepseek-live-'+(++sequence),method,params});}catch{throw Error(method+': BRIDGE_FAILED');}
 if(!response.ok)throw Error(method+': '+response.error?.code);
 return response.result;
}
async function until(check,timeout=90000){for(const end=Date.now()+timeout;Date.now()<end;){if(await check())return;await pause(120);}throw Error('LIVE_DEEPSEEK_TIMEOUT');}
function box(title){const block=adb('shell','dumpsys','window','windows').split(/  Window #/).find(b=>b.includes('u0 '+title+'}')&&b.includes('mHasSurface=true'));const m=block?.match(/Frames:.*? frame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);return m?{x:+m[1],y:+m[2],w:+m[3]-m[1],h:+m[4]-m[2]}:null;}
async function xml(){adb('shell','uiautomator','dump','/sdcard/familiar-deepseek-live.xml');return adb('shell','cat','/sdcard/familiar-deepseek-live.xml');}
async function tap(name){const data=await xml(),node=[...data.matchAll(/<node\b[^>]+>/g)].map(m=>m[0]).find(v=>v.includes('content-desc="'+name+'"')||v.includes('text="'+name+'"'));assert(node,'Native control missing: '+name);const m=node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);assert(m);adb('shell','input','tap',String(Math.round((+m[1]+ +m[3])/2)),String(Math.round((+m[2]+ +m[4])/2)));await pause(200);}
async function shot(name){await writeFile(out+'/'+name+'.png',execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554','exec-out','screencap','-p'],{windowsHide:true,maxBuffer:16*1024*1024}));}
async function send(text){assert(/^[a-zA-Z0-9 .-]+$/.test(text));await tap('气泡聊天输入');adb('shell','input','text',text.replace(/ /g,'%s'));await tap('发送气泡消息');}
async function response(turn){
 const started=Date.now(),partial=new Set();let message;
 await until(async()=>{const s=await call('snapshot.get'),c=s.conversations.find(c=>c.id===conversationId),answers=c.messages.filter(m=>m.role==='assistant');message=answers.at(-1);if(answers.length<turn)return false;if(message.status==='streaming'&&message.text)partial.add(message.text);return !s.activeReply&&message.status!=='streaming';},120000);
 assert.equal(message.status,'complete','Model response was not complete');assert(message.text.trim(),'Model returned no text');
 const record={turn,elapsedMs:Date.now()-started,status:message.status,text:message.text,streamingVersions:partial.size};proof.turns??=[];proof.turns.push(record);return record;
}
try{
 assert(!adb('forward','--list').includes('tcp:'+port));adb('shell','am','start','-n',app+'/app.familiar.mobile.MainActivity');
 await until(async()=>{try{const pid=adb('shell','pidof',app);if(!adb('shell','cat','/proc/net/unix').includes('webview_devtools_remote_'+pid))return false;adb('forward','tcp:'+port,'localabstract:webview_devtools_remote_'+pid);browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:1500});page=browser.contexts()[0].pages()[0];return !!page;}catch{await browser?.close().catch(()=>{});browser=page=undefined;return false;}},45000);
 await page.locator('#familiar-root[data-ready="true"]').waitFor();before=await call('snapshot.get');originalIme=adb('shell','settings','get','secure','default_input_method');
 assert(before.runtime.running&&before.runtime.overlayVisible&&!before.activeReply&&!before.tasks.length&&!before.voice.state.active&&!before.voice.wake.armed);
 assert(!box('FamiliarChat'),'Close the existing native chat before starting an isolated live test');
 assert(!await page.evaluate(()=>[...document.querySelectorAll('input[type=password],textarea.composer-input')].some(input=>input.value.trim())),'Unsubmitted input exists');
 await writeFile(out+'/before.json',JSON.stringify(project(before),null,2));proof.apkSha256=hash(await readFile('release/android/Familiar-0.3.0-arm64-debug.apk'));assert.equal(adb('shell','sha256sum',adb('shell','pm','path',app).replace(/^package:/,'')).split(/\s/)[0],proof.apkSha256);
 if(approved){
  assert(before.providers.every(p=>!p.profile.keyConfigured),'Do not replace any existing Android credential');
  sourceHashes=await Promise.all(sourcePaths.map(async p=>hash(await readFile(p))));
  const source=JSON.parse(await readFile(sourcePaths[0],'utf8')).provider;assert.equal(source.kind,'compatible');assert.equal(source.baseUrl,'https://api.deepseek.com');assert.equal(source.model,'deepseek-flash');
  const scope=hash(source.kind+'\n'+new URL(source.baseUrl).href.replace(/\/$/,'')),saved=JSON.parse(await readFile(sourcePaths[1],'utf8'));
  const encoded=typeof saved==='string'?saved:saved.entries?.[scope];assert(encoded,'Selected Familiar credential missing');const encrypted=Buffer.from(encoded,'base64');assert.equal(encrypted.subarray(0,3).toString(),'v10');
  const ps="$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $state=ConvertFrom-Json ([IO.File]::ReadAllText($env:FAMILIAR_LIVE_WINDOWS_STATE)); $protected=[Convert]::FromBase64String($state.os_crypt.encrypted_key); if ([Text.Encoding]::ASCII.GetString($protected,0,5) -ne 'DPAPI') { throw 'Unsupported Familiar store' }; $plain=[Security.Cryptography.ProtectedData]::Unprotect($protected[5..($protected.Length-1)],$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($plain)); [Array]::Clear($plain,0,$plain.Length)";
  let master;try{master=Buffer.from(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{windowsHide:true,encoding:'utf8',timeout:15000,env:{...process.env,FAMILIAR_LIVE_WINDOWS_STATE:sourcePaths[2]}}),'base64');assert.equal(master.length,32);const decipher=createDecipheriv('aes-256-gcm',master,encrypted.subarray(3,15));decipher.setAuthTag(encrypted.subarray(-16));secretBytes=Buffer.concat([decipher.update(encrypted.subarray(15,-16)),decipher.final()]);}catch{throw Error('WINDOWS_FAMILIAR_DECRYPT_FAILED');}finally{master?.fill(0);}
  assert(secretBytes.length>10&&secretBytes.length<8192);assert(!/[\r\n]/.test(secretBytes.toString()));
  const advanced={};for(const key of ['temperature','topP','maxOutputTokens','contextTokens','autoCompactPercent','timeoutSeconds','thinking','cache'])if(source[key]!==undefined)advanced[key]=source[key];
  await call('provider.save',{kind:source.kind,baseUrl:source.baseUrl,model:source.model,advanced,apiKey:secretBytes.toString()});keySaved=true;changed=true;
  const vault=execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554','exec-out','run-as',app,'cat','no_backup/credentials.v1'],{windowsHide:true,maxBuffer:1024*1024});assert(vault.length>28&&!vault.includes(secretBytes));proof.encryptedStorageVerified=true;proof.credentialsImported=true;proof.credentialSource='Windows Familiar selected compatible/https://api.deepseek.com scope only';secretBytes.fill(0);secretBytes=undefined;
  const now=await call('snapshot.get');assert(now.provider.keyConfigured);assert.equal(now.provider.baseUrl,proof.service);assert.equal(now.provider.model,proof.model);pass('经用户明确授权复用 Familiar DeepSeek，保存至 Android Keystore 加密文件且未记录密钥');
 }else{assert(before.provider.keyConfigured&&before.provider.baseUrl===proof.service&&before.provider.model===proof.model,'Configure the authorized DeepSeek connection first');}
 const selected=(await call('snapshot.get')).provider;proof.provider=selected;
 const models=await call('provider.models',{...profile(selected),refresh:true});assert(models.items.some(item=>item.id===proof.model));proof.modelCount=models.items.length;pass('实际 Android Runtime 从 DeepSeek 官方 HTTPS 获取模型目录');
 const tested=await call('provider.test',{...profile(selected),operationId:'deepseek-live-'+randomUUID()});assert(tested.connected);proof.connectionTest=tested;pass('真实 DeepSeek 固定短句流式连接测试通过');
 conversationId=(await call('conversation.create')).id;changed=true;await call('pet.settings.save',{scale:before.pet.scale,visible:before.pet.visible,quiet:true,bubbleSeconds:before.pet.bubbleSeconds});
 adb('shell','input','keyevent','KEYCODE_HOME');await pause(600);const anchor=box('FamiliarPet');assert(anchor);adb('shell','input','tap',String(anchor.x+anchor.w/2),String(anchor.y+anchor.h/2));await until(()=>!!box('FamiliarChat'));await pause(600);
 const marker='FAMILIAR'+randomUUID().slice(0,8).toUpperCase();proof.publicTestCode=marker;
 await send('Remember the temporary code '+marker+'. Then write ten short Chinese sentences about resting for a minute. Do not use tools.');
 const first=await response(1);assert(first.streamingVersions>0,'No visible streaming sample');assert(box('FamiliarChat'));assert(!/mResumedActivity:.*app\.familiar\.mobile\.debug/.test(adb('shell','dumpsys','activity','activities')));await pause(700);await shot('real-bubble-first');pass('主应用保持后台，原生气泡显示真实模型流式回复');
 await send('What was the temporary code from my previous message. Reply only with that code. Do not use tools.');const second=await response(2);assert(second.text.includes(marker));assert(box('FamiliarChat'));assert(!/mResumedActivity:.*app\.familiar\.mobile\.debug/.test(adb('shell','dumpsys','activity','activities')));await pause(700);assert((await xml()).includes(marker));await shot('real-bubble-continuous');proof.realModelVerified=true;pass('真实模型气泡连续第二轮保留上下文并回答临时口令');
 await tap('收起');await until(()=>!box('FamiliarChat'));
}catch(error){proof.error=error instanceof Error?error.message:'LIVE_CHECK_FAILED';console.error('Live DeepSeek check: '+proof.error);process.exitCode=1;}
finally{
 secretBytes?.fill(0);secretBytes=undefined;
 try{if(changed&&page){await call('reply.cancel');await call('snapshot.get',{controllerActive:true});if(before.activeConversationId)await call('conversation.select',{id:before.activeConversationId});if(conversationId)await call('conversation.delete',{id:conversationId});await call('pet.settings.save',{scale:before.pet.scale,visible:before.pet.visible,quiet:before.pet.quiet,bubbleSeconds:before.pet.bubbleSeconds});const after=await call('snapshot.get');assert.equal(after.activeConversationId,before.activeConversationId);assert.deepEqual(after.conversations.map(c=>c.id),before.conversations.map(c=>c.id));for(const key of ['scale','visible','quiet','bubbleSeconds','docking'])assert.deepEqual(after.pet[key],before.pet[key]);assert.equal(adb('shell','settings','get','secure','default_input_method'),originalIme);assert(!after.activeReply&&!after.tasks.length&&!after.voice.state.active&&!after.voice.wake.armed);assert(after.runtime.running&&after.runtime.overlayVisible);if(keySaved){assert(after.provider.keyConfigured&&after.provider.model===proof.model&&after.provider.baseUrl===proof.service);proof.authorizedProviderKept=true;}await writeFile(out+'/after.json',JSON.stringify(project(after),null,2));proof.originalConversationsAndPetRestored=true;pass('仅保留用户授权的模型连接，原会话/宠物/输入法恢复且无活动测试任务');}
 if(sourceHashes){const afterHashes=await Promise.all(sourcePaths.map(async p=>hash(await readFile(p))));assert.deepEqual(afterHashes,sourceHashes);proof.windowsFilesUnchanged=true;}
 }catch(error){proof.cleanupError=error instanceof Error?error.message:'CLEANUP_FAILED';console.error('Cleanup: '+proof.cleanupError);process.exitCode=1;}
 await browser?.close().catch(()=>{});try{if(adb('forward','--list').includes('tcp:'+port))adb('forward','--remove','tcp:'+port);adb('shell','input','keyevent','KEYCODE_HOME');}catch{proof.hostCleanupError=true;process.exitCode=1;}
 await writeFile(out+'/result.json',JSON.stringify(proof,null,2));
}
