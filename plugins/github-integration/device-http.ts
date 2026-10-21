export const githubDeviceUrl = 'https://github.com/login/device';
export const githubScopes = ['repo', 'read:org', 'gist'];
export const validGithubClient = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(v);
export const githubSecret = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 8000 && !/[\s\x00-\x1f]/.test(v);
const lifetime = (v: unknown, max: number): v is number => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= max;
export interface GithubTokens { accessToken: string; refreshToken: string; expiresIn: number; refreshExpiresIn: number; scopes: string[]; }
function tokens(v: Record<string, any>): GithubTokens {
  const scopes = typeof v.scope === 'string' ? v.scope.split(/[ ,]+/).filter(Boolean) : [];
  if (!githubSecret(v.access_token) || v.token_type !== 'bearer' || scopes.length > 100 || scopes.some(s=>!/^[a-zA-Z0-9_:-]{1,100}$/.test(s)) ||
      v.expires_in !== undefined && !lifetime(v.expires_in, 366*86400) ||
      v.refresh_token !== undefined && (!githubSecret(v.refresh_token) || !lifetime(v.refresh_token_expires_in, 366*86400) || !lifetime(v.expires_in, 366*86400))) throw Error('GITHUB_AUTH_RESPONSE');
  return {accessToken:v.access_token,refreshToken:v.refresh_token??'',expiresIn:v.expires_in??0,refreshExpiresIn:v.refresh_token?v.refresh_token_expires_in:0,scopes};
}
/** 固定 GitHub.com 端点；设备码、访问/刷新令牌不经界面和模型传递。 */
export function githubDeviceHttp(fetcher: typeof fetch = fetch) {
  async function request(url: string, init: RequestInit, signal: AbortSignal) {
    signal.throwIfAborted();
    try {
      const response=await fetcher(url,{...init,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
      if(!response.body)throw Error();const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>65536)throw Error();chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});}
      const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!data||typeof data!=='object'||Array.isArray(data))throw Error();
      signal.throwIfAborted();return {data:data as Record<string,any>,ok:response.ok};
    }catch{signal.throwIfAborted();throw Error('GITHUB_AUTH_NETWORK');}
  }
  const post=(path:string,body:Record<string,string>,signal:AbortSignal)=>request('https://github.com'+path,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body).toString()},signal);
  return {
    async start(clientId:string,signal:AbortSignal){
      const {data,ok}=await post('/login/device/code',{client_id:clientId,scope:githubScopes.join(' ')},signal);
      if(!ok||data.error||!githubSecret(data.device_code)||typeof data.user_code!=='string'||!/^[A-Z0-9-]{6,32}$/.test(data.user_code)||data.verification_uri!==githubDeviceUrl||!lifetime(data.expires_in,3600)||data.interval!==undefined&&!lifetime(data.interval,60))throw Error(data.error==='device_flow_disabled'?'GITHUB_DEVICE_DISABLED':'GITHUB_AUTH_START');
      return {deviceCode:data.device_code as string,userCode:data.user_code as string,expiresIn:data.expires_in as number,interval:(data.interval??5) as number};
    },
    async poll(clientId:string,deviceCode:string,signal:AbortSignal):Promise<GithubTokens|{pending:true;interval?:number}>{
      const {data,ok}=await post('/login/oauth/access_token',{client_id:clientId,device_code:deviceCode,grant_type:'urn:ietf:params:oauth:grant-type:device_code'},signal);
      if(data.error==='authorization_pending')return {pending:true};
      if(data.error==='slow_down'){if(data.interval!==undefined&&!lifetime(data.interval,86400))throw Error('GITHUB_AUTH_RESPONSE');return {pending:true,interval:data.interval??0};}
      if(data.error==='access_denied')throw Error('GITHUB_AUTH_DENIED');
      if(['expired_token','token_expired'].includes(data.error))throw Error('GITHUB_AUTH_EXPIRED');
      if(!ok||data.error)throw Error('GITHUB_AUTH_POLL');return tokens(data);
    },
    async user(token:string,signal:AbortSignal){
      const {data,ok}=await request('https://api.github.com/user',{headers:{Accept:'application/vnd.github+json','User-Agent':'Familiar/0.3',Authorization:'Bearer '+token}},signal);
      if(!ok||!Number.isSafeInteger(data.id)||data.id<1||typeof data.login!=='string'||!/^[A-Za-z0-9-]{1,100}$/.test(data.login))throw Error('GITHUB_AUTH_USER');
      return {id:data.id as number,login:data.login as string};
    },
    async refresh(clientId:string,refreshToken:string,signal:AbortSignal){
      const {data,ok}=await post('/login/oauth/access_token',{client_id:clientId,grant_type:'refresh_token',refresh_token:refreshToken},signal);
      if(!ok||data.error)throw Error('GITHUB_AUTH_REFRESH');return tokens(data);
    },
  };
}
