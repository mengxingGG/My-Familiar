import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';

// 只结束本应用的控制页进程，绝不 force-stop 整个包；常驻进程、设置和会话应独立保留。
const app='app.familiar.mobile.debug',out='.artifacts/android-controller-exit',port=9284,durationMs=120000;
await mkdir(out,{recursive:true});
const adb=(...args)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...args],{encoding:'utf8',windowsHide:true,timeout:30000}).trim();
const pid=name=>{try{return adb('shell','pidof',name);}catch{return '';}};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let browser,page,before,runtimePid,mainPid,sequence=0,terminated=false;
const proof={date:new Date().toISOString(),durationMs,samples:[],checks:[],screenLockTested:false};
const pass=name=>{proof.checks.push(name);console.log('PASS '+name);};
const call=async(method,params)=>{const r=await page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:'controller-exit-'+(++sequence),method,params});assert(r.ok,method+': '+r.error?.code);return r.result;};
async function detach(){await browser?.close().catch(()=>{});browser=page=undefined;if(adb('forward','--list').includes('tcp:'+port))adb('forward','--remove','tcp:'+port);}
async function attach(){await detach();adb('shell','am','start','-n',app+'/app.familiar.mobile.MainActivity');for(const end=Date.now()+45000;Date.now()<end&&!page;){try{const current=pid(app);if(current&&adb('shell','cat','/proc/net/unix').includes('webview_devtools_remote_'+current)){adb('forward','tcp:'+port,'localabstract:webview_devtools_remote_'+current);browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:1500});page=browser.contexts()[0].pages()[0];}}catch{await browser?.close().catch(()=>{});browser=page=undefined;}if(!page)await pause(300);}assert(page);await page.locator('#familiar-root[data-ready="true"]').waitFor();}
function petVisible(){return adb('shell','dumpsys','window','windows').split(/  Window #/).some(block=>block.includes('u0 FamiliarPet}')&&block.includes('mHasSurface=true'));}
const publicState=s=>({provider:s.provider,providers:s.providers,activeConversationId:s.activeConversationId,conversations:s.conversations.map(row=>row.id),pet:s.pet,runtime:s.runtime,ime:adb('shell','settings','get','secure','default_input_method')});
try{
 assert(!adb('forward','--list').includes('tcp:'+port));await attach();before=await call('snapshot.get');assert(before.runtime.running&&before.runtime.overlayVisible&&!before.activeReply&&!before.tasks.length&&!before.voice.state.active&&!before.voice.wake.armed);
 assert(!await page.evaluate(()=>[...document.querySelectorAll('input[type=password],textarea.composer-input')].some(input=>input.value.trim())),'Unsubmitted input must be preserved');
 await writeFile(out+'/before.json',JSON.stringify(publicState(before),null,2));
 proof.apkSha256=createHash('sha256').update(await readFile('release/android/Familiar-0.3.0-arm64-debug.apk')).digest('hex');assert.equal(adb('shell','sha256sum',adb('shell','pm','path',app).replace(/^package:/,'')).split(/\s/)[0],proof.apkSha256);
 const screenTimeout=Number(adb('shell','settings','get','system','screen_off_timeout'));assert(screenTimeout>durationMs+30000);assert(/mWakefulness=Awake/.test(adb('shell','dumpsys','power')));proof.screenLockNote='保持当前亮屏策略；系统报告安全锁屏，不主动锁定或尝试解锁。';
 mainPid=pid(app);runtimePid=pid(app+':runtime');assert(/^\d+$/.test(mainPid)&&/^\d+$/.test(runtimePid)&&mainPid!==runtimePid);proof.originalMainPid=mainPid;proof.runtimePid=runtimePid;
 const ticksPerSecond=Number(adb('shell','getconf','CLK_TCK'));assert(ticksPerSecond>0);proof.ticksPerSecond=ticksPerSecond;
 adb('shell','input','keyevent','KEYCODE_HOME');await pause(600);await detach();adb('shell','run-as',app,'kill','-9',mainPid);terminated=true;await pause(600);assert.equal(pid(app),'');assert.equal(pid(app+':runtime'),runtimePid);pass('仅控制页进程结束，独立 Runtime 和悬浮宠物保留');
 const started=Date.now();
 for(let sample=0;sample<=4;sample++){
  const target=started+sample*30000;if(Date.now()<target)await pause(target-Date.now());assert.equal(pid(app),'','Controller unexpectedly reopened');assert.equal(pid(app+':runtime'),runtimePid);assert(petVisible());assert(/mWakefulness=Awake/.test(adb('shell','dumpsys','power')));
  const services=adb('shell','dumpsys','activity','services',app);assert(services.includes('app.familiar.platform.PetService')&&services.includes('isForeground=true'));
  const raw=adb('shell','run-as',app,'cat','/proc/'+runtimePid+'/stat'),fields=raw.slice(raw.lastIndexOf(')')+2).split(/\s+/),uptime=Number(adb('shell','cat','/proc/uptime').split(/\s/)[0]),ticks=Number(fields[11])+Number(fields[12]);
  const memory=adb('shell','dumpsys','meminfo',runtimePid),pss=memory.match(/TOTAL PSS:\s+(\d+)/),rss=memory.match(/TOTAL RSS:\s+(\d+)/);assert(pss&&rss);
  const prior=proof.samples.at(-1),value={elapsedMs:Date.now()-started,deviceUptime:uptime,cpuTicks:ticks,pssKiB:Number(pss[1]),rssKiB:Number(rss[1]),threads:Number(fields[17]),mainAbsent:true,foregroundService:true,petVisible:true,...(prior?{oneCoreCpuPercent:100*(ticks-prior.cpuTicks)/ticksPerSecond/(uptime-prior.deviceUptime)}:{})};proof.samples.push(value);await writeFile(out+'/progress.json',JSON.stringify(proof,null,2));console.log('Resident sample '+sample+': '+Math.round(value.pssKiB/1024)+' MiB PSS, same Runtime PID.');
 }
 proof.observedMs=proof.samples.at(-1).elapsedMs;assert(proof.observedMs>=durationMs);pass('控制页缺席两分钟，前台服务和宠物持续运行且 Runtime 未重启');
}catch(error){proof.error=String(error);console.error(error);process.exitCode=1;}
finally{
 try{if(terminated){assert.equal(pid(app+':runtime'),runtimePid);await attach();const after=await call('snapshot.get');assert.equal(after.runtime.engine,'ready');assert(after.runtime.running&&after.runtime.overlayVisible&&!after.activeReply&&!after.tasks.length&&!after.voice.state.active&&!after.voice.wake.armed);assert.deepEqual(after.providers,before.providers);assert.equal(after.activeConversationId,before.activeConversationId);assert.deepEqual(after.conversations.map(row=>row.id),before.conversations.map(row=>row.id));for(const key of ['scale','visible','quiet','bubbleSeconds','docking'])assert.deepEqual(after.pet[key],before.pet[key]);const restored=publicState(after);assert.equal(restored.ime,JSON.parse(await readFile(out+'/before.json','utf8')).ime);proof.restored=true;proof.newMainPid=pid(app);proof.finalRuntime=after.runtime;pass('重开控制页重新连接原 Runtime，模型/会话/宠物和输入法保持');}}
 catch(error){proof.restoreError=String(error);console.error('RESTORE: '+error);process.exitCode=1;}
 await detach();adb('shell','input','keyevent','KEYCODE_HOME');await writeFile(out+'/result.json',JSON.stringify(proof,null,2));
}
