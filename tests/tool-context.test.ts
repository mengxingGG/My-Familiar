import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {compactToolHistory} from '../plugins/agent-runner/tool-context.ts';
import {bootstrapAndroid} from '../apps/tauri/runtime/bootstrap.ts';
import {mobileApi} from '../apps/tauri/runtime/mobile-api.ts';
import type {PromptMessage} from '../packages/contracts/index.ts';
import type {AndroidNative} from '../plugins/platform-android/index.ts';
import type {MobileCommand} from '../packages/mobile-contracts/index.ts';

const group=():PromptMessage[]=>[
 {role:'assistant',content:'先执行一次。',calls:[{id:'done',name:'write_fixture',arguments:JSON.stringify({body:'中'.repeat(11000)})}],native:{scope:'signed',items:[{private:'不得进入回查原文'}]}},
 {role:'tool',toolCallId:'done',toolName:'write_fixture',content:JSON.stringify({outcome:'unknown',error:'执行中断，不要重放。',body:'😀'.repeat(20000)})},
];
const reference={id:'context-012345678901234567890123-11111111-1111-1111-1111-111111111111',totalCharacters:80000,sha256:'a'.repeat(64)};

test('仅归档完整无图片轮次，保留结果未知提示与原参数、原生签名，不重放',async()=>{
 const source=group(),before=structuredClone(source),cache=new WeakMap(),archived:PromptMessage[][]=[];
 const options={cache,signal:new AbortController().signal,archive:async(m:PromptMessage[])=>{archived.push(structuredClone(m));return reference;},fits:async()=>true};
 const result=await compactToolHistory(source,source,options);
 assert.deepEqual(source,before);assert.deepEqual(archived,[before]);assert(!result.some(m=>m.calls||m.native||m.toolCallId));
 const notice=JSON.parse(result[1].content);assert.equal(notice.checkpoint,reference.id);assert.equal(notice.records[0].resultComplete,false);assert.match(notice.records[0].resultExcerpt,/unknown/);assert.match(notice.notice,/不要自动重试/);
 await compactToolHistory(source,source,options);assert.equal(archived.length,1);
 for(const input of [source.slice(0,1),[source[0],{...source[1],toolCallId:'wrong'}],[source[0],{...source[1],toolName:'wrong'}],[source[0],{...source[1],images:[{} as any]}],[source[0],{...source[1],attachments:[{} as any]}]]){
  assert.deepEqual(await compactToolHistory(input,input,options),input);
 }
 assert.equal(archived.length,1);
});

test('归档写入失败或取消不替换执行记录，不合并未完成的批量调用',async()=>{
 const source=group(),before=structuredClone(source),abort=new AbortController();let calls=0;
 await assert.rejects(compactToolHistory(source,source,{cache:new WeakMap(),signal:abort.signal,archive:async()=>{calls++;throw Error('disk full');},fits:async()=>true}),/disk full/);
 assert.deepEqual(source,before);assert.equal(calls,1);
 await assert.rejects(compactToolHistory(source,source,{cache:new WeakMap(),signal:abort.signal,archive:async()=>{abort.abort();return reference;},fits:async()=>true}));assert.deepEqual(source,before);
 const batch=group();batch[0].calls!.push({id:'pending',name:'next',arguments:'{}'});let archived=false;
 assert.deepEqual(await compactToolHistory(batch,batch,{cache:new WeakMap(),signal:new AbortController().signal,archive:async()=>{archived=true;return reference;},fits:async()=>true}),batch);assert(!archived);
});

test('32K Android 共享 Agent 归档长中文参数和完整结果，目录回查尾部后续答且只执行一次',{timeout:90000},async()=>{
 await mkdir('.artifacts',{recursive:true});const root=await mkdtemp(resolve('.artifacts/tool-context-')),keys=new Map<string,string>();
 const native:AndroidNative={async call<T>(method:string,p:Record<string,unknown>={}){return(method==='secrets.readAll'?Object.fromEntries(keys):method==='secrets.write'?(p.value?keys.set(String(p.name),String(p.value)):keys.delete(String(p.name)),null):method==='capabilities.status'?[]:method==='runtime.status'?{running:false,overlayVisible:false,engine:'ready',detail:'test'}:null) as T;}};
 const payload='中'.repeat(11000)+'ARG_END_MARKER',output='原始结果😀'.repeat(9000)+'RESULT_END_MARKER';
 let step=0,executed=0,approved=0,checkpoint='',ref='',modelError:unknown;const requests:any[]=[];
 const server=createServer(async(req,res)=>{try{
  if(req.url?.endsWith('/models')){res.end(JSON.stringify({data:[{id:'archive-fixture',context_length:32768}]}));return;}
  let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);requests.push(body);
  assert(Buffer.byteLength(JSON.stringify(body.messages))+Buffer.byteLength(JSON.stringify(body.tools))<28416);
  let name:string,args:unknown;
  if(step===0){name='large_write_fixture';args={body:payload};}
  else if(step===1){
   assert(!body.messages.some((m:any)=>m.tool_calls?.some((c:any)=>c.function.name==='large_write_fixture')));
   const record=body.messages.map((m:any)=>{try{return JSON.parse(m.content);}catch{return null;}}).find((m:any)=>m?.kind==='familiar.archived-tool-turn');assert(record);checkpoint=record.checkpoint;
   assert.deepEqual(body.tools.map((t:any)=>t.function.name),['familiar_tools_search','familiar_tool_schema','familiar_tool_invoke']);name='familiar_tools_search';args={query:'context_read'};
  }else if(step===2){ref=JSON.parse(body.messages.at(-1).content).tools.find((t:any)=>t.name==='context_read').ref;name='familiar_tool_schema';args={ref};}
  else if(step===3){assert(JSON.parse(JSON.parse(body.messages.at(-1).content).schema).properties.limit);name='familiar_tool_invoke';args={ref,arguments:{checkpoint,query:'RESULT_END_MARKER',limit:1000}};}
  else if(step===4){assert(JSON.parse(body.messages.at(-1).content).text.includes('RESULT_END_MARKER'));name='familiar_tool_invoke';args={ref,arguments:{checkpoint,query:'ARG_END_MARKER',limit:1000}};}
  else{assert.equal(step,5);assert(JSON.parse(body.messages.at(-1).content).text.includes('ARG_END_MARKER'));res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content:'完整参数与结果尾部已核对。'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);step++;return;}
  step++;res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'archive-step-'+step,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);
 }catch(error){modelError=error;res.end('data: [DONE]\n\n');}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));let kernel=await bootstrapAndroid(root,resolve('.'),native),api=mobileApi(kernel,native),seq=0;
 const call=async(method:MobileCommand,params?:unknown)=>{const r=await api({protocolVersion:1,id:'archive-test-'+(++seq),method,params});assert(r.ok,JSON.stringify(r));return r.result as any;};
 try{
  kernel.resolve('agent.tools').register({name:'large_write_fixture',description:'大型办公调用夹具',category:'outsideWrite',parameters:{type:'object',properties:{body:{type:'string'}},required:['body'],additionalProperties:false},async execute({body}){assert.equal(body,payload);executed++;return output;}});
  await call('provider.save',{kind:'compatible',baseUrl:`http://127.0.0.1:${(server.address() as any).port}/v1`,model:'archive-fixture'});
  const conversation=(await call('conversation.create')).id;await call('message.send',{conversationId:conversation,text:'执行一次，回查参数和结果尾部。'});
  for(let i=0;i<3000;i++){if(modelError)throw modelError;const tasks=kernel.resolve('agent.approvals').list();for(const t of tasks){approved++;await kernel.resolve('agent.approvals').decide(t.id,true,'once');}if(!kernel.resolve('conversation').state().busy)break;await new Promise(r=>setTimeout(r,10));}
  if(modelError)throw modelError;const state=kernel.resolve('conversation').state();assert(!state.busy);assert.equal(state.error,undefined);assert.equal(state.messages.at(-1)?.text,'完整参数与结果尾部已核对。');assert.equal(step,6);assert.equal(executed,1);assert.equal(approved,1);
  const saved=await kernel.resolve('storage.local').read<any>('conversation',null),trace=saved.messages.at(-1).trace as PromptMessage[];
  assert.equal(JSON.parse(trace.find(m=>m.calls?.[0].name==='large_write_fixture')!.calls![0].arguments).body,payload);assert.equal(trace.find(m=>m.toolName==='large_write_fixture')!.content,output);assert(output.length>32000);
  const compaction=kernel.resolve('context.compaction');let raw='',offset=0;for(;;){const part=await compaction.read(checkpoint,offset,'',2000);assert(!/[\uD800-\uDBFF]$/.test(part.text));raw+=part.text;if(part.nextOffset===null)break;offset=part.nextOffset;}
  const originals=raw.split('\n').map(line=>JSON.parse(line));assert.equal(originals[1].content,output);assert.equal(JSON.parse(originals[0].calls[0].arguments).body,payload);
  const summary=requests[1].messages.map((m:any)=>{try{return JSON.parse(m.content);}catch{return null;}}).find((m:any)=>m?.kind==='familiar.archived-tool-turn');assert.equal(createHash('sha256').update(raw).digest('hex'),summary.sha256);
  await kernel.dispose();kernel=await bootstrapAndroid(root,resolve('.'),native);api=mobileApi(kernel,native);assert.equal((await kernel.resolve('context.compaction').read(checkpoint)).totalCharacters,raw.length);
  await call('conversation.delete',{id:conversation});await assert.rejects(kernel.resolve('context.compaction').read(checkpoint),/不存在/);
 }finally{await kernel.dispose();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
});
