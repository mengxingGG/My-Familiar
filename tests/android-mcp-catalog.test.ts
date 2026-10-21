import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {bootstrapAndroid} from '../apps/tauri/runtime/bootstrap.ts';
import {mobileApi} from '../apps/tauri/runtime/mobile-api.ts';
import {httpMcpFixture} from './fixtures/http-mcp.ts';
import type {AndroidNative} from '../plugins/platform-android/index.ts';
import type {MobileCommand} from '../packages/mobile-contracts/index.ts';
import type {PromptMessage} from '../packages/contracts/index.ts';

for (const target of ['tool_077', 'picture']) test(`Android 大型 MCP 目录 ${target}，32K 模型循环及原工具审批/图片/撤销保持`,async()=>{
 await mkdir('.artifacts',{recursive:true});const root=await mkdtemp(resolve('.artifacts/android-catalog-')),fixture=await httpMcpFixture();
 const native:AndroidNative={async call<T>(method:string){return(method==='secrets.readAll'?{}:method==='capabilities.status'?[]:method==='runtime.status'?{running:false,overlayVisible:false,engine:'ready',detail:'test'}:null) as T;}};
 const kernel=await bootstrapAndroid(root,resolve('.'),native),api=mobileApi(kernel,native);let sequence=0,step=0,ref='',schema='',maxBytes=0,imageReceived=false,continued=false,compactTarget=false,compactSchema='';
 const call=async(method:MobileCommand,params?:unknown)=>{const r=await api({protocolVersion:1,id:'catalog-'+(++sequence),method,params});assert(r.ok,JSON.stringify(r));return r.result as any;};
 const model=createServer(async(req,res)=>{
  if(req.url?.endsWith('/models')){res.end(JSON.stringify({data:[{id:'catalog-model',context_length:32768}]}));return;}
  let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);maxBytes=Math.max(maxBytes,Buffer.byteLength(JSON.stringify(input.tools)));
  const previous=input.messages.filter((m:any)=>m.role==='tool').at(-1),previousName=input.messages.filter((m:any)=>m.role==='assistant'&&m.tool_calls?.length).at(-1)?.tool_calls.at(-1).function.name;let name='',args:unknown;
  if(step++===0){name='mcp_tools_search';args={server:'large',query:target};}
  else if(previousName==='mcp_tools_search'){ref=JSON.parse(previous.content).tools[0].ref;name='mcp_tool_schema';args={ref};}
  else if(previousName==='mcp_tool_schema'){const part=JSON.parse(previous.content);schema+=part.schema;if(part.nextOffset!==null){name='mcp_tool_schema';args={ref,offset:part.nextOffset};}else{if(input.tools.some((t:any)=>t.function.name==='mcp_tool_invoke')){name='mcp_tool_invoke';args={ref,arguments:{text:'catalog-approved'}};}else{compactTarget=true;name='familiar_tools_search';args={query:target};}}}
  else if(previousName==='mcp_tool_invoke'&&target==='picture'){
   assert.deepEqual(input.tools.map((t:any)=>t.function.name),['familiar_tools_search','familiar_tool_schema','familiar_tool_invoke']);
   imageReceived=JSON.stringify(input.messages).includes('data:image/png;base64,');name='familiar_tools_search';args={query:'catalog_followup'};
  }else if(previousName==='familiar_tools_search'){name='familiar_tool_schema';args={ref:JSON.parse(previous.content).tools[0].ref};}
  else if(previousName==='familiar_tool_schema'){const part=JSON.parse(previous.content);compactSchema+=part.schema;if(part.nextOffset!==null){name='familiar_tool_schema';args={ref:part.ref,offset:part.nextOffset};}else{assert.equal(JSON.parse(compactSchema).type,'object');compactSchema='';name='familiar_tool_invoke';args={ref:part.ref,arguments:compactTarget?{text:'catalog-approved'}:{}};}}
  else if(previousName==='familiar_tool_invoke'){if(compactTarget){compactTarget=false;if(target==='picture'){assert.deepEqual(input.tools.map((t:any)=>t.function.name),['familiar_tools_search','familiar_tool_schema','familiar_tool_invoke']);imageReceived=JSON.stringify(input.messages).includes('data:image/png;base64,');name='familiar_tools_search';args={query:'catalog_followup'};}}else assert.equal(previous.content,'continued');}
  // 新日历目录降低常驻定义开销；显式加入会话负载，继续验证图片之后的预算降级。
  const padding=target==='picture'&&step===1?'上下文预算夹具。'.repeat(250):'';
  if(name)assert(input.tools.some((tool:any)=>tool.function.name===name),`模型只能调用本轮公开工具：${name}`);
  const choice=name?{delta:{...(padding?{content:padding}:{}),tool_calls:[{index:0,id:'catalog-step-'+step,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}:{delta:{content:'目录工具调用完成。'},finish_reason:'stop'};
  res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[choice]})}\n\ndata: [DONE]\n\n`);
 });await new Promise<void>(r=>model.listen(0,'127.0.0.1',r));
 const tools=kernel.resolve('agent.tools'),approvals=kernel.resolve('agent.approvals'),manager=kernel.resolve('mcp.manager');
 tools.register({name:'catalog_followup',description:'图片后的连续任务',category:'read',parameters:{type:'object',properties:{},additionalProperties:false},async execute(){continued=true;return 'continued';}});
 const run=async(name:string,args:unknown)=>JSON.parse(await tools.run({id:'lookup-'+(++sequence),name,arguments:JSON.stringify(args)},new AbortController().signal));
 try{
  const base=Buffer.byteLength(JSON.stringify(tools.list()));
  let row=await call('mcp.save',{config:{id:'large',name:'大目录',transport:'http',url:fixture.url+'/large',enabled:true},revision:null});
  assert.equal((await call('mcp.connect',{id:row.id,revision:row.revision,operationId:'connect-large'})).tools.length,80);
  assert(fixture.state.catalogBytes>32768);assert.equal((await manager.list()).find(s=>s.id==='large')!.tools,80);
  assert.equal(tools.list().filter(t=>t.name.startsWith('mcp_large_')).length,0);assert(Buffer.byteLength(JSON.stringify(tools.list()))<base+4000);
  await call('provider.save',{kind:'compatible',baseUrl:`http://127.0.0.1:${(model.address() as {port:number}).port}/v1`,model:'catalog-model'});
  const conversation=(await call('conversation.create')).id;await call('message.send',{conversationId:conversation,text:'调用大目录中的 tool_077 工具完成测试。'});
  let approved=false;
  for(let i=0;i<250;i++){
   const pending=approvals.list();if(pending.length){assert(!approved);assert.equal(fixture.state.calls.length,0);assert(pending[0].title.includes(target));await approvals.decide(pending[0].id,true,'once');approved=true;}
   const s=await call('snapshot.get');if(!s.activeReply&&!kernel.resolve('conversation').state().busy)break;await new Promise(r=>setTimeout(r,10));
  }
  const s=await call('snapshot.get');assert(!s.activeReply);assert(approved,JSON.stringify({step,last:s.conversations.find((c:any)=>c.id===conversation).messages.at(-1)}));assert(s.conversations.find((c:any)=>c.id===conversation).messages.at(-1).text.endsWith('目录工具调用完成。'),kernel.resolve('conversation').state().error);assert.equal(continued,target==='picture');
  assert.equal(JSON.parse(schema).properties.text.maxLength,200);assert.deepEqual(fixture.state.calls,[{name:target,text:'catalog-approved'}]);assert(maxBytes<20000,`工具目录体积 ${maxBytes} 超过 20000 字节`);assert.equal(imageReceived,target==='picture');
  const saved=await kernel.resolve('storage.local').read<{messages:{trace?:PromptMessage[]}[]}>('conversation',{messages:[]});
  const stored={trace:saved.messages.flatMap(message=>message.trace??[])};
  assert(stored.trace?.some(m=>m.toolName==='mcp_tool_schema'&&JSON.parse(m.content).schema===schema),JSON.stringify({message:'完整参数页保留在持久化记录中',schema:schema.length,traces:stored.trace.map(m=>({name:m.toolName,length:m.content.length,attachments:m.attachments?.length}))}));
  if(target==='picture')assert(stored.trace?.some(m=>['mcp_tool_invoke','familiar_tool_invoke'].includes(m.toolName ?? '')&&m.attachments?.length===1));
  const matches=await run('mcp_tools_search',{server:'large'});assert.equal(matches.tools.length,6);assert.equal(matches.nextOffset,6);
  const picture=await run('mcp_tools_search',{server:'large',query:'picture'}),echo=await run('mcp_tools_search',{server:'large',query:'echo'});
  tools.compactList!();
  const compactPicture=(await run('familiar_tools_search',{query:'HTTP fixture picture'})).tools[0];
  const key=(name:string,ref:string)=>tools.denialKey!({id:'key',name,arguments:JSON.stringify({ref})});
  assert.equal(key('familiar_tool_invoke',compactPicture.ref),key('mcp_tool_invoke',picture.tools[0].ref));
  assert.notEqual(tools.denialKey!({id:'a',name:'mcp_tool_invoke',arguments:JSON.stringify({ref:picture.tools[0].ref})}),tools.denialKey!({id:'b',name:'mcp_tool_invoke',arguments:JSON.stringify({ref:echo.tools[0].ref})}));
  await assert.rejects(run('mcp_tool_invoke',{ref:ref,arguments:{unexpected:true}}),/参数/);assert.equal(approvals.list().length,0);
  const image=tools.runRich!({id:'picture',name:'mcp_tool_invoke',arguments:JSON.stringify({ref:picture.tools[0].ref,arguments:{text:'image'}})},new AbortController().signal);
  while(!approvals.list().length)await new Promise(r=>setTimeout(r,5));await approvals.decide(approvals.list()[0].id,true,'once');assert.equal((await image).attachments?.length,1);
  const other=await call('mcp.save',{config:{id:'other',name:'另一目录',transport:'http',url:fixture.url+'/large',enabled:true},revision:null});await call('mcp.connect',{id:other.id,revision:other.revision,operationId:'connect-other'});
  assert.equal(tools.list().filter(t=>['mcp_tools_search','mcp_tool_schema','mcp_tool_invoke'].includes(t.name)).length,3);
  await call('mcp.disconnect',{id:'large'});await assert.rejects(run('mcp_tool_schema',{ref}),/失效/);assert.equal((await run('mcp_tools_search',{server:'other'})).total,80);
  await call('mcp.connect',{id:row.id,revision:row.revision,operationId:'reconnect-large'});
  await assert.rejects(run('familiar_tool_invoke',{ref:compactPicture.ref,arguments:{text:'stale'}}),/连接已变化/);assert.equal(approvals.list().length,0);
  await call('mcp.disconnect',{id:'large'});
  await call('mcp.disconnect',{id:'other'});assert(!tools.list().some(t=>t.name==='mcp_tool_invoke'));
 }finally{await kernel.dispose();await fixture.close();model.closeAllConnections();await new Promise<void>(r=>model.close(()=>r()));await rm(root,{recursive:true,force:true});}
});
