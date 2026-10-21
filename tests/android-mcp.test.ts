import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {bootstrapAndroid} from '../apps/tauri/runtime/bootstrap.ts';
import {mobileApi} from '../apps/tauri/runtime/mobile-api.ts';
import {httpMcpFixture} from './fixtures/http-mcp.ts';
import {projectMcpResult} from '../packages/mobile-bridge/mcp.ts';
import {mcpCredentialScope} from '../plugins/mcp-client/index.ts';
import type {MobileCommand,MobileMcpServer} from '../packages/mobile-contracts/index.ts';
import type {AndroidNative} from '../plugins/platform-android/index.ts';

test('Android HTTP MCP 真实握手/鉴权/审批/媒体，配置隔离、取消与重启恢复',async()=>{
 await mkdir('.artifacts',{recursive:true});const root=await mkdtemp(resolve('.artifacts/android-mcp-')),fixture=await httpMcpFixture();const keys=new Map<string,string>();
 const native:AndroidNative={async call<T>(method:string,p:Record<string,unknown>={}){let value:unknown=null;if(method==='secrets.readAll')value=Object.fromEntries(keys);if(method==='secrets.write'){if(p.value)keys.set(String(p.name),String(p.value));else keys.delete(String(p.name));}if(method==='capabilities.status')value=[];if(method==='runtime.status')value={running:false,overlayVisible:false,engine:'ready',detail:'test'};return value as T;}};
 let kernel=await bootstrapAndroid(root,resolve('.'),native),api=mobileApi(kernel,native),seq=0;
 const request=(method:MobileCommand,params?:unknown)=>api({protocolVersion:1,id:'mcp-test-'+(++seq),method,params});
 const call=async(method:MobileCommand,params?:unknown)=>{const r=await request(method,params);assert(r.ok,JSON.stringify(r));return r.result as any;};
 const wait=async(fn:()=>boolean|Promise<boolean>)=>{for(let i=0;i<150;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Fixture timed out');};
 try{
  const initial=await call('mcp.list');assert.deepEqual(initial.map((s:MobileMcpServer)=>s.id).sort(),['amap','exa']);assert(initial.every((s:MobileMcpServer)=>!s.enabled));
  let row:MobileMcpServer=await call('mcp.save',{config:{id:'fixture',name:'隔离服务',transport:'http',url:fixture.url+'/mcp',enabled:true,auth:{kind:'header',name:'x-fixture-key'}},revision:null,apiKey:'isolated-mcp-key'});
  assert(row.hasKey);assert(!JSON.stringify(await call('mcp.list')).includes('isolated-mcp-key'));
  assert.deepEqual((await call('mcp.connect',{id:row.id,revision:row.revision,operationId:'connect-one'})).tools,['echo','picture']);assert(fixture.state.requests.every(r=>r.authenticated));
  const tools=kernel.resolve('agent.tools'),approvals=kernel.resolve('agent.approvals');const entries=()=>tools.list().filter(t=>t.name.startsWith('mcp_fixture_'));
  assert.equal(entries().length,2);const echo=entries().find(t=>t.description.includes('echo'))!.name;const run=()=>tools.run({id:'tool-test',name:echo,arguments:'{"text":"approved"}'},new AbortController().signal);
  const denied=assert.rejects(run(),/拒绝/);await wait(()=>approvals.list().length>0);assert.equal(fixture.state.calls.length,0);await approvals.decide(approvals.list()[0].id,false,'once');await denied;
  const approved=run();await wait(()=>approvals.list().length>0);await approvals.decide(approvals.list()[0].id,true,'once');assert.match(await approved,/echo:approved/);assert.equal(fixture.state.calls.length,1);
  const picture=tools.runRich!({id:'image',name:entries().find(t=>t.description.includes('picture'))!.name,arguments:'{"text":"image"}'},new AbortController().signal);await wait(()=>approvals.list().length>0);await approvals.decide(approvals.list()[0].id,true,'once');assert.equal((await picture).attachments?.length,1);
  const oldPending=assert.rejects(run(),/连接已变化/);await wait(()=>approvals.list().length>0);
  const beforeChange=fixture.state.calls.length;const oldRevision=row.revision;
  row=await call('mcp.save',{config:{...row,url:fixture.url+'/other'},revision:row.revision});assert(!row.hasKey);assert.equal(entries().length,0);await approvals.decide(approvals.list()[0].id,true,'once');await oldPending;assert.equal(fixture.state.calls.length,beforeChange);
  assert.equal((await request('mcp.save',{config:row,revision:oldRevision})).error?.code,'CONFLICT');
  for(const config of [{...row,transport:'stdio',command:'node',args:[]},{...row,url:'https://example.test/?key=secret'},{...row,url:'http://example.test/mcp'}])assert.equal((await request('mcp.save',{config,revision:row.revision})).error?.code,'INVALID_INPUT');
  row=await call('mcp.save',{config:{...row,url:fixture.url+'/slow'},revision:row.revision});
  const pending=request('mcp.connect',{id:row.id,revision:row.revision,operationId:'slow-one'});await wait(()=>fixture.state.slowStarted>0);await Promise.race([call('snapshot.get'),new Promise((_,j)=>setTimeout(()=>j(Error('Snapshot blocked by connect')),1000))]);await call('mcp.connect.cancel',{operationId:'slow-one'});assert.equal((await pending).error?.code,'CANCELLED');assert.equal(entries().length,0);
  row=await call('mcp.save',{config:{...row,url:fixture.url+'/duplicate'},revision:row.revision});assert.equal((await request('mcp.connect',{id:row.id,revision:row.revision,operationId:'duplicate'})).error?.code,'PROVIDER');assert.equal(entries().length,0);
  row=await call('mcp.save',{config:{...row,url:fixture.url+'/mcp',auth:{kind:'query',name:'credential'}},revision:row.revision,apiKey:'isolated-mcp-key'});
  await call('mcp.connect',{id:row.id,revision:row.revision,operationId:'query-key'});assert(fixture.state.requests.filter(r=>r.path==='/mcp').every(r=>r.authenticated));
  await kernel.dispose();kernel=await bootstrapAndroid(root,resolve('.'),native);api=mobileApi(kernel,native);await wait(async()=>((await call('mcp.list')) as MobileMcpServer[]).some(s=>s.id==='fixture'&&s.connected));
  row=(await call('mcp.list')).find((s:MobileMcpServer)=>s.id==='fixture');assert(row.hasKey);await call('mcp.disconnect',{id:row.id});assert(!(await call('mcp.list')).find((s:MobileMcpServer)=>s.id===row.id).connected);
  const enable=kernel.resolve('agent.tools').run({id:'enable-old',name:'mcp_enable',arguments:'{"id":"fixture"}'},new AbortController().signal);
  const staleEnable=assert.rejects(enable,/CONFLICT/);const currentApprovals=kernel.resolve('agent.approvals');await wait(()=>currentApprovals.list().length>0);
  row=await call('mcp.save',{config:{...row,name:'新的服务设置'},revision:row.revision});await currentApprovals.decide(currentApprovals.list()[0].id,true,'once');await staleEnable;
  assert.equal((await call('mcp.list')).find((s:MobileMcpServer)=>s.id===row.id).name,'新的服务设置');
  const scope=mcpCredentialScope(row);assert(keys.has(scope));await call('mcp.remove',{id:row.id,revision:row.revision});assert(!(await call('mcp.list')).some((s:MobileMcpServer)=>s.id===row.id));assert(!keys.has(scope));
 }finally{await kernel.dispose();await fixture.close();assert(root.startsWith(resolve('.artifacts')+requireSeparator()));await rm(root,{recursive:true,force:true});}
});
function requireSeparator(){return process.platform==='win32'?'\\':'/';}

test('MCP 移动响应只投影公开配置，拒绝凭据 URL 和错误工具列表',()=>{
 const row={id:'test',name:'test',transport:'http',url:'https://example.test/mcp',enabled:false,revision:'a'.repeat(64),hasKey:true,connected:false,tools:0,toolNames:[],apiKey:'must-not-leak',hostPath:'/private',auth:{kind:'header',name:'Authorization',prefix:'Bearer ',key:'must-not-leak'}};
 assert(!JSON.stringify(projectMcpResult('mcp.list',[row])).includes('must-not-leak'));
 assert.throws(()=>projectMcpResult('mcp.list',[{...row,url:'https://example.test/?key=secret'}]));
 assert.throws(()=>projectMcpResult('mcp.connect',{tools:[null]}));
});
