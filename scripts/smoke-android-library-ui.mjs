import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const output = '.artifacts/android-library-ui'; await mkdir(output, { recursive: true });
const bundle = await build({ stdin: { contents: `
import {mountApp} from './apps/tauri/ui/app.ts';import {createPreviewBridge} from './apps/tauri/preview/fixture.ts';
const fixture=createPreviewBridge(),state=await fixture.request('snapshot.get');fixture.dispose();state.library={memory:true,skills:true};state.media={choose:true,maxAttachments:8,maxBytes:12582912,maxTextBytes:400000};
let version=0;const doc=(path,text)=>({path,text,revision:String(++version).padStart(64,'0'),characters:Array.from(text).length,truncated:false,...(path==='CORE.md'?{limit:2000}:{})});
window.docs={'CORE.md':doc('CORE.md','原规则'),'USER.md':doc('USER.md','身份')};window.calls=[];window.skills=[{id:'demo-skill',description:'<img src=x onerror=alert(1)>',enabled:true,supported:true,valid:true}];
window.skillSource='---\\nname: imported-skill\\ndescription: 完整文件导入\\n---\\n'+'步骤'.repeat(7000)+'TAIL-COMPLETE';window.delaySave=false;window.delayRead=false;
mountApp({subscribe(){return()=>{};},async request(method,p){window.calls.push({method,p});if(method==='snapshot.get')return structuredClone(state);
if(method==='library.memory.list')return{files:Object.keys(window.docs),core:{characters:window.docs['CORE.md'].characters,limit:2000},index:{characters:0,limit:1000,omitted:0}};
if(method==='library.memory.read'){const value=structuredClone(window.docs[p.path]);if(window.delayRead&&p.path==='USER.md')await new Promise(r=>window.finishRead=r);return value;}
if(method==='library.memory.search')return Object.values(window.docs).filter(d=>d.text.includes(p.query)).map(d=>({path:d.path,excerpt:d.text}));
if(method==='library.memory.write'){if(window.delaySave)await new Promise(r=>window.finishSave=r);const old=window.docs[p.path];if(old&&old.revision!==p.revision)throw{code:'CONFLICT'};return window.docs[p.path]=doc(p.path,p.text);}
if(method==='library.skills.list'){const value={items:structuredClone(window.skills),total:window.skills.length,nextOffset:null};if(window.delaySkills)await new Promise(r=>window.finishSkills=r);return value;}
if(method==='library.skills.read')return{id:p.id,text:window.skillSource};
if(method==='library.skills.source')return{text:window.skillSource};
if(method==='media.choose')return[{id:'c13b3f20-e67f-4c28-91db-e24f95d385b2',name:'SKILL.md',kind:'text',mimeType:'text/plain',bytes:43000}];
if(method==='library.skills.install'){const id=/name: (.*)/.exec(p.content)[1];const s={id,description:'导入技能',enabled:true,supported:true,valid:true};window.skills.push(s);return s;}
if(method==='library.skills.toggle'){const s=window.skills.find(s=>s.id===p.id);s.enabled=p.enabled;return structuredClone(s);}
if(method==='library.skills.remove'){window.skills=window.skills.filter(s=>s.id!==p.id);return;}
throw Error(method);}});
`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'browser' });
const server = createServer(async (req,res) => { if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].contents);}else if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end(await readFile('apps/tauri/ui/style.css'));}else if(/^\/characters\/[a-z]+\/idle-0.svg$/.test(req.url)){res.setHeader('Content-Type','image/svg+xml');res.end(await readFile(req.url.slice(1)));}else{res.setHeader('Content-Type','text/html;charset=utf-8');res.end(await readFile('apps/tauri/ui/index.html'));} });
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:390,height:844}}),results=[],errors=[];
page.on('pageerror',e=>errors.push(e.message));const pass=text=>{results.push(text);console.log('PASS '+text);};
try {
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'记忆与技能 查看、整理记忆与管理技能'}).click();
 const editor=page.getByRole('textbox',{name:'记忆内容',exact:true});await page.getByRole('button',{name:'CORE.md',exact:true}).click();await editor.fill('本地草稿');
 await page.getByRole('button',{name:'USER.md',exact:true}).click();await editor.fill('身份草稿');await page.getByRole('button',{name:'CORE.md',exact:true}).click();assert.equal(await editor.inputValue(),'本地草稿');
 await page.locator('.library-page .pagebar button').click();await page.getByRole('button',{name:'记忆与技能 查看、整理记忆与管理技能'}).click();assert.equal(await editor.inputValue(),'本地草稿');pass('切换文件与返回页面保留草稿');
 await page.evaluate(()=>{window.docs['CORE.md']={...window.docs['CORE.md'],text:'聊天写入的新规则',revision:'9'.repeat(64)};});await page.getByRole('button',{name:'保存记忆',exact:true}).click();await page.getByText('有新版本，草稿未覆盖。请读取最新版本并合并。',{exact:true}).waitFor();assert.equal(await editor.inputValue(),'本地草稿');
 await page.getByRole('button',{name:'读取最新版本',exact:true}).click();await page.locator('.library-compare pre').getByText('聊天写入的新规则',{exact:true}).waitFor();assert(await page.getByRole('button',{name:'保存记忆',exact:true}).isDisabled());
 await page.getByRole('button',{name:'保留草稿，开始合并',exact:true}).click();await editor.fill('本地草稿 + 聊天新规则');await page.getByRole('button',{name:'保存记忆',exact:true}).click();await page.waitForFunction(()=>window.docs['CORE.md'].text==='本地草稿 + 聊天新规则');pass('修订冲突保留草稿并显式合并');
 await editor.fill('发送保存的版本');await page.evaluate(()=>window.delaySave=true);await page.getByRole('button',{name:'保存记忆',exact:true}).click();await page.waitForFunction(()=>!!window.finishSave);await editor.fill('等待保存时继续输入');await page.evaluate(()=>{window.delaySave=false;window.finishSave();});await page.getByText('有未保存的修改',{exact:true}).waitFor();assert.equal(await editor.inputValue(),'等待保存时继续输入');pass('迟到的保存结果不覆盖继续输入');
 await page.locator('.library-create summary').click();await page.getByLabel('文件名称',{exact:true}).fill('手机资料');await page.getByRole('button',{name:'开始编辑',exact:true}).click();await editor.fill('新建的扩展记忆');await page.getByRole('button',{name:'保存记忆',exact:true}).click();await page.waitForFunction(()=>window.docs['topics/手机资料.md']?.text==='新建的扩展记忆');
 await page.getByLabel('搜索记忆',{exact:true}).fill('新建');await page.getByRole('button',{name:'搜索',exact:true}).click();await page.locator('.library-files button').first().waitFor();assert.equal(await page.locator('.library-files button').count(),1);pass('新建分层记忆与关键词查找');
 for(const width of [360,390,430,768]){await page.setViewportSize({width,height:844});await editor.scrollIntoViewIfNeeded();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`${output}/memory-${width}.png`});}
 await page.getByRole('button',{name:'技能',exact:true}).click();await page.locator('.library-skill').waitFor();assert.equal(await page.locator('.library-skill img').count(),0);
 await page.getByRole('button',{name:'从手机选择 SKILL.md',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.library-install textarea').value.endsWith('TAIL-COMPLETE'));assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='library.skills.install').length),0);
 assert((await page.getByLabel('技能文档',{exact:true}).inputValue()).length>12000);await page.getByRole('button',{name:'安装技能',exact:true}).click();await page.getByRole('heading',{name:'imported-skill',exact:true}).waitFor();
 await page.evaluate(()=>window.delaySkills=true);await page.getByRole('button',{name:'刷新技能',exact:true}).click();await page.waitForFunction(()=>!!window.finishSkills);
 await page.getByRole('button',{name:'停用 imported-skill',exact:true}).click();await page.getByRole('button',{name:'启用 imported-skill',exact:true}).waitFor();await page.evaluate(()=>{window.delaySkills=false;window.finishSkills();});await page.waitForTimeout(100);assert(await page.getByRole('button',{name:'启用 imported-skill',exact:true}).isVisible());pass('选择文件导入完整正文，确认安装，启停技能；旧列表不回滚状态');
 const imported=page.locator('.library-skill').filter({has:page.getByRole('heading',{name:'imported-skill',exact:true})});await imported.getByRole('button',{name:'移除',exact:true}).click();const dialog=page.getByRole('alertdialog');await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='library.skills.remove').length),0);
 await imported.getByRole('button',{name:'移除',exact:true}).click();await dialog.getByRole('button',{name:'移除技能',exact:true}).click();await page.waitForFunction(()=>!window.skills.some(s=>s.id==='imported-skill'));pass('技能内容按纯文本显示；移除确认可取消');
 await page.getByLabel('技能文档',{exact:true}).fill('保留现有草稿');await page.getByRole('button',{name:'从手机选择 SKILL.md',exact:true}).click();await dialog.getByRole('heading',{name:'替换技能草稿',exact:true}).waitFor();await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await page.getByLabel('技能文档',{exact:true}).inputValue(),'保留现有草稿');
 for(const width of [360,390,430,768]){await page.setViewportSize({width,height:844});await page.getByLabel('技能文档',{exact:true}).scrollIntoViewIfNeeded();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`${output}/skills-${width}.png`});}pass('文件替换可取消；四种宽度的记忆和技能页无溢出');
 assert.deepEqual(errors,[]);
} catch(error) { await page.screenshot({path:`${output}/failure.png`});console.error(await page.locator('.library-page').innerText(),errors);throw error; } finally { await browser.close();await new Promise(r=>server.close(r));await writeFile(`${output}/result.json`,JSON.stringify({date:new Date().toISOString(),results,errors},null,2)); }
