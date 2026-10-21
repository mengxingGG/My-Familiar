import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {bootstrapAndroid} from '../apps/tauri/runtime/bootstrap.ts';
import {mobileApi} from '../apps/tauri/runtime/mobile-api.ts';
import {githubDeviceScope,isGithubDeviceCredential} from '../plugins/github-integration/device-auth.ts';
import {githubConfig} from '../plugins/github-integration/config.ts';
import {mcpCredentialScope} from '../plugins/mcp-client/index.ts';
import {projectGithubAuth} from '../packages/mobile-bridge/github.ts';
import type {AndroidNative} from '../plugins/platform-android/index.ts';
import type {MobileCommand} from '../packages/mobile-contracts/index.ts';

const pause=(ms=5)=>new Promise(r=>setTimeout(r,ms));
const until=async(check:()=>unknown|Promise<unknown>)=>{for(let i=0;i<400;i++){if(await check())return;await pause();}throw Error('GitHub fixture condition deadline');};
const token=(n=1)=>({access_token:'gho_fixture_access_'+n,refresh_token:'ghr_fixture_refresh_'+n,expires_in:80,refresh_token_expires_in:10000,token_type:'bearer',scope:'repo,read:org,gist'});
async function fixture(seed:{clientFile?:string;keys?:[string,string][]}={}){
 await mkdir('.artifacts',{recursive:true});const root=await mkdtemp(resolve('.artifacts/github-auth-'));assert(root.startsWith(resolve('.artifacts')+sep));
 if(seed.clientFile!==undefined){await mkdir(join(root,'data'),{recursive:true});await writeFile(join(root,'data/github-oauth-client.json'),seed.clientFile,{mode:0o600});}
 const keys=new Map<string,string>(seed.keys),calls:{url:string;body:URLSearchParams;headers:Headers}[]=[],opened:any[]=[],waits:{ms:number;go():void}[]=[];let time=1000000,polls:any[]=[token()],refresh:any=token(2),holdWrite:Promise<void>|undefined,holdClear:Promise<void>|undefined;
 const native:AndroidNative={async call<T>(method:string,p:Record<string,unknown>={}){let value:unknown=null;if(method==='secrets.readAll')value=Object.fromEntries(keys);if(method==='secrets.write'){if(p.name===githubDeviceScope){if(p.value&&holdWrite)await holdWrite;if(!p.value&&holdClear)await holdClear;}if(p.value)keys.set(String(p.name),String(p.value));else keys.delete(String(p.name));}if(method==='github.auth.open')opened.push(p);if(method==='capabilities.status')value=[];if(method==='runtime.status')value={running:true,overlayVisible:true,engine:'ready',detail:'fixture'};return value as T;}};
 const fetcher:typeof fetch=async(input,init)=>{
  const request=new Request(input,init),body=new URLSearchParams(await request.text());calls.push({url:request.url,body,headers:request.headers});assert.equal(request.redirect,'error');assert(!body.has('client_secret'));
  let result:any;
  if(request.url==='https://github.com/login/device/code')result={device_code:'private-device-code',user_code:'ABCD-EFGH',verification_uri:'https://github.com/login/device',expires_in:900,interval:5};
  else if(request.url==='https://github.com/login/oauth/access_token'){result=body.get('grant_type')==='refresh_token'?await refresh:polls.shift()??{error:'authorization_pending'};if(result instanceof Error)throw result;}
  else if(request.url==='https://api.github.com/user'){assert.match(request.headers.get('Authorization')!,/^Bearer gho_fixture_access_/);result={id:42,login:'familiar-fixture'};}
  else throw Error('Unexpected external OAuth endpoint '+request.url);
  return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json'}});
 };
 const options={githubAuth:{fetcher,now:()=>time,wait:(ms:number,signal:AbortSignal)=>new Promise<void>((resolveWait,reject)=>{
  const item={ms,go(){time+=ms;signal.removeEventListener('abort',abort);waits.splice(waits.indexOf(item),1);resolveWait();}},abort=()=>{const at=waits.indexOf(item);if(at>=0)waits.splice(at,1);reject(signal.reason);};if(signal.aborted){reject(signal.reason);return;}waits.push(item);signal.addEventListener('abort',abort,{once:true});
 })}};
 let kernel:Awaited<ReturnType<typeof bootstrapAndroid>>;try{kernel=await bootstrapAndroid(root,resolve('.'),native,options);}catch(error){await rm(root,{recursive:true,force:true});throw error;}
 let api=mobileApi(kernel,native),seq=0;
 const raw=(method:MobileCommand,params?:unknown)=>api({protocolVersion:1,id:'github-auth-'+(++seq),method,params});
 const call=async(method:MobileCommand,params?:unknown)=>{const r=await raw(method,params);assert(r.ok,JSON.stringify(r));return r.result as any;};
 const status=()=>call('github.auth.status');
 return {root,keys,calls,opened,waits,raw,call,status,get kernel(){return kernel;},set polls(v:any[]){polls=v;},set refresh(v:any){refresh=v;},set holdWrite(v:Promise<void>|undefined){holdWrite=v;},set holdClear(v:Promise<void>|undefined){holdClear=v;},advance(ms:number){time+=ms;},
  async configured(){const s=await status();await call('github.auth.configure',{revision:s.revision,clientId:'Ov23_fixture_application'});},
  async login(){await this.configured();await call('github.auth.begin',{revision:(await status()).revision});await until(()=>waits.length);waits[0].go();await until(async()=>(await status()).connected);},
  async restart(){await kernel.dispose();kernel=await bootstrapAndroid(root,resolve('.'),native,options);api=mobileApi(kernel,native);},
  async close(){await kernel.dispose();await rm(root,{recursive:true,force:true});}
 };
}

test('GitHub 损坏的可选 Client ID 不阻断核心启动，原文件保留并可明确保存修复',{timeout:20000},async()=>{
 for(const raw of ['"https://invalid.fixture/client"','null','false','0','{}','[]','{broken','']){
  const h=await fixture({clientFile:raw});
  try{
   let status=await h.status();assert.equal(status.clientId,'');assert.equal(status.phase,'error');assert.equal(status.configurationError,true);assert.equal(projectGithubAuth(status).configurationError,true);assert.throws(()=>projectGithubAuth({...status,configurationError:'invalid'}));assert.match(status.detail,/登录应用设置.*重新保存/);assert(!status.connected&&!status.authorization);assert.equal(h.calls.length,0);
   const state=await h.call('snapshot.get');assert.equal(state.runtime.engine,'ready');assert.equal(typeof state.pet.visible,'boolean');assert((await h.call('conversation.create')).id);
   assert.equal((await h.raw('github.auth.begin',{revision:status.revision})).error?.code,'UNAVAILABLE');assert.equal(h.calls.length,0);assert.equal(await readFile(join(h.root,'data/github-oauth-client.json'),'utf8'),raw);
   assert.equal((await h.raw('github.auth.configure',{revision:status.revision,clientId:'invalid client'})).error?.code,'INVALID_INPUT');assert.equal(await readFile(join(h.root,'data/github-oauth-client.json'),'utf8'),raw);
   await h.call('github.auth.configure',{revision:status.revision,clientId:''});assert.equal(await h.kernel.resolve('storage.local').read('github-oauth-client','missing'),'');status=await h.status();assert.equal(status.phase,'signedOut');assert.equal(status.configurationError,undefined);
   await h.restart();assert.equal((await h.status()).phase,'signedOut');assert.equal(h.calls.length,0);
  }finally{await h.close();}
 }
});

test('GitHub 配置损坏时不使用或删除旧登录，普通共享聊天继续工作',{timeout:20000},async()=>{
 const credential=JSON.stringify({v:1,clientId:'Ov23_fixture_old_application',binding:'11111111-1111-4111-8111-111111111111',user:{id:42,login:'fixture-old'},scopes:['repo'],accessToken:'gho_fixture_old_access',refreshToken:'',expiresAt:0,refreshExpiresAt:0,refreshing:false});
 const h=await fixture({clientFile:'"invalid client"',keys:[[githubDeviceScope,credential]]}),original=globalThis.fetch;let modelCalls=0;
 globalThis.fetch=async(input)=>{assert.equal(new Request(input).url,'http://127.0.0.1:1/v1/chat/completions');modelCalls++;return new Response('data: '+JSON.stringify({choices:[{delta:{content:'伙伴继续运行'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});};
 try{
  const auth=h.kernel.resolve('github.deviceAuth'),binding='familiar:github-device:11111111-1111-4111-8111-111111111111';assert(!auth.available(binding));await assert.rejects(auth.token(binding,new AbortController().signal),/GITHUB_LOGIN_REQUIRED/);assert.equal(h.keys.get(githubDeviceScope),credential);assert.equal(h.calls.length,0);assert(!JSON.stringify(await h.status()).includes('gho_fixture'));
  await h.kernel.resolve('mcp.manager').save(githubConfig(true,true),{key:binding,officialGithub:true});assert.equal(h.keys.get(mcpCredentialScope(githubConfig(true))),binding);assert.equal(h.keys.get(githubDeviceScope),credential);
  await h.call('provider.save',{kind:'compatible',baseUrl:'http://127.0.0.1:1/v1',model:'startup-fixture',clearApiKey:true});const conversation=await h.call('conversation.create');await h.call('message.send',{conversationId:conversation.id,text:'你好'});
  await until(async()=>{const s=await h.call('snapshot.get');return !s.activeReply&&s.conversations.find((c:any)=>c.id===conversation.id)?.messages.some((m:any)=>m.role==='assistant'&&m.text==='伙伴继续运行');});assert.equal(modelCalls,1);assert.equal(h.keys.get(githubDeviceScope),credential);
  await h.call('github.auth.configure',{revision:(await h.status()).revision,clientId:''});assert(!h.keys.has(githubDeviceScope));assert.equal((await h.status()).phase,'signedOut');const server=(await h.call('mcp.list')).find((row:any)=>row.id==='github');assert(!server.enabled&&!server.connected&&!server.hasKey);assert(!h.keys.has(mcpCredentialScope(githubConfig(true))));
  await h.configured();assert.equal((await h.status()).phase,'signedOut');assert.equal((await h.status()).clientId,'Ov23_fixture_application');assert.equal(h.calls.length,0);
 }finally{globalThis.fetch=original;await h.close();}
});

test('GitHub 设备授权 pending/slow_down、系统页面、加密所有者和 MCP 动态刷新',{timeout:20000},async()=>{
 const h=await fixture(),original=globalThis.fetch,network:{token:string;method:string}[]=[];
 globalThis.fetch=async(input,init)=>{const r=new Request(input,init);assert([githubConfig(true).url,githubConfig(false).url].includes(r.url));network.push({token:r.headers.get('Authorization')!,method:r.method});
  if(r.method!=='POST')return new Response(null,{status:405});const rpc=JSON.parse(await r.text());if(rpc.id===undefined)return new Response(null,{status:202});let result:unknown={};
  if(rpc.method==='initialize')result={protocolVersion:rpc.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'github-fixture',version:'1'}};
  if(rpc.method==='tools/list')result={tools:[{name:'get_me',inputSchema:{type:'object'}}]};if(rpc.method==='tools/call')result={content:[{type:'text',text:'GitHub fixture result'}]};
  return new Response(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}),{headers:{'Content-Type':'application/json'}});
 };
 try{
  const initial=await h.status();assert(!initial.connected&&!initial.clientId);assert.equal((await h.raw('github.auth.begin',{revision:initial.revision})).error?.code,'UNAVAILABLE');assert.equal(h.calls.length,0);
  await h.configured();h.polls=[{error:'authorization_pending'},{error:'slow_down',interval:8},token()];const s=await h.status();await h.call('github.auth.begin',{revision:s.revision});let next=await h.status();assert(next.authorization);
  assert.equal((await h.raw('github.auth.open',{revision:next.revision,url:'https://foreign.invalid'})).error?.code,'INVALID_INPUT');await h.call('github.auth.open',{revision:next.revision});assert.deepEqual(h.opened,[{url:'https://github.com/login/device',userCode:'ABCD-EFGH'}]);
  for(const interval of [5000,5000,10000]){await until(()=>h.waits.length);assert.equal(h.waits[0].ms,interval);h.waits[0].go();await pause();}await until(async()=>(await h.status()).connected);
  next=await h.status();assert.equal(next.user.login,'familiar-fixture');assert(!next.applied&&!next.authorization);assert(!JSON.stringify(next).includes('gho_'));assert(!JSON.stringify(next).includes('private-device-code'));
  const row=await h.call('github.auth.apply',{revision:next.revision,targetRevision:next.targetRevision,enabled:true,readOnly:true});assert(row.applied);let server=(await h.call('mcp.list')).find((s:any)=>s.id==='github');
  const credential=h.keys.get(mcpCredentialScope(githubConfig(true)))!;assert(isGithubDeviceCredential(credential));assert(!credential.includes('gho_'));await h.call('mcp.connect',{id:'github',revision:server.revision,operationId:'connect-oauth'});
  assert(network.some(r=>r.token==='Bearer gho_fixture_access_1'));h.advance(25000);
  const tool=h.kernel.resolve('agent.tools').list().find(t=>t.description.includes('get_me'))!;assert(tool);assert.match(await h.kernel.resolve('agent.tools').run({id:'after-refresh',name:tool.name,arguments:'{}'},new AbortController().signal),/fixture result/);
  assert(network.some(r=>r.token==='Bearer gho_fixture_access_2'));assert.equal(h.calls.filter(c=>c.body.get('grant_type')==='refresh_token').length,1);assert.equal(h.keys.get(mcpCredentialScope(githubConfig(true))),credential);
  server=(await h.call('mcp.list')).find((s:any)=>s.id==='github');await h.call('mcp.github.save',{enabled:false,readOnly:true,revision:server.revision});await h.restart();next=await h.status();assert(next.connected&&next.applied);assert.equal(next.user.id,42);
  await h.call('github.auth.forget',{revision:next.revision});next=await h.status();server=(await h.call('mcp.list')).find((s:any)=>s.id==='github');assert(!next.connected&&!next.applied&&!server.hasKey&&!server.enabled);assert(!h.keys.has(githubDeviceScope));assert(!network.some(r=>r.token.includes('familiar:')));
 }finally{await h.close();globalThis.fetch=original;}
});

test('GitHub 取消迟到落盘会回滚，停止常驻也取消授权，不泄漏公开状态',{timeout:20000},async()=>{
 const h=await fixture();let release!:()=>void;
 try{
  await h.configured();await h.call('github.auth.begin',{revision:(await h.status()).revision});h.holdWrite=new Promise<void>(r=>release=r);h.waits[0].go();await until(()=>h.calls.some(c=>c.url==='https://api.github.com/user'));
  await h.call('github.auth.cancel',{revision:(await h.status()).revision});h.holdWrite=undefined;release();await until(()=>!h.keys.has(githubDeviceScope));await pause(20);assert(!(await h.status()).connected);assert.equal(h.keys.get(githubDeviceScope),undefined);
  await h.call('github.auth.begin',{revision:(await h.status()).revision});await until(()=>h.waits.length);await h.call('runtime.set',{enabled:false});assert.equal((await h.status()).phase,'signedOut');assert.equal(h.waits.length,0);
  const safe=projectGithubAuth({...await h.status(),accessToken:'hidden',deviceCode:'hidden',authorization:undefined});assert(!JSON.stringify(safe).includes('hidden'));
  for(const field of ['user','authorization'])assert.throws(()=>projectGithubAuth({...safe,[field]:null}),/不兼容/);
 }finally{release?.();await h.close();}
});

test('GitHub 刷新结果未知不重试，重启后仍要求重新登录',{timeout:20000},async()=>{
 const h=await fixture();
 try{await h.login();const auth=h.kernel.resolve('github.deviceAuth'),credential=auth.credential();h.advance(25000);h.refresh=Error('network lost');
  await assert.rejects(auth.token(credential,new AbortController().signal),/GITHUB_LOGIN_REQUIRED/);await pause();assert.equal(h.calls.filter(c=>c.body.get('grant_type')==='refresh_token').length,1);
  await assert.rejects(auth.token(credential,new AbortController().signal),/GITHUB_LOGIN_REQUIRED/);assert.equal(h.calls.filter(c=>c.body.get('grant_type')==='refresh_token').length,1);assert((await h.status()).detail.includes('未确认'));
  await h.restart();assert(!(await h.status()).connected);await assert.rejects(h.kernel.resolve('github.deviceAuth').token(credential,new AbortController().signal),/GITHUB_LOGIN_REQUIRED/);assert.equal(h.calls.filter(c=>c.body.get('grant_type')==='refresh_token').length,1);
 }finally{await h.close();}
});

test('GitHub 登录应用/旧配置冲突，旧应用凭据不能覆盖新 Token',{timeout:20000},async()=>{
 const h=await fixture();try{await h.login();let old=await h.status();const row=await h.call('mcp.github.save',{enabled:false,readOnly:true,revision:null,apiKey:'new-user-token'});
  assert.equal((await h.raw('github.auth.apply',{revision:old.revision,targetRevision:old.targetRevision,readOnly:true,enabled:false})).error?.code,'CONFLICT');assert.equal(h.keys.get(mcpCredentialScope(githubConfig(true))),'new-user-token');
  await h.call('github.auth.configure',{revision:old.revision,clientId:'Ov23_other_application'});assert(!(await h.status()).connected);assert.equal(h.keys.get(mcpCredentialScope(githubConfig(true))),'new-user-token');
  assert.equal((await h.raw('github.auth.begin',{revision:old.revision})).error?.code,'CONFLICT');assert.equal((await h.raw('github.auth.configure',{revision:(await h.status()).revision,clientId:'https://foreign.invalid'})).error?.code,'INVALID_INPUT');assert.equal((await h.call('mcp.list')).find((s:any)=>s.id==='github').revision,row.revision);
 }finally{await h.close();}
});

test('GitHub 保存应用期间不发起旧应用授权，相同配置保持已绑定登录',{timeout:20000},async()=>{
 const h=await fixture();let release!:()=>void;
 try{await h.login();let s=await h.status();await h.call('github.auth.apply',{revision:s.revision,targetRevision:s.targetRevision,enabled:false,readOnly:true});s=await h.status();
  const same=await h.call('github.auth.configure',{revision:s.revision,clientId:s.clientId});assert(same.applied&&same.connected);
  h.holdClear=new Promise<void>(r=>release=r);const changing=h.call('github.auth.configure',{revision:same.revision,clientId:'Ov23_new_client'});await until(async()=>(await h.status()).phase==='saving');
  const count=h.calls.length;assert.equal((await h.raw('github.auth.begin',{revision:(await h.status()).revision})).error?.code,'BUSY');assert.equal(h.calls.length,count);h.holdClear=undefined;release();await changing;
  s=await h.status();assert.equal(s.clientId,'Ov23_new_client');assert(!s.connected&&!s.applied);assert(!h.keys.has(githubDeviceScope));
 }finally{release?.();await h.close();}
});

test('GitHub 应用登录提交队列再次核对凭据，保护并发保存的新 Token',{timeout:20000},async()=>{
 const h=await fixture();try{await h.login();await h.call('mcp.github.save',{enabled:false,readOnly:true,revision:null,apiKey:'first-user-token'});const s=await h.status(),manager=h.kernel.resolve('mcp.manager'),save=manager.save;let injected=false;
  manager.save=async(config,update)=>{if(!injected&&update?.key&&isGithubDeviceCredential(update.key)){injected=true;await save(config,{...update,key:'concurrent-new-token'});}return save(config,update);};
  assert.equal((await h.raw('github.auth.apply',{revision:s.revision,targetRevision:s.targetRevision,enabled:false,readOnly:true})).error?.code,'CONFLICT');assert(injected);assert.equal(h.keys.get(mcpCredentialScope(githubConfig(true))),'concurrent-new-token');assert(!(await h.status()).applied);
 }finally{await h.close();}
});

test('GitHub 并发请求只刷新一次，取消一个请求不会中断令牌轮换',{timeout:20000},async()=>{
 const h=await fixture();let release!:(value:any)=>void;
 try{await h.login();const auth=h.kernel.resolve('github.deviceAuth'),credential=auth.credential();h.advance(25000);h.refresh=new Promise(r=>release=r);
  const cancelled=new AbortController(),first=assert.rejects(auth.token(credential,cancelled.signal)),second=auth.token(credential,new AbortController().signal);await until(()=>h.calls.some(c=>c.body.get('grant_type')==='refresh_token'));cancelled.abort();release(token(2));await first;assert.equal(await second,'gho_fixture_access_2');assert.equal(h.calls.filter(c=>c.body.get('grant_type')==='refresh_token').length,1);assert(auth.available(credential));
 }finally{release?.(token(2));await h.close();}
});
