import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { keywordEncoder, WakeCapture } from "../plugins/platform-android/wake.ts";
import { bootstrapAndroid } from "../apps/tauri/runtime/bootstrap.ts";
import { mobileApi } from "../apps/tauri/runtime/mobile-api.ts";
import type { AndroidNative } from "../plugins/platform-android/index.ts";
import type { MobileRequest } from "../packages/mobile-bridge/index.ts";
import { pcmWav } from "../plugins/voice-session/audio.ts";

const tokenText = await readFile(new URL('./fixtures/wake-tokens.txt', import.meta.url), 'utf8');
const lexicon = 'LIGHT L AY1 T\nUP AH1 P\nLOVELY L AH1 V L IY0\nCHILD CH AY1 L D\n';
const speech = Buffer.alloc(4800); for(let i=0;i<2400;i++) speech.writeInt16LE(Math.round(Math.sin(i*.13)*5000),i*2);
test('Android 唤醒词：上游中英音素一致，未知词和关键词语法不能注入', () => {
  const encode = keywordEncoder(tokenText, lexicon);
  assert.deepEqual(encode(['文森特卡索','周望军','女儿','LIGHT UP']).map(p=>p.tokens), [
    ['w','én','s','ēn','t','è','k','ǎ','s','uǒ'], ['zh','ōu','w','àng','j','ūn'], ['n','ǚ','ér'], ['L','AY1','T','AH1','P']
  ]);
  assert.deepEqual(encode(['小森'])[0].tokens,['x','iǎo','s','ēn']);
  for(const value of [[],['小森','小森'],['小森/@k0'],['小森\n#0'],['notinlexicon'],['123'],['小森'.repeat(21)],Array(9).fill('词')]) assert.throws(()=>encode(value),/INVALID_INPUT/);
});

test('唤醒交接：命中前不输出、只保留两秒、命中后等静音、超长拒绝截断', () => {
  const capture = new WakeCapture();
  for(let i=0;i<50;i++) assert.equal(capture.push(speech),undefined);
  assert.equal(capture.push(speech,'小森'),undefined);
  let result; for(let i=0;i<7;i++) result=capture.push(Buffer.alloc(4800));
  assert.equal(result?.text,'小森'); assert.equal(result?.audio.data.length,28*4800); assert.equal(result?.audio.rate,24000);
  const long = new WakeCapture(); long.push(speech,'小森'); assert.throws(()=>{for(let i=0;i<90;i++) long.push(speech);},/WAKE_TOO_LONG/);
});

test('Android 唤醒接入共享语音：显式开启、会话绑定、转写交接、停止/旧回调隔离及重启不自启', async () => {
  const root=await mkdtemp(resolve('.artifacts/android-wake-core-')); await mkdir(join(root,'engine/wake'),{recursive:true});
  await writeFile(join(root,'engine/wake/tokens.txt'),tokenText); await writeFile(join(root,'engine/wake/en.phone'),lexicon);
  const events:any[]=[]; let api:ReturnType<typeof mobileApi>,seq=0,stt=0,chat=0,tts=0;
  const keys:Record<string,string>={};
  const server=createServer(async(req,res)=>{
    if(req.url?.endsWith('/models')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'chat',context_length:32768}]}));return;}
    const parts:Buffer[]=[];for await(const part of req) parts.push(part); const body=Buffer.concat(parts);
    if(req.url?.endsWith('/transcriptions')){stt++;assert(body.includes(Buffer.from('RIFF')));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({text:'小森，测试唤醒后的对话。'}));}
    else if(req.url?.endsWith('/speech')){tts++;res.setHeader('Content-Type','audio/wav');res.end(pcmWav(new Uint8Array(4800)));}
    else{chat++;const messages=JSON.parse(body.toString()).messages;assert(messages.some((v:any)=>v.role==='user'&&v.content==='测试唤醒后的对话。'));res.setHeader('Content-Type','text/event-stream');res.end('data: {"choices":[{"delta":{"content":"已进入共享语音会话。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');}
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r)); const address=server.address();assert(address&&typeof address!=='string'); const baseUrl=`http://127.0.0.1:${address.port}/v1`;
  const native:AndroidNative={async call<T>(method:string,p:any={}){
    events.push({method,...p});
    if(method==='secrets.readAll')return {...keys} as T;
    if(method==='secrets.write'){if(p.value)keys[p.name]=p.value;else delete keys[p.name];}
    if(method==='runtime.status')return {running:true,overlayVisible:true,engine:'ready',detail:'fixture'} as T;
    if(method==='capabilities.status')return [{id:'microphone',state:'granted',title:'麦克风',description:'fixture',detail:'fixture'}] as T;
    if(method==='wake.listen')setTimeout(()=>void call('voice.wake.host',{sessionId:p.sessionId,operationId:p.operationId,type:'ready'}),0);
    if(method==='audio.command'&&p.type==='listen')setTimeout(()=>void call('voice.host',{epoch:p.epoch,type:'listening'}),0);
    if(method==='audio.command'&&p.type==='play'){await rm(join(root,'voice-outbox',`${p.token}.audio`),{force:true});setTimeout(()=>void call('voice.host',{epoch:p.epoch,playback:p.playback,id:p.id,type:'playing-end'}),0);}
    return null as T;
  }};
  let kernel=await bootstrapAndroid(root,resolve('.'),native); api=mobileApi(kernel,native);
  async function raw(method:MobileRequest['method'],params?:unknown){return api({protocolVersion:1,id:`wake-${++seq}`,method,params});}
  async function call(method:MobileRequest['method'],params?:unknown):Promise<any>{const r=await raw(method,params);assert(r.ok,`${method}: ${r.error?.code}`);return r.result;}
  async function until(predicate:(s:any)=>boolean){for(let i=0;i<250;i++){const s=await call('snapshot.get');if(predicate(s))return s;await new Promise(r=>setTimeout(r,10));}throw Error('wake timeout '+JSON.stringify(kernel.resolve('voice.session').state()));}
  try{
    await call('voice.save',{stt:{kind:'compatible',baseUrl,model:'stt'},tts:{kind:'compatible',baseUrl,model:'tts',voice:'test',speed:1},autoRead:false,continuous:true});
    await call('provider.save',{kind:'compatible',baseUrl,model:'chat'});
    const conversationId=(await call('conversation.create')).id;
    await call('voice.wake.save',{enabled:true,phrases:['小森'],sensitivity:50});
    assert(!events.some(e=>e.method==='wake.enable'||e.method==='wake.listen'));
    assert.equal((await raw('voice.wake.start',{conversationId})).error?.code,'UNAVAILABLE');
    assert.equal((await raw('voice.wake.start',{conversationId,foregroundAt:Date.now()-6000})).error?.code,'UNAVAILABLE');
    await call('voice.wake.start',{conversationId,foregroundAt:Date.now()});
    await until(s=>s.voice.wake.listening&&s.voice.state.phase==='sleeping');
    assert.equal((await raw('conversation.create')).error?.code,'BUSY');
    assert.equal((await raw('voice.save',{})).error?.code,'BUSY');
    const operation=events.findLast(e=>e.method==='wake.listen');
    const feed=(data:Buffer,hit?:string,op=operation)=>call('voice.wake.host',{sessionId:op.sessionId,operationId:op.operationId,type:'pcm',data:data.toString('base64'),hit});
    for(let i=0;i<30;i++)await feed(speech);
    assert.equal(stt,0);assert.equal(chat,0);assert.equal(tts,0);
    await feed(speech,'小森');for(let i=0;i<7;i++)await feed(Buffer.alloc(4800));
    await until(s=>s.voice.state.active&&s.voice.state.phase==='listening'&&s.conversations.some((c:any)=>c.id===conversationId&&c.messages.some((m:any)=>m.role==='assistant'&&m.status==='complete')));
    assert.equal(stt,1);assert.equal(chat,1);assert.equal(tts,1);
    await call('voice.stop');assert(!(await call('snapshot.get')).voice.wake.armed);
    await feed(speech,'小森');for(let i=0;i<8;i++)await feed(Buffer.alloc(4800));await new Promise(r=>setTimeout(r,30));assert.equal(stt,1);
    await call('voice.wake.start',{conversationId,foregroundAt:Date.now()});await until(s=>s.voice.wake.listening);
    const current=events.findLast(e=>e.method==='wake.listen');
    await call('voice.wake.host',{sessionId:operation.sessionId,type:'error'});assert((await call('snapshot.get')).voice.wake.armed);
    await call('voice.wake.host',{sessionId:current.sessionId,type:'error'});await until(s=>!s.voice.wake.armed);
    await call('voice.stop');
    const starts=events.filter(e=>e.method==='wake.enable'||e.method==='wake.listen').length;
    await kernel.dispose();kernel=await bootstrapAndroid(root,resolve('.'),native);api=mobileApi(kernel,native);
    const after=await call('snapshot.get');assert(after.voice.wake.enabled);assert(!after.voice.wake.armed&&!after.voice.state.active);
    assert.equal(events.filter(e=>e.method==='wake.enable'||e.method==='wake.listen').length,starts);
  }finally{await kernel.dispose();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
});
