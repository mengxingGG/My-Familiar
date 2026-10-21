import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync,spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const adbPath='C:/AndroidSDK/platform-tools/adb.exe',args=['-s','emulator-5554'];
const adb=(...a)=>execFileSync(adbPath,[...args,...a],{encoding:'utf8',windowsHide:true}).trim();
const out='.artifacts/android-device',requests=[],errors=[];
const wav=Buffer.alloc(44+9600);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(9600,40);
const server=createServer(async(req,res)=>{try{
 const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);requests.push({path:req.url,bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')});
 if(req.url.endsWith('/models')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'replay-chat',context_length:32768}]}));}
 else if(req.url.endsWith('/transcriptions')){assert(body.includes(Buffer.from('RIFF')));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({text:'周望军，请确认这是一条唤醒回放测试。'}));}
 else if(req.url.endsWith('/speech')){assert(JSON.parse(body.toString()).input.includes('回放'));res.setHeader('Content-Type','audio/wav');res.end(wav);}
 else{const messages=JSON.parse(body.toString()).messages;assert(messages.some(m=>m.role==='user'&&m.content==='请确认这是一条唤醒回放测试。'));res.setHeader('Content-Type','text/event-stream');res.end('data: {"choices":[{"delta":{"content":"设备回放已进入共享对话。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');}
 }catch(e){errors.push(String(e));res.statusCode=500;res.end('{}');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;adb('reverse',`tcp:${port}`,`tcp:${port}`);
const apk='plugins/platform-android/android/build/outputs/apk/androidTest/debug/tauri-plugin-familiar-android-debug-androidTest.apk';let installed=false,output='';
try{
 adb('install','-r',apk);installed=true;adb('shell','pm','grant','app.familiar.platform.test','android.permission.RECORD_AUDIO');adb('shell','pm','grant','app.familiar.platform.test','android.permission.POST_NOTIFICATIONS');
 const result=await new Promise(resolve=>{const process=spawn(adbPath,[...args,'shell','am','instrument','-w','-r','-e','fixturePort',String(port),'-e','class','app.familiar.platform.WakeReplayTest','app.familiar.platform.test/androidx.test.runner.AndroidJUnitRunner'],{windowsHide:true});process.stdout.on('data',d=>{output+=d;});process.stderr.on('data',d=>{output+=d;});process.on('exit',code=>resolve(code));});
 await writeFile(out+'/wake-replay-device.log',output);assert.equal(result,0);assert.match(output,/OK \(1 test\)/);assert.deepEqual(errors,[]);
 assert.equal(requests.filter(r=>r.path.endsWith('/transcriptions')).length,1);assert.equal(requests.filter(r=>r.path.endsWith('/speech')).length,1);assert.equal(requests.filter(r=>r.path.endsWith('/chat/completions')).length,1);
 const bytes=await readFile(apk);await writeFile(out+'/wake-replay-smoke.json',JSON.stringify({testApkSha:createHash('sha256').update(bytes).digest('hex'),requests,errors,checks:['actual ARM64 keyword detection','private native IPC and Android Node core','wake phrase removed before shared model request','native TTS file playback and background return to listening','stop and stale event isolation'],limitations:['prerecorded input; HTTP transcription and model are local fixtures, not real cloud services']},null,2));console.log('PASS 真实 ARM64 模型 → 私有 IPC → Android Node → 转写/对话/朗读夹具 → 原生播放；停止后旧事件隔离');
}finally{if(installed)adb('uninstall','app.familiar.platform.test');adb('reverse','--remove',`tcp:${port}`);server.closeAllConnections();await new Promise(r=>server.close(r));}
