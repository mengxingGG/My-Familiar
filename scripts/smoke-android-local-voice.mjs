import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
const app='app.familiar.mobile.debug',out='.artifacts/android-device',results=[];
const adb=(...a)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...a],{encoding:'utf8',windowsHide:true,maxBuffer:40*1024*1024}).trim();
const pause=ms=>new Promise(r=>setTimeout(r,ms)); let browser,page,before,conversation,n=0,response='';
let cloudSpeech=0,apkSha; const cacheBefore=new Set(),createdCache=new Set();
const server=createServer(async(req,res)=>{for await(const _ of req){} if(req.url.endsWith('/speech')){cloudSpeech++;res.writeHead(500);res.end();return;} res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content:response},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;adb('reverse',`tcp:${port}`,`tcp:${port}`);
async function attach(){await browser?.close();browser=null;adb('shell','am','start','-n',`${app}/app.familiar.mobile.MainActivity`);for(let i=0;i<60;i++){try{adb('forward','tcp:9237',`localabstract:webview_devtools_remote_${adb('shell','pidof',app)}`);browser=await chromium.connectOverCDP('http://127.0.0.1:9237');page=browser.contexts()[0].pages()[0];if(page)break;}catch{}await pause(250);}assert(page);await page.locator('#familiar-root[data-ready="true"]').waitFor();}
const raw=(method,params)=>page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:`tts-smoke-${++n}`,method,params});
async function call(method,params){const r=await raw(method,params);assert(r.ok,`${method}: ${r.error?.code}`);return r.result;}
async function until(check,timeout=20000){let s;for(let end=Date.now()+timeout;Date.now()<end;){s=await call('snapshot.get');if(check(s))return s;await pause(80);}throw Error('TTS timeout '+JSON.stringify(s?.voice?.state));}
const pass=name=>{results.push(name);console.log('PASS '+name);};
const files=()=>adb('shell','run-as',app,'ls','files/voice-cache').split(/\s+/).filter(f=>/^[a-f0-9]{64}\.json$/.test(f));
async function reply(text){response=text;await call('message.send',{conversationId:conversation,text:'系统朗读验收 '+n});const s=await until(s=>!s.activeReply&&s.conversations.some(c=>c.id===conversation&&c.messages.some(m=>m.role==='assistant'&&m.text===text&&m.status==='complete')));return s.conversations.find(c=>c.id===conversation).messages.findLast(m=>m.role==='assistant').id;}
const read=id=>call('voice.read',{conversationId:conversation,messageId:id});
async function released(){ for(let i=0;i<30;i++){if(!adb('shell','dumpsys','activity','services',app).includes('VoiceService')) return;await pause(100);}throw Error('VoiceService still running after stop'); }
const stopped=s=>['off','error'].includes(s.voice.state.phase)&&!s.voice.state.active;
try{
 await attach();before=await call('snapshot.get');apkSha=adb('shell','sha256sum',adb('shell','pm','path',app).replace(/^package:/,'')).split(/\s/)[0];assert(before.voice.localTts);assert(!before.voice.settings.tts.keyConfigured&&!before.voice.settings.stt.keyConfigured&&!before.provider.keyConfigured);
 await writeFile(`${out}/tts-before.json`,JSON.stringify(before));for(const f of files())cacheBefore.add(f);
 const catalog=await call('voice.local.catalog');const zh=catalog.voices.find(v=>v.name.endsWith(' · cmn')),en=catalog.voices.find(v=>v.name.endsWith(' · en-us'));assert(zh&&en);pass('真实系统引擎返回已安装中英文音色');
 assert(!(await raw('tts.start',{operationId:'ignored',text:'not public'})).ok);assert(!(await raw('tts.poll',{operationId:'ignored'})).ok);pass('公开 WebView 拒绝私有合成任务和文件通道');
 const settings={...before.voice.settings,tts:{...before.voice.settings.tts,kind:'system',baseUrl:"http://127.0.0.1:"+port+"/v1",model:'must-not-call-cloud',voice:zh.id,speed:1,stream:false},autoRead:false,continuous:false};
 await call('voice.save',settings);await call('provider.save',{kind:'compatible',baseUrl:`http://127.0.0.1:${port}/v1`,model:'local-tts-fixture'});conversation=(await call('conversation.create')).id;
 let chinese;
 for(const [name,voice,text] of [['zh',zh,'你好，我是灵伴。这是系统本地中文朗读测试。'],['en',en,'Hello. I am Familiar. This is a local Android speech synthesis test.']]){
   settings.tts.voice=voice.id;await call('voice.save',settings);const id=await reply(text);if(name==='zh')chinese=id;
   const old=new Set(files());await read(id);await until(s=>s.voice.state.phase==='speaking');assert(adb('shell','dumpsys','activity','services',app).includes('VoiceService'));
   const done=await until(stopped,30000);assert.equal(done.voice.state.phase,'off');
   const fresh=files().filter(f=>!old.has(f));assert.equal(fresh.length,1);createdCache.add(fresh[0]);const entry=JSON.parse(adb('shell','run-as',app,'cat',`files/voice-cache/${fresh[0]}`));const wav=Buffer.from(entry.data,'base64');assert.equal(entry.mimeType,'audio/wav');assert.equal(wav.toString('ascii',0,4),'RIFF');assert(wav.length>10000);assert(wav.subarray(44).some(v=>v!==0));
   await writeFile(`${out}/tts-${name}.wav`,wav);await writeFile(`${out}/tts-${name}-audio.json`,JSON.stringify({bytes:wav.length,sha256:createHash('sha256').update(wav).digest('hex'),rate:wav.readUInt32LE(24),channels:wav.readUInt16LE(22),bits:wav.readUInt16LE(34)}));
   pass(`${name} 实际合成非空 WAV，经 MediaPlayer 播放并收到结束回执`);
 }
 settings.tts.voice=zh.id;await call('voice.save',settings);await read(chinese);await until(s=>s.voice.state.phase==='speaking');await call('voice.stop');await until(s=>s.voice.state.phase==='off');await pause(400);await released();pass('缓存朗读可停止，释放播放器与语音前台服务');
 const long=await reply('这是一段用于取消的本地语音合成。'.repeat(150));await read(long);await until(s=>['thinking','speaking'].includes(s.voice.state.phase));await call('voice.stop');await until(s=>s.voice.state.phase==='off');await pause(600);assert.equal(adb('shell','run-as',app,'ls','files/tts-inbox'),'');await released();pass('长文本处理中取消后无迟到播放，私有合成文件清空');
 adb('shell','am','force-stop',app);await attach();const restarted=await call('snapshot.get');assert.equal(restarted.voice.settings.tts.kind,'system');assert.equal(restarted.voice.settings.tts.voice,zh.id);await read(chinese);await until(s=>s.voice.state.phase==='speaking');await call('voice.stop');await until(s=>s.voice.state.phase==='off');pass('进程重启保留系统音色设置，缓存回放仍经共享语音流程');
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByText('语音连接',{exact:true}).click();await page.getByRole('button',{name:'刷新设备音色',exact:true}).click();await page.locator('[name=tts-local-voice] option').filter({hasText:'中文 · cmn'}).waitFor({state:'attached'});await page.locator('.local-voice-note').filter({hasText:'使用 eSpeak'}).waitFor();await page.locator('[name=tts-local-voice]').selectOption(zh.id);await page.screenshot({path:`${out}/tts-local-ui.png`});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));pass('实际 Android 界面显示本地音色且无横向溢出');
 if(process.argv.includes('--remove-test-engine')){
   const path=adb('shell','pm','path','com.reecedunn.espeak').replace(/^package:/,'');const hash=adb('shell','sha256sum',path).split(/\s/)[0];assert.equal(hash,createHash('sha256').update(await readFile('.artifacts/android-tts/espeak-1.52.0-signed.apk')).digest('hex'));
   assert.equal(adb('uninstall','com.reecedunn.espeak'),'Success');assert.equal((await call('voice.local.catalog')).voices.length,0);await read(chinese);const s=await until(stopped);assert.equal(s.voice.state.phase,'error');await pause(400);await released();pass('卸载测试引擎后音色目录为空，相同文字不能绕过检查回放缓存');
 }
 assert.equal(cloudSpeech,0);
}finally{
 try{if(before){if(!browser?.isConnected()||page?.isClosed())await attach();await call('voice.stop');await call('reply.cancel');await call('voice.save',before.voice.settings);await call('provider.save',before.provider);if(before.activeConversationId)await call('conversation.select',{id:before.activeConversationId});if(conversation)await call('conversation.delete',{id:conversation});for(const f of files())if(!cacheBefore.has(f))createdCache.add(f);for(const f of createdCache){assert(/^[a-f0-9]{64}\.json$/.test(f));adb('shell','run-as',app,'rm',`files/voice-cache/${f}`);}}}catch(e){console.error('RESTORE FAILED',e);process.exitCode=1;}
 await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));adb('reverse','--remove',`tcp:${port}`);
 await writeFile(`${out}/tts-smoke.json`,JSON.stringify({date:new Date().toISOString(),results,cloudSpeech,apkSha},null,2));
}
