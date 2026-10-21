import assert from 'node:assert/strict';
import {spawnSync,execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const root='.artifacts/android-unicode',app='app.familiar.cliprobe';
const hash=value=>createHash('sha256').update(value).digest('hex');
const readJson=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
const metadata=await readJson('.artifacts/android-feishu/managed-build.json');
const policy=await readFile('plugins/feishu-android/cli/policy.go');
const fileCases=await readFile('plugins/feishu-android/cli/policy_cases_test.json');
await mkdir(root,{recursive:true});
if(process.argv.includes('--prepare')){
 const specs=JSON.parse(fileCases.toString()),cases=[];
 for(const spec of specs){
  if(spec.name==='empty')continue;
  const value=spec.unit.repeat(spec.repeat)+spec.suffix;assert.equal(value.length,spec.utf16Units);
  cases.push({name:spec.name,args:['docs','+create','--title','Unicode验收','--api-version','v2','--doc-format','markdown','--content',value,'--dry-run'],expectedCode:spec.accepted?0:2,
   ...(spec.accepted?{expectedContentSha256:hash('<title>Unicode验收</title>\n'+value)}:{expectedError:'OFFICE_COMMAND_NOT_ALLOWED'})});
 }
 const large='中'.repeat(32000);cases.push({name:'byte-envelope',args:['docs','+create','--title',large,'--content',large,'--dry-run'],expectedCode:2,expectedError:'INPUT_TOO_LARGE'});
 const workspace=resolve(root+'/host-workspace'),configuration=resolve(root+'/host-config');await mkdir(workspace,{recursive:true});await mkdir(configuration,{recursive:true});
 const results=[],environment={...process.env,LARKSUITE_CLI_CONFIG_DIR:configuration,NO_COLOR:'1'};delete environment.GODEBUG;
 for(const item of cases){
  const request={args:item.args,appId:'cli_0123456789abcdef',identity:'bot',workspace};
  const child=spawnSync(resolve(root+'/host-cli.exe'),[],{input:JSON.stringify(request),encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:2*1024*1024,env:environment});
  const result={name:item.name,code:child.status};results.push(result);assert.ifError(child.error);assert.equal(child.signal,null,item.name);assert.equal(child.status,item.expectedCode,item.name);
  if(child.status===0){const plan=JSON.parse(child.stdout),first=plan.data.api[0];assert(plan.ok&&plan.dry_run);assert.equal(first.method,'POST');assert.equal(first.url,'/open-apis/docs_ai/v1/documents');result.contentSha256=hash(first.body.content);assert.equal(result.contentSha256,item.expectedContentSha256,item.name);}
  else{result.error=child.stderr.trim();assert.equal(result.error,item.expectedError,item.name);}
 }
 const content=JSON.stringify(cases);await writeFile(root+'/cases.json',content);
 await writeFile(root+'/host-result.json',JSON.stringify({date:new Date().toISOString(),passed:true,policySha256:hash(policy),sourceCasesSha256:hash(fileCases),casesSha256:hash(content),armBinarySha256:metadata.sha256,hostBinarySha256:hash(await readFile(root+'/host-cli.exe')),results},null,2));
 console.log(`PASS ${results.length} real host CLI Unicode dry-runs and rejections`);
}else{
 const host=await readJson(root+'/host-result.json');assert(host.passed);assert.equal(host.policySha256,hash(policy));assert.equal(host.sourceCasesSha256,hash(fileCases));assert.equal(host.armBinarySha256,metadata.sha256);
 const cases=await readJson(root+'/cases.json'),runId=randomUUID(),proof={runId,date:new Date().toISOString(),binary:metadata,hostPolicySha256:host.policySha256,casesSha256:hash(await readFile(root+'/cases.json')),apkSha256:hash(await readFile('.artifacts/android-feishu/fixture/probe.apk'))};
 const adb=(...a)=>execFileSync('C:/AndroidSDK/platform-tools/adb.exe',['-s','emulator-5554',...a],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:2*1024*1024}).trim();
 let installed=false;
 try{
  assert(!adb('shell','pm','list','packages',app).includes('package:'+app),'Do not replace an existing probe installation');
  assert.equal(adb('install','.artifacts/android-feishu/fixture/probe.apk').split(/\r?\n/).at(-1),'Success');installed=true;
  adb('shell','am','start','-n',app+'/.UnicodeProbeActivity','--es','runId',runId);
  let current,completed=-1;
  for(const end=Date.now()+Math.max(120000,cases.length*25000);Date.now()<end;){
   try{current=JSON.parse(adb('shell','run-as',app,'cat','files/unicode-report.json'));}catch{}
   if(current?.runId===runId){if(current.results.length!==completed){completed=current.results.length;console.log(`Unicode CLI: ${completed}/${cases.length} finished`);}if(current.completed||current.error)break;}
   await new Promise(r=>setTimeout(r,1000));
  }
  assert.equal(current?.runId,runId,'Fresh device report missing');proof.device=current;
  assert.equal(current.completed,true);assert.equal(current.error,undefined);assert.equal(current.binarySha256,metadata.sha256);assert.equal(current.casesSha256,proof.casesSha256);assert.equal(current.results.length,cases.length);
  proof.failures=current.results.filter(r=>!r.passed);assert.equal(proof.failures.length,0,'Unexpected Unicode CLI result; no retry performed');proof.passed=true;
  console.log(`PASS ${cases.length} Android ARM64 Unicode dry-runs and rejections`);
 }catch(error){proof.error=String(error);console.error(error);process.exitCode=1;}
 finally{
  if(installed)try{assert.equal(adb('uninstall',app),'Success');proof.fixtureRemoved=true;}catch(error){proof.cleanupError=String(error);process.exitCode=1;}
  adb('shell','input','keyevent','KEYCODE_HOME');await writeFile(root+'/device-result.json',JSON.stringify(proof,null,2));
 }
}
