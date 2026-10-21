import assert from 'node:assert/strict';import{execFileSync}from'node:child_process';import{readFile,writeFile,mkdir}from'node:fs/promises';import{createHash}from'node:crypto';import{probeCall as call}from'./lib/android-release-probe.mjs';
const out='.artifacts/android-1.0/migration-live';await mkdir(out,{recursive:true});const proof={checks:[]},owned=[];let before,originalToken,cleared=false,sourceApplied=false;
const adb=(...a)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...a],{encoding:'utf8',windowsHide:true,timeout:30000}).trim();
const delay=ms=>new Promise(r=>setTimeout(r,ms)),pass=s=>{proof.checks.push(s);console.log('PASS '+s);};
const password=JSON.parse(await readFile('.artifacts/android-1.0/migration-test-session.json','utf8')).password;
const exported=JSON.parse(await readFile('.artifacts/android-1.0/migration-export-proof.json','utf8'));
async function until(fn,timeout=20000){for(const end=Date.now()+timeout;Date.now()<end;){const result=await fn();if(result)return result;await delay(250);}throw Error('Migration UI timeout');}
async function memoryHash(){const listed=await call('library.memory.list');const files=[];for(const path of listed.files){const doc=await call('library.memory.read',{path});assert(!doc.truncated);files.push([path,createHash('sha256').update(doc.text).digest('hex')]);}return files;}
const publicState=s=>({companion:s.companion,provider:s.provider,providers:s.providers,pet:{scale:s.pet.scale,visible:s.pet.visible,quiet:s.pet.quiet,bubbleSeconds:s.pet.bubbleSeconds}});
async function inspectApply(token){const p=await call('backup.inspect',{token,password});await call('backup.apply',{id:p.id});}
try{
 adb('shell','am','start','-n','app.familiar.mobile/app.familiar.mobile.MainActivity');await delay(700);before=await call('snapshot.get');assert(before.backupManagement);assert(before.provider.keyConfigured);
 proof.originalMemoryHash=await memoryHash();proof.originalRecovery=await call('backup.capture');originalToken=(await call('backup.export',{password,includeKeys:true})).token;
 await call('ui.request',{method:'backup.choose'});const basename=exported.androidPath.split('/').at(-1);
 const entry=await until(async()=>{const nodes=await call('controls');return nodes.find(n=>n.resourceId==='android:id/title'&&n.text===basename&&n.right>n.left);});adb('shell','input','tap',String(entry.x),String(entry.y));
 const chosen=await until(async()=>await call('ui.result'));assert(chosen.ok,JSON.stringify(chosen));const token=chosen.result.token;assert(token);pass('正式签名包通过 Android 系统选择器读取旧签名单文件');
 await assert.rejects(call('backup.inspect',{token,password:password+'wrong'}),/BACKUP_DECRYPT/);assert((await call('snapshot.get')).provider.keyConfigured);pass('真实 Android 上错误密码不导入、不清除模型连接');
 await call('provider.save',{...before.provider,clearApiKey:true});cleared=true;assert.equal((await call('snapshot.get')).provider.keyConfigured,false);
 const preview=await call('backup.inspect',{token,password});proof.preview=preview;assert(preview.modelKeys>=1);assert(!JSON.stringify(preview).includes(password));await call('backup.apply',{id:preview.id});sourceApplied=true;assert((await call('snapshot.get')).provider.keyConfigured);pass('导入前移除目标测试模型密钥，导入后由新版 Keystore 恢复配置与凭据');
 const id=(await call('conversation.create')).id;owned.push(id);await call('message.send',{conversationId:id,text:'这是迁移后模型连接验收。请只回复：迁移连接成功。不要调用任何工具，也不要写入记忆。'});
 const completed=await until(async()=>{const s=await call('snapshot.get');if(s.activeReply)return;const last=s.conversations.find(c=>c.id===id)?.messages.at(-1);return last?.role==='assistant'&&last.status==='complete'?last:null;},180000);assert.match(completed.text,/迁移|成功/);proof.realModelReply=completed.text;pass('实际导入的 DeepSeek 连接完成真实模型调用');
 const rollback=await call('backup.recovery',{password});assert(rollback.rollback);await call('backup.apply',{id:rollback.id});sourceApplied=false;assert.equal((await call('snapshot.get')).provider.keyConfigured,false);assert.deepEqual(await memoryHash(),proof.originalMemoryHash);pass('真实恢复点回滚记忆，并恢复导入前的无密钥测试状态');
 await inspectApply(originalToken);originalToken=undefined;cleared=false;assert.deepEqual(await memoryHash(),proof.originalMemoryHash);assert.deepEqual(publicState(await call('snapshot.get')),publicState(before));pass('从独立加密保护备份恢复原正式版配置、记忆和有效模型密钥');
}catch(e){proof.error=e.message;process.exitCode=1;console.error(e.stack);}finally{
 try{await call('reply.cancel');if(sourceApplied){const r=await call('backup.recovery',{password});await call('backup.apply',{id:r.id});sourceApplied=false;}if(originalToken&&cleared){await inspectApply(originalToken);cleared=false;}for(const id of owned)await call('conversation.delete',{id});if(before?.activeConversationId)await call('conversation.select',{id:before.activeConversationId});await call('backup.cleanup');proof.restored=before?JSON.stringify(await memoryHash())===JSON.stringify(proof.originalMemoryHash)&&JSON.stringify(publicState(await call('snapshot.get')))===JSON.stringify(publicState(before)):false;assert(proof.restored);}
 catch(e){proof.restoreError=e.message;process.exitCode=1;console.error('RESTORE '+e.message);}await writeFile(out+'/result.json',JSON.stringify(proof,null,2));
}
