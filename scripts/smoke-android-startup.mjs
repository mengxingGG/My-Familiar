import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';

const app='app.familiar.mobile.debug',root='.artifacts/android-device',port=9254;
const permissionOnly=process.argv.includes('--permission-only'),stem=permissionOnly?'startup-permission':'startup';
const adb=(...args)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...args],{encoding:'utf8',windowsHide:true,timeout:15000,stdio:['ignore','pipe','pipe']}).trim();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const results=[],proof={date:new Date().toISOString()};let browser,page,before,seq=0,permissionChanged=false;
const pass=name=>{results.push(name);console.log('PASS '+name);};
async function until(check,timeout=30000){for(const end=Date.now()+timeout;Date.now()<end;){try{const v=await check();if(v)return v;}catch{}await delay(400);}throw Error('Timed out waiting for device state');}
async function call(method,params){const r=await page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:'startup-device-'+(++seq),method,params});assert(r.ok,JSON.stringify(r));return r.result;}
async function detach(){await browser?.close().catch(()=>{});browser=undefined;page=undefined;try{adb('forward','--remove',`tcp:${port}`);}catch{}}
async function attach(){
 await until(()=>adb('shell','am','start','-n',`${app}/app.familiar.mobile.MainActivity`),60000);
 await until(async()=>{const pid=adb('shell','pidof',app);if(!pid)return false;adb('forward',`tcp:${port}`,`localabstract:webview_devtools_remote_${pid}`);browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:1500});return browser;});
 page=browser.contexts()[0].pages()[0];await page.locator('#familiar-root[data-ready="true"]').waitFor();await page.getByRole('button',{name:'小窝',exact:true}).click();
}
const services=()=>adb('shell','dumpsys','activity','services',app);
function petBlock(){return services().split(/\* ServiceRecord/).find(s=>s.includes('app.familiar.platform.PetService'))??'';}
function box(){const block=adb('shell','dumpsys','window','windows').split(/  Window #/).find(s=>s.includes('u0 FamiliarPet}')&&s.includes('mHasSurface=true'));const m=block?.match(/Frames:.*? frame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);return m?{x:+m[1],y:+m[2],w:+m[3]-m[1],h:+m[4]-m[2]}:null;}
function noAudio(){assert(!services().includes('VoiceService'));assert(!adb('shell','cmd','appops','get',app,'RECORD_AUDIO').includes('(running)'));}
function nodes(){adb('shell','uiautomator','dump','/sdcard/familiar-startup-settings.xml');return [...adb('shell','cat','/sdcard/familiar-startup-settings.xml').matchAll(/<node\b[^>]+>/g)].map(m=>Object.fromEntries([...m[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],a[2]])));}
function tap(node){assert(node);const p=[...node.bounds.matchAll(/\d+/g)].map(m=>+m[0]);adb('shell','input','tap',String(Math.round((p[0]+p[2])/2)),String(Math.round((p[1]+p[3])/2)));}
async function overlay(enabled){
 adb('shell','am','start','-a','android.settings.action.MANAGE_OVERLAY_PERMISSION','-d',`package:${app}`);let list=nodes();
 if(!list.some(n=>n.checkable==='true')){tap(list.find(n=>n.text==='Familiar'));list=nodes();}
 assert(list.some(n=>n.text==='Familiar'));const toggles=list.filter(n=>n.checkable==='true');assert.equal(toggles.length,1);
 if(toggles[0].checked!==String(enabled))tap(toggles[0]);assert.equal(nodes().find(n=>n.checkable==='true')?.checked,String(enabled));
}
async function preference(enabled){const toggle=page.getByLabel('开机启动伙伴',{exact:true});if(await toggle.isChecked()!==enabled)await toggle.click();await until(async()=>{const s=await call('snapshot.get');return s.startup.enabled===enabled&&!await toggle.isDisabled();});}
async function reboot(label){
 const oldCount=Number(adb('shell','settings','get','global','boot_count'));
 adb('shell','input','keyevent','KEYCODE_HOME');await detach();console.log('REBOOT '+label);
 try{adb('reboot');}catch(error){if(error.code!=='ETIMEDOUT'&&!String(error.stderr).includes('closed'))throw error;}
 await until(()=>adb('shell','getprop','sys.boot_completed')==='1'&&Number(adb('shell','settings','get','global','boot_count'))>oldCount,120000);
 adb('shell','input','keyevent','KEYCODE_WAKEUP');adb('shell','wm','dismiss-keyguard');await delay(8000);
 const newCount=Number(adb('shell','settings','get','global','boot_count'));assert(newCount>oldCount);return {oldCount,newCount};
}
try{
 assert(!adb('forward','--list').includes(`tcp:${port}`));
 const resume=process.argv.find(a=>a.startsWith('--resume-boot='));
 if(resume){const saved=JSON.parse(await readFile(root+'/startup-before.json','utf8'));before=saved.snapshot;proof.originalBox=saved.box;proof.resumedAfterAdbDisconnect=true;}
 else{await attach();await call('runtime.set',{enabled:true});await until(()=>box());before=await call('snapshot.get');}
 assert(before.startup&&!before.startup.enabled&&before.startup.overlayGranted,'Expected default-off baseline');assert(!before.activeReply&&before.tasks.length===0&&!before.voice.state.active&&!before.voice.wake.armed);noAudio();
 if(!resume){proof.originalBox=box();await writeFile(root+'/'+stem+'-before.json',JSON.stringify({snapshot:before,box:proof.originalBox},null,2));}
 const apk=await readFile('apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk');proof.apkSha256=createHash('sha256').update(apk).digest('hex');assert.equal(adb('shell','sha256sum',adb('shell','pm','path',app).replace(/^package:/,'')).split(/\s/)[0],proof.apkSha256);
 if(permissionOnly){
  await preference(true);await call('runtime.set',{enabled:false});await until(()=>!petBlock());await detach();permissionChanged=true;await overlay(false);await attach();
  const denied=await call('snapshot.get');assert(denied.startup.enabled&&!denied.startup.overlayGranted);assert(!await page.getByLabel('开机启动伙伴',{exact:true}).isDisabled());proof.beforePermissionBoot={startup:denied.startup,appOps:adb('shell','cmd','appops','get',app,'SYSTEM_ALERT_WINDOW')};pass('可见系统设置撤回悬浮窗，仍能关闭已开启的开机偏好');
  proof.permissionBoot=await reboot('permission-revoked');proof.afterPermissionBoot={appOps:adb('shell','cmd','appops','get',app,'SYSTEM_ALERT_WINDOW'),petService:petBlock(),box:box(),preferences:adb('shell','run-as',app,'cat','shared_prefs/pet-startup.xml')};noAudio();
  await attach();const bootState=await call('snapshot.get');proof.afterPermissionBoot.startup=bootState.startup;
  if(bootState.startup.overlayGranted){proof.permissionResetAtBoot=true;console.log('UNVERIFIED 悬浮窗权限在模拟器重启后已恢复允许，未覆盖权限缺失的开机分支');await call('runtime.set',{enabled:false});await detach();await overlay(false);await attach();}
  else{assert.equal(proof.afterPermissionBoot.petService,'');assert.equal(proof.afterPermissionBoot.box,null);assert.match(proof.afterPermissionBoot.preferences,/<string name="result">permission<\/string>/);pass('撤回权限后真实重启不启动服务，持久记录权限原因');}
  const toggle=page.getByLabel('开机启动伙伴',{exact:true});await toggle.click();await until(async()=>!(await call('snapshot.get')).startup.enabled);await until(()=>toggle.isDisabled());assert.match(await page.locator('.res-startup').innerText(),/请先允许悬浮窗/);pass('权限缺失时允许关闭但禁止重新开启');
 }else{
 if(!resume){
 await preference(true);let s=await call('snapshot.get');assert(s.runtime.running&&s.startup.enabled);noAudio();pass('实际表单默认关闭，开启只保存偏好且不开麦');
 await call('runtime.set',{enabled:false});await until(()=>!petBlock());assert((await call('snapshot.get')).startup.enabled);pass('停止当前陪伴保留下一次开机偏好');
 proof.enabledBoot=await reboot('enabled');
 }else{proof.enabledBoot={oldCount:Number(resume.split('=')[1]),newCount:Number(adb('shell','settings','get','global','boot_count'))};assert(proof.enabledBoot.newCount>proof.enabledBoot.oldCount);}
 await until(()=>petBlock().includes('isForeground=true')&&box());
 let mainPid='';try{mainPid=adb('shell','pidof',app);}catch{}assert.equal(mainPid,'','Boot must not open the controller');noAudio();
 proof.coldBoot={mainPid,petService:petBlock(),box:box(),preferences:adb('shell','run-as',app,'cat','shared_prefs/pet-startup.xml')};assert.match(proof.coldBoot.preferences,/<string name="result">started<\/string>/);assert.match(proof.coldBoot.preferences,new RegExp(`name="handledBoot" value="${proof.enabledBoot.newCount}"`));
 await writeFile(root+'/startup-cold-boot.json',JSON.stringify(proof.coldBoot,null,2));pass('真实重启后控制页未启动，前台宠物服务与悬浮窗自行恢复');
 await attach();const s=await until(async()=>{const v=await call('snapshot.get');return v.runtime.engine==='ready'&&v;});assert(s.startup.enabled&&s.startup.lastResult==='started');assert(!s.voice.state.active&&!s.voice.wake.armed);await page.getByLabel('开机启动伙伴',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:root+'/startup-device.png'});pass('开机状态回传真实服务结果，共享核心就绪且没有自动录音');
 await preference(false);await call('runtime.set',{enabled:false});await until(()=>!petBlock());proof.disabledBoot=await reboot('disabled');assert.equal(petBlock(),'');assert.equal(box(),null);noAudio();proof.disabledBoot.preferences=adb('shell','run-as',app,'cat','shared_prefs/pet-startup.xml');assert.match(proof.disabledBoot.preferences,/<boolean name="enabled" value="false"/);pass('关闭开机开关后再次真实重启，不启动宠物服务');
 }
}catch(error){proof.error=String(error);console.error(error);process.exitCode=1;}
finally{
 try{
  if(before){if(permissionChanged){await detach();await overlay(true);}if(!page)await attach();await call('runtime.startup.save',{enabled:before.startup.enabled});await call('runtime.set',{enabled:before.runtime.running});await until(()=>box());
   const s=await until(async()=>{const v=await call('snapshot.get');return v.runtime.engine==='ready'&&v;});assert.equal(s.startup.enabled,before.startup.enabled);assert.deepEqual(box(),proof.originalBox);
   for(const key of ['scale','visible','quiet','bubbleSeconds','docking'])assert.deepEqual(s.pet[key],before.pet[key]);assert.deepEqual(s.provider,before.provider);assert.deepEqual(s.providers,before.providers);assert.deepEqual(s.voice.settings,before.voice.settings);assert.deepEqual(s.voice.live,before.voice.live);for(const key of ['enabled','phrases','sensitivity'])assert.deepEqual(s.voice.wake[key],before.voice.wake[key]);assert.equal(s.activeConversationId,before.activeConversationId);assert.deepEqual(s.conversations.map(c=>c.id).sort(),before.conversations.map(c=>c.id).sort());assert(!s.voice.state.active&&!s.voice.wake.armed);noAudio();proof.restored=true;proof.finalRuntime=s.runtime;proof.finalStartup=s.startup;pass('原开机偏好、宠物位置、模型、语音与会话恢复');adb('shell','input','keyevent','KEYCODE_HOME');}
 }catch(error){proof.restoreError=String(error);console.error('RESTORE FAILED',error);process.exitCode=1;}
 await detach();try{adb('shell','rm','-f','/sdcard/familiar-startup-settings.xml');}catch{}await writeFile(root+'/'+stem+'-smoke.json',JSON.stringify({results,proof},null,2));
}
