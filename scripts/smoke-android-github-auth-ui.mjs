import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const out=process.env.FAMILIAR_GITHUB_UI_REPORT_DIR??'.artifacts/android-github-auth/ui';await mkdir(out,{recursive:true});
const bundle=await build({stdin:{contents:`
import{mountApp}from'./apps/tauri/ui/app.ts';import{createPreviewBridge}from'./apps/tauri/preview/fixture.ts';
const f=createPreviewBridge({nativeControls:true}),state=await f.request('snapshot.get');f.dispose();state.mcpManagement=true;state.githubAuth=false;
let listener,version=1;const revision=()=> '11111111-1111-4111-8111-'+String(++version).padStart(12,'0');
window.calls=[];window.rows=[];window.auth={revision:revision(),clientId:'',connected:false,applied:false,targetRevision:'a'.repeat(64),phase:'signedOut',detail:'尚未登录 GitHub。',scopes:[]};
window.emit=()=>{state.revision++;listener?.(structuredClone(state));};window.support=()=>{state.githubAuth=true;window.emit();};
window.authorized=()=>{window.auth={...window.auth,revision:revision(),connected:true,phase:'connected',detail:'GitHub 登录已保存在本机。',user:{id:42,login:'fixture-user'},scopes:['repo','read:org','gist']};delete window.auth.authorization;};
mountApp({subscribe(fn){listener=fn;return()=>{};},async request(method,p){window.calls.push({method,p});
if(method==='snapshot.get')return structuredClone(state);if(method==='mcp.list')return structuredClone(window.rows);
if(method==='github.auth.status'){const s=structuredClone(window.auth);if(window.delayStatus){window.delayStatus=false;await new Promise(r=>window.finishStatus=r);}return s;}
if(method==='github.auth.configure'){window.auth={...window.auth,clientId:p.clientId,revision:revision(),connected:false,phase:'signedOut',detail:'登录应用已保存。'};delete window.auth.configurationError;}
else if(method==='github.auth.begin'){if(window.delayBegin)await new Promise(r=>window.finishBegin=r);window.auth={...window.auth,revision:revision(),phase:'authorizing',detail:'请在 GitHub 输入验证码。',authorization:{url:'https://github.com/login/device',userCode:'ABCD-EFGH',expiresAt:Date.now()+300000}};}
else if(method==='github.auth.open'){}
else if(method==='github.auth.cancel'){window.auth={...window.auth,revision:revision(),phase:'signedOut',detail:'本次登录已取消。'};delete window.auth.authorization;}
else if(method==='github.auth.apply'){window.rows=[{id:'github',name:'GitHub 官方',transport:'http',url:'https://api.githubcopilot.com/mcp/'+(p.readOnly?'readonly':''),enabled:p.enabled,auth:{kind:'header',name:'Authorization',prefix:'Bearer '},revision:'b'.repeat(64),connected:false,hasKey:true,tools:0,toolNames:[]}];window.auth.applied=true;window.auth.targetRevision='b'.repeat(64);}
else if(method==='github.auth.forget'){window.auth={...window.auth,revision:revision(),connected:false,applied:false,phase:'signedOut',detail:'本机 GitHub 登录已清除。'};delete window.auth.user;window.rows=window.rows.map(r=>({...r,hasKey:false,enabled:false,connected:false}));}
else if(method==='mcp.github.save')throw Error('Unexpected outer form submission');else throw Error(method);
return structuredClone(window.auth);}});
`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser'});
const server=createServer(async(req,res)=>{try{
 if(req.url==='/app.js'){res.setHeader('content-type','text/javascript');res.end(bundle.outputFiles[0].contents);}
 else if(req.url==='/style.css'){res.setHeader('content-type','text/css');res.end(await readFile('apps/tauri/ui/style.css'));}
 else if(/^\/characters\/[a-z]+\/idle-0.svg$/.test(req.url)){res.setHeader('content-type','image/svg+xml');res.end(await readFile(req.url.slice(1)));}
 else{res.setHeader('content-type','text/html;charset=utf-8');res.end(await readFile('apps/tauri/ui/index.html'));}
 }catch{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
const checks=[],errors=[];const pass=t=>{checks.push(t);console.log('PASS '+t);};
try{
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:390,height:844}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.address().port);await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:/网络工具 · MCP/}).click();
 const ui=page.locator('.mcp-page'),panel=ui.locator('.github-auth'),client=panel.getByLabel('GitHub 登录应用 Client ID',{exact:true});
 const github=()=>ui.getByRole('button',{name:'GitHub 官方',exact:true}).click();await github();assert(await panel.isHidden());assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method.startsWith('github.auth.')).length),0);pass('旧宿主隐藏浏览器登录，保留 Token 接入');
 await page.evaluate(()=>window.support());await client.waitFor();assert(await panel.getByRole('button',{name:'获取 GitHub 验证码',exact:true}).isDisabled());
 await page.evaluate(()=>{window.auth={...window.auth,phase:'error',configurationError:true,detail:'本地 GitHub 登录应用设置已损坏，请重新保存 Client ID。'};});
 await panel.getByRole('status').filter({hasText:'设置已损坏'}).waitFor();const repair=panel.getByRole('button',{name:'保存登录应用',exact:true});assert(await repair.isEnabled());await repair.click();let repairDialog=page.getByRole('alertdialog');await repairDialog.waitFor();assert.match(await repairDialog.innerText(),/清空.*清除此设备/s);await repairDialog.getByRole('button',{name:'取消',exact:true}).click();assert(await page.evaluate(()=>window.auth.configurationError));
 await repair.click();await repairDialog.getByRole('button',{name:'更换并清除旧登录',exact:true}).click();await page.waitForFunction(()=>window.auth.phase==='signedOut'&&!window.auth.configurationError);assert.equal(await client.inputValue(),'');assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='github.auth.begin'||c.method==='github.auth.apply').length),0);pass('损坏配置可明确保存为空，先确认旧登录清理且不自动授权或启用工具');
 await client.fill('https://invalid');await client.press('Enter');await panel.getByRole('alert').filter({hasText:'Client ID'}).waitFor();assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='mcp.github.save').length),0);
 await client.fill('Ov23_ui_fixture');await client.press('Enter');await page.waitForFunction(()=>window.auth.clientId==='Ov23_ui_fixture');await panel.getByRole('button',{name:'获取 GitHub 验证码',exact:true}).waitFor();await page.waitForTimeout(50);pass('Client ID 单独保存，输入回车不会误提交 MCP 表单');
 await page.evaluate(()=>window.delayBegin=true);await panel.getByRole('button',{name:'获取 GitHub 验证码',exact:true}).click();await page.waitForFunction(()=>!!window.finishBegin);assert(await client.isDisabled());assert(await ui.getByRole('button',{name:'保存设置',exact:true}).isDisabled());await page.evaluate(()=>window.finishBegin());await panel.getByText('ABCD-EFGH',{exact:true}).waitFor();
 await panel.getByRole('button',{name:'复制验证码并打开 GitHub',exact:true}).click();await page.waitForFunction(()=>window.calls.some(c=>c.method==='github.auth.open'));const open=await page.evaluate(()=>window.calls.find(c=>c.method==='github.auth.open'));assert.deepEqual(Object.keys(open.p),['revision']);pass('授权期间锁定重复提交，打开页面只传状态版本');
 for(const width of [360,390,430,768]){await page.setViewportSize({width,height:844});await panel.getByText('ABCD-EFGH',{exact:true}).scrollIntoViewIfNeeded();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:out+'/code-'+width+'.png'});}pass('手机和平板四种宽度验证码可读，无横向溢出');
 await ui.getByRole('button',{name:'返回',exact:true}).click();await page.evaluate(()=>window.authorized());assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='github.auth.cancel').length),0);
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:/网络工具 · MCP/}).click();await github();await panel.getByText(/fixture-user/).waitFor();pass('关闭设置页不取消登录，重新进入显示完成状态');
 const key=ui.getByLabel('GitHub Token（留空保留）',{exact:true});await key.fill('unsaved-token');await panel.getByRole('button',{name:'保存登录到此服务',exact:true}).click();await panel.getByRole('alert').filter({hasText:'尚未保存的 Token'}).waitFor();assert.equal(await key.inputValue(),'unsaved-token');assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='github.auth.apply').length),0);
 await key.fill('');await panel.getByRole('button',{name:'保存登录到此服务',exact:true}).click();await page.waitForFunction(()=>window.auth.applied);assert.equal(await key.inputValue(),'');assert.equal(await page.evaluate(()=>window.rows[0].enabled),false);pass('未保存 Token 保留，明确保存登录后才绑定服务且保持启用偏好');
 await panel.getByRole('button',{name:'清除此设备的 GitHub 登录',exact:true}).click();let dialog=page.getByRole('alertdialog');await dialog.waitFor();assert.match(await dialog.innerText(),/fixture-user/);await dialog.getByRole('button',{name:'取消',exact:true}).click();assert(await page.evaluate(()=>window.auth.connected));
 await panel.getByRole('button',{name:'清除此设备的 GitHub 登录',exact:true}).click();await dialog.getByRole('button',{name:'清除本机登录',exact:true}).click();await page.waitForFunction(()=>!window.auth.connected);await page.waitForFunction(()=>document.querySelector('.sheet-confirm').hidden);assert(!await page.evaluate(()=>window.rows[0].hasKey));pass('清除登录明确展示账号，可取消，确认后工具凭据状态刷新');
 if(await client.isHidden())await panel.getByText('登录应用设置',{exact:true}).click();await page.evaluate(()=>window.delayStatus=true);await page.waitForFunction(()=>!!window.finishStatus);await client.fill('Ov23_unsaved_client');await page.evaluate(()=>window.finishStatus());await page.waitForTimeout(80);assert.equal(await client.inputValue(),'Ov23_unsaved_client');await client.fill('Ov23_ui_fixture');assert(!await panel.getByRole('button',{name:'获取 GitHub 验证码',exact:true}).isDisabled());pass('迟到轮询保留草稿，恢复原 Client ID 后可继续登录');
 assert.deepEqual(errors,[]);
}finally{await browser?.close();await new Promise(r=>server.close(r));await writeFile(out+'/result.json',JSON.stringify({checks,errors},null,2));}
