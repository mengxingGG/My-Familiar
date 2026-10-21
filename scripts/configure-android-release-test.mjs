import {readFile,writeFile} from 'node:fs/promises';
import {createHash,createDecipheriv,publicEncrypt,constants} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {probeCall,probeSession} from './lib/android-release-probe.mjs';
if(!process.argv.includes('--reuse-approved-deepseek'))throw Error('须先取得用户对 Familiar DeepSeek 凭据复用的明确授权。');
const root=process.env.APPDATA.replaceAll('\\','/')+'/Familiar',paths=[root+'/data/settings.json',root+'/data/model-secret.json',root+'/runtime/Local State'];
const hash=b=>createHash('sha256').update(b).digest('hex'),before=await Promise.all(paths.map(async p=>hash(await readFile(p))));
const p=JSON.parse(await readFile(paths[0],'utf8')).provider;assert(p.kind==='compatible'&&p.baseUrl==='https://api.deepseek.com'&&p.model==='deepseek-flash');
const scope=hash(p.kind+'\n'+new URL(p.baseUrl).href.replace(/\/$/,'')),saved=JSON.parse(await readFile(paths[1],'utf8')),bytes=Buffer.from(saved.entries[scope],'base64'),local=JSON.parse(await readFile(paths[2],'utf8'));
const protectedKey=Buffer.from(local.os_crypt.encrypted_key,'base64');assert(bytes.subarray(0,3).toString()==='v10'&&protectedKey.subarray(0,5).toString()==='DPAPI');
const ps="Add-Type -AssemblyName System.Security; $v=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $p=[Security.Cryptography.ProtectedData]::Unprotect($v,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($p)); [Array]::Clear($p,0,$p.Length)";
const master=Buffer.from(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{input:protectedKey.subarray(5).toString('base64'),encoding:'utf8',windowsHide:true}),'base64');
let secret;try{const d=createDecipheriv('aes-256-gcm',master,bytes.subarray(3,15));d.setAuthTag(bytes.subarray(-16));secret=Buffer.concat([d.update(bytes.subarray(15,-16)),d.final()]);}finally{master.fill(0);}
const session=await probeSession();let encryptedKey;try{encryptedKey=publicEncrypt({key:Buffer.from(session.publicKey,'base64'),format:'der',type:'spki',padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha1'},secret).toString('base64');}finally{secret.fill(0);}
const advanced={};for(const key of ['temperature','topP','maxOutputTokens','contextTokens','autoCompactPercent','timeoutSeconds','thinking','cache'])if(p[key]!==undefined)advanced[key]=p[key];
await probeCall('provider.configure',{kind:p.kind,baseUrl:p.baseUrl,model:p.model,advanced},{encryptedKey});
const state=await probeCall('snapshot.get');assert(state.provider.keyConfigured);assert.deepEqual(await Promise.all(paths.map(async p=>hash(await readFile(p)))),before);
await writeFile('.artifacts/android-1.0/release-provider.json',JSON.stringify({provider:state.provider,encryptedTransfer:true,windowsFilesUnchanged:true,credentialsLogged:false},null,2));console.log(JSON.stringify({provider:state.provider,runtime:state.runtime,capabilities:state.capabilities}));
