import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {bootstrapAndroid} from '../apps/tauri/runtime/bootstrap.ts';
import {mobileApi} from '../apps/tauri/runtime/mobile-api.ts';
import {githubConfig} from '../plugins/github-integration/config.ts';
import {mcpCredentialScope} from '../plugins/mcp-client/index.ts';
import type {AndroidNative} from '../plugins/platform-android/index.ts';
import type {MobileCommand,MobileMcpServer} from '../packages/mobile-contracts/index.ts';

test('Android GitHub 官方 Token 接入、模式切换、逐项写审批及清除恢复',async()=>{
 await mkdir('.artifacts',{recursive:true});const root=await mkdtemp(resolve('.artifacts/android-github-')),keys=new Map<string,string>();
 const native:AndroidNative={async call<T>(method:string,p:Record<string,unknown>={}){let value:unknown=null;if(method==='secrets.readAll')value=Object.fromEntries(keys);if(method==='secrets.write'){if(p.value)keys.set(String(p.name),String(p.value));else keys.delete(String(p.name));}if(method==='capabilities.status')value=[];if(method==='runtime.status')value={running:false,overlayVisible:false,engine:'ready',detail:'test'};return value as T;}};
 let kernel=await bootstrapAndroid(root,resolve('.'),native),api=mobileApi(kernel,native),seq=0;
 const request=(method:MobileCommand,params?:unknown)=>api({protocolVersion:1,id:'github-test-'+(++seq),method,params});
 const call=async(method:MobileCommand,params?:unknown)=>{const r=await request(method,params);assert(r.ok,JSON.stringify(r));return r.result as any;};
 const wait=async(fn:()=>boolean)=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Approval missing');};
 const originalFetch=globalThis.fetch,requests:string[]=[],writes:string[]=[];
 // 不向 GitHub 发送夹具凭据；完整走共享 MCP 客户端和工具注册。
 globalThis.fetch=async(input,init)=>{
  const req=new Request(input,init);assert([githubConfig(true).url,githubConfig(false).url].includes(req.url));
  assert.equal(req.headers.get('Authorization'),'Bearer fixture-github-token');requests.push(req.url);
  if(req.method!=='POST')return new Response(null,{status:405});const rpc=JSON.parse(await req.text());
  if(rpc.id===undefined)return new Response(null,{status:202});let result:unknown={};
  if(rpc.method==='initialize')result={protocolVersion:rpc.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'github-fixture',version:'1'}};
  if(rpc.method==='tools/list')result={tools:['get_me','issue_write','create_ssh_key'].map(name=>({name,inputSchema:{type:'object'},annotations:{readOnlyHint:true}}))};
  if(rpc.method==='tools/call'){writes.push(rpc.params.name);result={content:[{type:'text',text:'fixture success'}]};}
  return new Response(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}),{headers:{'Content-Type':'application/json'}});
 };
 try{
  let row:MobileMcpServer=await call('mcp.github.save',{enabled:false,readOnly:true,revision:null});assert(!row.hasKey);assert.equal(requests.length,0);
  assert.equal((await request('mcp.github.save',{enabled:true,readOnly:true,revision:row.revision})).error?.code,'INVALID_INPUT');
  assert.equal((await request('mcp.github.save',{enabled:false,readOnly:true,revision:row.revision,url:'https://evil.invalid'})).error?.code,'INVALID_INPUT');
  row=await call('mcp.github.save',{enabled:true,readOnly:true,revision:row.revision,apiKey:'fixture-github-token'});
  assert.deepEqual((await call('mcp.connect',{id:row.id,revision:row.revision,operationId:'readonly'})).tools,['get_me']);
  const ro=mcpCredentialScope(githubConfig(true)),rw=mcpCredentialScope(githubConfig(false));assert(keys.has(ro));
  const revision=row.revision;row=await call('mcp.github.save',{enabled:true,readOnly:false,revision});assert(row.hasKey&&!row.connected);assert(!keys.has(ro));assert.equal(keys.get(rw),'fixture-github-token');
  assert.equal((await request('mcp.github.save',{enabled:true,readOnly:true,revision,apiKey:'stale'})).error?.code,'CONFLICT');assert.equal(keys.get(rw),'fixture-github-token');
  assert.deepEqual((await call('mcp.connect',{id:row.id,revision:row.revision,operationId:'write-mode'})).tools,['get_me','issue_write']);
  const tools=kernel.resolve('agent.tools'),approvals=kernel.resolve('agent.approvals');
  const name=tools.list().find(t=>t.description.includes('issue_write'))!.name;
  const run=()=>tools.run({id:'write-'+(++seq),name,arguments:'{"title":"fixture"}'},new AbortController().signal);
  const denied=assert.rejects(run(),/拒绝/);await wait(()=>approvals.list().length>0);assert.equal(writes.length,0);await approvals.decide(approvals.list()[0].id,false,'once');await denied;
  const approved=run();await wait(()=>approvals.list().length>0);assert.equal(writes.length,0);await approvals.decide(approvals.list()[0].id,true,'once');assert.match(await approved,/fixture success/);assert.deepEqual(writes,['issue_write']);
  const stale=assert.rejects(run(),/连接已变化/);await wait(()=>approvals.list().length>0);
  row=await call('mcp.github.save',{enabled:true,readOnly:true,revision:row.revision});await approvals.decide(approvals.list()[0].id,true,'once');await stale;assert.equal(writes.length,1);assert(!keys.has(rw));assert(keys.has(ro));
  assert(!JSON.stringify(await call('mcp.list')).includes('fixture-github-token'));
  row=await call('mcp.github.save',{enabled:true,readOnly:true,revision:row.revision,clearApiKey:true});assert(!row.enabled&&!row.hasKey&&!row.connected);assert(!keys.has(ro)&&!keys.has(rw));
  await kernel.dispose();kernel=await bootstrapAndroid(root,resolve('.'),native);api=mobileApi(kernel,native);
  row=(await call('mcp.list')).find((s:MobileMcpServer)=>s.id==='github');assert(!row.hasKey&&!row.enabled);
  const saves=await Promise.all([false,true].map(readOnly=>request('mcp.github.save',{enabled:false,readOnly,revision:row.revision,apiKey:'race'})));assert.equal(saves.filter(r=>r.ok).length,1);assert.equal(saves.filter(r=>r.error?.code==='CONFLICT').length,1);
  row=(await call('mcp.list')).find((s:MobileMcpServer)=>s.id==='github');await call('mcp.remove',{id:row.id,revision:row.revision});assert(!keys.has(ro)&&!keys.has(rw));
  row=await call('mcp.save',{config:{...githubConfig(true),url:'https://foreign.invalid/mcp'},revision:null,apiKey:'foreign-key'});
  assert.equal((await request('mcp.github.save',{enabled:false,readOnly:true,revision:row.revision})).error?.code,'INVALID_INPUT');assert(!keys.has(ro)&&!keys.has(rw));assert.equal(keys.get(mcpCredentialScope(row)),'foreign-key');
 }finally{await kernel.dispose();globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true});}
});
