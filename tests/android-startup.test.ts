import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {bootstrapAndroid} from '../apps/tauri/runtime/bootstrap.ts';
import {mobileApi} from '../apps/tauri/runtime/mobile-api.ts';
import {createMobileBridge,isMobileSnapshot,type MobileRequest} from '../packages/mobile-bridge/index.ts';
import type {AndroidNative} from '../plugins/platform-android/index.ts';
import type {MobileSnapshot,MobileStartup} from '../packages/mobile-contracts/index.ts';

test('Android 开机设置由原生持有，协议拒绝多余参数，失败不显示启用，也不启动当前服务或录音',async()=>{
 const root=await mkdtemp(resolve('.artifacts/startup-core-'));let seq=0,fail=false;
 let startup:MobileStartup={enabled:false,overlayGranted:true,lastResult:'none',lastAttemptAt:0,detail:'尚无开机启动记录。'};
 const calls:string[]=[];
 const native:AndroidNative={async call<T>(method:string,p:Record<string,unknown>={}){
  calls.push(method);if(method==='runtime.startup.save'){if(fail)throw Error('UNAVAILABLE');startup={...startup,enabled:p.enabled as boolean};return structuredClone(startup) as T;}
  return (method==='runtime.startup.get'?structuredClone(startup):method==='secrets.readAll'?{}:method==='capabilities.status'?[]:method==='runtime.status'?{running:false,engine:'ready',overlayVisible:false,detail:'fixture'}:null) as T;
 }};
 let kernel=await bootstrapAndroid(root,resolve('.'),native),api=mobileApi(kernel,native);
 const call=(method:MobileRequest['method'],params?:unknown)=>api({protocolVersion:1,id:'startup-'+(++seq),method,params});
 const good=async(method:MobileRequest['method'],params?:unknown)=>{const r=await call(method,params);assert(r.ok,JSON.stringify(r));return r.result;};
 try{
  const initial=await good('snapshot.get') as MobileSnapshot;assert(isMobileSnapshot(initial));assert.equal(initial.startup?.enabled,false);
  for(const p of [undefined,{enabled:1},{enabled:'true'},{enabled:true,action:'boot'},{enabled:false,extra:0}])assert.equal((await call('runtime.startup.save',p)).error?.code,'INVALID_INPUT');
  fail=true;assert(!(await call('runtime.startup.save',{enabled:true})).ok);assert.equal((await good('snapshot.get') as MobileSnapshot).startup?.enabled,false);
  fail=false;assert((await good('runtime.startup.save',{enabled:true}) as MobileStartup).enabled);assert(!calls.includes('runtime.set'));assert(!calls.some(m=>m==='wake.enable'||m==='audio.command'));
  await kernel.dispose();kernel=await bootstrapAndroid(root,resolve('.'),native);api=mobileApi(kernel,native);const restored=await good('snapshot.get') as MobileSnapshot;assert(restored.startup?.enabled);
  const bridge=createMobileBridge({listen:()=>()=>{},async invoke(r){return{protocolVersion:1,id:r.id,ok:true,result:r.method==='snapshot.get'?{...restored,startup:{...startup,privateValue:'hidden'}}:{...startup,privateValue:'hidden'}};}});
  try{assert(!JSON.stringify(await bridge.request('snapshot.get',undefined)).includes('hidden'));assert(!JSON.stringify(await bridge.request('runtime.startup.save',{enabled:true})).includes('hidden'));}finally{bridge.dispose();}
  assert(!isMobileSnapshot({...restored,startup:{...startup,lastResult:'pretend'}}));assert(!isMobileSnapshot({...restored,startup:{...startup,lastAttemptAt:-1}}));
  await good('runtime.startup.save',{enabled:false});assert.equal((await good('snapshot.get') as MobileSnapshot).startup?.enabled,false);
 }finally{await kernel.dispose();await rm(root,{recursive:true,force:true});}
});
