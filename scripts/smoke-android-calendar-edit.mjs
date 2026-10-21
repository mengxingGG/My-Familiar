import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {chromium} from 'playwright';

// 仅写本轮独立 LOCAL 日历；模型为回环协议夹具，原配置与会话在 finally 恢复。
const app='app.familiar.mobile.debug',out='.artifacts/android-device',cdp=9255,fixture='familiar-calendar-edit-'+randomUUID();
const adb=(...a)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...a],{encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:8*1024*1024}).trim();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const results=[],proof={date:new Date().toISOString(),fixture,catalogCalls:0};let browser,page,before,conversationId,calendarId,seq=0,plan,step=0,outputs=[],changed=false,approvalHook,schema='',ref;
const pass=name=>{results.push(name);console.log('PASS '+name);};
const server=createServer(async(req,res)=>{
 try{let raw='';for await(const c of req)raw+=c;const request=JSON.parse(raw);
  const m=request.messages.filter(m=>m.role==='tool').at(-1),previous=request.messages.filter(m=>m.role==='assistant'&&m.tool_calls?.length).at(-1)?.tool_calls.at(-1).function.name;
  let item;
  if(step++===0){schema='';item=request.tools.some(t=>t.function.name===plan.name)?plan:{name:'android_calendar_tools_search',args:{query:plan.name}};}
  else if(previous==='android_calendar_tools_search'){const found=JSON.parse(m.content).tools.find(t=>t.name===plan.name);assert(found);ref=found.ref;item={name:'android_calendar_tool_schema',args:{ref}};}
  else if(previous==='android_calendar_tool_schema'){const part=JSON.parse(m.content);schema+=part.schema;item=part.nextOffset===null?{name:'android_calendar_tool_invoke',args:{ref,arguments:plan.args}}:{name:'android_calendar_tool_schema',args:{ref,offset:part.nextOffset}};if(part.nextOffset===null){assert.equal(JSON.parse(schema).type,'object');proof.catalogCalls++;}}
  else {try{outputs.push(JSON.parse(m.content));}catch{outputs.push(m?.content);}}
  if(item)assert(request.tools.some(t=>t.function.name===item.name),item.name+' not advertised');
  const choice=item?{delta:{tool_calls:[{index:0,id:'calendar-edit-step-'+step,type:'function',function:{name:item.name,arguments:JSON.stringify(item.args)}}]},finish_reason:'tool_calls'}:{delta:{content:'隔离日历验收完成。'},finish_reason:'stop'};
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[choice]})}\n\ndata: [DONE]\n\n`);
 }catch{res.statusCode=500;res.end('fixture failure');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;adb('reverse',`tcp:${port}`,`tcp:${port}`);
async function until(fn,ms=45000){for(const end=Date.now()+ms;Date.now()<end;){const v=await fn();if(v)return v;await delay(100);}throw Error('Device condition timeout');}
async function call(method,params){const r=await page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:'calendar-edit-'+(++seq),method,params});assert(r.ok,JSON.stringify(r));return r.result;}
async function attach(){await browser?.close();adb('shell','am','start','-n',`${app}/app.familiar.mobile.MainActivity`);browser=undefined;
 for(let i=0;i<60;i++)try{adb('forward',`tcp:${cdp}`,`localabstract:webview_devtools_remote_${adb('shell','pidof',app)}`);browser=await chromium.connectOverCDP(`http://127.0.0.1:${cdp}`,{timeout:1500});break;}catch{await delay(250);}
 assert(browser);page=browser.contexts()[0].pages()[0];await page.locator('#familiar-root[data-ready="true"]').waitFor();}
const snapshot=()=>call('snapshot.get'),op=()=>fixture+'-'+(++seq);
async function tool(name,args,approve=true){
 if(conversationId){await call('conversation.select',{id:before.activeConversationId});await call('conversation.delete',{id:conversationId});conversationId=undefined;}
 conversationId=(await call('conversation.create')).id;plan={name,args};outputs=[];step=0;await call('message.send',{conversationId,text:'仅执行本轮隔离日历验收。'});
 await until(async()=>{const s=await snapshot();for(const task of s.tasks){assert.equal(task.kind,'calendar');if(approvalHook){const hook=approvalHook;approvalHook=undefined;await hook(task);}await call('task.respond',{id:task.id,action:approve?'approve':'stop'});}
  const last=s.conversations.find(c=>c.id===conversationId)?.messages.at(-1);assert.notEqual(last?.status,'error',JSON.stringify(last));return last?.role==='assistant'&&last.status==='complete';});
 assert.equal(outputs.length,1,JSON.stringify(outputs));return outputs[0];
}
const query=(table,projection,where)=>adb('shell','content','query','--uri','content://com.android.calendar/'+table,'--projection',projection,...(where?['--where',`'${where}'`]:[]));
const rows=()=>query('events','_id',`calendar_id=${calendarId} AND deleted=0`).split('\n').filter(s=>s.includes('Row:')).length;
const createArgs=(title,start,end,timeZone,recurrence,allDay=false)=>({operationId:op(),calendarId,title:fixture+'-'+title,start,end,timeZone,allDay,...(recurrence?{recurrence}:{})});
async function create(args){const v=await tool('android_calendar_create',args);assert.equal(v.status,'completed',JSON.stringify(v));return v;}
async function instances(id,start,end){const v=await tool('android_calendar_query',{start,end});assert(!v.truncated);assert(Array.isArray(v.events),JSON.stringify(v));return v.events.filter(e=>e.id===id);}
const dates=rows=>rows.map(r=>r.start.slice(0,10));
try{
 await attach();await call('runtime.set',{enabled:true});before=await snapshot();assert(before.capabilities.some(c=>c.id==='calendar'&&c.state==='granted'));assert(before.activeConversationId&&!before.activeReply&&before.tasks.length===0&&!before.voice.state.active&&!before.voice.wake.armed);proof.configuredProfilesPreserved=before.providers.filter(p=>p.profile.keyConfigured).map(p=>p.id);proof.vaultHashBefore=adb('shell','run-as',app,'sha256sum','no_backup/credentials.v1').split(/\s/)[0];
 await writeFile(out+'/calendar-edit-before.json',JSON.stringify({snapshot:before},null,2));changed=true;await call('pet.settings.save',{scale:before.pet.scale,visible:before.pet.visible,quiet:true,bubbleSeconds:0});
 await call('provider.save',{kind:'compatible',baseUrl:`http://127.0.0.1:${port}/v1`,model:'calendar-edit-fixture',advanced:{...before.providers.find(p=>p.id==='compatible').profile.advanced,maxOutputTokens:2048,contextTokens:131072}});
 const uri=`content://com.android.calendar/calendars?caller_is_syncadapter=true&account_name=${fixture}&account_type=LOCAL`;
 adb('shell',`content insert --uri '${uri}' --bind account_name:s:${fixture} --bind account_type:s:LOCAL --bind name:s:${fixture} --bind calendar_displayName:s:${fixture} --bind ownerAccount:s:${fixture} --bind calendar_access_level:i:700 --bind visible:i:1 --bind sync_events:i:1 --bind calendar_timezone:s:UTC --bind maxReminders:i:5 --bind allowedReminders:s:0,1`);
 calendarId=query('calendars','_id:name').split('\n').find(s=>s.includes('name='+fixture))?.match(/_id=(\d+)/)?.[1];assert(calendarId);proof.calendarId=calendarId;
 const read=id=>tool('android_calendar_read',{eventId:id});
 const single=(seriesId,originalStart)=>tool('android_calendar_instance_read',{seriesId,originalStart});
 const list=async()=>{const v=await tool('android_calendar_query',{start:'2026-10-26T00:00:00Z',end:'2026-11-10T00:00:00Z'});assert(!v.truncated);return v.events.filter(e=>e.calendarId===calendarId);};
 const ok=v=>{assert.equal(v.status,'completed',JSON.stringify(v));return v;};
 const daily=await create(createArgs('每日例会','2026-10-30T09:00:00-04:00','2026-10-30T10:00:00-04:00','America/New_York',{frequency:'daily',count:5}));
 const unsynced=await single(daily.eventId,'2026-11-01T14:00:00Z');assert.equal(unsynced.editable,false);const localCount=rows();
 const unavailable=await tool('android_calendar_instance_cancel',{operationId:op(),target:unsynced.target});assert.equal(unavailable.status,'unavailable');assert.match(unavailable.detail,/未写入/);assert.equal(rows(),localCount);assert.equal((await list()).length,5);pass('没有同步标识的本地系列在写入前拒绝单次操作，其他日期完整保留');
 // 仅为本轮独立 LOCAL 日历模拟同步器赋予 ID；不伪装成真实云端同步验收。
 const syncUri=id=>`content://com.android.calendar/events/${id}?caller_is_syncadapter=true&account_name=${fixture}&account_type=LOCAL`;
 const synced=id=>adb('shell',`content update --uri '${syncUri(id)}' --bind _sync_id:s:${fixture}-${id}`);
 synced(daily.eventId);
 let master=await read(daily.eventId);ok(await tool('android_calendar_reminders_set',{operationId:op(),target:master.target,scope:'series',minutes:[5,30]}));master=await read(daily.eventId);
 assert.equal(master.target.exceptionCount,0);const all=await list();assert.equal(all.length,5);assert(all.every(e=>e.seriesId===daily.eventId&&e.originalStart===e.start));
 let instance=await single(daily.eventId,'2026-11-01T14:00:00Z');assert.equal(instance.target.start,'2026-11-01T14:00:00Z');assert.equal(instance.target.end,'2026-11-01T15:00:00Z');assert(!instance.isException);proof.initial=instance;
 pass('实例从真实 Instances 展开读取，跨夏令时时间和系列定位正确');
 const move={operationId:op(),target:instance.target,patch:{availability:'free',visibility:'private',title:'本周延后一次',start:'2026-11-02T11:00:00-05:00',end:'2026-11-02T12:30:00-05:00',timeZone:'America/New_York',location:'线上'}};
 const count=rows();assert.match(JSON.stringify(await tool('android_calendar_instance_update',move,false)),/拒绝/);assert.equal(rows(),count);assert.equal((await read(daily.eventId)).target.revision,master.target.revision);
 approvalHook=async task=>{assert.equal(task.title,'修改这一次日程');assert.match(task.detail,/范围：仅这一次/);assert.match(task.detail,/原定开始：2026-11-01T14:00:00Z/);assert.match(task.detail,/新结束：2026-11-02T12:30/);proof.singleApproval=task;adb('shell','input','keyevent','KEYCODE_HOME');await delay(800);await writeFile(out+'/calendar-edit-single-approval.png',execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554','exec-out','screencap','-p'],{windowsHide:true}));};
 const moved=ok(await tool('android_calendar_instance_update',move));adb('shell','am','start','-n',`${app}/app.familiar.mobile.MainActivity`);assert.notEqual(moved.eventId,daily.eventId);const movedRecord=await read(moved.eventId);assert.equal(movedRecord.availability,1);assert.equal(movedRecord.accessLevel,2);assert.equal(rows(),count+1);instance=await single(daily.eventId,'2026-11-01T14:00:00Z');assert(instance.isException);assert.equal(instance.target.start,'2026-11-02T16:00:00Z');assert.deepEqual(instance.reminders.map(r=>r.minutes).sort((a,b)=>a-b),[5,30]);
 const movedRows=await list();proof.moved=movedRows;proof.movedMaster=await read(daily.eventId);proof.rawAfterMove=query('events','_id:title:dtstart:dtend:rrule:duration:original_id:originalInstanceTime:eventStatus',`calendar_id=${calendarId}`);await writeFile(out+'/calendar-edit-intermediate.json',JSON.stringify(proof,null,2));assert.equal(movedRows.length,5);assert(!movedRows.some(e=>e.start==='2026-11-01T14:00:00Z'));const changedRow=movedRows.find(e=>e.id===moved.eventId);assert.equal(changedRow.originalStart,'2026-11-01T14:00:00Z');assert.equal(changedRow.seriesId,daily.eventId);
 pass('拒绝无写入；批准后仅一次跨日改期，保留提醒及其他四次安排');
 assert.deepEqual(await tool('android_calendar_instance_update',move),moved);assert.equal(rows(),count+1);assert.match(JSON.stringify(await tool('android_calendar_instance_update',{...move,patch:{title:'不同参数'}})),/INVALID_INPUT/);
 const second=ok(await tool('android_calendar_instance_update',{operationId:op(),target:instance.target,patch:{location:'二次调整',description:'只改这次'}}));assert.equal(second.eventId,moved.eventId);assert.equal(rows(),count+1);proof.second=second;
 pass('同编号返回缓存，改参数拒绝；再次修改复用原例外，没有复制第二条');
 const stale=await tool('android_calendar_delete',{operationId:op(),target:master.target,scope:'series'});assert.match(JSON.stringify(stale),/CONFLICT/);assert.equal(rows(),count+1);
 const staleSingle=await tool('android_calendar_instance_cancel',{operationId:op(),target:instance.target});assert.match(JSON.stringify(staleSingle),/CONFLICT/);
 master=await read(daily.eventId);const oldExceptions=master.exceptions;
 const renamed=ok(await tool('android_calendar_update',{operationId:op(),target:master.target,scope:'series',patch:{title:'整个系列改名'}}));assert.deepEqual(renamed.event.exceptions,oldExceptions);assert.equal((await single(daily.eventId,'2026-11-01T14:00:00Z')).target.title,'本周延后一次');
 const protectedSchedule=await tool('android_calendar_update',{operationId:op(),target:renamed.event.target,scope:'series',patch:{start:'2026-10-30T10:00:00-04:00',end:'2026-10-30T11:00:00-04:00',timeZone:'America/New_York',recurrence:{frequency:'daily',count:6}}});assert.match(JSON.stringify(protectedSchedule),/UNAVAILABLE/);assert.equal((await read(daily.eventId)).target.revision,renamed.event.target.revision);
 pass('系列及单次旧版本均拒绝；系列改名保留例外，有例外时重排整组被保护');
 instance=await single(daily.eventId,'2026-11-01T14:00:00Z');const cancel={operationId:op(),target:instance.target};const canceled=ok(await tool('android_calendar_instance_cancel',cancel));assert.equal(canceled.eventId,moved.eventId);assert(canceled.instance.target.cancelled);assert.equal((await list()).length,4);assert.equal(rows(),count+1);assert.deepEqual(await tool('android_calendar_instance_cancel',cancel),canceled);proof.cancelled=canceled;
 const first=await single(daily.eventId,'2026-10-30T13:00:00Z');ok(await tool('android_calendar_instance_cancel',{operationId:op(),target:first.target}));assert.equal((await list()).length,3);assert((await single(daily.eventId,'2026-10-30T13:00:00Z')).target.cancelled);
 assert.match(JSON.stringify(await single(daily.eventId,'2026-10-29T13:00:00Z')),/NOT_FOUND/);
 pass('取消已改期的一次复用例外，取消首次新增例外，其他实例仍在；不存在日期拒绝');
 const backup=await tool('android_calendar_recovery_read',{recoveryId:canceled.recoveryId});assert.equal(backup.instance.target.start,'2026-11-02T16:00:00Z');assert.equal(backup.series.exceptions.length,1);proof.recovery=backup;
 await browser.close();browser=undefined;adb('shell','am','force-stop',app);await attach();assert.deepEqual(await tool('android_calendar_instance_cancel',cancel),canceled);assert.equal((await list()).length,3);
 pass('进程重启后取消仍生效，操作编号不会重新执行，变更前系列和实例可回查');
 master=await read(daily.eventId);assert.equal(master.target.exceptionCount,2);
 approvalHook=async task=>{assert.match(task.detail,/范围：整个重复系列/);assert.match(task.detail,/取消：2 次/);assert.match(task.detail,/删除全部日期/);proof.seriesApproval=task;};
 const deleted=ok(await tool('android_calendar_delete',{operationId:op(),target:master.target,scope:'series'}));assert.equal(deleted.event,null);assert.equal((await list()).length,0);assert.equal(rows(),0);assert.match(JSON.stringify(await read(moved.eventId)),/NOT_FOUND/);const deletedBefore=await tool('android_calendar_recovery_read',{recoveryId:deleted.recoveryId});assert.equal(deletedBefore.exceptions.length,2);
 pass('整组删除包含两条取消/改期例外，实例无残留，保留字段与提醒恢复资料');
 const reschedule=await create(createArgs('重排系列','2026-10-30T09:00:00-04:00','2026-10-30T10:00:00-04:00','America/New_York',{frequency:'daily',count:3}));
 const revised=ok(await tool('android_calendar_update',{operationId:op(),target:(await read(reschedule.eventId)).target,scope:'series',patch:{start:'2026-10-31T11:00:00-04:00',end:'2026-10-31T12:30:00-04:00',timeZone:'America/New_York',recurrence:{frequency:'daily',interval:2,count:4}}}));assert.equal(revised.event.end,null);assert.equal(revised.event.duration,'PT5400S');assert.deepEqual((await list()).filter(e=>e.id===reschedule.eventId).map(e=>e.start),['2026-10-31T15:00:00Z','2026-11-02T16:00:00Z','2026-11-04T16:00:00Z','2026-11-06T16:00:00Z']);
 assert.match(JSON.stringify(await tool('android_calendar_update',{operationId:op(),target:revised.event.target,scope:'series',patch:{start:'2026-10-31T12:00:00-04:00'}})),/INVALID_INPUT/);
 pass('无例外系列可整组重排时间、时长、间隔和次数，跨夏令时保持当地时间');
 const allday=await create(createArgs('全天出差','2026-11-02T00:00:00Z','2026-11-04T00:00:00Z','UTC',{frequency:'daily',count:3},true));
 synced(allday.eventId);
 const dayInstance=await single(allday.eventId,'2026-11-03T00:00:00Z');assert(dayInstance.target.allDay);
 const badDay=await tool('android_calendar_instance_update',{operationId:op(),target:dayInstance.target,patch:{start:'2026-11-05T01:00:00Z',end:'2026-11-06T01:00:00Z'}});assert.match(JSON.stringify(badDay),/INVALID_INPUT/);
 const dayMoved=ok(await tool('android_calendar_instance_update',{operationId:op(),target:dayInstance.target,patch:{start:'2026-11-06T00:00:00Z',end:'2026-11-08T00:00:00Z'}}));assert(dayMoved.instance.target.allDay);assert.equal(dayMoved.instance.target.end,'2026-11-08T00:00:00Z');assert.equal((await list()).filter(e=>e.seriesId===allday.eventId).length,3);
 pass('全天重复中的一次跨日改期保留 UTC 午夜、排他结束日期和两天时长');
 const conflictMaster=await read(allday.eventId);approvalHook=async()=>{adb('shell',`content update --uri content://com.android.calendar/events/${dayMoved.eventId} --bind title:s:external-change`);};
 assert.match(JSON.stringify(await tool('android_calendar_delete',{operationId:op(),target:conflictMaster.target,scope:'series'})),/CONFLICT/);assert.equal((await read(allday.eventId)).exceptions[0].title,'external-change');
 const normal=await create(createArgs('普通事件','2026-11-05T10:00:00Z','2026-11-05T11:00:00Z','UTC'));
 ok(await tool('android_calendar_update',{operationId:op(),target:(await read(normal.eventId)).target,scope:'event',patch:{title:'普通事件修改'}}));ok(await tool('android_calendar_delete',{operationId:op(),target:(await read(normal.eventId)).target,scope:'event'}));assert.match(JSON.stringify(await read(normal.eventId)),/NOT_FOUND/);
 pass('审批期间外部改单次例外导致整组删除冲突；普通事件改删保持兼容');
 const bytes=await readFile('apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk');proof.apkSha256=createHash('sha256').update(bytes).digest('hex');assert.equal(adb('shell','sha256sum',adb('shell','pm','path',app).replace(/^package:/,'')).split(/\s/)[0],proof.apkSha256);

}catch(error){proof.error=String(error);console.error(error);process.exitCode=1;}
finally{
 const errors=[];
 try{if(before&&changed){if(!browser?.isConnected())await attach();await call('reply.cancel');await call('conversation.select',{id:before.activeConversationId});if(conversationId)await call('conversation.delete',{id:conversationId});await call('provider.save',{kind:'compatible',...before.providers.find(p=>p.id==='compatible').profile});await call('provider.save',{...before.provider});await call('pet.settings.save',{scale:before.pet.scale,visible:before.pet.visible,quiet:before.pet.quiet,bubbleSeconds:before.pet.bubbleSeconds});await call('runtime.set',{enabled:before.runtime.running});const after=await snapshot();assert.deepEqual(after.provider,before.provider);assert.deepEqual(after.providers,before.providers);assert.equal(after.activeConversationId,before.activeConversationId);assert.deepEqual(after.conversations.map(c=>c.id).sort(),before.conversations.map(c=>c.id).sort());for(const key of ['scale','visible','quiet','bubbleSeconds','docking'])assert.deepEqual(after.pet[key],before.pet[key]);assert.deepEqual(after.voice.settings,before.voice.settings);assert.equal(after.startup.enabled,before.startup.enabled);assert(!after.voice.state.active&&!after.voice.wake.armed&&!after.activeReply&&after.tasks.length===0);proof.vaultHashAfter=adb('shell','run-as',app,'sha256sum','no_backup/credentials.v1').split(/\s/)[0];assert.equal(proof.vaultHashAfter,proof.vaultHashBefore);proof.settingsRestored=true;}}
 catch(error){errors.push(String(error));}
 try{if(calendarId&&query('calendars/'+calendarId,'name').includes(fixture)){adb('shell',`content delete --uri 'content://com.android.calendar/calendars/${calendarId}?caller_is_syncadapter=true&account_name=${fixture}&account_type=LOCAL'`);assert.match(query('calendars/'+calendarId,'_id'),/No result found/);assert.equal(rows(),0);proof.calendarCleaned=true;}}
 catch(error){errors.push(String(error));}
 if(errors.length){proof.restoreErrors=errors;console.error('RESTORE FAILED',errors);process.exitCode=1;}else if(proof.settingsRestored&&proof.calendarCleaned)pass('隔离日历与测试会话清理，模型、语音、开机和宠物偏好恢复');
 await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));adb('forward','--remove',`tcp:${cdp}`);adb('reverse','--remove',`tcp:${port}`);await writeFile(out+'/calendar-edit-smoke.json',JSON.stringify({results,proof},null,2));
}
