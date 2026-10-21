import {createHash} from 'node:crypto';
import type {Kernel} from '../../../packages/kernel/index.ts';
import type {MobileGithubAuth} from '../../../packages/mobile-contracts/github.ts';
import {githubConfig,isGithubConfig} from '../../../plugins/github-integration/config.ts';
import {isGithubDeviceCredential} from '../../../plugins/github-integration/device-auth.ts';
import {mcpCredentialScope,mcpRevision} from '../../../plugins/mcp-client/index.ts';
const input:(v:unknown)=>asserts v=v=>{if(!v)throw Error('INVALID_INPUT');};
/** OAuth 登录和工具启用分开确认；外发地址始终由核心固定。 */
export function mobileGithub(kernel:Kernel){
 const auth=kernel.resolve('github.deviceAuth'),manager=kernel.resolve('mcp.manager'),keys=kernel.resolve('secrets.local');
 const target=async()=>{
  const row=(await manager.list()).find(s=>s.id==='github'),key=row?keys.get(mcpCredentialScope(row)):'';
  return {row,key,stamp:createHash('sha256').update(JSON.stringify([row?mcpRevision(row):null,key])).digest('hex')};
 };
 const status=async():Promise<MobileGithubAuth>=>{const t=await target();return {...auth.status(),applied:!!t.row&&isGithubConfig(t.row)&&isGithubDeviceCredential(t.key)&&auth.available(t.key),targetRevision:t.stamp};};
 const clearBinding=async(expected:string)=>{const t=await target();if(t.row&&isGithubConfig(t.row)&&isGithubDeviceCredential(t.key)&&t.key===expected)try{await manager.save({...githubConfig(t.row.url!.endsWith('/readonly')),enabled:false},{expectedRevision:mcpRevision(t.row),expectedKey:t.key,key:'',officialGithub:true});}catch(error){if((error as Error).message!=='CONFLICT')throw error;}};
 return async(method:string,p:Record<string,unknown>={})=>{
  if(method==='github.auth.status'){input(Object.keys(p).length===0);return status();}
  const allowed=method==='github.auth.configure'?['revision','clientId']:method==='github.auth.apply'?['revision','targetRevision','readOnly','enabled']:['revision'];
  input(Object.keys(p).every(k=>allowed.includes(k))&&typeof p.revision==='string'&&/^[a-f0-9-]{36}$/.test(p.revision));
  if(method==='github.auth.configure'){input(typeof p.clientId==='string');const before=auth.status(),t=await target();await auth.configure({revision:p.revision,clientId:p.clientId});if(before.configurationError||before.clientId!==auth.status().clientId)await clearBinding(t.key);}
  else if(method==='github.auth.begin')await auth.begin(p.revision);
  else if(method==='github.auth.open')await auth.open(p.revision);
  else if(method==='github.auth.cancel')auth.cancel(p.revision);
  else if(method==='github.auth.forget'){const t=await target();await auth.forget(p.revision);await clearBinding(t.key);}
  else if(method==='github.auth.apply'){
   input(typeof p.readOnly==='boolean'&&typeof p.enabled==='boolean'&&typeof p.targetRevision==='string');const before=auth.status();if(before.revision!==p.revision)throw Error('CONFLICT');
   const t=await target();if(t.stamp!==p.targetRevision)throw Error('CONFLICT');if(t.row&&!isGithubConfig(t.row))throw Error('INVALID_INPUT');
   const credential=auth.credential();await manager.save(githubConfig(p.readOnly,p.enabled),{expectedRevision:t.row?mcpRevision(t.row):null,expectedKey:t.key,key:credential,officialGithub:true});
   if(auth.status().revision!==before.revision||!auth.available(credential)){await clearBinding(credential);throw Error('CONFLICT');}
  }else throw Error('UNAVAILABLE');
  return status();
 };
}
