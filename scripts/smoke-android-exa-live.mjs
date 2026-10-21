import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import Ajv from 'ajv';

// 模型规划留在本机，只有固定的公开查询经真实 Android MCP 发往官方 Exa；不使用账号或 API 密钥。
const app='app.familiar.mobile.debug',out=process.env.FAMILIAR_EXA_LIVE_REPORT_DIR??'.artifacts/android-exa-live',cdp=9283,runId=randomUUID(),serverId='exa-check-'+runId.slice(0,8);
const endpoint='https://mcp.exa.ai/mcp',query='site:developer.android.com foreground service background start restrictions';
await mkdir(out,{recursive:true});
const adb=(...args)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...args],{encoding:'utf8',windowsHide:true,timeout:30000}).trim();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),missing=Symbol('not advertised');
let browser,page,before,initial,row,conversationId,changed=false,restoring=false,sequence=0,visible=new Map(),scenario,serverError,toolResult,toolName,approvals=0,modelRequests=0,searchCalls=0;
const checks=[],proof={date:new Date().toISOString(),runId,checks,service:{url:endpoint,authenticated:false},query,modelService:'local-protocol-fixture',calls:[]};
const pass=name=>{checks.push(name);console.log('PASS '+name);};
const parsed=value=>{if(typeof value!=='string')return value;try{return JSON.parse(value);}catch{return value;}};
const validator=new Ajv({strict:false});
function* route(name,args){
 const matches=entry=>entry.name===name||name===toolName&&entry.description?.includes('Exa 实际连通验收 · '+toolName+':');
 const direct=[...visible.values()].find(matches);if(direct)return yield {name:direct.name,args:typeof args==='function'?args(direct.parameters):args};
 if(!visible.has('familiar_tools_search'))return missing;
 const found=yield {name:'familiar_tools_search',args:{query:name}},entry=found.tools?.find(matches);if(!entry)return missing;
 let text='',offset=0;for(;;){const part=yield {name:'familiar_tool_schema',args:{ref:entry.ref,...(offset?{offset}:{})}};assert.equal(typeof part.schema,'string');text+=part.schema;if(part.nextOffset===null)break;offset=part.nextOffset;}JSON.parse(text);
 return yield {name:'familiar_tool_invoke',args:{ref:entry.ref,arguments:typeof args==='function'?args(JSON.parse(text)):args}};
}
function* search(){
 const args=schema=>{const value={query,...(schema.properties?.numResults?{numResults:2}:{}),...(schema.properties?.contextMaxCharacters?{contextMaxCharacters:4000}:{}),...(schema.properties?.objective?{objective:'Find current official Android Developers documentation about restrictions on starting foreground services from the background. Rank developer.android.com first and return a short useful excerpt from each of at most two pages.'}:{})};proof.searchSchema=schema;assert(validator.validate(schema,value),JSON.stringify(validator.errors));return value;};
 let result=yield* route(toolName,args);
 if(result===missing){
  const found=yield* route('mcp_tools_search',{server:serverId,query:'web_search_exa'});assert.notEqual(found,missing);const entry=found.tools?.find(entry=>entry.name==='web_search_exa'||entry.name.includes('web_search_exa'));assert(entry);
  let schema='',offset=0;for(;;){const part=yield* route('mcp_tool_schema',{ref:entry.ref,...(offset?{offset}:{})});assert.notEqual(part,missing);schema+=part.schema;if(part.nextOffset===null)break;offset=part.nextOffset;}JSON.parse(schema);
  result=yield* route('mcp_tool_invoke',{ref:entry.ref,arguments:args(JSON.parse(schema))});assert.notEqual(result,missing);
 }
 searchCalls++;toolResult=typeof result==='string'?result:JSON.stringify(result);assert(toolResult.includes('developer.android.com'));assert(/https?:\/\//.test(toolResult));
 return '实际 Exa 搜索已返回 Android 官方文档。';
}
const llm=createServer(async(req,res)=>{try{
 if(req.url.endsWith('/models')){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'exa-live-check'}]}));return;}
 let raw='';for await(const part of req)raw+=part;const input=JSON.parse(raw);modelRequests++;assert(modelRequests<30);assert.equal(input.model,'exa-live-check');visible=new Map(input.tools.map(tool=>[tool.function.name,tool.function]));
 const last=input.messages.filter(message=>message.role==='tool').at(-1),next=scenario.next(last?parsed(last.content):undefined);let choice;
 if(next.done)choice={delta:{content:next.value},finish_reason:'stop'};
 else{assert(visible.has(next.value.name));proof.calls.push({name:next.value.name});choice={delta:{tool_calls:[{index:0,id:'exa-live-'+modelRequests,type:'function',function:{name:next.value.name,arguments:JSON.stringify(next.value.args)}}]},finish_reason:'tool_calls'};}
 res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[choice]})+'\n\ndata: [DONE]\n\n');
}catch(error){serverError=String(error);res.writeHead(500);res.end('local fixture failed');}});
await new Promise(resolve=>llm.listen(0,'127.0.0.1',resolve));const modelPort=llm.address().port,baseUrl='http://127.0.0.1:'+modelPort+'/v1';
const raw=(method,params)=>page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:'exa-live-'+(++sequence),method,params});
const call=async(method,params)=>{const response=await raw(method,params);assert(response.ok,method+': '+response.error?.code);return response.result;};
async function until(check,timeout=60000){for(const end=Date.now()+timeout;Date.now()<end;){if(serverError&&!restoring)throw Error(serverError);if(await check())return;await pause(200);}throw Error('EXA_LIVE_TIMEOUT');}
try{
 assert(!adb('forward','--list').includes('tcp:'+cdp));adb('shell','am','start','-n',app+'/app.familiar.mobile.MainActivity');
 await until(async()=>{try{const pid=adb('shell','pidof',app);if(!adb('shell','cat','/proc/net/unix').includes('webview_devtools_remote_'+pid))return false;adb('forward','tcp:'+cdp,'localabstract:webview_devtools_remote_'+pid);browser=await chromium.connectOverCDP('http://127.0.0.1:'+cdp,{timeout:1500});page=browser.contexts()[0].pages()[0];return !!page;}catch{await browser?.close().catch(()=>{});browser=page=undefined;return false;}},45000);
 await page.locator('#familiar-root[data-ready="true"]').waitFor();before=await call('snapshot.get');initial=await call('mcp.list');assert(before.runtime.running&&!before.activeReply&&!before.tasks.length&&!before.voice.state.active&&!before.voice.wake.armed);assert(before.providers.every(row=>!row.profile.keyConfigured));assert(initial.every(row=>!row.enabled&&!row.connected&&!row.hasKey));assert(!initial.some(row=>row.id===serverId));
 await writeFile(out+'/before.json',JSON.stringify({snapshot:before,servers:initial},null,2));proof.apkSha256=createHash('sha256').update(await readFile('release/android/Familiar-0.3.0-arm64-debug.apk')).digest('hex');assert.equal(adb('shell','sha256sum',adb('shell','pm','path',app).replace(/^package:/,'')).split(/\s/)[0],proof.apkSha256);
 row=await call('mcp.save',{config:{id:serverId,name:'Exa 实际连通验收',transport:'http',url:endpoint,enabled:true},revision:null});assert(!row.auth&&!row.hasKey);changed=true;
 const connected=await call('mcp.connect',{id:row.id,revision:row.revision,operationId:'exa-live-'+runId});row=(await call('mcp.list')).find(item=>item.id===serverId);assert(row.connected&&!row.hasKey&&!row.auth);assert(connected.tools.length>0);proof.tools=connected.tools;toolName=row.toolNames.find(name=>name.includes('web_search_exa'));assert(toolName);pass('真实 Android Runtime 无密钥连接官方 Exa 并读取工具目录');
 adb('reverse','tcp:'+modelPort,'tcp:'+modelPort);await call('provider.save',{kind:'compatible',baseUrl,model:'exa-live-check',clearApiKey:true});conversationId=(await call('conversation.create')).id;scenario=search();await call('message.send',{conversationId,text:'仅搜索 Android 官方前台服务文档，执行一次，不读取个人资料。'});
 const approved=new Set();await until(async()=>{const state=await call('snapshot.get');for(const task of state.tasks){if(approved.has(task.id))continue;assert(task.detail.includes(query),'Only the fixed public search may be approved');approved.add(task.id);await call('task.respond',{id:task.id,action:'approve'});approvals++;}
  const last=state.conversations.find(item=>item.id===conversationId)?.messages.at(-1);assert.notEqual(last?.status,'error');return last?.role==='assistant'&&last.status==='complete';},90000);
 assert.equal(searchCalls,1);assert.equal(serverError,undefined);assert(toolResult);proof.approvals=approvals;proof.modelRequests=modelRequests;proof.toolResultBytes=Buffer.byteLength(toolResult);proof.resultUrls=[...new Set((toolResult.match(/https?:\/\/[^\s"<>\\]+/g)??[]).map(url=>url.replace(/[),.;]+$/,'')))].slice(0,10);assert(proof.resultUrls.some(url=>url.startsWith('https://developer.android.com/')));await writeFile(out+'/search-result.txt',toolResult);pass('共享 Agent 经原参数与权限检查完成一次真实搜索并返回官方文档');
}catch(error){proof.error=String(error);console.error(error);process.exitCode=1;}
finally{
 restoring=true;try{if(changed){
  const state=await call('snapshot.get');if(state.activeReply){assert.equal(state.activeReply.conversationId,conversationId);await call('reply.cancel');}assert(!state.tasks.length);
  const current=(await call('snapshot.get')).provider;if(current.baseUrl===baseUrl&&current.model==='exa-live-check'&&!current.keyConfigured){const p=before.providers.find(row=>row.id==='compatible').profile;await call('provider.save',{kind:'compatible',baseUrl:p.baseUrl,model:p.model,clearApiKey:true});if(before.provider.kind!=='compatible')await call('provider.save',{kind:before.provider.kind,baseUrl:before.provider.baseUrl,model:before.provider.model});}
  if(before.activeConversationId)await call('conversation.select',{id:before.activeConversationId});if(conversationId)await call('conversation.delete',{id:conversationId});await raw('mcp.connect.cancel',{operationId:'exa-live-'+runId});row=(await call('mcp.list')).find(item=>item.id===serverId);if(row){await call('mcp.disconnect',{id:serverId});row=(await call('mcp.list')).find(item=>item.id===serverId);await call('mcp.remove',{id:serverId,revision:row.revision});}
  const after=await call('snapshot.get');assert.deepEqual(after.providers,before.providers);assert.equal(after.activeConversationId,before.activeConversationId);assert.deepEqual(after.conversations.map(item=>item.id),before.conversations.map(item=>item.id));assert.deepEqual(await call('mcp.list'),initial);assert(!after.activeReply&&!after.tasks.length);assert(after.runtime.running&&after.runtime.overlayVisible);proof.restored=true;pass('临时服务与会话移除，原模型/MCP/会话和常驻状态保持');
 }}catch(error){proof.restoreError=String(error);console.error('RESTORE: '+error);process.exitCode=1;}
 await browser?.close();try{if(adb('forward','--list').includes('tcp:'+cdp))adb('forward','--remove','tcp:'+cdp);if(adb('reverse','--list').includes('tcp:'+modelPort))adb('reverse','--remove','tcp:'+modelPort);}catch{}llm.closeAllConnections();await new Promise(resolve=>llm.close(resolve));adb('shell','input','keyevent','KEYCODE_HOME');if(toolResult!==undefined)await writeFile(out+'/received-tool-result.txt',toolResult);proof.searchResultsReceived=searchCalls;await writeFile(out+'/result.json',JSON.stringify(proof,null,2));
}
