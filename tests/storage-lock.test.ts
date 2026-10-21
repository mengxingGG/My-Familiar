import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {replaceFile} from '../plugins/storage-local/rename.ts';

test('Windows 实际文件锁：短暂占用后完成原子替换，持续占用失败保留原文', {skip:process.platform!=='win32'}, async()=>{
  const root=await mkdtemp(resolve('.artifacts/storage-lock-')),target=join(root,'target.txt'),source=join(root,'pending.txt');
  const script=join(root,'lock.ps1'); let child: ReturnType<typeof spawn> | undefined;
  // 锁的路径来自隔离测试目录环境变量，不拼接成 PowerShell 代码。
  await writeFile(script, "$f=[IO.File]::Open($env:FAMILIAR_LOCK_TEST_PATH,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)\ntry { [Console]::WriteLine('READY'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }\n");
  async function lock(){
    child=spawn('powershell.exe',['-NoProfile','-File',script],{windowsHide:true,env:{...process.env,FAMILIAR_LOCK_TEST_PATH:target},stdio:['pipe','pipe','pipe']});
    await new Promise<void>((done,fail)=>{let s='';child!.stdout!.on('data',b=>{s+=String(b);if(s.includes('READY'))done();});child!.once('error',fail);child!.once('exit',code=>{if(!s.includes('READY'))fail(Error(`lock exited ${code}`));});});
  }
  async function unlock(){if(child){const ended=once(child,'exit');child.stdin!.end('\n');await ended;child=undefined;}}
  try{
    await writeFile(target,'原文');await writeFile(source,'新内容');await lock();
    const changing=replaceFile(source,target);assert.equal(await readFile(target,'utf8'),'原文');
    await new Promise(r=>setTimeout(r,120));await unlock();await changing;assert.equal(await readFile(target,'utf8'),'新内容');
    await writeFile(source,'不应覆盖');await lock();
    await assert.rejects(replaceFile(source,target),e=>['EPERM','EBUSY'].includes((e as NodeJS.ErrnoException).code??''));
    assert.equal(await readFile(target,'utf8'),'新内容');assert.equal(await readFile(source,'utf8'),'不应覆盖');
  }finally{await unlock();await rm(root,{recursive:true,force:true});}
});
