import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {bootstrapAndroid} from '../apps/tauri/runtime/bootstrap.ts';
import {mobileApi} from '../apps/tauri/runtime/mobile-api.ts';
import {channelSecretScope,normalizeChannelMessage} from '../plugins/feishu-channel/index.ts';
import {feishuTransport} from '../plugins/feishu-channel/transport.ts';
import {projectFeishuResult} from '../packages/mobile-bridge/feishu.ts';
import {feishuFixture,incoming} from './fixtures/feishu.ts';
import type {AndroidNative} from '../plugins/platform-android/index.ts';
import type {MobileCommand,MobileFeishuStatus} from '../packages/mobile-contracts/index.ts';
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function wait(check:()=>boolean|Promise<boolean>){for(let n=0;n<300;n++){if(await check())return;await pause(10);}throw Error('Fixture deadline');}

test('飞书官方 SDK HTTP/WebSocket → Android 共享 Agent：配对、审批、去重、停止和重启',async()=>{
 await mkdir('.artifacts',{recursive:true});const root=await mkdtemp(resolve('.artifacts/android-feishu-')),fixture=await feishuFixture();
 const keys=new Map<string,string>();let available=true,seq=0,writes=0;
 const native:AndroidNative={async call<T>(method:string,p:Record<string,unknown>={}){if(method==='secrets.write'){p.value?keys.set(String(p.name),String(p.value)):keys.delete(String(p.name));return null as T;}return(method==='secrets.readAll'?Object.fromEntries(keys):method==='runtime.status'?{running:available,overlayVisible:available,engine:'ready',detail:'fixture'}:method==='capabilities.status'?[]:null) as T;}};
 const options={feishuTransport:feishuTransport(fixture.url),feishuPollMs:20};
 let kernel=await bootstrapAndroid(root,resolve('.'),native,options),api=mobileApi(kernel,native);
 const raw=(method:MobileCommand,params?:unknown)=>api({protocolVersion:1,id:'feishu-'+(++seq),method,params});
 const call=async(method:MobileCommand,params?:unknown)=>{const result=await raw(method,params);assert(result.ok,JSON.stringify(result));return result.result as any;};
 const status=()=>call('feishu.status') as Promise<MobileFeishuStatus>;
 const register=()=>kernel.resolve('agent.tools').register({name:'fixture_write',description:'隔离外部写入',category:'outsideWrite',parameters:{type:'object',properties:{},additionalProperties:false},async execute(){writes++;return 'written';}});
 try{
  register();let s=await status();assert(!s.enabled&&!s.hasSecret&&s.phase==='off');assert.equal(fixture.state.pulls,0);
  assert.equal((await raw('feishu.save',{appId:'cli_bad_id',enabled:true,allowedUsers:[],revision:s.revision,appSecret:'fixture-secret'})).error?.code,'INVALID_INPUT');
  assert.equal((await raw('feishu.save',{appId:'cli_0123456789abcdef',enabled:true,allowedUsers:[],revision:s.revision})).error?.code,'INVALID_INPUT');
  assert.equal((await raw('feishu.save',{appId:'cli_0123456789abcdef',enabled:false,allowedUsers:[],revision:s.revision,domain:fixture.url})).error?.code,'INVALID_INPUT');
  s=await call('feishu.save',{appId:'cli_0123456789abcdef',enabled:false,allowedUsers:[],revision:s.revision,appSecret:'fixture-secret'});assert(s.hasSecret);assert.equal(fixture.state.pulls,0);
  assert(!(await readFile(join(root,'data/feishu-channel.json'),'utf8')).includes('fixture-secret'));assert.equal(keys.get(channelSecretScope('cli_0123456789abcdef')),'fixture-secret');
  fixture.state.hold=true;
  s=await call('feishu.save',{revision:s.revision,appId:s.appId,enabled:true,allowedUsers:[]});
  await wait(()=>fixture.state.pulls===1);await call('feishu.stop');fixture.release();fixture.state.hold=false;
  await pause(40);assert.equal((await status()).phase,'off');assert.equal(fixture.clients(),0);
  s=await status();const old=s.revision;s=await call('feishu.save',{revision:s.revision,appId:s.appId,enabled:true,allowedUsers:[]});
  assert.equal((await raw('feishu.pair',{revision:old})).error?.code,'CONFLICT');await wait(async()=>(await status()).phase==='connected').catch(async error=>{throw Error(JSON.stringify({error:String(error),status:await status(),fixture:fixture.state}));});
  await call('provider.save',{kind:'compatible',baseUrl:fixture.url+'/v1',model:'fixture-model'});
  fixture.send(incoming('om_unknown','未配对消息'));await wait(()=>fixture.state.acks===1);assert.equal(fixture.state.model.length,0);assert.equal(fixture.state.replies.length,0);
  s=await status();s=await call('feishu.pair',{revision:s.revision});assert(s.pairing);const pairingCode=s.pairing.code;fixture.send(incoming('om_pair','/pair '+pairingCode));await wait(()=>fixture.state.replies.length===1);assert.equal(fixture.state.model.length,0);
  s=await status();assert.deepEqual(s.allowedUsers,['ou_fixture']);assert(!s.pairing);assert.match(fixture.state.replies[0].text,/配对成功/);
  fixture.send({...incoming('om_group','群聊'),message:{...incoming('om_group','群聊').message,chat_type:'group'}});fixture.send(incoming('om_reused_code','/pair '+pairingCode,'ou_other'));
  fixture.send(incoming('om_hello','你好'));await wait(()=>fixture.state.replies.length===2);assert.equal(fixture.state.model.length,1);assert.equal(fixture.state.replies[1].id,'om_hello');assert.match(fixture.state.replies[1].text,/fixture-answer:你好/);
  fixture.send(incoming('om_hello','你好'));await pause(70);assert.equal(fixture.state.replies.length,2);
  fixture.send(incoming('om_deny','操作'));await wait(()=>kernel.resolve('agent.approvals').list().length===1);assert.equal(writes,0);assert.match(kernel.resolve('agent.approvals').list()[0].title,/飞书私聊/);await kernel.resolve('agent.approvals').decide(kernel.resolve('agent.approvals').list()[0].id,false,'once');await wait(()=>fixture.state.replies.length===3);assert.equal(writes,0);
  fixture.send(incoming('om_allow','操作'));await wait(()=>kernel.resolve('agent.approvals').list().length===1);await kernel.resolve('agent.approvals').decide(kernel.resolve('agent.approvals').list()[0].id,true,'once');await wait(()=>fixture.state.replies.length===4);assert.equal(writes,1);
  fixture.send(incoming('om_cancel','操作'));await wait(()=>kernel.resolve('agent.approvals').list().length===1);await call('feishu.stop');await wait(()=>fixture.clients()===0&&(kernel.resolve('agent.approvals').list().length===0));assert.equal(writes,1);assert.equal(fixture.state.replies.length,4);const pulls=fixture.state.pulls;await pause(100);assert.equal(fixture.state.pulls,pulls);
  s=await status();await call('feishu.save',{revision:s.revision,appId:s.appId,enabled:true,allowedUsers:s.allowedUsers});await wait(async()=>(await status()).phase==='connected');
  fixture.send(incoming('om_runtime_cancel','操作'));await wait(()=>kernel.resolve('agent.approvals').list().length===1);
  await call('runtime.set',{enabled:false});assert.equal(kernel.resolve('agent.approvals').list().length,0);assert.equal((await status()).phase,'waiting');assert((await status()).enabled);await wait(()=>fixture.clients()===0);assert.equal(writes,1);assert.equal(fixture.state.replies.length,4);
  await call('runtime.set',{enabled:true});await wait(async()=>(await status()).phase==='connected');
  available=false;await wait(async()=>(await status()).phase==='waiting'&&fixture.clients()===0);assert.equal(fixture.clients(),0);available=true;await wait(async()=>(await status()).phase==='connected');
  await kernel.dispose();kernel=await bootstrapAndroid(root,resolve('.'),native,options);api=mobileApi(kernel,native);register();await wait(async()=>(await status()).phase==='connected');
  const responses=fixture.state.replies.length;fixture.send(incoming('om_cancel','操作'));fixture.send(incoming('om_hello','你好'));await pause(80);assert.equal(fixture.state.replies.length,responses);assert.equal(kernel.resolve('agent.approvals').list().length,0);
  const models=fixture.state.model.length;fixture.send(incoming('om_new','/new'));await wait(()=>fixture.state.replies.length===responses+1);assert.equal(fixture.state.model.length,models);
  s=await status();await call('feishu.save',{revision:s.revision,appId:s.appId,enabled:true,allowedUsers:s.allowedUsers,clearSecret:true});s=await status();assert(!s.hasSecret&&!s.enabled);assert.equal(fixture.clients(),0);
  assert.equal((await raw('feishu.save',{revision:s.revision,appId:s.appId,enabled:true,allowedUsers:s.allowedUsers})).error?.code,'INVALID_INPUT');
  s=await call('feishu.save',{revision:s.revision,appId:s.appId,enabled:false,allowedUsers:s.allowedUsers,appSecret:'fixture-secret'});
  const changed=await call('feishu.save',{revision:s.revision,appId:'cli_fedcba9876543210',enabled:false,allowedUsers:s.allowedUsers});assert(!changed.hasSecret);assert.deepEqual(changed.allowedUsers,[]);assert(!keys.has(channelSecretScope('cli_0123456789abcdef')));
  const returned=await call('feishu.save',{revision:changed.revision,appId:'cli_0123456789abcdef',enabled:false,allowedUsers:[]});assert(!returned.hasSecret);
  assert(!JSON.stringify(projectFeishuResult({...changed,appSecret:'hidden'})).includes('hidden'));
  assert.deepEqual(fixture.state.errors,[]);
 }finally{await kernel.dispose();await fixture.close();await rm(root,{recursive:true,force:true});}
});

test('飞书 SDK 凭据失败公开固定错误且关闭后不再重连',async()=>{
 const fixture=await feishuFixture(),states:string[]=[];fixture.state.discoveryCode=514;
 const abort=new AbortController(),transport=feishuTransport(fixture.url)({appId:'cli_0123456789abcdef',appSecret:'fixture-secret',signal:abort.signal,state:s=>states.push(s),receive(){assert.fail('Unexpected message');}});
 try{await wait(()=>states.includes('error'));assert(!states.includes('connected'));abort.abort();transport.close();const pulls=fixture.state.pulls;await pause(50);assert.equal(fixture.state.pulls,pulls);assert.equal(fixture.clients(),0);assert.deepEqual(fixture.state.errors,[]);}
 finally{transport.close();await fixture.close();}
});

test('飞书通道拒绝非文字、机器人、群聊与畸形资料，公开状态不携带密钥',()=>{
 const base=incoming('om_test','hello');assert(normalizeChannelMessage(base));
 assert(!normalizeChannelMessage({...base,sender:{...base.sender,sender_type:'app'}}));
 assert(!normalizeChannelMessage({...base,message:{...base.message,content:'broken'}}));
 assert(!normalizeChannelMessage({...base,message:{...base.message,message_type:'image'}}));
 assert(!normalizeChannelMessage({...base,message:{...base.message,message_id:'om_'+ 'a'.repeat(1000)}}));
 assert.throws(()=>projectFeishuResult({}));
});
