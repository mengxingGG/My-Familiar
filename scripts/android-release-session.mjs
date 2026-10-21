import {spawn,execFileSync} from 'node:child_process';
import {writeFile,unlink,access} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
const adb='C:/AndroidSDK/platform-tools/adb.exe',file='.artifacts/android-1.0/probe-session.json',forwardPort=9291;
const run=(...args)=>execFileSync(adb,['-s','emulator-5554',...args],{encoding:'utf8',windowsHide:true,timeout:30000}).trim();
try{await access(file);throw Error('已有验收会话，先结束原会话。');}catch(error){if(error.code!=='ENOENT')throw error;}
if(run('forward','--list').includes('tcp:'+forwardPort))throw Error('验收端口已被占用');
run('install','-r',process.env.FAMILIAR_PROBE_OBSERVER==='1'?'.artifacts/android-1.0/release-probe-observer/probe.apk':process.env.FAMILIAR_PROBE_DEBUG==='1'?'.artifacts/android-1.0/release-probe-debug/probe.apk':'.artifacts/android-1.0/release-probe/probe.apk');const token=randomBytes(32).toString('base64url');
const child=spawn(adb,['-s','emulator-5554','shell','am','instrument','-w','-r','-e','token',token,'app.familiar.releaseprobe/.ReleaseProbe'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let log='',saved=false;child.stdout.on('data',async chunk=>{log+=chunk.toString();const port=log.match(/INSTRUMENTATION_STATUS: port=(\d+)/)?.[1],publicKey=log.match(/INSTRUMENTATION_STATUS: publicKey=([^\r\n]+)/)?.[1];if(port&&publicKey&&!saved){saved=true;run('forward','tcp:'+forwardPort,'tcp:'+port);await writeFile(file,JSON.stringify({forwardPort,token,publicKey,app:process.env.FAMILIAR_PROBE_DEBUG==='1'?'app.familiar.mobile.debug':'app.familiar.mobile'},null,2),{flag:'wx',mode:0o600});console.log('Isolated signed release session ready; WebView debugging remains disabled.');}});
child.stderr.on('data',()=>{});
const code=await new Promise(resolve=>child.on('exit',resolve));
await writeFile('.artifacts/android-1.0/probe-session-last.log',log.replaceAll(token,'[session]'));
try{run('forward','--remove','tcp:'+forwardPort);}catch{}try{await unlink(file);}catch{}try{run('uninstall','app.familiar.releaseprobe');}catch{}
console.log('Release probe ended and removed. Exit '+code);if(!saved||/INSTRUMENTATION_FAILED|INSTRUMENTATION_ABORTED|INSTRUMENTATION_RESULT: error=/.test(log)){console.error(log.replaceAll(token,'[session]'));process.exitCode=1;}
