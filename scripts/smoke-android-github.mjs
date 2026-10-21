import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';

// 仅测试新建且始终停用的 GitHub 配置；夹具 Token 不发往网络。
const app='app.familiar.mobile.debug',out='.artifacts/android-device',port=9252;
const adb=(...args)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...args],{encoding:'utf8',windowsHide:true}).trim();
const delay=ms=>new Promise(r=>setTimeout(r,ms));const results=[];let browser,page,before,initial,seq=0,owned=false;
const proof={};const pass=name=>{results.push(name);console.log('PASS '+name);};
const raw=(method,params)=>page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:'github-device-'+(++seq),method,params});
const call=async(method,params)=>{const r=await raw(method,params);assert(r.ok,JSON.stringify(r));return r.result;};
const row=async()=>(await call('mcp.list')).find(s=>s.id==='github');
async function until(fn){for(let i=0;i<100;i++){if(await fn())return;await delay(100);}throw Error('Device condition timeout');}
async function attach(){
 await browser?.close();adb('shell','am','start','-n',`${app}/app.familiar.mobile.MainActivity`);
 for(let i=0;i<40;i++)try{adb('forward',`tcp:${port}`,`localabstract:webview_devtools_remote_${adb('shell','pidof',app)}`);browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:1500});break;}catch{await delay(300);}
 assert(browser?.isConnected());page=browser.contexts()[0].pages()[0];await page.locator('#familiar-root[data-ready="true"]').waitFor();
}
async function open(){if(await page.locator('.mcp-page:not([hidden])').count())await page.locator('.mcp-page .pagebar button').click();await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:/网络工具 · MCP/}).click();await page.locator('.mcp-page:not([hidden])').waitFor();}
try{
 await attach();before=await call('snapshot.get');initial=await call('mcp.list');assert(!initial.some(s=>s.id==='github'),'Existing user GitHub configuration must not be replaced');assert(!before.activeReply&&!before.voice.state.active&&!before.voice.wake.armed);
 await writeFile(out+'/github-before.json',JSON.stringify({snapshot:before,servers:initial},null,2));
 await open();let ui=page.locator('.mcp-page');const button=name=>ui.getByRole('button',{name,exact:true});
 await button('GitHub 官方').click();let token=ui.getByLabel('GitHub Token（留空保留）',{exact:true});const readOnly=ui.getByLabel('GitHub 只读模式',{exact:true});
 assert(await readOnly.isChecked());assert(!await ui.getByLabel('启用服务，应用启动时自动连接',{exact:true}).isChecked());assert(await ui.getByLabel('MCP 服务地址',{exact:true}).isHidden());
 await token.fill('device-github-fixture-token');owned=true;await button('保存设置').click();await until(async()=>(await row())?.hasKey);assert.equal(await token.inputValue(),'');assert(!(await row()).enabled);pass('实际 Android 表单默认只读/停用，Token 保存后不回填');
 let previous=await row();await readOnly.uncheck();await button('保存设置').click();await until(async()=>(await row()).url.endsWith('/mcp/'));let current=await row();assert(current.hasKey&&!current.connected&&!current.enabled);
 assert.equal((await raw('mcp.github.save',{readOnly:true,enabled:false,revision:previous.revision,apiKey:'stale-token'})).error.code,'CONFLICT');
 assert.equal((await raw('mcp.github.save',{readOnly:true,enabled:false,revision:current.revision,url:'https://foreign.invalid/mcp'})).error.code,'INVALID_INPUT');pass('切换模式保留 Token，旧版本和自定义外发地址被拒绝');
 assert(!JSON.stringify(await call('mcp.list')).includes('device-github-fixture-token'));
 const vault=execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554','exec-out','run-as',app,'cat','no_backup/credentials.v1'],{windowsHide:true});assert(vault.length>29&&!vault.includes(Buffer.from('device-github-fixture-token')));proof.encryptedVault=true;
 await page.screenshot({path:out+'/github-settings.png'});
 await browser.close();adb('shell','am','force-stop',app);await attach();current=await row();assert(current.hasKey&&!current.enabled&&!current.connected&&current.url.endsWith('/mcp/'));pass('进程重启后 Token 状态与可写模式恢复，停用服务不自动连接');
 await open();ui=page.locator('.mcp-page');token=ui.getByLabel('GitHub Token（留空保留）',{exact:true});await button('GitHub 官方').click();assert.equal(await token.inputValue(),'');await ui.getByLabel('清除此地址已保存的密钥',{exact:true}).check();await button('保存设置').click();await until(async()=>!(await row()).hasKey);assert(!(await row()).enabled);pass('清除 Token 后无密钥且服务停用');
 current=await row();await call('mcp.github.save',{readOnly:true,enabled:false,revision:current.revision});assert(!(await row()).hasKey);assert.equal((await raw('mcp.github.save',{readOnly:true,enabled:true,revision:(await row()).revision})).error.code,'INVALID_INPUT');pass('切回旧模式不会复活已清除 Token，缺 Token 不能启用');
 const bytes=await readFile('apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk');proof.apkSha=createHash('sha256').update(bytes).digest('hex');assert.equal(adb('shell','sha256sum',adb('shell','pm','path',app).replace(/^package:/,'')).split(/\s+/)[0],proof.apkSha);
}catch(e){console.error('CHECK_FAILED',e);proof.error=String(e);process.exitCode=1;}
finally{
 try{
  if(owned){if(!browser?.isConnected())await attach();const current=await row();if(current)await call('mcp.remove',{id:current.id,revision:current.revision});}
  if(before){const after=await call('snapshot.get');assert.deepEqual(await call('mcp.list'),initial);assert.deepEqual(after.provider,before.provider);assert.deepEqual(after.providers,before.providers);assert.equal(after.activeConversationId,before.activeConversationId);assert.deepEqual(after.conversations.map(c=>c.id),before.conversations.map(c=>c.id));proof.restored=true;pass('临时 GitHub 配置移除，原 MCP、模型和会话核对恢复');}
 }catch(e){console.error('RESTORE FAILED',e);proof.restoreError=String(e);process.exitCode=1;}
 await browser?.close();adb('forward','--remove',`tcp:${port}`);await writeFile(out+'/github-smoke.json',JSON.stringify({date:new Date().toISOString(),results,proof},null,2));
}
