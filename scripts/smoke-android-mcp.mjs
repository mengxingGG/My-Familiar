import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {httpMcpFixture} from '../tests/fixtures/http-mcp.ts';

// 仅使用本轮临时 HTTP 服务和本轮新建的 MCP 配置，finally 恢复模型及会话。
const app='app.familiar.mobile.debug',out='.artifacts/android-device';
const adb=(...args)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...args],{encoding:'utf8',windowsHide:true}).trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const fixture=await httpMcpFixture(),results=[],proof={},scopes=new Map();
let browser,page,before,row,conversationId,configured=false,seq=0,scenario,step=0,toolOutput,imageReceived=false,serverError,catalogRef,catalogSchema='',catalogMaxBytes=0;
const llm=createServer(async(req,res)=>{
 try {
  if(req.url.endsWith('/models')){res.end(JSON.stringify({data:[{id:'mcp-fixture',context_length:131072}]}));return;}
  let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);
  let choice;
  if(scenario.startsWith('catalog')){
   catalogMaxBytes=Math.max(catalogMaxBytes,Buffer.byteLength(JSON.stringify(input.tools)));
   const previous=input.messages.filter(m=>m.role==='tool').at(-1),previousName=input.messages.filter(m=>m.role==='assistant'&&m.tool_calls?.length).at(-1)?.tool_calls.at(-1).function.name;
   let name='',args;
   if(step++===0){name='mcp_tools_search';args={server:row.id,query:scenario==='catalog-image'?'picture':'tool_077'};}
   else if(previousName==='mcp_tools_search'){catalogRef=JSON.parse(previous.content).tools[0].ref;name='mcp_tool_schema';args={ref:catalogRef};}
   else if(previousName==='mcp_tool_schema'){const part=JSON.parse(previous.content);catalogSchema+=part.schema;if(part.nextOffset!==null){name='mcp_tool_schema';args={ref:catalogRef,offset:part.nextOffset};}else{name='mcp_tool_invoke';args={ref:catalogRef,arguments:{text:'isolated-device-check'}};}}
   if(name)choice={delta:{tool_calls:[{index:0,id:'catalog-device-'+step,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'};
   else{toolOutput=previous?.content;imageReceived=JSON.stringify(input.messages).includes('data:image/png;base64,');if(scenario==='catalog-image'){assert.deepEqual(input.tools.map(t=>t.function.name),['familiar_tools_search','familiar_tool_schema','familiar_tool_invoke']);proof.adaptiveCatalog=true;}choice={delta:{content:'本轮隔离 MCP 验收完成。'},finish_reason:'stop'};}
  }else if(step++===0){
   const tool=input.tools.find(t=>scenario==='enable'?t.function.name==='mcp_enable':t.function.description.includes('HTTP fixture '+scenario));
   assert(tool,'Fixture tool must be in real model catalog');
   choice={delta:{tool_calls:[{index:0,id:'mcp-device-'+seq,type:'function',function:{name:tool.function.name,arguments:JSON.stringify(scenario==='enable'?{id:row.id}:{text:'isolated-device-check'})}}]},finish_reason:'tool_calls'};
  }else{
   toolOutput=input.messages.filter(m=>m.role==='tool').at(-1)?.content;
   imageReceived=JSON.stringify(input.messages).includes('data:image/png;base64,');
   choice={delta:{content:'本轮隔离 MCP 验收完成。'},finish_reason:'stop'};
  }
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[choice]})}\n\ndata: [DONE]\n\n`);
 }catch(e){serverError=e.message;res.writeHead(500);res.end();}
});
await new Promise(r=>llm.listen(0,'127.0.0.1',r));const modelPort=llm.address().port;
adb('reverse',`tcp:${fixture.port}`,`tcp:${fixture.port}`);adb('reverse',`tcp:${modelPort}`,`tcp:${modelPort}`);
async function attach(){
 page=undefined;adb('shell','am','start','-n',`${app}/app.familiar.mobile.MainActivity`);
 for(let n=0;n<60;n++){try{adb('forward','tcp:9230',`localabstract:webview_devtools_remote_${adb('shell','pidof',app)}`);browser=await chromium.connectOverCDP('http://127.0.0.1:9230');page=browser.contexts()[0].pages()[0];if(page)break;await browser.close();}catch{}await sleep(250);}
 assert(page);await page.locator('#familiar-root[data-ready="true"]').waitFor();
}
async function raw(method,params){return page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:'mcp-device-'+(++seq),method,params});}
async function call(method,params){const r=await raw(method,params);assert(r.ok,`${method}: ${r.error?.code}`);return r.result;}
async function until(fn,timeout=20000){for(const end=Date.now()+timeout;Date.now()<end;){if(await fn())return;await sleep(100);}throw Error('Device fixture deadline');}
const pass=name=>{results.push(name);console.log('PASS '+name);};
const remember=s=>{scopes.set(JSON.stringify([s.url,s.auth]),{...s,enabled:false});return s;};
async function save(config,extra={}){row=remember(await call('mcp.save',{config,revision:row.revision,...extra}));return row;}
async function openUi(){const back=page.locator('.mcp-page:not([hidden]) .pagebar button, .feishu-page:not([hidden]) .pagebar button');if(await back.count())await back.click();await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:/网络工具 · MCP/}).click();await page.locator('.mcp-page:not([hidden])').waitFor();}
async function runTool(name,approve,beforeApproval){
 if(conversationId){if(before.activeConversationId)await call('conversation.select',{id:before.activeConversationId});await call('conversation.delete',{id:conversationId});}
 conversationId=(await call('conversation.create')).id;scenario=name;step=0;toolOutput=undefined;imageReceived=false;catalogSchema='';
 await call('message.send',{conversationId,text:'仅执行本轮隔离 MCP 验收。'});
 let approvals=0;
 await until(async()=>{const s=await call('snapshot.get');for(const t of s.tasks){approvals++;await beforeApproval?.();await call('task.respond',{id:t.id,action:approve?'approve':'stop'});}const last=s.conversations.find(c=>c.id===conversationId)?.messages.at(-1);assert.notEqual(last?.status,'error',JSON.stringify(last));return last?.role==='assistant'&&last.status==='complete';});
 assert.equal(approvals,1,'Untrusted readOnlyHint must still request approval');assert.equal(serverError,undefined);assert(toolOutput);
 return toolOutput;
}
try{
 await attach();before=await call('snapshot.get');assert(before.mcpManagement);assert(!before.activeReply&&!before.voice.state.active);assert(before.providers.every(p=>!p.profile.keyConfigured));
 const initial=await call('mcp.list');await writeFile(out+'/mcp-before.json',JSON.stringify({provider:before.provider,providers:before.providers,activeConversationId:before.activeConversationId,servers:initial},null,2));
 await openUi();const ui=page.locator('.mcp-page');const button=name=>ui.getByRole('button',{name,exact:true});
 await button('添加服务').click();await ui.getByLabel('服务名称',{exact:true}).fill('隔离网络工具验收');await ui.getByLabel('MCP 服务地址',{exact:true}).fill(fixture.url+'/mcp');await ui.getByLabel('启用服务，应用启动时自动连接',{exact:true}).check();
 await ui.getByLabel('鉴权方式',{exact:true}).selectOption('header');await ui.getByLabel('鉴权字段名',{exact:true}).fill('x-fixture-key');await ui.getByLabel('密钥（留空保留）',{exact:true}).fill('isolated-mcp-key');await button('保存设置').click();
  await ui.getByText('设置已保存。',{exact:true}).waitFor();await until(async()=>{row=(await call('mcp.list')).find(s=>s.name==='隔离网络工具验收'&&!initial.some(old=>old.id===s.id));return row;});remember(row);assert(row.hasKey);assert.equal(await ui.getByLabel('密钥（留空保留）',{exact:true}).inputValue(),'');
 await button('连接并读取工具').click();await until(async()=>(await call('mcp.list')).find(s=>s.id===row.id)?.connected);await ui.getByText('已连接 · 2 个工具',{exact:true}).waitFor();assert(fixture.state.requests.length>0&&fixture.state.requests.every(r=>r.authenticated));
 assert(!JSON.stringify(await call('mcp.list')).includes('isolated-mcp-key'));await page.screenshot({path:out+'/mcp-settings.png'});pass('实际 Android 页面保存、读取密钥状态与 HTTP 握手，工具目录可用且密钥不回填');
 await ui.locator('.pagebar button').click();
 const original=before.providers.find(p=>p.id==='compatible').profile;
 await call('provider.save',{kind:'compatible',baseUrl:`http://127.0.0.1:${modelPort}/v1`,model:'mcp-fixture',advanced:{...original.advanced,contextTokens:131072}});configured=true;
 const count=fixture.state.calls.length;await runTool('echo',false);assert.equal(fixture.state.calls.length,count);const echo=await runTool('echo',true);assert.match(echo,/echo:isolated-device-check/);assert.equal(fixture.state.calls.length,count+1);pass('真实共享 Agent 发起 MCP 工具；拒绝无请求，批准后服务收到调用');
 await runTool('picture',true);assert(imageReceived);assert.equal(fixture.state.calls.at(-1).name,'picture');pass('MCP 图片经共享媒体层送入后续模型请求');
 const enableResult=await runTool('enable',true,async()=>{await save({...row,name:'隔离网络工具验收-已修改'});});assert.match(enableResult,/CONFLICT/);assert.equal((await call('mcp.list')).find(s=>s.id===row.id).name,'隔离网络工具验收-已修改');pass('启用 MCP 的旧审批不能覆盖等待期间修改的新配置');
 const oldRevision=row.revision;await save({...row,url:fixture.url+'/slow'});assert(!row.hasKey);assert.equal((await raw('mcp.save',{config:row,revision:oldRevision})).error.code,'CONFLICT');
 await openUi();await ui.getByLabel('MCP 服务',{exact:true}).selectOption(row.id);await button('连接并读取工具').click();await until(()=>fixture.state.slowStarted>0);const started=Date.now();await call('snapshot.get');await button('取消连接').click();await ui.getByText('连接已取消。',{exact:true}).waitFor();assert(Date.now()-started<4000);assert(!(await call('mcp.list')).find(s=>s.id===row.id).connected);pass('换地址隔离密钥、旧版本保存被拒绝；慢连接可取消且不阻塞核心');
 await ui.locator('.pagebar button').click();await save({...row,url:fixture.url+'/mcp',auth:{kind:'query',name:'credential'}},{apiKey:'isolated-mcp-key'});await call('mcp.connect',{id:row.id,revision:row.revision,operationId:'query-'+seq});
 assert(fixture.state.requests.filter(r=>r.path==='/mcp').every(r=>r.authenticated));
 await save({...row,url:fixture.url+'/large'},{apiKey:'isolated-mcp-key'});await call('mcp.connect',{id:row.id,revision:row.revision,operationId:'large-'+seq});
 assert.equal((await call('mcp.list')).find(s=>s.id===row.id).tools,80);assert(fixture.state.catalogBytes>32768);
 await call('provider.save',{kind:'compatible',baseUrl:`http://127.0.0.1:${modelPort}/v1`,model:'mcp-fixture',advanced:{...original.advanced,contextTokens:32768}});
 const large=await runTool('catalog',true);assert.match(large,/echo:isolated-device-check/);assert.equal(JSON.parse(catalogSchema).properties.text.maxLength,200);assert(catalogMaxBytes<20000);proof.catalogBytes=fixture.state.catalogBytes;proof.modelToolBytes=catalogMaxBytes;pass('80 个工具的大目录在 32K 窗口按需检索、完整读参数并获批调用');
 const callsBefore=fixture.state.calls.length;await runTool('catalog-denied',false);assert.equal(fixture.state.calls.length,callsBefore);pass('目录调用拒绝后外部服务零执行');
 await runTool('catalog-image',true);assert(imageReceived);pass('按需调用的图片结果仍进入后续模型请求');
 const beforeStale=fixture.state.calls.length;const stale=await runTool('catalog-stale',true,async()=>{await save({...row,name:'隔离大目录-等待中修改'});});assert.match(stale,/连接已变化/);assert.equal(fixture.state.calls.length,beforeStale);pass('按需调用等待批准期间修改配置，旧工具不能执行');
 await call('mcp.connect',{id:row.id,revision:row.revision,operationId:'large-restore-'+seq});
 await browser.close();adb('shell','am','force-stop',app);await attach();await until(async()=>(await call('mcp.list')).some(s=>s.id===row.id&&s.connected));row=(await call('mcp.list')).find(s=>s.id===row.id);assert(row.hasKey);pass('查询参数鉴权可用，Android 进程重启后从加密存储恢复并自动连接');
 const apk=await readFile('apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk');proof.apkSha256=createHash('sha256').update(apk).digest('hex');const installed=adb('shell','pm','path',app).split('\n').find(s=>s.startsWith('package:')).slice(8);assert.equal(adb('shell','sha256sum',installed).split(/\s+/)[0],proof.apkSha256);pass('已安装 ARM64 APK 与本次构建哈希一致');
}finally{
 try{
  if(before){
   if(!browser?.isConnected()||page?.isClosed())await attach();await call('reply.cancel');
   if(row){
    row=(await call('mcp.list')).find(s=>s.id===row.id);
    if(row){for(const config of scopes.values()){row=await call('mcp.save',{config,revision:row.revision,clearApiKey:true});assert(!row.hasKey);}await call('mcp.remove',{id:row.id,revision:row.revision});assert(!(await call('mcp.list')).some(s=>s.id===row.id));}
   }
   if(before.activeConversationId)await call('conversation.select',{id:before.activeConversationId});
   if(conversationId)await call('conversation.delete',{id:conversationId});
   if(configured){await call('provider.save',{...before.providers.find(p=>p.id==='compatible').profile});await call('provider.save',{...before.provider});}
   if(before.activeConversationId)await call('conversation.select',{id:before.activeConversationId});
   const final=await call('snapshot.get');assert(!final.activeReply&&final.tasks.length===0);assert.deepEqual(final.conversations.map(c=>c.id).sort(),before.conversations.map(c=>c.id).sort());proof.cleanup=true;await writeFile(out+'/mcp-after.json',JSON.stringify({provider:final.provider,providers:final.providers,servers:await call('mcp.list')},null,2));
  }
 }catch(e){console.error('RESTORE FAILED',e);process.exitCode=1;}
 await browser?.close();await fixture.close();llm.closeAllConnections();await new Promise(r=>llm.close(r));adb('forward','--remove','tcp:9230');adb('reverse','--remove',`tcp:${fixture.port}`);adb('reverse','--remove',`tcp:${modelPort}`);await writeFile(out+'/mcp-smoke.json',JSON.stringify({date:new Date().toISOString(),results,proof},null,2));
}
