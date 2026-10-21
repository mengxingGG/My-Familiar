import test from 'node:test';
import assert from 'node:assert/strict';
import {githubDeviceHttp} from '../plugins/github-integration/device-http.ts';
const signal=()=>new AbortController().signal;
const device={device_code:'private-device-code',user_code:'ABCD-EFGH',verification_uri:'https://github.com/login/device',expires_in:900,interval:5};
const tokens={access_token:'gho_fixture_access',refresh_token:'ghr_fixture_refresh',expires_in:28800,refresh_token_expires_in:15897600,token_type:'bearer',scope:'repo,read:org'};

test('GitHub OAuth HTTP 固定端点、有效范围和秘密仅进入官方请求',async()=>{
 const records:Request[]=[];const http=githubDeviceHttp(async(input,init)=>{const req=new Request(input,init);records.push(req);assert.equal(req.redirect,'error');return new Response(JSON.stringify(req.url.endsWith('/device/code')?device:tokens));});
 assert.equal((await http.start('Ov23_fixture',signal())).interval,5);assert.equal((await http.poll('Ov23_fixture','private-code',signal()) as any).accessToken,tokens.access_token);assert.equal((await http.refresh('Ov23_fixture','private-refresh',signal())).refreshToken,tokens.refresh_token);
 for(const r of records){const body=new URLSearchParams(await r.text());assert.equal(body.get('client_id'),'Ov23_fixture');assert(!body.has('client_secret'));assert(!r.url.includes('private'));assert.equal(r.headers.get('Accept'),'application/json');}
});

test('GitHub OAuth 拒绝外部验证地址、坏代码、无效/过大响应及头返回后的中断',async()=>{
 for(const response of [{...device,verification_uri:'https://foreign.invalid/login'}, {...device,user_code:'<script>'},{...device,expires_in:-1},{...device,interval:0}])await assert.rejects(githubDeviceHttp(async()=>new Response(JSON.stringify(response))).start('fixture',signal()),/GITHUB_AUTH_START/);
 await assert.rejects(githubDeviceHttp(async()=>new Response('x'.repeat(65537))).start('fixture',signal()),/GITHUB_AUTH_NETWORK/);
 const abort=new AbortController();let cancelled=false;
 const http=githubDeviceHttp(async(_input,init)=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));init?.signal?.addEventListener('abort',()=>{cancelled=true;c.error(Error('aborted'));},{once:true});}})));
 const waiting=assert.rejects(http.start('fixture',abort.signal));setTimeout(()=>abort.abort(),10);await waiting;assert(cancelled);
});

test('GitHub OAuth pending、slow_down、拒绝、过期与轮换响应不会伪装成功',async()=>{
 for(const [error,expected] of [['authorization_pending','pending'],['slow_down','pending'],['access_denied','GITHUB_AUTH_DENIED'],['expired_token','GITHUB_AUTH_EXPIRED'],['incorrect_client_credentials','GITHUB_AUTH_POLL']]){
  const http=githubDeviceHttp(async()=>new Response(JSON.stringify({error})));if(expected==='pending')assert('pending' in await http.poll('fixture','private',signal()));else await assert.rejects(http.poll('fixture','private',signal()),new RegExp(expected));
 }
 const slow=await githubDeviceHttp(async()=>new Response(JSON.stringify({error:'slow_down',interval:5000}))).poll('fixture','private',signal());assert.deepEqual(slow,{pending:true,interval:5000});
 for(const value of [{...tokens,access_token:'bad\nheader'},{...tokens,expires_in:undefined},{...tokens,refresh_token_expires_in:0}])await assert.rejects(githubDeviceHttp(async()=>new Response(JSON.stringify(value))).refresh('fixture','private',signal()),/GITHUB_AUTH_RESPONSE/);
 const long=await githubDeviceHttp(async()=>new Response(JSON.stringify({access_token:'gho_fixture_long_lived',token_type:'bearer',scope:''}))).poll('fixture','private',signal());assert.equal((long as any).expiresIn,0);
});
