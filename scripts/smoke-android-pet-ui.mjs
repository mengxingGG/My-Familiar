import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const output='.artifacts/android-pet-ui';await mkdir(output,{recursive:true});
const bundle=await build({stdin:{contents:`
import {mountApp} from './apps/tauri/ui/app.ts';import {createPreviewBridge} from './apps/tauri/preview/fixture.ts';
const fixture=createPreviewBridge();const state=await fixture.request('snapshot.get');fixture.dispose();
state.pet={scale:1,visible:true,quiet:false,bubbleSeconds:15,action:'idle',docking:{snapToEdge:false,hideWhenIdle:true,delaySeconds:30,tucked:false}};
let listener;window.calls=[];window.fail=false;const publish=()=>{state.revision++;listener?.(structuredClone(state));};window.tick=publish;
mountApp({subscribe(fn){listener=fn;publish();return()=>{};},async request(method,p){window.calls.push({method,p});if(method==='snapshot.get')return structuredClone(state);
if(window.fail)throw Error('fixture failed');if(method==='pet.docking.save')Object.assign(state.pet.docking,p);else if(method==='pet.settings.save')Object.assign(state.pet,p);else if(method!=='pet.interact')throw Error('unsupported');publish();}});
`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser'});
const server=createServer(async(req,res)=>{if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].contents);}else if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end(await readFile('apps/tauri/ui/style.css'));}else if(/^\/characters\/[a-z]+\/idle-0.svg$/.test(req.url)){res.setHeader('Content-Type','image/svg+xml');res.end(await readFile(req.url.slice(1)));}else{res.setHeader('Content-Type','text/html;charset=utf-8');res.end(await readFile('apps/tauri/ui/index.html'));}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:390,height:844}});const results=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByRole('button',{name:'设置',exact:true}).click();await page.locator('.pet-details summary').click();
 const snap=page.getByLabel('拖动后自动吸附边缘',{exact:true}),hide=page.getByLabel('停靠后闲置收成小脑袋',{exact:true}),delay=page.getByLabel('闲置多久收起（秒）',{exact:true});
 assert(await hide.isDisabled());await snap.check();await delay.fill('45');await page.evaluate(()=>window.tick());assert.equal(await delay.inputValue(),'45');
 await page.getByRole('button',{name:'保存停靠设置',exact:true}).click();await page.getByText('停靠设置已保存',{exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.calls.findLast(c=>c.method==='pet.docking.save').p),{snapToEdge:true,hideWhenIdle:true,delaySeconds:45});
 await hide.uncheck();assert(await delay.isDisabled());await page.getByRole('button',{name:'保存停靠设置',exact:true}).click();
 await page.getByLabel('宠物大小（%）',{exact:true}).fill('125');await page.getByRole('button',{name:'保存宠物设置',exact:true}).click();assert.equal(await page.evaluate(()=>window.calls.findLast(c=>c.method==='pet.settings.save').p.scale),1.25);
 results.push('吸附/闲置收起分别设置；编辑草稿不被刷新覆盖；尺寸百分比正确传递');
 await page.evaluate(()=>{window.fail=true;});await snap.uncheck();await page.getByRole('button',{name:'保存停靠设置',exact:true}).click();await page.waitForTimeout(100);assert(!(await snap.isChecked()));await page.evaluate(()=>{window.fail=false;window.tick();});assert(!(await snap.isChecked()));
 results.push('宿主保存失败保留未保存草稿');
 for(const width of [360,390,430,768]){await page.setViewportSize({width,height:844});await page.getByRole('button',{name:'保存停靠设置',exact:true}).scrollIntoViewIfNeeded();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const box=await snap.locator('..').boundingBox();assert(box&&box.height>=44);await page.screenshot({path:`${output}/settings-${width}.png`});}
 results.push('四种宽度无横向溢出');assert.deepEqual(errors,[]);console.log(results.map(x=>'PASS '+x).join('\n'));
}finally{await browser.close();await new Promise(r=>server.close(r));await writeFile(`${output}/result.json`,JSON.stringify({results,errors},null,2));}
