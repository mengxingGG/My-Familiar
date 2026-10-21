import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {chromium} from 'playwright';

// 仅写本轮独立 LOCAL 日历；模型为回环协议夹具，原配置与会话在 finally 恢复。
const app='app.familiar.mobile.debug',out='.artifacts/android-device',cdp=9255,fixture='familiar-recurrence-'+randomUUID();
const adb=(...a)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...a],{encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:8*1024*1024}).trim();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const results=[],proof={date:new Date().toISOString(),fixture};let browser,page,before,conversationId,calendarId,seq=0,plan,step=0,outputs=[],changed=false,approvalHook;
const pass=name=>{results.push(name);console.log('PASS '+name);};
const server=createServer(async(req,res)=>{
 try{let raw='';for await(const c of req)raw+=c;const request=JSON.parse(raw);
  if(step>0){const m=request.messages.filter(m=>m.role==='tool').at(-1);try{outputs.push(JSON.parse(m.content));}catch{outputs.push(m?.content);}}
  const item=step++===0?plan:null;const choice=item?{delta:{tool_calls:[{index:0,id:'recurrence-step',type:'function',function:{name:item.name,arguments:JSON.stringify(item.args)}}]},finish_reason:'tool_calls'}:{delta:{content:'隔离日历验收完成。'},finish_reason:'stop'};
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[choice]})}\n\ndata: [DONE]\n\n`);
 }catch{res.statusCode=500;res.end('fixture failure');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;adb('reverse',`tcp:${port}`,`tcp:${port}`);
async function until(fn,ms=45000){for(const end=Date.now()+ms;Date.now()<end;){const v=await fn();if(v)return v;await delay(100);}throw Error('Device condition timeout');}
async function call(method,params){const r=await page.evaluate(payload=>window.__TAURI_INTERNALS__.invoke('plugin:familiar-android|invoke',{payload}),{protocolVersion:1,id:'recurrence-'+(++seq),method,params});assert(r.ok,JSON.stringify(r));return r.result;}
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
 await attach();await call('runtime.set',{enabled:true});before=await snapshot();assert(before.capabilities.some(c=>c.id==='calendar'&&c.state==='granted'));assert(before.activeConversationId&&!before.activeReply&&before.tasks.length===0&&!before.voice.state.active&&!before.voice.wake.armed);assert(before.providers.every(p=>!p.profile.keyConfigured));
 await writeFile(out+'/recurrence-before.json',JSON.stringify({snapshot:before},null,2));changed=true;await call('pet.settings.save',{scale:before.pet.scale,visible:before.pet.visible,quiet:true,bubbleSeconds:0});
 await call('provider.save',{kind:'compatible',baseUrl:`http://127.0.0.1:${port}/v1`,model:'calendar-fixture',advanced:{...before.providers.find(p=>p.id==='compatible').profile.advanced,contextTokens:131072}});
 const old=JSON.parse(await readFile(out+'/system-smoke.json','utf8')).proof.created;
 const journal=JSON.parse(adb('shell','run-as',app,'cat','no_backup/calendar-operations.json'));
 const legacy=Object.entries(journal).find(([,v])=>v.result?.title===old.title&&v.result?.eventId===old.eventId);assert(legacy);
 const oldArgs={operationId:legacy[0],calendarId:old.calendarId,title:old.title,description:old.description,location:old.location,start:old.start,end:old.end,timeZone:old.timeZone};
 assert.deepEqual(await tool('android_calendar_create',oldArgs),legacy[1].result);proof.legacyOperation=legacy[0];pass('升级前已完成的一次性日程操作号继续防重，不要求旧日历仍存在');
 const uri=`content://com.android.calendar/calendars?caller_is_syncadapter=true&account_name=${fixture}&account_type=LOCAL`;
 adb('shell',`content insert --uri '${uri}' --bind account_name:s:${fixture} --bind account_type:s:LOCAL --bind name:s:${fixture} --bind calendar_displayName:s:${fixture} --bind ownerAccount:s:${fixture} --bind calendar_access_level:i:700 --bind visible:i:1 --bind sync_events:i:1 --bind calendar_timezone:s:UTC --bind maxReminders:i:5 --bind allowedReminders:s:0,1`);
 calendarId=query('calendars','_id:name').split('\n').find(s=>s.includes('name='+fixture))?.match(/_id=(\d+)/)?.[1];assert(calendarId);proof.calendarId=calendarId;
 const day=await create(createArgs('全天','2026-11-03T00:00:00Z','2026-11-05T00:00:00Z','UTC',undefined,true));const dayRead=await tool('android_calendar_read',{eventId:day.eventId});assert(dayRead.allDay&&!dayRead.recurring);assert.equal(dayRead.end,'2026-11-05T00:00:00Z');proof.allDay=dayRead;pass('直接通过产品创建跨两天的全天事件，UTC 午夜与结束日排他边界正确');
 const weeklyArgs=createArgs('每周例会','2026-10-26T09:00:00+08:00','2026-10-26T09:45:00+08:00','Asia/Shanghai',{frequency:'weekly',weekDays:['MO','WE','FR'],count:5});
 approvalHook=async task=>{assert.equal(task.title,'新建系统日程');assert.match(task.detail,/周一、周三、周五/);assert.match(task.detail,/共 5 次/);proof.approval=task;adb('shell','input','keyevent','KEYCODE_HOME');await delay(900);const image=execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554','exec-out','screencap','-p'],{windowsHide:true});await writeFile(out+'/recurrence-approval.png',image);};
 const weekly=await create(weeklyArgs);adb('shell','am','start','-n',`${app}/app.familiar.mobile.MainActivity`);
 const weeklyRows=await instances(weekly.eventId,'2026-10-25T00:00:00Z','2026-11-10T00:00:00Z');assert.deepEqual(dates(weeklyRows),['2026-10-26','2026-10-28','2026-10-30','2026-11-02','2026-11-04']);assert(weeklyRows.every(e=>e.start.endsWith('T01:00:00Z')&&e.end.endsWith('T01:45:00Z')));proof.weekly=weeklyRows;pass('每周多星期、总次数、首次时区与 45 分钟时长由实际 Instances 展开确认');
 const daily=await create(createArgs('跨夏令时','2026-10-30T09:00:00-04:00','2026-10-30T10:00:00-04:00','America/New_York',{frequency:'daily',until:'2026-11-03'}));
 const dailyRows=await instances(daily.eventId,'2026-10-29T00:00:00Z','2026-11-05T00:00:00Z');assert.deepEqual(dailyRows.map(e=>e.start),['2026-10-30T13:00:00Z','2026-10-31T13:00:00Z','2026-11-01T14:00:00Z','2026-11-02T14:00:00Z','2026-11-03T14:00:00Z']);proof.dst=dailyRows;pass('跨纽约夏令时后仍在当地 09:00，截止日包含当天且不多创建下一天');
 const biweekly=await create(createArgs('每隔两周','2026-10-26T10:00:00Z','2026-10-26T11:00:00Z','UTC',{frequency:'weekly',interval:2,count:3}));assert.deepEqual(dates(await instances(biweekly.eventId,'2026-10-25T00:00:00Z','2026-11-25T00:00:00Z')),['2026-10-26','2026-11-09','2026-11-23']);pass('每两周重复，省略星期时沿用首次星期');
 const monthly=await create(createArgs('每月31日','2027-01-31T10:00:00Z','2027-01-31T11:00:00Z','UTC',{frequency:'monthly',count:3}));const monthRows=[];for(const [start,end]of [['2027-01-30','2027-02-28'],['2027-03-01','2027-04-01'],['2027-05-01','2027-06-01']])monthRows.push(...await instances(monthly.eventId,start+'T00:00:00Z',end+'T00:00:00Z'));assert.deepEqual(dates(monthRows),['2027-01-31','2027-03-31','2027-05-31']);proof.monthly=monthRows;
 const yearly=await create(createArgs('闰日','2028-02-29T10:00:00Z','2028-02-29T11:00:00Z','UTC',{frequency:'yearly',count:2}));const leapRows=[];for(const year of [2028,2029,2032])leapRows.push(...await instances(yearly.eventId,`${year}-02-01T00:00:00Z`,`${year}-03-01T00:00:00Z`));assert.deepEqual(dates(leapRows),['2028-02-29','2032-02-29']);proof.yearly=leapRows;pass('每月 31 日和每年闰日跳过不存在的日期，次数只计算有效实例');
 const dayRepeat=await create(createArgs('跨年全天','2026-12-29T00:00:00Z','2026-12-31T00:00:00Z','UTC',{frequency:'daily',until:'2027-01-02'},true));assert.equal(dayRepeat.duration,'P2D');const repeatRows=await instances(dayRepeat.eventId,'2026-12-28T00:00:00Z','2027-01-05T00:00:00Z');assert.deepEqual(dates(repeatRows),['2026-12-29','2026-12-30','2026-12-31','2027-01-01','2027-01-02']);assert(repeatRows.every(e=>e.allDay&&Date.parse(e.end)-Date.parse(e.start)===172800000));proof.allDayRepeat=repeatRows;pass('全天重复跨年、日期型 UNTIL 与两天持续时间正确');
 const forever=await create(createArgs('工作日','2026-11-02T09:00:00Z','2026-11-02T10:00:00Z','UTC',{frequency:'weekly',weekDays:['MO','TU','WE','TH','FR']}));assert(!/UNTIL|COUNT/.test(forever.recurrenceRule));assert.equal((await instances(forever.eventId,'2026-11-02T00:00:00Z','2026-11-08T00:00:00Z')).length,5);pass('无截止日期的工作日计划可创建，查询仍受原 31 天与 100 条限制');
 const total=rows();assert.deepEqual(await create({...weeklyArgs,recurrence:{count:5,weekDays:['FR','WE','MO'],frequency:'weekly',interval:1}}),weekly);assert.equal(rows(),total);
 const conflict=await tool('android_calendar_create',{...weeklyArgs,recurrence:{...weeklyArgs.recurrence,count:6}});assert.match(JSON.stringify(conflict),/INVALID_INPUT/);
 const rejected=await tool('android_calendar_create',createArgs('拒绝写入','2026-11-02T10:00:00Z','2026-11-02T11:00:00Z','UTC',{frequency:'daily',count:2}),false);assert.match(JSON.stringify(rejected),/拒绝/);assert.equal(rows(),total);pass('等价重复参数规范化防重，同编号改计划拒绝，拒绝审批不写日历');
 for(const change of [{allDay:true},{recurrence:{frequency:'weekly',weekDays:['TU']}},{start:'2026-10-26T09:00:00+09:00'},{recurrence:{frequency:'daily',until:'2026-02-30'}},{recurrence:{frequency:'daily',until:'2026-10-25'}},{recurrence:{frequency:'daily',count:1,until:'2026-11-02'}},{recurrence:{frequency:'daily',rrule:'FREQ=SECONDLY'}},{start:'2026-10-26T09:00:00.001+08:00'}]){const invalid=await tool('android_calendar_create',{...weeklyArgs,operationId:op(),...change});assert.notEqual(invalid?.status,'completed');assert.match(JSON.stringify(invalid),/INVALID_INPUT|UNAVAILABLE|规范/);assert.equal(rows(),total);}pass('非法全天、时区、星期、日期、截止及额外规则均拒绝，无事件残留');
 await browser.close();browser=undefined;adb('shell','am','force-stop',app);await attach();assert.deepEqual(await create(weeklyArgs),weekly);assert.equal(rows(),total);assert.equal((await tool('android_calendar_read',{eventId:dayRepeat.eventId})).duration,'P2D');pass('进程重启后重复日程、持续时间与操作防重记录保持');
 const bytes=await readFile('apps/tauri/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk');proof.apkSha256=createHash('sha256').update(bytes).digest('hex');assert.equal(adb('shell','sha256sum',adb('shell','pm','path',app).replace(/^package:/,'')).split(/\s/)[0],proof.apkSha256);
}catch(error){proof.error=String(error);console.error(error);process.exitCode=1;}
finally{
 const errors=[];
 try{if(before&&changed){if(!browser?.isConnected())await attach();await call('reply.cancel');await call('conversation.select',{id:before.activeConversationId});if(conversationId)await call('conversation.delete',{id:conversationId});await call('provider.save',{kind:'compatible',...before.providers.find(p=>p.id==='compatible').profile});await call('provider.save',{...before.provider});await call('pet.settings.save',{scale:before.pet.scale,visible:before.pet.visible,quiet:before.pet.quiet,bubbleSeconds:before.pet.bubbleSeconds});await call('runtime.set',{enabled:before.runtime.running});const after=await snapshot();assert.deepEqual(after.provider,before.provider);assert.deepEqual(after.providers,before.providers);assert.equal(after.activeConversationId,before.activeConversationId);assert.deepEqual(after.conversations.map(c=>c.id).sort(),before.conversations.map(c=>c.id).sort());for(const key of ['scale','visible','quiet','bubbleSeconds','docking'])assert.deepEqual(after.pet[key],before.pet[key]);assert.deepEqual(after.voice.settings,before.voice.settings);assert.equal(after.startup.enabled,before.startup.enabled);assert(!after.voice.state.active&&!after.voice.wake.armed&&!after.activeReply&&after.tasks.length===0);proof.settingsRestored=true;}}
 catch(error){errors.push(String(error));}
 try{if(calendarId&&query('calendars/'+calendarId,'name').includes(fixture)){adb('shell',`content delete --uri 'content://com.android.calendar/calendars/${calendarId}?caller_is_syncadapter=true&account_name=${fixture}&account_type=LOCAL'`);assert.match(query('calendars/'+calendarId,'_id'),/No result found/);assert.equal(rows(),0);proof.calendarCleaned=true;}}
 catch(error){errors.push(String(error));}
 if(errors.length){proof.restoreErrors=errors;console.error('RESTORE FAILED',errors);process.exitCode=1;}else if(proof.settingsRestored&&proof.calendarCleaned)pass('隔离日历与测试会话清理，模型、语音、开机和宠物偏好恢复');
 await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));adb('forward','--remove',`tcp:${cdp}`);adb('reverse','--remove',`tcp:${port}`);await writeFile(out+'/recurrence-smoke.json',JSON.stringify({results,proof},null,2));
}
