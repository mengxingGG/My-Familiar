import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';

// 只使用始终停用的临时配置；不向飞书发送夹具密钥。
const app='app.familiar.mobile.debug',out='.artifacts/android-device',port=9252;
const adb=(...args)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...args],{encoding:'utf8',windowsHide:true}).trim();
const delay=ms=>new Promise(r=>setTimeout(r,ms));const results=[],proof={};let browser,page,before,initial,seq=0,owned=false;
const pass=name=>{results.push(name);console.log('PASS '+name);};
const raw=(method,params)=>page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:'feishu-device-'+(++seq),method,params});
const call=async(method,params)=>{const r=await raw(method,params);assert(r.ok,JSON.stringify(r));return r.result;};
async function until(fn){for(let i=0;i<100;i++){if(await fn())return;await delay(100);}throw Error('Device condition timeout');}
async function attach(){
 await browser?.close();adb('shell','am','start','-n',`${app}/app.familiar.mobile.MainActivity`);
 for(let i=0;i<40;i++)try{adb('forward',`tcp:${port}`,`localabstract:webview_devtools_remote_${adb('shell','pidof',app)}`);browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:1500});break;}catch{await delay(300);}
 assert(browser?.isConnected());page=browser.contexts()[0].pages()[0];await page.locator('#familiar-root[data-ready="true"]').waitFor();
}
async function open(){await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:/飞书私聊/}).click();await page.locator('.feishu-page:not([hidden])').waitFor();}
try{
 await attach();before=await call('snapshot.get');initial=await call('feishu.status');assert(!initial.hasSecret&&!initial.appId&&!initial.enabled,'Do not replace existing user channel');assert(!before.activeReply&&!before.voice.state.active&&!before.voice.wake.armed);await writeFile(out+'/feishu-before.json',JSON.stringify({snapshot:before,channel:initial},null,2));
 await open();let ui=page.locator('.feishu-page'),id=ui.getByLabel('应用编号（App ID）',{exact:true}),secret=ui.getByLabel('应用密钥（留空保留）',{exact:true});const button=name=>ui.getByRole('button',{name,exact:true});
 assert(!await ui.getByLabel('开启飞书私聊',{exact:true}).isChecked());await id.fill('cli_0123456789abcdef');await secret.fill('device-feishu-fixture-secret');owned=true;await button('保存并应用').click();await until(async()=>(await call('feishu.status')).hasSecret);assert.equal(await secret.inputValue(),'');let saved=await call('feishu.status');assert(!saved.enabled&&saved.phase==='off');pass('Android 实际设置页默认停用，保存应用密钥后不回填、不连接');
 assert.equal((await raw('feishu.pair',{revision:saved.revision})).error.code,'UNAVAILABLE');
 assert.equal((await raw('feishu.save',{appId:saved.appId,enabled:false,allowedUsers:[],revision:initial.revision})).error.code,'CONFLICT');
 assert.equal((await raw('feishu.save',{appId:saved.appId,enabled:false,allowedUsers:[],revision:saved.revision,domain:'https://fixture.invalid'})).error.code,'INVALID_INPUT');
 assert.equal((await raw('feishu.save',{appId:'cli_invalid',enabled:true,allowedUsers:[],revision:saved.revision})).error.code,'INVALID_INPUT');pass('未连接不能配对；旧配置、非法编号及端点覆盖被拒绝');
 const vault=execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554','exec-out','run-as',app,'cat','no_backup/credentials.v1'],{windowsHide:true});assert(vault.length>29&&!vault.includes(Buffer.from('device-feishu-fixture-secret')));assert(!JSON.stringify(saved).includes('device-feishu-fixture-secret'));proof.encryptedVault=true;
 await page.screenshot({path:out+'/feishu-settings.png'});
 await browser.close();adb('shell','am','force-stop',app);await attach();saved=await call('feishu.status');assert(saved.hasSecret&&!saved.enabled&&saved.phase==='off');pass('进程重启恢复加密凭据状态，停用配置保持离线');
 await open();ui=page.locator('.feishu-page');secret=ui.getByLabel('应用密钥（留空保留）',{exact:true});assert.equal(await secret.inputValue(),'');await ui.getByLabel('清除已保存的应用密钥',{exact:true}).check();await button('保存并应用').click();await until(async()=>!(await call('feishu.status')).hasSecret);saved=await call('feishu.status');assert(!saved.enabled);
 assert.equal((await raw('feishu.save',{appId:saved.appId,enabled:true,allowedUsers:[],revision:saved.revision})).error.code,'INVALID_INPUT');pass('原生清除密钥同时停用，缺少密钥不能开启');
 const bytes=await readFile('apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk');proof.apkSha256=createHash('sha256').update(bytes).digest('hex');assert.equal(adb('shell','sha256sum',adb('shell','pm','path',app).replace(/^package:/,'')).split(/\s+/)[0],proof.apkSha256);
}catch(error){console.error(error);proof.error=String(error);process.exitCode=1;}
finally{
 try{
  if(owned){if(!browser?.isConnected())await attach();const current=await call('feishu.status');await call('feishu.save',{appId:initial.appId,enabled:false,allowedUsers:initial.allowedUsers,revision:current.revision,clearSecret:true});}
  if(before){const current=await call('feishu.status');assert(!current.hasSecret&&!current.enabled&&!current.appId);const after=await call('snapshot.get');assert.deepEqual(after.provider,before.provider);assert.deepEqual(after.providers,before.providers);assert.equal(after.activeConversationId,before.activeConversationId);assert.deepEqual(after.conversations.map(c=>c.id),before.conversations.map(c=>c.id));proof.restored=true;pass('移除本轮临时凭据与配置，原模型和会话恢复核对');}
 }catch(error){console.error('RESTORE FAILED',error);proof.restoreError=String(error);process.exitCode=1;}
 await browser?.close();adb('forward','--remove',`tcp:${port}`);await writeFile(out+'/feishu-smoke.json',JSON.stringify({date:new Date().toISOString(),results,proof},null,2));
}
