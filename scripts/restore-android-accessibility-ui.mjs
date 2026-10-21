import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {probeCall} from './lib/android-release-probe.mjs';
const adb=(...a)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...a],{encoding:'utf8',windowsHide:true,timeout:30000}).trim();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(const end=Date.now()+25000;Date.now()<end;){const v=await fn();if(v)return v;await pause(250);}throw Error('ACCESSIBILITY_UI_TIMEOUT');}
const controls=()=>probeCall('controls'),tap=n=>{assert(n?.enabled&&n.right>n.left&&n.bottom>n.top);adb('shell','input','tap',String(n.x),String(n.y));};
/** 独立 UI 观察器也可用；只通过用户可见设置页面，不写 Secure Settings。 */
export async function restoreAccessibilityUI(){
 const status=adb('shell','dumpsys','accessibility');
 assert(status.split('\n').find(l=>l.includes('Enabled services:'))?.includes('app.familiar.mobile/app.familiar.platform.FamiliarAccessibility'));
 if(status.split('\n').find(l=>l.includes('Bound services:'))?.includes('灵伴手机操作')&&!status.split('\n').find(l=>l.includes('Crashed services:'))?.includes('app.familiar.mobile/'))return;
 adb('shell','am','start','-W','-n','com.android.settings/.Settings\\$AccessibilitySettingsActivity');
 const target=await until(async()=>{const rows=await controls();if(rows.some(n=>n.resourceId==='com.android.settings:id/switch_text'&&n.text==='使用“灵伴手机操作”'))return {details:true};const titles=rows.filter(n=>n.packageName==='com.android.settings'&&n.text==='灵伴手机操作');const candidates=titles.filter(t=>rows.some(n=>(n.text==='已开启'||n.text.startsWith('无法运行'))&&n.y>t.y&&n.y-t.y<200));return candidates.length===1?candidates[0]:null;});if(!target.details)tap(target);
 tap(await until(async()=>{const rows=await controls();return rows.some(n=>n.resourceId==='android:id/switch_widget'&&n.checked)?rows.find(n=>n.resourceId==='com.android.settings:id/main_switch_bar'):null;}));
 tap(await until(async()=>(await controls()).find(n=>n.resourceId==='android:id/button1'&&n.text==='停止'&&n.clickable)));
 tap(await until(async()=>{const rows=await controls();return rows.some(n=>n.resourceId==='android:id/switch_widget'&&!n.checked)?rows.find(n=>n.resourceId==='com.android.settings:id/main_switch_bar'):null;}));
 tap(await until(async()=>(await controls()).find(n=>n.resourceId==='com.android.settings:id/permission_enable_allow_button'&&n.clickable&&n.enabled)));
 await until(()=>{const value=adb('shell','dumpsys','accessibility');return value.split('\n').find(l=>l.includes('Bound services:'))?.includes('灵伴手机操作')&&!value.split('\n').find(l=>l.includes('Crashed services:'))?.includes('app.familiar.mobile/');});
 console.log('Accessibility restored through Android Settings UI; no permission or settings writes.');
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/restore-android-accessibility-ui.mjs')||process.argv[1]==='scripts/restore-android-accessibility-ui.mjs')await restoreAccessibilityUI();
