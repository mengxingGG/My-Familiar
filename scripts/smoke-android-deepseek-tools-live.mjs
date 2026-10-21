import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {chromium} from 'playwright';

// 已配置模型的真实验收：不读取或导出任何明文凭据，网络工具只使用固定公开查询。
const app='app.familiar.mobile.debug',out='.artifacts/android-deepseek-live/tools',port=9286,runId=randomUUID(),serverId='exa-deepseek-'+runId.slice(0,8);
const query='site:developer.android.com foreground service background start restrictions';
const objective='Find official Android Developers pages explaining restrictions on starting foreground services from the background. Return at most two developer.android.com pages.';
await mkdir(out,{recursive:true});
const adb=(...args)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...args],{encoding:'utf8',windowsHide:true,timeout:30000}).trim();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),hash=data=>createHash('sha256').update(data).digest('hex');
let browser,page,before,servers,ime,conversationId,row,sequence=0,restarted=false,changed=false;
const proof={date:new Date().toISOString(),checks:[],realModelVerified:false,service:'https://api.deepseek.com',model:'deepseek-flash',query,credentialsRead:false};
const pass=name=>{proof.checks.push(name);console.log('PASS '+name);};
const profile=p=>({kind:p.kind,baseUrl:p.baseUrl,model:p.model,advanced:p.advanced});
const call=async(method,params)=>{let r;try{r=await page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:'deepseek-tools-'+(++sequence),method,params});}catch{throw Error(method+': BRIDGE_FAILED');}assert(r.ok,method+': '+r.error?.code);return r.result;};
async function until(check,timeout=60000){for(const end=Date.now()+timeout;Date.now()<end;){if(await check())return;await pause(250);}throw Error('DEEPSEEK_TOOLS_TIMEOUT');}
async function detach(){await browser?.close().catch(()=>{});browser=page=undefined;if(adb('forward','--list').includes('tcp:'+port))adb('forward','--remove','tcp:'+port);}
async function attach(){await detach();adb('shell','am','start','-n',app+'/app.familiar.mobile.MainActivity');await until(async()=>{try{const pid=adb('shell','pidof',app);if(!adb('shell','cat','/proc/net/unix').includes('webview_devtools_remote_'+pid))return false;adb('forward','tcp:'+port,'localabstract:webview_devtools_remote_'+pid);browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:1500});page=browser.contexts()[0].pages()[0];return !!page;}catch{await browser?.close().catch(()=>{});browser=page=undefined;return false;}},45000);await page.locator('#familiar-root[data-ready="true"]').waitFor();}
const trace=()=>{assert(conversationId&&/^[a-f0-9-]+$/.test(conversationId));return JSON.parse(adb('shell','run-as',app,'cat','files/data/conversation-session-'+conversationId+'.json')).messages.filter(m=>m.role==='assistant').flatMap(m=>m.trace??[]);};
try{
 assert(!adb('forward','--list').includes('tcp:'+port));await attach();before=await call('snapshot.get');servers=await call('mcp.list');ime=adb('shell','settings','get','secure','default_input_method');
 assert(before.provider.keyConfigured&&before.provider.kind==='compatible'&&before.provider.baseUrl===proof.service&&before.provider.model===proof.model);
 assert(before.runtime.running&&before.runtime.overlayVisible&&!before.activeReply&&!before.tasks.length&&!before.voice.state.active&&!before.voice.wake.armed);assert(servers.every(s=>!s.enabled&&!s.connected&&!s.hasKey));
 assert(!await page.evaluate(()=>[...document.querySelectorAll('input[type=password],textarea.composer-input')].some(input=>input.value.trim())),'Unsubmitted input exists');
 assert(!adb('shell','dumpsys','window','windows').split(/  Window #/).some(b=>b.includes('u0 FamiliarChat}')&&b.includes('mHasSurface=true')),'Close native chat before the explicit restart test');
 await writeFile(out+'/before.json',JSON.stringify({provider:before.provider,providers:before.providers,activeConversationId:before.activeConversationId,conversationIds:before.conversations.map(c=>c.id),pet:before.pet,servers,ime},null,2));proof.apkSha256=hash(await readFile('release/android/Familiar-0.3.0-arm64-debug.apk'));assert.equal(adb('shell','sha256sum',adb('shell','pm','path',app).replace(/^package:/,'')).split(/\s/)[0],proof.apkSha256);
 const vault=()=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554','exec-out','run-as',app,'cat','no_backup/credentials.v1'],{windowsHide:true,maxBuffer:1024*1024});const vaultHash=hash(vault());proof.originalRuntimePid=adb('shell','pidof',app+':runtime');
 await detach();adb('shell','am','force-stop',app);restarted=true;await attach();await call('runtime.set',{enabled:true});await until(async()=>{const s=await call('snapshot.get');return s.runtime.engine==='ready'&&s.runtime.running&&s.runtime.overlayVisible;});
 const fresh=await call('snapshot.get');assert.deepEqual(fresh.providers,before.providers);assert.equal(hash(vault()),vaultHash);proof.newRuntimePid=adb('shell','pidof',app+':runtime');assert.notEqual(proof.newRuntimePid,proof.originalRuntimePid);
 const tested=await call('provider.test',{...profile(fresh.provider),operationId:'deepseek-restart-'+runId});assert(tested.connected);proof.restartConnectionTest=tested;pass('全新 Runtime 从 Android Keystore 恢复 DeepSeek，并通过真实连接测试');
 if(before.capabilities.find(c=>c.id==='accessibility')?.state==='granted'&&fresh.capabilities.find(c=>c.id==='accessibility')?.state!=='granted'){
  execFileSync('node',['.artifacts/android-device/restore-accessibility.mjs','--reconnect'],{windowsHide:true,timeout:60000,stdio:'pipe'});adb('shell','am','start','-n',app+'/app.familiar.mobile.MainActivity');await until(async()=>(await call('snapshot.get')).capabilities.find(c=>c.id==='accessibility')?.state==='granted');proof.accessibilityRestored=true;
 }
 row=await call('mcp.save',{config:{id:serverId,name:'Exa DeepSeek 实际验收',transport:'http',url:'https://mcp.exa.ai/mcp',enabled:true},revision:null});changed=true;assert(!row.auth&&!row.hasKey);const connected=await call('mcp.connect',{id:serverId,revision:row.revision,operationId:'deepseek-exa-'+runId});assert(connected.tools.includes('web_search_exa'));pass('真实 DeepSeek 配置保持，官方 Exa 基础工具实际连通');
 conversationId=(await call('conversation.create')).id;
 const text='这是一轮公开联网工具验收。请仅调用服务“Exa DeepSeek 实际验收”的 web_search_exa 一次，query 为 '+query+'，numResults 为 2，objective 为 '+objective+'。不要查询或读写个人文件、记忆、日历、手机内容，不要调用其他联网工具。允许按需读取工具目录或参数说明。根据本次实际工具结果，用中文简短回复找到的 Android 官方页面标题和链接。工具失败请直接说明，不要凭已有知识生成结果。';
 await call('message.send',{conversationId,text});const approved=new Set();let answer;
 await until(async()=>{const s=await call('snapshot.get');for(const task of s.tasks){assert(task.detail.includes(query),'Unexpected approval scope');if(!approved.has(task.id)){approved.add(task.id);await call('task.respond',{id:task.id,action:'approve'});}}const last=s.conversations.find(c=>c.id===conversationId)?.messages.at(-1);assert.notEqual(last?.status,'error','Real model tool turn failed');answer=last;return last?.role==='assistant'&&last.status==='complete';},120000);
 await pause(500);const turns=trace(),calls=turns.flatMap(t=>t.calls??[]),results=turns.filter(t=>t.role==='tool'),searchResults=results.filter(t=>t.toolName?.startsWith('mcp_'+serverId+'_'));
 assert.equal(searchResults.length,1,'Expected one actual Exa search result');const content=typeof searchResults[0].content==='string'?searchResults[0].content:JSON.stringify(searchResults[0].content);assert(content.includes('developer.android.com'));assert(!/^\s*\{\s*"error"/.test(content));assert(answer.text.includes('developer.android.com'));
 proof.approvals=approved.size;proof.modelToolRounds=turns.filter(t=>t.role==='assistant').length;proof.toolNames=calls.map(c=>c.name);proof.searchResultBytes=Buffer.byteLength(content);proof.sourceUrls=[...new Set((content.match(/https?:\/\/[^\s"<>\\]+/g)??[]).map(url=>url.replace(/[),.;]+$/,'')))].filter(url=>url.startsWith('https://developer.android.com/'));assert(proof.sourceUrls.length);proof.answer=answer.text;proof.realModelVerified=true;proof.realExaVerified=true;
 // 只投影工具名/结果长度和最终可见答复；不保存原生 reasoning_content 或原始请求。
 pass('真实 DeepSeek 经共享 Agent 调用一次实际 Exa 搜索并完成工具结果续答');
}catch(error){proof.error=error instanceof Error?error.message:'LIVE_TOOLS_FAILED';console.error('Live tools: '+proof.error);process.exitCode=1;}
finally{
 try{if(page&&(changed||restarted)){
  const s=await call('snapshot.get');if(s.activeReply){assert.equal(s.activeReply.conversationId,conversationId);await call('reply.cancel');}for(const task of s.tasks)await call('task.respond',{id:task.id,action:'reject'});
  if(before.activeConversationId)await call('conversation.select',{id:before.activeConversationId});if(conversationId)await call('conversation.delete',{id:conversationId});
  if(changed){row=(await call('mcp.list')).find(r=>r.id===serverId);if(row){await call('mcp.disconnect',{id:serverId});row=(await call('mcp.list')).find(r=>r.id===serverId);await call('mcp.remove',{id:serverId,revision:row.revision});}}
  const after=await call('snapshot.get');assert.deepEqual(after.providers,before.providers);assert.equal(after.activeConversationId,before.activeConversationId);assert.deepEqual(after.conversations.map(c=>c.id),before.conversations.map(c=>c.id));for(const key of ['scale','visible','quiet','bubbleSeconds','docking'])assert.deepEqual(after.pet[key],before.pet[key]);assert.deepEqual(await call('mcp.list'),servers);assert.equal(adb('shell','settings','get','secure','default_input_method'),ime);assert(after.runtime.running&&after.runtime.overlayVisible&&!after.activeReply&&!after.tasks.length&&!after.voice.state.active&&!after.voice.wake.armed);
  proof.authorizedModelAndOriginalStateKept=true;proof.finalRuntime=after.runtime;proof.accessibility=after.capabilities.find(c=>c.id==='accessibility')?.state;pass('保留授权模型，移除临时联网服务与会话，原宠物和常驻状态保持');
 }}catch(error){proof.cleanupError=error instanceof Error?error.message:'CLEANUP_FAILED';console.error('Cleanup: '+proof.cleanupError);process.exitCode=1;}
 await detach();adb('shell','input','keyevent','KEYCODE_HOME');await writeFile(out+'/result.json',JSON.stringify(proof,null,2));
}
