import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const adb=(...a)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...a],{encoding:'utf8',windowsHide:true}).trim();
const app='app.familiar.mobile.debug',sleep=ms=>new Promise(r=>setTimeout(r,ms)),results=[];
adb('shell','am','start','-n',`${app}/app.familiar.mobile.MainActivity`);adb('forward','tcp:9223',`localabstract:webview_devtools_remote_${adb('shell','pidof',app)}`);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9223');const page=browser.contexts()[0].pages()[0];let seq=0,before;const rotation=adb('shell','wm','user-rotation');
async function call(method,params){const r=await page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:`geometry-${++seq}`,method,params});assert(r.ok,JSON.stringify(r));return r.result;}
function box(){const b=adb('shell','dumpsys','window','windows').split(/  Window #/).find(b=>b.includes('u0 FamiliarPet}')&&b.includes('mHasSurface=true'));const m=b?.match(/Frames:.*? frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);return m?{x:+m[1],y:+m[2],w:+m[3]-m[1],h:+m[4]-m[2]}:null;}
async function drag(x,y){const b=box();assert(b);adb('shell','input','swipe',String(b.x+b.w/2),String(b.y+b.h/2),String(x),String(y),'350');await sleep(550);return box();}
const pass=name=>{results.push(name);console.log('PASS '+name);};
try{
 before=await call('snapshot.get');await call('pet.settings.save',{scale:1,visible:true,quiet:true,bubbleSeconds:15});await call('runtime.set',{enabled:true});await call('pet.docking.save',{snapToEdge:true,hideWhenIdle:false,delaySeconds:30});await call('pet.interact',{action:'reset-position'});await sleep(300);adb('shell','input','keyevent','KEYCODE_HOME');await sleep(300);
 let b=await drag(250,1200);assert.equal(b.x,32);b=await drag(720,350);assert.equal(b.y,128);b=await drag(720,2350);assert.equal(b.y,2080);b=await drag(1320,1200);assert.equal(b.x,960);pass('四条边分别吸附，避开系统栏和屏幕边距');
 for(const [x,y,left,top] of [[100,300,32,128],[1320,300,960,128],[100,2400,32,2080],[1320,2400,960,2080]]){b=await drag(x,y);assert.equal(b.x,left);assert.equal(b.y,top);}pass('四个角落均能停靠');
 await call('pet.settings.save',{scale:1.6,visible:true,quiet:true,bubbleSeconds:15});await sleep(400);b=box();assert.equal(b.w,716);assert(b.x>=32&&b.x+b.w<=1408&&b.y>=128&&b.y+b.h<=2528);pass('160% 放大后重新约束位置，宠物保持完整可见');
 adb('shell','am','start','-n',`${app}/app.familiar.mobile.MainActivity`);adb('shell','wm','user-rotation','lock','1');
 let landscape=false;for(let i=0;i<30;i++){await sleep(200);if(await page.evaluate(()=>innerWidth>innerHeight)){landscape=true;break;}}
 assert(landscape,'Emulator did not rotate');b=box();assert(b.x>=0&&b.y>=96&&b.x+b.w<=2560&&b.y+b.h<=1440);await page.screenshot({path:'.artifacts/android-device/pet-landscape-ui.png'});pass('横屏后保持归一化位置并重新计算安全边界');
 await call('pet.settings.save',{scale:1.6,visible:false,quiet:true,bubbleSeconds:15});await sleep(400);assert.equal(box(),null);assert((await call('snapshot.get')).runtime.running);await call('pet.settings.save',{scale:1.6,visible:true,quiet:true,bubbleSeconds:15});await sleep(400);assert(box());pass('隐藏宠物不停止常驻，重新显示恢复窗口');
 const denied=await page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:'private-pet-host',method:'pet.host',params:{action:'drag-start'}});assert(!denied.ok);pass('公共 WebView 拒绝原生私有宠物事件命令');
}finally{
 if(rotation==='free')adb('shell','wm','user-rotation','free');else{const m=rotation.match(/lock\s+(\d)/);if(m)adb('shell','wm','user-rotation','lock',m[1]);}
 await sleep(500);if(before){await call('pet.settings.save',before.pet);await call('pet.docking.save',before.pet.docking);await call('pet.interact',{action:'reset-position'});}
 await browser.close();await writeFile('.artifacts/android-device/pet-geometry.json',JSON.stringify({date:new Date().toISOString(),rotationBefore:rotation,results},null,2));
}
