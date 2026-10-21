import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
const root='.artifacts/android-feishu',app='app.familiar.cliprobe',runId=randomUUID();
const mode=process.env.FAMILIAR_CLI_PROBE_MODE??'default';
assert(['default','asyncpreemptoff','atomics-off','maxprocs-1','maxprocs-1-atomics-off'].includes(mode));
const repeats=Number(process.env.FAMILIAR_CLI_PROBE_REPEATS??8);
assert(Number.isInteger(repeats)&&repeats>=1&&repeats<=32);
const label=process.env.FAMILIAR_CLI_PROBE_LABEL??mode;
assert(/^[a-z0-9][a-z0-9.-]{0,80}$/.test(label));
const adb=(...args)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...args],{encoding:'utf8',windowsHide:true,timeout:25000,maxBuffer:4*1024*1024}).trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const manifest=JSON.parse((await readFile(process.env.FAMILIAR_CLI_PROBE_MANIFEST??`${root}/managed-build.json`,'utf8')).replace(/^\uFEFF/,''));
const report={runId,mode,repeats,date:new Date().toISOString(),binary:manifest,apkSha256:createHash('sha256').update(await readFile(`${root}/fixture/probe.apk`)).digest('hex')};
try{
 assert.equal(adb('install','-r',`${root}/fixture/probe.apk`).split(/\r?\n/).at(-1),'Success');
 adb('shell','am','start','-n',`${app}/.ProbeActivity`,'--es','runId',runId,'--es','mode',mode,'--ei','repeats',String(repeats));
 let current,lastCycle=-1;
 for(let deadline=Date.now()+Math.max(120000,repeats*30000);Date.now()<deadline;){
  try{current=JSON.parse(adb('shell','run-as',app,'cat','files/report.json'));}catch{}
  if(current?.runId===runId){const cycle=Math.floor(current.results.length/12);if(cycle!==lastCycle){lastCycle=cycle;console.log(`${mode}: ${current.results.length}/${repeats*12} processes finished`);}}
  if(current?.runId===runId&&(current.completed||current.error))break;
  await sleep(1500);
 }
 assert.equal(current?.runId,runId,'Fresh report missing');report.device=current;
 assert.equal(current.binarySha256,manifest.sha256,'Device binary differs from build');
 assert.equal(current.mode,mode);assert.equal(current.repeats,repeats);
 assert.equal(current.error,undefined);assert.equal(current.completed,true,'Probe did not finish');assert.equal(current.results.length,repeats*12);
 assert(!JSON.stringify(current).includes('DO_NOT_EXPOSE_PRIVATE_FILE'),'Private file contents leaked');
 const expected=[0,0,0,0,0,0,0,2,2,4,2,2];
 report.failures=current.results.flatMap((result,index)=>result.code===expected[index%12]?[]:[{index,args:result.args,code:result.code,expected:expected[index%12],output:result.output}]);
 if(report.failures.length)console.error(report.failures.map(({index,code,expected,output})=>({index,code,expected,detail:output.split('\n')[0].slice(0,160)})));
 assert.equal(report.failures.length,0,'Unexpected CLI outcome; see report.failures');
 // 预览必须包含真实的官方请求方法、路径与正文，不能只靠退出码。
 const plans=current.results.filter((_,index)=>index%12===5||index%12===6);
 for(const result of plans){const start=result.output.indexOf('{');const plan=JSON.parse(result.output.slice(start));assert.equal(plan.dry_run,true);assert.equal(plan.identity,'bot');assert(plan.data.api.some(a=>a.method==='POST'));}
 report.passed=true;console.log(`PASS ${repeats*12} Android CLI checks (${mode}), dry-run and workspace isolation`);
}catch(error){report.error=String(error);console.error(error);process.exitCode=1;}
finally{
 try{assert.equal(adb('uninstall',app),'Success');report.fixtureRemoved=true;}catch(error){report.cleanupError=String(error);process.exitCode=1;}
 await writeFile(`${root}/smoke-${label}.json`,JSON.stringify(report,null,2));
}
