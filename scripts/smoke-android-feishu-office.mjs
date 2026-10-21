import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';

const app='app.familiar.mobile.debug',out=process.env.FAMILIAR_SMOKE_DIR??'.artifacts/android-feishu',cdp=9261,overlayCdp=9262;
await mkdir(out,{recursive:true});
const adb=(...args)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...args],{encoding:'utf8',windowsHide:true}).trim();
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const focus=process.env.FAMILIAR_OFFICE_FOCUS??'all',includeUnicode=process.env.FAMILIAR_OFFICE_UNICODE==='1';
assert(['all','unicode'].includes(focus));assert(focus!=='unicode'||includeUnicode);
const proof={date:new Date().toISOString(),focus,includeUnicode,checks:[]}; const conversations=[];
let browser,overlay,page,before,initial,seq=0,changed=false,command,toolResult,step=0,ref,modelError,archiveCheckpoint,archivedCallId,archiveRef;
let archiveReads=[],maxRequestBytes=0;
const pass=name=>{proof.checks.push(name);console.log('PASS '+name);};
const server=createServer(async(req,res)=>{
 try{
  if(req.url.endsWith('/models')){res.end(JSON.stringify({data:[{id:'office-local-fixture'}]}));return;}
  let data='';for await(const chunk of req)data+=chunk;const request=JSON.parse(data),last=request.messages.filter(m=>m.role==='tool').at(-1);
  maxRequestBytes=Math.max(maxRequestBytes,Buffer.byteLength(JSON.stringify(request.messages))+Buffer.byteLength(JSON.stringify(request.tools)));
  const archived=request.messages.map(m=>{try{return JSON.parse(m.content);}catch{return null;}}).find(m=>m?.kind==='familiar.archived-tool-turn'&&m.records?.some(r=>r.toolCallId==='office-3'));
  let name,args;const names=request.tools.map(t=>t.function.name);
  if(step===0){if(names.includes('feishu_cli')){name='feishu_cli';args={args:command};step=3;}else{assert(names.includes('familiar_tools_search'));name='familiar_tools_search';args={query:'feishu_cli'};step=1;}}
  else if(step===1){ref=JSON.parse(last.content).tools.find(t=>t.name==='feishu_cli')?.ref;assert(ref);name='familiar_tool_schema';args={ref};step=2;}
  else if(step===2){name='familiar_tool_invoke';args={ref,arguments:{args:command}};step=3;}
  else if(step===3&&archived){archiveCheckpoint=archived.checkpoint;archivedCallId='office-3';name='familiar_tools_search';args={query:'context_read'};step=4;}
  else if(step===4){archiveRef=JSON.parse(last.content).tools.find(t=>t.name==='context_read')?.ref;assert(archiveRef);name='familiar_tool_schema';args={ref:archiveRef};step=5;}
  else if(step===5){assert(JSON.parse(JSON.parse(last.content).schema).properties.limit);name='familiar_tool_invoke';args={ref:archiveRef,arguments:{checkpoint:archiveCheckpoint,query:'dry_run',limit:2000}};step=6;}
  else if(step===6){assert(JSON.parse(last.content).text.includes('dry_run'));archiveReads.push('dry_run');name='familiar_tool_invoke';args={ref:archiveRef,arguments:{checkpoint:archiveCheckpoint,query:'extra_param',limit:2000}};step=7;}
  else if(step===7){assert(JSON.parse(last.content).text.includes('extra_param'));archiveReads.push('extra_param');res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content:'本地办公预览及原文回查完成'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);return;}
  else{toolResult=last.content;res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content:'本地办公验收完成'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);return;}
  res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'office-'+step,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);
 }catch(error){modelError=String(error);res.writeHead(500);res.end('fixture failed');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
const raw=(method,params)=>page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:'office-'+(++seq),method,params});
const call=async(method,params)=>{const r=await raw(method,params);assert(r.ok,JSON.stringify(r));return r.result;};
async function until(check,timeout=25000){for(const end=Date.now()+timeout;Date.now()<end;){if(await check())return;await delay(200);}throw Error('Device deadline; '+(modelError??''));}
async function approve(allow){
 if(!overlay)await until(async()=>{try{const pid=adb('shell','pidof',app+':runtime');if(!adb('shell','cat','/proc/net/unix').includes('webview_devtools_remote_'+pid))return false;adb('forward','tcp:'+overlayCdp,'localabstract:webview_devtools_remote_'+pid);overlay=await chromium.connectOverCDP('http://127.0.0.1:'+overlayCdp,{timeout:1500});return true;}catch{return false;}});
 let p;await until(async()=>{p=overlay.contexts()[0].pages().find(p=>p.url().includes('/approval/index.html'));return !!p;});
 await p.locator('.approval[data-ready="true"]').waitFor();const b=p.getByRole('button',{name:allow?/^允许这一步/:/^拒绝这一步/});await until(()=>b.isEnabled());
 await p.screenshot({path:out+'/office-approval-'+(allow?'allow':'deny')+'.png'});
 const box=await b.boundingBox(),v=await p.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}));const size=adb('shell','wm','size').match(/Physical size: (\d+)x(\d+)/);
 adb('shell','input','tap',String(Math.round((+size[1]-v.width*v.dpr)/2+(box.x+box.width/2)*v.dpr)),String(Math.round(+size[2]-24*v.dpr-v.height*v.dpr+(box.y+box.height/2)*v.dpr)));
}
async function scenario(args,decision){
 command=args;step=0;ref=undefined;toolResult=undefined;modelError=undefined;archiveCheckpoint=undefined;archivedCallId=undefined;archiveRef=undefined;archiveReads=[];
 const conversation=await call('conversation.create');conversations.push(conversation.id);
 await call('message.send',{conversationId:conversation.id,text:'执行本地飞书组件验收，仅预览请求，不写入云端。'});
 if(decision!==undefined){await until(async()=>(await call('snapshot.get')).tasks.length===1);const pending=(await call('snapshot.get')).tasks[0];assert.match(pending.title,/飞书办公操作/);assert.match(pending.detail,/cli_0123456789abcdef/);assert.equal(toolResult,undefined);await approve(decision);}
 await until(async()=>{const s=await call('snapshot.get');return !s.activeReply&&!s.tasks.length;});assert.equal(modelError,undefined);
 if(archiveCheckpoint&&archiveReads.length===2){
  const stored=JSON.parse(adb('shell','run-as',app,'cat','files/data/conversation-session-'+conversation.id+'.json'));
  const answer=stored.messages.filter(m=>m.role==='assistant').at(-1);assert.equal(answer?.status,'complete');
  toolResult=answer.trace.find(m=>m.role==='tool'&&m.toolCallId===archivedCallId)?.content;
  proof.archivedContinuation={checkpoint:archiveCheckpoint,queries:[...archiveReads],visibleReply:answer.text,complete:true,maxRequestBytes,rawToolResultBytes:typeof toolResult==='string'?Buffer.byteLength(toolResult):0};
 }
 if(typeof toolResult!=='string'){
  const stored=JSON.parse(adb('shell','run-as',app,'cat','files/data/conversation-session-'+conversation.id+'.json'));
  await writeFile(out+'/failed-scenario.json',JSON.stringify(stored,null,2));
  const assistant=stored.messages.filter(m=>m.role==='assistant').at(-1),last=assistant?.trace?.filter(m=>m.role==='tool').at(-1);
  proof.failedScenario={conversationId:conversation.id,status:assistant?.status,context:stored.session.status,toolResultBytes:last?Buffer.byteLength(last.content):0};
 }
 assert.equal(typeof toolResult,'string');return toolResult;
}
try{
 assert(!adb('forward','--list').includes('tcp:'+cdp));adb('reverse','tcp:'+port,'tcp:'+port);
 adb('shell','am','start','-n',app+'/app.familiar.mobile.MainActivity');await delay(1200);
 adb('forward','tcp:'+cdp,'localabstract:webview_devtools_remote_'+adb('shell','pidof',app));browser=await chromium.connectOverCDP('http://127.0.0.1:'+cdp);page=browser.contexts()[0].pages()[0];await page.locator('#familiar-root[data-ready="true"]').waitFor();
 before=await call('snapshot.get');initial=await call('feishu.status');
 if(before.runtime.engine==='ready'&&!before.runtime.running){await call('runtime.set',{enabled:true});await until(async()=>(await call('snapshot.get')).runtime.running);before=await call('snapshot.get');}
 assert(before.runtime.engine==='ready'&&before.runtime.running&&!before.activeReply&&!before.tasks.length&&!before.voice.state.active&&!before.voice.wake.armed);
 assert(!initial.appId&&!initial.hasSecret&&!initial.enabled&&!initial.office.enabled);assert(before.providers.every(p=>!p.profile.keyConfigured));
 await writeFile(out+'/office-device-before.json',JSON.stringify({before,initial},null,2));
 proof.apkSha256=createHash('sha256').update(await readFile('apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk')).digest('hex');
 assert.equal(adb('shell','sha256sum',adb('shell','pm','path',app).replace(/^package:/,'')).split(/\s+/)[0],proof.apkSha256);
 assert(initial.office.available);let checked=await call('feishu.office.check');assert.match(checked.office.detail,/内置办公执行器可用/);pass('主 APK 内置 ARM64 办公程序从真实 Runtime 启动');
 assert.equal((await raw('feishu.office.check',{args:['auth','login']})).error?.code,'INVALID_INPUT');
 assert.equal((await raw('feishu.office.save',{enabled:true,revision:initial.office.revision,channelRevision:initial.revision})).error?.code,'UNAVAILABLE');pass('网页不能传入办公命令，缺少凭据不能开启');
 const ui=page.locator('.feishu-page');
 if(!await ui.isVisible()){await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:/飞书.*机器人私聊/}).click();}
 assert(initial.auth&&!initial.auth.connected&&initial.auth.phase==='signedOut');await ui.locator('.feishu-auth').waitFor();assert(await ui.getByRole('button',{name:'登录个人账号',exact:true}).isDisabled());
 assert.equal((await raw('feishu.auth.begin',{revision:initial.auth.revision,channelRevision:initial.revision,scopes:[]})).error?.code,'UNAVAILABLE');
 assert.equal((await raw('feishu.auth.open',{revision:initial.auth.revision,url:'https://example.com'})).error?.code,'INVALID_INPUT');
 assert.equal((await raw('feishu.auth.open',{revision:initial.auth.revision})).error?.code,'UNAVAILABLE');pass('实际登录入口在缺凭据时禁用，公共桥拒绝自定义授权地址');
 await ui.getByLabel('应用编号（App ID）',{exact:true}).fill('cli_0123456789abcdef');await ui.getByLabel('应用密钥（留空保留）',{exact:true}).fill('office-device-fixture-secret');changed=true;await ui.getByRole('button',{name:'保存并应用',exact:true}).click();await until(async()=>(await call('feishu.status')).hasSecret);
 await ui.getByLabel('办公身份',{exact:true}).selectOption('user');await ui.getByLabel('开启办公能力',{exact:true}).check();await ui.getByRole('button',{name:'保存办公设置',exact:true}).click();await until(async()=>(await call('feishu.status')).office.identity==='user');
 assert.match((await call('feishu.status')).office.detail,/先完成个人账号登录/);assert(!await ui.getByRole('button',{name:'登录个人账号',exact:true}).isDisabled());
 await ui.locator('.feishu-auth').scrollIntoViewIfNeeded();await page.screenshot({path:out+'/auth-device-settings.png'});
 await ui.getByLabel('办公身份',{exact:true}).selectOption('bot');pass('个人办公身份可保存，未登录时提示登录且不代用机器人');
 await ui.getByLabel('开启办公能力',{exact:true}).check();await ui.getByRole('button',{name:'保存办公设置',exact:true}).click();await until(async()=>(await call('feishu.status')).office.enabled);assert(!(await call('feishu.status')).enabled);
 await ui.getByRole('button',{name:'检查办公组件',exact:true}).click();await until(async()=>(await call('feishu.status')).office.detail.includes('本次检查未连接飞书'));
 await ui.getByLabel('开启办公能力',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:out+'/office-device-settings.png'});pass('实际设置页独立启用办公并显示离线组件检查结果');
 await call('provider.save',{kind:'compatible',baseUrl:`http://127.0.0.1:${port}/v1`,model:'office-local-fixture',clearApiKey:true});
 if(focus!=='unicode'){
 assert.match(await scenario(['docs','--help']),/Document and content operations/);pass('本地模型通过共享 Agent 调用真实 CLI 文档帮助');
 const args=['calendar','+create','--calendar-id','primary','--summary','Android办公验收','--start','2026-11-01T10:00:00+08:00','--end','2026-11-01T11:00:00+08:00','--dry-run'];
 assert(!String(await scenario(args,false)).includes('"dry_run": true'));pass('触摸拒绝后办公写入预览不执行');
 const preview=JSON.parse(await scenario(args,true));proof.preview=preview;assert.equal(preview.dry_run,true);assert.equal(preview.identity,'bot');assert.match(JSON.stringify(preview),/Android办公验收/);pass('触摸批准后得到官方日历 POST 请求预览，无真实云端写入');
 }
 if(includeUnicode){
  const content='中'.repeat(11000),result=JSON.parse(await scenario(['docs','+create','--api-version','v2','--title','Unicode验收','--content',content,'--doc-format','markdown','--dry-run'],true));
  assert(result.ok&&result.dry_run);const post=result.data.api.find(a=>a.method==='POST');assert.equal(post.body.content,'<title>Unicode验收</title>\n'+content);
  proof.unicode={units:content.length,bytes:Buffer.byteLength(content),contentSha256:createHash('sha256').update(post.body.content).digest('hex')};pass('共享 Agent 经实体批准调用 33000 字节中文参数，官方文档预览完整保留');
 }
 if(focus!=='unicode'){
 const escape=JSON.parse(await scenario(['docs','+create','--title','workspace','--content','@../outside.txt','--doc-format','markdown','--dry-run'],true));assert.equal(escape.ok,false);assert.notEqual(escape.exitCode,0);pass('主程序办公文件输入拒绝越出灵伴工作区');
 }
}catch(error){
 proof.error=String(error);console.error(error);process.exitCode=1;
 if(proof.failedScenario)try{
  adb('shell','input','keyevent','KEYCODE_HOME');await delay(500);
  const window=adb('shell','dumpsys','window','windows').split(/  Window #/).find(b=>b.includes('u0 FamiliarPet}')&&b.includes('mHasSurface=true'));
  const m=window?.match(/Frames:.*? frame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);assert(m);
  adb('shell','input','tap',String(Math.round((+m[1]+ +m[3])/2)),String(Math.round((+m[2]+ +m[4])/2)));await delay(900);
  adb('shell','uiautomator','dump','/sdcard/familiar-office-error.xml');await writeFile(out+'/failure-ui.xml',adb('shell','cat','/sdcard/familiar-office-error.xml'));
  await writeFile(out+'/failure.png',execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554','exec-out','screencap','-p'],{windowsHide:true,maxBuffer:16*1024*1024}));
  adb('shell','am','start','-n',app+'/app.familiar.mobile.MainActivity');await delay(500);await call('snapshot.get');
 }catch(diagnosticError){proof.diagnosticError=String(diagnosticError);}
}
finally{
 try{
  if(changed){
   await call('reply.cancel');let s=await call('feishu.status');await call('feishu.office.save',{enabled:false,revision:s.office.revision,channelRevision:s.revision});
   s=await call('feishu.status');await call('feishu.save',{appId:initial.appId,enabled:false,allowedUsers:initial.allowedUsers,revision:s.revision,clearSecret:true});
   s=await call('feishu.status');await call('feishu.office.save',{enabled:false,revision:s.office.revision,channelRevision:s.revision});
   const profile=before.providers.find(p=>p.id==='compatible').profile;await call('provider.save',{kind:'compatible',baseUrl:profile.baseUrl,model:profile.model,clearApiKey:true});
   if(before.provider.kind!=='compatible')await call('provider.save',{kind:before.provider.kind,baseUrl:before.provider.baseUrl,model:before.provider.model});
   if(before.activeConversationId)await call('conversation.select',{id:before.activeConversationId});for(const id of conversations)await call('conversation.delete',{id});
   const after=await call('snapshot.get'),restored=await call('feishu.status');assert(!restored.appId&&!restored.hasSecret&&!restored.enabled&&!restored.office.enabled&&!restored.office.appId);
   assert.deepEqual(after.provider,before.provider);assert.deepEqual(after.providers,before.providers);assert.equal(after.activeConversationId,before.activeConversationId);assert.deepEqual(after.conversations.map(c=>c.id),before.conversations.map(c=>c.id));
   for(const key of ['scale','visible','quiet','bubbleSeconds','docking'])assert.deepEqual(after.pet[key],before.pet[key]);assert(after.runtime.running&&after.runtime.overlayVisible&&!after.activeReply&&!after.tasks.length);
   proof.restored=true;pass('已移除测试凭据和会话，原模型、宠物与常驻状态恢复');
  }
 }catch(error){proof.restoreError=String(error);console.error('RESTORE FAILED',error);process.exitCode=1;}
 await overlay?.close();await browser?.close();adb('forward','--remove','tcp:'+cdp);if(adb('forward','--list').includes('tcp:'+overlayCdp))adb('forward','--remove','tcp:'+overlayCdp);adb('reverse','--remove','tcp:'+port);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 await writeFile(out+'/office-device.json',JSON.stringify(proof,null,2));
}
