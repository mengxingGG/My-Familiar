import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';

const app='app.familiar.mobile.debug', root='.artifacts/android-device', port=9251;
const prefix=process.env.FAMILIAR_SMOKE_PREFIX??'feishu';assert(/^[a-z0-9-]+$/.test(prefix));
const adb=(...args)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...args],{encoding:'utf8',windowsHide:true}).trim();
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const results=[];let browser,page,before,originalBox,sequence=0,changed=false;
const report={date:new Date().toISOString(),results};
const pass=name=>{results.push(name);console.log('PASS '+name);};
function box(){
 const block=adb('shell','dumpsys','window','windows').split(/  Window #/).find(b=>b.includes('u0 FamiliarPet}')&&b.includes('mHasSurface=true'));
 const m=block?.match(/Frames:.*? frame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
 return m?{x:+m[1],y:+m[2],w:+m[3]-m[1],h:+m[4]-m[2]}:null;
}
async function waitBox(check,timeout=6000){for(const until=Date.now()+timeout;Date.now()<until;){const b=box();if(b&&check(b))return b;await delay(200);}throw Error('Unexpected pet window '+JSON.stringify(box()));}
async function call(method,params){const r=await page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:`current-dock-${++sequence}`,method,params});assert(r.ok,JSON.stringify(r));return r.result;}
async function drag(cx,cy){const b=box();assert(b);adb('shell','input','swipe',String(b.x+b.w/2),String(b.y+b.h/2),String(cx),String(cy),'350');await delay(350);}
async function tap(){const b=box();assert(b);adb('shell','input','tap',String(b.x+b.w/2),String(b.y+b.h/2));await delay(350);}
async function shot(){const bytes=execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554','exec-out','screencap','-p'],{windowsHide:true,maxBuffer:16*1024*1024});await writeFile(root+'/'+prefix+'-docking-head.png',bytes);}
try{
 assert(!adb('forward','--list').includes(`tcp:${port}`),'CDP port already in use');
 adb('shell','am','start','-n',`${app}/app.familiar.mobile.MainActivity`);await delay(1500);
 adb('forward',`tcp:${port}`,`localabstract:webview_devtools_remote_${adb('shell','pidof',app)}`);
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);page=browser.contexts()[0].pages()[0];await page.locator('#familiar-root[data-ready="true"]').waitFor();
 await call('runtime.set',{enabled:true});await delay(800);before=await call('snapshot.get');originalBox=box();
 assert(before.runtime.running&&before.runtime.overlayVisible&&originalBox);
 assert(!before.activeReply&&before.tasks.length===0&&!before.voice.state.active&&!before.voice.wake.armed);
 assert(!before.pet.docking.snapToEdge&&!before.pet.docking.tucked&&before.pet.scale===1,'Expected saved free-placement baseline');
 const installed=adb('shell','pm','path',app).replace(/^package:/,'');
 report.apkSha256=createHash('sha256').update(await readFile('apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk')).digest('hex');
 assert.equal(adb('shell','sha256sum',installed).split(/\s/)[0],report.apkSha256);
 await writeFile(root+'/'+prefix+'-docking-before.json',JSON.stringify({pet:before.pet,box:originalBox},null,2));
 changed=true;await call('pet.settings.save',{scale:1,visible:true,quiet:true,bubbleSeconds:0});
 adb('shell','input','keyevent','KEYCODE_HOME');await delay(500);
 await call('pet.docking.save',{snapToEdge:true,hideWhenIdle:false,delaySeconds:10});
 await drag(900,1200);await waitBox(b=>b.x===960&&b.w===448);
 await drag(1320,360);await waitBox(b=>b.x===960&&b.y===128&&b.w===448);pass('拖放吸附最近边缘，靠近角落停在角落');
 await drag(1400,352);await waitBox(b=>b.w===192&&b.h===192);assert((await call('snapshot.get')).pet.docking.tucked);await delay(350);await shot();pass('向外滑后收成 48dp 小脑袋，窗口同步缩小');
 await tap();await waitBox(b=>b.w===448);assert(/mCurrentFocus=.*com.android.launcher3/.test(adb('shell','dumpsys','window')));
 await drag(1400,352);await waitBox(b=>b.w===192);await drag(900,1000);await waitBox(b=>b.w===448);pass('点按或向内拖展开，点按小脑袋不打开设置');
 await delay(11000);assert.equal(box().w,448);
 await call('pet.docking.save',{snapToEdge:true,hideWhenIdle:true,delaySeconds:10});await waitBox(b=>b.w===192,13000);pass('闲置收起开关独立生效，10 秒后自动收起');
 await call('pet.docking.save',{snapToEdge:false,hideWhenIdle:true,delaySeconds:10});await drag(720,1200);
 await waitBox(b=>Math.abs(b.x-496)<=3&&Math.abs(b.y-976)<=3&&b.w===448);await delay(11000);assert.equal(box().w,448);pass('关闭吸附后自由放置，闲置不收起');
}catch(error){report.error=String(error);console.error(error);process.exitCode=1;}
finally{
 try{
  if(changed){
   await call('pet.docking.save',{snapToEdge:false,hideWhenIdle:false,delaySeconds:30});await waitBox(b=>b.w===448);
   await drag(originalBox.x+originalBox.w/2,originalBox.y+originalBox.h/2);
   await call('pet.docking.save',before.pet.docking);
   await call('pet.settings.save',{scale:before.pet.scale,visible:before.pet.visible,quiet:before.pet.quiet,bubbleSeconds:before.pet.bubbleSeconds});
   await delay(500);
   const after=await call('snapshot.get');for(const key of ['scale','visible','quiet','bubbleSeconds','docking'])assert.deepEqual(after.pet[key],before.pet[key]);assert.deepEqual(box(),originalBox);
   assert.deepEqual(after.provider,before.provider);assert.deepEqual(after.providers,before.providers);
   assert.deepEqual(after.conversations.map(c=>c.id),before.conversations.map(c=>c.id));assert.equal(after.activeConversationId,before.activeConversationId);
   assert(after.runtime.running&&after.runtime.overlayVisible);assert(!after.voice.state.active&&!after.voice.wake.armed);
   report.restored=true;report.finalPet=after.pet;pass('原偏好、位置、模型及会话保持原样');
  }
 }catch(error){report.restoreError=String(error);console.error('RESTORE FAILED',error);process.exitCode=1;}
 await browser?.close();adb('forward','--remove',`tcp:${port}`);await writeFile(root+'/'+prefix+'-docking-check.json',JSON.stringify(report,null,2));
}
