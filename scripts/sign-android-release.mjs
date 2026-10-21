import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {resolve} from 'node:path';
// 私钥与口令仅保存在本地忽略目录；只发布 APK 和公开校验信息。
const root=resolve('.release-keys'),settings=root+'/android-signing.json';
const java=process.env.JAVA_HOME??'C:/Program Files/Java/jdk-17.0.2',sdk=process.env.ANDROID_HOME??'C:/AndroidSDK';
const run=(file,args,env=process.env)=>execFileSync(file,args,{env,windowsHide:true,encoding:'utf8',timeout:120000});
await mkdir(root,{recursive:true});run('icacls.exe',[root,'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`]);
let config;try{config=JSON.parse(await readFile(settings,'utf8'));}catch(error){
 if(error.code!=='ENOENT')throw error;
 config={keystore:'familiar-android-release.p12',alias:'familiar',password:randomBytes(36).toString('base64url')};
 const env={...process.env,FAMILIAR_ANDROID_SIGNING_PASSWORD:config.password};
 await access(root+'/'+config.keystore).then(()=>{throw Error('已有私钥而缺少设置，请恢复原设置，不生成替代密钥。');},error=>{if(error.code!=='ENOENT')throw error;});
 run(java+'/bin/keytool.exe',['-genkeypair','-keystore',root+'/'+config.keystore,'-storetype','PKCS12','-storepass:env','FAMILIAR_ANDROID_SIGNING_PASSWORD','-keypass:env','FAMILIAR_ANDROID_SIGNING_PASSWORD','-alias',config.alias,'-keyalg','RSA','-keysize','4096','-sigalg','SHA256withRSA','-validity','10000','-dname','CN=Familiar, O=Familiar, C=TW'],env);
 await writeFile(settings,JSON.stringify(config,null,2),{flag:'wx',mode:0o600});console.log('Created local release signing key in ignored .release-keys; keep a private backup of that directory.');
}
if(process.argv.includes('--initialize'))process.exit(0);
const input=process.argv[2];if(!input)throw Error('需要未签名 release APK 路径');
const version=JSON.parse(await readFile('package.json','utf8')).version;if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('发行版本号无效');
const output=`release/android/Familiar-${version}-arm64.apk`;await mkdir('release/android',{recursive:true});
const env={...process.env,FAMILIAR_ANDROID_SIGNING_PASSWORD:config.password},args=['-jar',sdk+'/build-tools/36.0.0/lib/apksigner.jar'];
run(java+'/bin/java.exe',[...args,'sign','--ks',root+'/'+config.keystore,'--ks-key-alias',config.alias,'--ks-pass','env:FAMILIAR_ANDROID_SIGNING_PASSWORD','--key-pass','env:FAMILIAR_ANDROID_SIGNING_PASSWORD','--v2-signing-enabled','true','--v3-signing-enabled','true','--v4-signing-enabled','false','--out',output,input],env);
// 从 API 24 起校验签名分支，使工具同时检查 v2 和 v3；这不改变 APK 的 minSdk 28。
const verification=run(java+'/bin/java.exe',[...args,'verify','--min-sdk-version','24','--verbose','--print-certs',output]);if(!verification.includes('Verified using v2 scheme (APK Signature Scheme v2): true')||!verification.includes('Verified using v3 scheme (APK Signature Scheme v3): true'))throw Error('APK v2/v3 签名检查失败');
const bytes=await readFile(output),sha256=createHash('sha256').update(bytes).digest('hex');await mkdir('.artifacts/android-1.0',{recursive:true});await writeFile('.artifacts/android-1.0/signature.txt',verification);await writeFile('.artifacts/android-1.0/signed-apk.json',JSON.stringify({file:output,version,bytes:bytes.length,sha256,certificateSha256:verification.match(/certificate SHA-256 digest: ([a-f0-9]+)/)?.[1]},null,2));console.log(`Signed release APK: ${output}; SHA256 ${sha256}`);
