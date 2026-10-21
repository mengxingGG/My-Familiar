import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {compareVersions, selectRelease, RELEASE_ENDPOINT} from '../plugins/app-updates/release.ts';
import {UpdateManager} from '../plugins/app-updates/manager.ts';
import {validUpdate, projectUpdate} from '../packages/mobile-bridge/updates.ts';
const data = Buffer.from('Familiar update fixture\n');
const sha = createHash('sha256').update(data).digest('hex');
function release(v = '1.2.0') {return {tag_name: 'v'+v, draft:false, prerelease:false, assets: [`Familiar-${v}-arm64.apk`,`Familiar-${v}-Setup-x64.exe`,`Familiar-${v}-win-x64.zip`].map(name=>({name,size:data.length,digest:'sha256:'+sha,browser_download_url:`https://github.com/mengxingGG/My-Familiar/releases/download/v${v}/${name}`}))};}
async function fixture(run: (x: {manager:UpdateManager; directory:string; saved:()=>unknown; requests:string[]; opened:string[]; setRelease:(v: unknown)=>void; setData:(v: Buffer)=>void}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(),'familiar-update-')); let saved: unknown = null, meta: unknown = release(), body: Buffer = data;
  const requests:string[] = [], opened:string[] = [];
  const manager = new UpdateManager({currentVersion:'1.1.0', platform:'android-arm64',directory,open:async path=>{opened.push(path);},fetch: (async (url:any)=>{requests.push(String(url)); return String(url) === RELEASE_ENDPOINT ? Response.json(meta) : new Response(new Uint8Array(body));}) as typeof fetch},async value=>{saved=value;});
  try {await run({manager,directory,saved:()=>saved,requests,opened,setRelease:v=>{meta=v;},setData:v=>{body=v;}});}
  finally {await manager.dispose(); await rm(directory,{recursive:true,force:true});}
}
async function settled(manager: UpdateManager) {for(let i=0;i<100 && manager.state().phase==='downloading';i++) await new Promise(r=>setTimeout(r,10)); assert.notEqual(manager.state().phase,'downloading');}
test('正式版按数字比较，拒绝迁移测试版，严格选择本机安装包',()=>{
  assert.equal(compareVersions('1.10.0','1.9.9'),1); assert.equal(compareVersions('1.1.0','1.1.0'),0);
  assert.throws(()=>compareVersions('1.1.0-beta','1.0.0'));
  assert.equal(selectRelease(release(),'android-arm64').name,'Familiar-1.2.0-arm64.apk');
  assert.equal(selectRelease(release(),'windows-x64').name,'Familiar-1.2.0-Setup-x64.exe');
  for(const bad of [{...release(),prerelease:true},{...release(),draft:true},{...release(),tag_name:'v0.3.1-migration'},{...release(),assets:[]}]) assert.throws(()=>selectRelease(bad,'android-arm64'));
  const bad = release(); bad.assets[0].browser_download_url='https://example.com/setup.apk'; assert.throws(()=>selectRelease(bad,'android-arm64'));
  const missingDigest=release(); missingDigest.assets[0].digest=''; assert.throws(()=>selectRelease(missingDigest,'android-arm64'));
});
test('只有显式下载才请求安装包，重复点击合并，SHA 校验后才能打开',()=>fixture(async({manager,requests,directory,opened})=>{
  const checks=await Promise.all([manager.check(),manager.check()]); assert.equal(checks[0].phase,'available'); assert.equal(requests.length,1);
  assert.equal(manager.download().phase,'downloading'); manager.download(); await settled(manager);
  assert.equal(manager.state().phase,'ready'); assert.equal(requests.length,2);
  assert.deepEqual(await readFile(join(directory,'Familiar-1.2.0-arm64.apk')),data);
  assert.equal(opened.length,0); await manager.open(); assert.equal(opened.length,1);
  assert(validUpdate(manager.state())); assert.deepEqual(projectUpdate({...manager.state(),secret:'never'}),manager.state());
}));
test('错误/截断安装包不能打开，重试成功，篡改已下载文件会重新拒绝',()=>fixture(async({manager,setData,directory,opened})=>{
  await manager.check(); setData(Buffer.from('broken')); manager.download(); await settled(manager);
  assert.equal(manager.state().phase,'error'); await assert.rejects(manager.open());
  setData(data); manager.download(); await settled(manager); assert.equal(manager.state().phase,'ready');
  await writeFile(join(directory,'Familiar-1.2.0-arm64.apk'),'tampered'); await manager.open();
  assert.equal(manager.state().phase,'error'); assert.equal(opened.length,0);
}));
test('重启恢复安装包及校验状态，旧缓存不提示降级更新',()=>fixture(async({manager,saved,directory})=>{
  await manager.check(); manager.download(); await settled(manager);
  const next=new UpdateManager({currentVersion:'1.1.0',platform:'android-arm64',directory,open:async()=>{}},async()=>{});
  await next.restore(saved()); assert.equal(next.state().phase,'ready'); await next.dispose();
  const upgraded=new UpdateManager({currentVersion:'1.2.0',platform:'android-arm64',directory,open:async()=>{}},async()=>{});
  await upgraded.restore(saved()); assert.equal(upgraded.state().assetName,null); await upgraded.dispose();
}));
test('最新版本及旧版本均不自动下载或提示降级',()=>fixture(async({manager,setRelease,requests})=>{
  for(const v of ['1.1.0','1.0.0']) {setRelease(release(v)); assert.equal((await manager.check()).phase,'current'); assert.equal(manager.state().assetName,null);}
  assert(requests.every(u=>u===RELEASE_ENDPOINT));
}));
test('取消未完成的传输不会打开或留下半个安装包', async()=>{
  const directory=await mkdtemp(join(tmpdir(),'familiar-update-cancel-'));
  const manager=new UpdateManager({currentVersion:'1.1.0',platform:'android-arm64',directory,open:async()=>{throw Error('must not open');},fetch:(async(url:any,init:any)=>{
    if(String(url)===RELEASE_ENDPOINT) return Response.json(release());
    return new Response(new ReadableStream({start(controller){controller.enqueue(data.subarray(0,4));init.signal.addEventListener('abort',()=>controller.error(new Error('aborted')));}}));
  }) as typeof fetch},async()=>{});
  try {await manager.check(); manager.download(); await new Promise(r=>setTimeout(r,30)); manager.cancel(); await settled(manager); assert.equal(manager.state().phase,'available'); await assert.rejects(readFile(join(directory,'Familiar-1.2.0-arm64.apk.part')));}
  finally {await manager.dispose(); await rm(directory,{recursive:true,force:true});}
});
