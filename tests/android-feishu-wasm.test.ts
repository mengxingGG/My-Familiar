import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readdir,rm} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {Worker} from 'node:worker_threads';
import {wasmFeishuRunner} from '../plugins/feishu-android/wasm-runner.ts';

async function fixture(timeoutMs=3000) {
  const base=resolve('.artifacts');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'office-wasm-runner-'));
  const script=join(root,'worker.cjs');
  await writeFile(script,`const{parentPort,workerData}=require('node:worker_threads');const p=JSON.parse(workerData.payload),mode=p.stdin;
const result=(code=0,output='',errors='')=>parentPort.postMessage({kind:'result',code,output,errors});
if(mode==='hang')setInterval(()=>{},1000);
else if(mode==='crash')process.exit(139);
else if(mode==='panic')result(2,'','panic: local failure\\n');
else if(mode==='validation')result(2,'','INPUT_JSON_INVALID\\n');
else if(mode==='large')result(0,'x'.repeat(1100000));
else if(mode==='inspect')result(0,JSON.stringify({p,envToken:process.env.LARKSUITE_CLI_USER_ACCESS_TOKEN,options:process.env.NODE_OPTIONS,scopes:workerData.scopes,argv:process.argv.slice(2)}),p.token);
else{
parentPort.on('message',m=>{if(m.kind==='http.result')result(0,JSON.stringify({status:m.status,error:m.error,body:m.body?Buffer.from(m.body).toString('utf8'):''}));});
parentPort.postMessage({kind:'http',id:'query-1',url:mode==='foreign'?'https://foreign.invalid/data':'https://open.feishu.cn/open-apis/calendar/v4/calendars',method:'GET',headers:[['Authorization','Bearer '+p.token]]});}
`);
  let workers=0;const network:RequestInit[]=[],urls:string[]=[];let hang=false,cancelled=0,broken=false,tooLarge=false;
  const runner=wasmFeishuRunner({assets:root,addon:join(root,'lib.so'),workspace:join(root,'workspace'),configuration:join(root,'config'),temporary:join(root,'tmp'),timeoutMs,
    createWorker(file,options){workers++;assert.equal(file,script);return new Worker(file,options);},
    fetcher:async(url,options)=>{urls.push(String(url));network.push(options!);assert.equal(options!.redirect,'manual');if(broken)throw Error('connection lost after request');if(tooLarge)return new Response(new Uint8Array(32*1024*1024+1));if(hang)return await new Promise<Response>((_,reject)=>{options!.signal!.addEventListener('abort',()=>{cancelled++;reject(Error('cancelled'));},{once:true});});return new Response('{"ok":true}',{status:200});},
  });
  const input={args:['calendar','calendars','list'],appId:'cli_0123456789abcdef',identity:'bot' as const,token:'test-only-token'};
  return {root,runner,input,network,urls,counts:()=>({workers,cancelled}),hold:()=>{hang=true;},breakNetwork:()=>{broken=true;},oversized:()=>{tooLarge=true;},async cleanup(){assert.equal(dirname(root),base);await rm(root,{recursive:true,force:true});}};
}
test('Wasm 执行器隔离参数/凭据、限制认证来源、保持普通参数错误分类',async()=>{
  const f=await fixture();try{
    const inspect=await f.runner({...f.input,stdin:'inspect'},new AbortController().signal);assert.equal(inspect.code,0);assert(!JSON.stringify(inspect).includes(f.input.token));const actual=JSON.parse(inspect.output);assert.equal(actual.p.workspace,'/workspace');assert.equal(actual.envToken,undefined);assert.equal(actual.options,undefined);assert.deepEqual(actual.argv,[]);assert.equal(actual.scopes.workspace,join(f.root,'workspace'));assert.equal(dirname(actual.scopes.tmp),join(f.root,'tmp'));
    const call=await f.runner(f.input,new AbortController().signal);assert.equal(call.code,0);assert.equal(JSON.parse(call.output).status,200);assert.equal(f.network.length,1);assert.equal(new Headers(f.network[0].headers).get('authorization'),'Bearer '+f.input.token);
    const rejected=await f.runner({...f.input,stdin:'foreign'},new AbortController().signal);assert.equal(JSON.parse(rejected.output).error,'FEISHU_HTTP_FAILED');assert.equal(f.network.length,1);
    const validation=await f.runner({...f.input,stdin:'validation'},new AbortController().signal);assert.equal(validation.code,2);assert.equal(validation.interrupted,undefined);
    assert.throws(()=>f.runner({...f.input,args:['auth','login']},new AbortController().signal));assert.equal(f.counts().workers,4);assert.deepEqual(await readdir(join(f.root,'tmp')),[]);
  }finally{await f.cleanup();}
});
test('Wasm 取消、排队、超时、崩溃和输出超限不重放，网络请求一同取消',async()=>{
  const f=await fixture(450);try{
    const timed=await f.runner({...f.input,stdin:'hang'},new AbortController().signal);assert.equal(timed.interrupted,'timeout');
    const cancel=new AbortController(),active=f.runner({...f.input,stdin:'hang'},cancel.signal),waiting=f.runner(f.input,cancel.signal);const refused=assert.rejects(waiting);await new Promise(resolve=>setTimeout(resolve,120));cancel.abort();assert.equal((await active).interrupted,'cancelled');await refused;
    for(const [mode,expected] of [['crash','process-failed'],['panic','process-failed'],['large','output-limit']])assert.equal((await f.runner({...f.input,stdin:mode},new AbortController().signal)).interrupted,expected);
    f.hold();const networkCancel=new AbortController(),pending=f.runner(f.input,networkCancel.signal);for(let n=0;n<100&&!f.network.length;n++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.network.length,1);networkCancel.abort();assert.equal((await pending).interrupted,'cancelled');for(let n=0;n<30&&!f.counts().cancelled;n++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.counts().cancelled,1);assert.equal(f.counts().workers,6);assert.deepEqual(await readdir(join(f.root,'tmp')),[]);
  }finally{await f.cleanup();}
});
test('Wasm 发出后网络中断标记结果未知且不重试，响应体按上限停止',async()=>{
  const a=await fixture(),b=await fixture();try{
    a.breakNetwork();const failed=await a.runner(a.input,new AbortController().signal);assert.equal(failed.interrupted,'process-failed');assert.equal(a.network.length,1);assert.equal(a.counts().workers,1);
    b.oversized();const large=await b.runner(b.input,new AbortController().signal);assert.equal(large.interrupted,'output-limit');assert.equal(b.network.length,1);assert.equal(b.counts().workers,1);assert.deepEqual(await readdir(join(b.root,'tmp')),[]);
  }finally{await a.cleanup();await b.cleanup();}
});
