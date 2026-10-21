import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
const root=resolve('.artifacts/android-toolchain'), destination=join(root,'node-mobile');
const version='24.22.0-0', name=`nodejs-mobile-android-${version}.zip`, archive=join(root,name);
const expected='9b068f4ad4c755f26c04b31883c536f037a4831e6575847a699cdf5fa72dde25';
const exists=async p=>access(p).then(()=>true,()=>false);
if(await exists(join(destination,'include/node/node.h')) && await exists(join(destination,'bin/arm64-v8a/libnode.so'))) {console.log('Pinned Android Node runtime already prepared.');process.exit(0);}
if(await exists(destination)) throw Error('Existing node-mobile folder is incomplete; inspect it before replacing.');
await mkdir(root,{recursive:true});
let bytes;
if(await exists(archive)) bytes=await readFile(archive);
else {const response=await fetch(`https://github.com/fogtape/nodejs-mobile/releases/download/v${version}/${name}`);if(!response.ok)throw Error(`Node archive download: ${response.status}`);bytes=Buffer.from(await response.arrayBuffer());}
if(bytes.length!==112769022 || createHash('sha256').update(bytes).digest('hex')!==expected) throw Error('Android Node archive SHA-256 mismatch.');
if(!await exists(archive)) await writeFile(archive,bytes,{flag:'wx'});
const stage=join(root,`node-extract-${randomUUID()}`);await mkdir(stage);
execFileSync('tar.exe',['-xf',archive,'-C',stage],{windowsHide:true,stdio:'inherit'});
await access(join(stage,'include/node/node.h'));await access(join(stage,'bin/arm64-v8a/libnode.so'));
await rename(stage,destination);console.log('Verified Android Node runtime prepared (community fogtape/nodejs-mobile).');
