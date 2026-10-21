import assert from'node:assert/strict';import{execFileSync}from'node:child_process';import{writeFile}from'node:fs/promises';import{probeCall as call}from'./lib/android-release-probe.mjs';
const adb=(...a)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...a],{encoding:'utf8',windowsHide:true,timeout:30000}).trim(),delay=ms=>new Promise(r=>setTimeout(r,ms));
const controls=()=>call('controls'),tap=n=>{assert(n&&n.right>n.left&&n.bottom>n.top);adb('shell','input','tap',String(n.x),String(n.y));};
async function wait(fn){for(const end=Date.now()+20000;Date.now()<end;){const v=await fn();if(v)return v;await delay(250);}throw Error('System UI timeout');}
const before=await call('snapshot.get');
if(before.capabilities.find(c=>c.id==='accessibility')?.state==='disconnected'){
 adb('shell','am','start','-W','-n','com.android.settings/.Settings\\$AccessibilitySettingsActivity');
 const title=await wait(async()=>{const nodes=await controls();if(nodes.some(n=>n.resourceId==='com.android.settings:id/switch_text'&&n.text==='使用“灵伴手机操作”'))return {details:true};const titles=nodes.filter(n=>n.packageName==='com.android.settings'&&n.text==='灵伴手机操作');const candidates=titles.filter(t=>nodes.some(n=>(n.text==='已开启'||n.text.startsWith('无法运行'))&&n.y>t.y&&n.y-t.y<200));return candidates.length===1?candidates[0]:null;});if(!title.details)tap(title);
 const toggle=await wait(async()=>{const nodes=await controls();return nodes.some(n=>n.resourceId==='android:id/switch_widget'&&n.checked)?nodes.find(n=>n.resourceId==='com.android.settings:id/main_switch_bar'):null;});tap(toggle);
 tap(await wait(async()=>(await controls()).find(n=>n.text==='停止'&&n.resourceId==='android:id/button1'&&n.clickable)));
 const disabled=await wait(async()=>{const nodes=await controls();return nodes.some(n=>n.resourceId==='android:id/switch_widget'&&!n.checked)?nodes.find(n=>n.resourceId==='com.android.settings:id/main_switch_bar'):null;});tap(disabled);
 tap(await wait(async()=>(await controls()).find(n=>n.resourceId==='com.android.settings:id/permission_enable_allow_button'&&n.enabled&&n.clickable)));
}
adb('shell','am','start','-n','app.familiar.mobile/app.familiar.mobile.MainActivity');await delay(500);await call('runtime.set',{enabled:true});
const state=await wait(async()=>{const s=await call('snapshot.get');return s.runtime.running&&s.runtime.overlayVisible&&s.capabilities.find(c=>c.id==='accessibility')?.state==='granted'?s:null;});
assert(state.provider.keyConfigured);for(const id of ['calendar','overlay','notifications','accessibility'])assert.equal(state.capabilities.find(c=>c.id===id)?.state,'granted');
await writeFile('.artifacts/android-1.0/final-device-ready.json',JSON.stringify({runtime:state.runtime,model:state.provider.model,permissions:state.capabilities.map(c=>({id:c.id,state:c.state})),activeConversationId:state.activeConversationId},null,2));console.log('Formal runtime ready; overlay, notifications, calendar and actual accessibility connection granted through Android UI.');
