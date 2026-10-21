import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {probeCall} from './lib/android-release-probe.mjs';
const out='.artifacts/release-1.1.0/background',app='app.familiar.mobile';await mkdir(out,{recursive:true});
const adb=(...a)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...a],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:12*1024*1024}).trim();
const pid=name=>{try{return adb('shell','pidof',name);}catch{return '';}};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function box(){const block=adb('shell','dumpsys','window','windows').split(/  Window #/).find(b=>b.split('\n')[0].includes('u0 FamiliarPet}')&&b.includes('mHasSurface=true')&&b.includes('isReadyForDisplay()=true'));const m=block?.match(/Frames:.*? frame=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);return m?{x:+m[1],y:+m[2],w:+m[3]-m[1],h:+m[4]-m[2]}:null;}
const proof={date:new Date().toISOString(),approvals:[],samples:[],checks:[]};
try{
 adb('shell','input','keyevent','KEYCODE_HOME');await pause(600);proof.mainBefore=pid(app);proof.runtimePid=pid(app+':runtime');assert(proof.mainBefore&&proof.runtimePid&&box());
 // 普通后台进程回收不会强行停止应用；前台常驻及系统绑定的无障碍进程必须留下。
 adb('shell','am','kill','--user','0',app);await pause(1000);assert.equal(pid(app),'');assert.equal(pid(app+':runtime'),proof.runtimePid);proof.checks.push('控制器后台进程已回收，独立 Runtime 保留');
 const started=Date.now();
 while(Date.now()-started<90000){assert.equal(pid(app),'');assert.equal(pid(app+':runtime'),proof.runtimePid);assert(box());proof.samples.push({elapsedMs:Date.now()-started,mainAbsent:true,runtimeSame:true,petVisible:true});await writeFile(out+'/progress.json',JSON.stringify(proof,null,2));await pause(15000);}
 const b=box();adb('shell','input','tap',String(b.x+b.w/2),String(b.y+b.h/2));await pause(800);
 let input=(await probeCall('controls')).find(n=>n.packageName===app&&n.description==='气泡聊天输入'&&n.enabled);assert(input);adb('shell','input','tap',String(input.x),String(input.y));await pause(700);
 await probeCall('ui.type',{text:'This is a background lifecycle test. Use android_apps to find com.aiwerewolf and android_open_app to open it. Then android_screen and android_action to enter its API model settings. Do not change any values. Reply briefly in Chinese.'});
 for(let i=0;i<40;i++){if((await probeCall('controls')).some(n=>n.description==='发送气泡消息'&&n.enabled))break;await pause(200);}adb('shell','input','keyevent','KEYCODE_ENTER');
 let lastApproval=0,completed=false;
 for(const end=Date.now()+180000;Date.now()<end;){
  assert.equal(pid(app),'','Controller process must stay absent');assert.equal(pid(app+':runtime'),proof.runtimePid);
  const controls=await probeCall('controls'),button=controls.find(n=>n.packageName===app&&n.clickable&&n.enabled&&(n.description||n.text).startsWith('允许一次'));
  if(button&&Date.now()-lastApproval>1500){assert(proof.approvals.length<12);const descriptions=controls.filter(n=>n.packageName===app&&n.text&&!n.text.startsWith('允许')).map(n=>n.text).join('\n');proof.approvals.push({elapsedMs:Date.now()-started,summary:descriptions.slice(0,1600)});lastApproval=Date.now();adb('shell','input','tap',String(button.x),String(button.y));}
  const top=adb('shell','dumpsys','activity','activities').split('\n').find(l=>/topResumedActivity|mResumedActivity/.test(l))??'';
  const busy=controls.some(n=>n.packageName===app&&n.description==='停止回复');
  if(proof.approvals.length>=4&&top.includes('com.aiwerewolf')&&!button&&!busy&&Date.now()-lastApproval>4000){completed=true;proof.topActivity=top;break;}
  await writeFile(out+'/progress.json',JSON.stringify(proof,null,2));await pause(500);
 }
 assert(completed,'Background model task did not finish');assert.equal(pid(app),'');assert.equal(pid(app+':runtime'),proof.runtimePid);
 const state=adb('shell','dumpsys','accessibility');assert(state.split('\n').find(l=>l.includes('Bound services:')).includes('灵伴手机操作'));assert(!state.split('\n').find(l=>l.includes('Crashed services:')).includes('app.familiar.mobile/'));
 proof.elapsedMs=Date.now()-started;assert(proof.elapsedMs>=90000);proof.checks.push('控制器进程缺席超过九十秒后，真实 DeepSeek 从气泡完成应用打开和无障碍观察/点击审批');
 await writeFile(out+'/normal-background.png',execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554','exec-out','screencap','-p'],{windowsHide:true,maxBuffer:16*1024*1024}));for(const c of proof.checks)console.log('PASS '+c);
}catch(error){proof.error=String(error);console.error(error);process.exitCode=1;}
finally{await writeFile(out+'/result.json',JSON.stringify(proof,null,2));}
