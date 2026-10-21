import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {definePlugin} from '../../packages/contracts/index.ts';
import type {GithubAuthStatus} from '../../packages/contracts/github-auth.ts';
import {githubDeviceHttp,githubDeviceUrl,githubSecret,validGithubClient,type GithubTokens} from './device-http.ts';
export const githubDeviceScope='github-device-login';
const prefix='familiar:github-device:';
export const isGithubDeviceCredential=(v:string)=>new RegExp('^'+prefix+'[a-f0-9-]{36}$').test(v);
interface Saved {
  v:1;clientId:string;binding:string;user:{id:number;login:string};scopes:string[];
  accessToken:string;refreshToken:string;expiresAt:number;refreshExpiresAt:number;refreshing:boolean;
}
export interface GithubDeviceOptions {fetcher?:typeof fetch;open?:(url:string,userCode:string)=>Promise<void>;now?:()=>number;wait?:(ms:number,signal:AbortSignal)=>Promise<void>;}
function decode(raw:string):Saved|undefined{
  try{const s=JSON.parse(raw) as Saved;if(s.v===1&&validGithubClient(s.clientId)&&/^[a-f0-9-]{36}$/.test(s.binding)&&Number.isSafeInteger(s.user?.id)&&s.user.id>0&&/^[A-Za-z0-9-]{1,100}$/.test(s.user.login)&&
    Array.isArray(s.scopes)&&s.scopes.length<=100&&s.scopes.every(v=>typeof v==='string'&&/^[a-zA-Z0-9_:-]{1,100}$/.test(v))&&githubSecret(s.accessToken)&&typeof s.refreshToken==='string'&&(!s.refreshToken||githubSecret(s.refreshToken))&&
    [s.expiresAt,s.refreshExpiresAt].every(v=>Number.isSafeInteger(v)&&v>=0)&&typeof s.refreshing==='boolean')return s;}catch{}return;
}
function waiting<T>(task:Promise<T>,signal:AbortSignal):Promise<T>{
  signal.throwIfAborted();return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});task.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
/** 独立 Runtime 拥有设备授权与轮换，Controller 只读公开状态。 */
export function githubDeviceAuth(options:GithubDeviceOptions={}){
 return definePlugin({manifest:{manifestVersion:1,id:'familiar.github-device-auth',version:'0.1.0',provides:['github.deviceAuth'],requires:['storage.local','secrets.local'],permissions:['network.github']},
 async start(ctx){
  ctx.require('network.github');const store=ctx.use('storage.local'),keys=ctx.use('secrets.local'),http=githubDeviceHttp(options.fetcher),now=options.now??Date.now,wait=options.wait??((ms,signal)=>delay(ms,undefined,{signal}));
  // 可选登录应用的数据损坏不能阻断整个 Runtime；保留原文件，等待用户明确重新保存。
  let storedClient:unknown,clientConfigInvalid=false;
  try{storedClient=await store.read<unknown>('github-oauth-client','');}catch{clientConfigInvalid=true;}
  if(storedClient!==''&&!validGithubClient(storedClient))clientConfigInvalid=true;
  let clientId=typeof storedClient==='string'&&!clientConfigInvalid?storedClient:'';
  const invalidClientDetail='本地 GitHub 登录应用设置无法读取或已损坏，请重新保存 Client ID。其他伙伴功能可继续使用。';
  let saved=decode(keys.get(githubDeviceScope)),revision=randomUUID() as string,owner=new AbortController(),authorizing=false,authorization:GithubAuthStatus['authorization'],detail='尚未登录 GitHub。',failed=false;
  let queue=Promise.resolve(),login:Promise<void>|undefined,refreshFlight:Promise<string>|undefined,changing=false;
  const valid=()=>saved&&saved.clientId===clientId;
  const connected=()=>!!(!changing&&valid()&&(!saved!.refreshing||refreshFlight)&&(saved!.expiresAt===0||saved!.expiresAt>now()||saved!.refreshToken&&saved!.refreshExpiresAt>now()));
  const status=():GithubAuthStatus=>({revision,clientId,connected:connected(),phase:changing?'saving':authorizing?'authorizing':refreshFlight?'refreshing':connected()?'connected':saved||failed||clientConfigInvalid?'error':'signedOut',
   detail:clientConfigInvalid&&!changing?invalidClientDetail:changing||authorizing||refreshFlight||failed?detail:connected()?'GitHub 登录已保存在本机，可用于官方工具。':saved?'登录已过期或上次刷新中断，请重新登录。':detail,...(clientConfigInvalid?{configurationError:true}:{}),scopes:valid()?[...saved!.scopes]:[],...(valid()?{user:{...saved!.user}}:{}),...(authorization&&authorization.expiresAt>now()?{authorization:{...authorization}}:{})});
  const publish=()=>{if(ctx.active)ctx.emit('github.auth.changed',status());};
  const serial=<T>(work:()=>Promise<T>)=>{const task=queue.then(work);queue=task.then(()=>{},()=>{});return task;};
  const check=(value:string)=>{if(value!==revision)throw Error('CONFLICT');};
  const invalidate=()=>{owner.abort();owner=new AbortController();revision=randomUUID();authorizing=false;authorization=undefined;};
  const persist=(value:Saved,signal:AbortSignal)=>serial(async()=>{
    signal.throwIfAborted();if(value.clientId!==clientId)throw Error('CONFLICT');const old=saved;
    await keys.set(githubDeviceScope,JSON.stringify(value));
    if(signal.aborted){try{await keys.set(githubDeviceScope,old?JSON.stringify(old):'');}catch{saved=undefined;failed=true;detail='取消时清理登录失败，请重试清除本机登录。';publish();}signal.throwIfAborted();}
    saved=value;failed=false;
  });
  const fromTokens=(t:GithubTokens,identity:Pick<Saved,'binding'|'user'>):Saved=>({v:1,clientId,...identity,scopes:t.scopes,accessToken:t.accessToken,refreshToken:t.refreshToken,expiresAt:t.expiresIn?now()+t.expiresIn*1000:0,refreshExpiresAt:t.refreshToken?now()+t.refreshExpiresIn*1000:0,refreshing:false});
  const message=(error:unknown)=>({GITHUB_DEVICE_DISABLED:'此 GitHub 应用尚未启用 Device Flow，请在应用设置中开启。',GITHUB_AUTH_DENIED:'你在 GitHub 中拒绝了授权。',GITHUB_AUTH_EXPIRED:'验证码已过期，请重新发起登录。',GITHUB_AUTH_START:'未能获取验证码，请检查 Client ID 和 GitHub 应用设置。',GITHUB_AUTH_USER:'未能确认 GitHub 用户信息，请重新登录。'})[(error as Error)?.message]??'登录未完成，请检查网络和 GitHub 应用设置后重试。';
  ctx.provide('github.deviceAuth',{
   status,
   async configure(value){check(value.revision);if(changing)throw Error('BUSY');if(value.clientId!==''&&!validGithubClient(value.clientId))throw Error('INVALID_INPUT');if(value.clientId===clientId&&!clientConfigInvalid)return;changing=true;invalidate();detail='正在保存 GitHub 登录应用…';publish();
    try{await serial(async()=>{await keys.set(githubDeviceScope,'');saved=undefined;await store.write('github-oauth-client',value.clientId);clientId=value.clientId;clientConfigInvalid=false;failed=false;detail='登录应用已保存，请发起 GitHub 授权。';});}catch{failed=true;detail='保存登录应用失败，请重试。';throw Error('UNAVAILABLE');}finally{changing=false;publish();}
   },
   async begin(value){check(value);if(changing||authorizing||refreshFlight)throw Error('BUSY');if(!clientId)throw Error('UNAVAILABLE');invalidate();authorizing=true;failed=false;detail='正在获取 GitHub 验证码…';publish();
    const signal=AbortSignal.any([owner.signal,ctx.abort.signal]),app=clientId;
    try{const device=await http.start(app,signal);signal.throwIfAborted();authorization={url:githubDeviceUrl,userCode:device.userCode,expiresAt:now()+device.expiresIn*1000};detail='请在系统浏览器输入验证码并确认 GitHub 授权。';publish();const expires=authorization.expiresAt;
     login=(async()=>{let interval=device.interval;while(now()<expires){await wait(Math.min(interval*1000,expires-now()),signal);signal.throwIfAborted();if(now()>=expires)break;
      let result;try{result=await http.poll(app,device.deviceCode,signal);}catch(error){signal.throwIfAborted();if((error as Error).message!=='GITHUB_AUTH_NETWORK')throw error;interval+=5;detail='网络暂时中断，仍在等待 GitHub 授权结果。';publish();continue;}
      if(now()>=expires)throw Error('GITHUB_AUTH_EXPIRED');if('pending' in result){if(result.interval!==undefined)interval=Math.max(interval+5,result.interval);continue;}
      const user=await http.user(result.accessToken,signal);signal.throwIfAborted();await persist(fromTokens(result,{binding:randomUUID(),user}),signal);signal.throwIfAborted();authorizing=false;authorization=undefined;revision=randomUUID();detail='GitHub 登录完成。';publish();return;
     }throw Error('GITHUB_AUTH_EXPIRED');})().catch(error=>{if(!signal.aborted){authorizing=false;authorization=undefined;failed=true;detail=message(error);revision=randomUUID();publish();}});
    }catch(error){if(!signal.aborted){authorizing=false;authorization=undefined;failed=true;detail=message(error);revision=randomUUID();publish();}else throw Error('CANCELLED');}
   },
   async open(value){check(value);if(!authorizing||!authorization||authorization.expiresAt<=now()||!options.open)throw Error('UNAVAILABLE');await options.open(githubDeviceUrl,authorization.userCode);},
   cancel(value){check(value);if(!authorizing)throw Error('CONFLICT');invalidate();detail='本次 GitHub 登录已取消。';publish();},
   async forget(value){check(value);if(changing)throw Error('BUSY');changing=true;invalidate();saved=undefined;failed=false;detail='正在清除本机 GitHub 登录…';publish();try{await serial(()=>keys.set(githubDeviceScope,''));failed=false;detail='本机 GitHub 登录已清除。';}catch{failed=true;detail='清除本机登录失败，请重试；重启可能恢复旧登录。';throw Error('UNAVAILABLE');}finally{changing=false;publish();}},
   credential(){if(!connected())throw Error('UNAVAILABLE');return prefix+saved!.binding;},
   available(value){return isGithubDeviceCredential(value)&&connected()&&value===prefix+saved!.binding;},
   async token(value,signal){signal.throwIfAborted();if(changing||!isGithubDeviceCredential(value)||!valid()||value!==prefix+saved!.binding)throw Error('GITHUB_LOGIN_REQUIRED');if(refreshFlight)return waiting(refreshFlight,signal);if(saved!.refreshing)throw Error('GITHUB_LOGIN_REQUIRED');
    if(!saved!.expiresAt||saved!.expiresAt>now()+60000)return saved!.accessToken;
    if(!saved!.refreshToken||saved!.refreshExpiresAt<=now()){if(saved!.expiresAt>now())return saved!.accessToken;throw Error('GITHUB_LOGIN_REQUIRED');}
    const old=saved!,refreshSignal=AbortSignal.any([owner.signal,ctx.abort.signal]);
    const task=(async()=>{await persist({...old,refreshing:true},refreshSignal);detail='正在刷新 GitHub 登录…';const result=await http.refresh(old.clientId,old.refreshToken,refreshSignal);await persist(fromTokens(result,old),refreshSignal);return saved!.accessToken;})().catch(error=>{if(!refreshSignal.aborted){if(saved?.binding===old.binding)saved={...saved,refreshing:true};failed=true;detail='登录刷新结果未确认，请重新登录；未发出 GitHub 工具请求。';publish();}throw Error('GITHUB_LOGIN_REQUIRED');});
    refreshFlight=task;publish();void task.finally(()=>{if(refreshFlight===task){refreshFlight=undefined;publish();}}).catch(()=>{});return waiting(task,signal);
   },
  });
  ctx.effect(async()=>{owner.abort();await login;await refreshFlight?.catch(()=>{});await queue;});
 },});
}
