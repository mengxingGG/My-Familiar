import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {Kernel} from '../packages/kernel/index.ts';
import {createDocumentText,PDF_MIME,DOCX_MIME} from '../plugins/document-text/index.ts';
import {buildDocumentText} from './build-document-text.mjs';
import {pdf,docx} from '../tests/fixtures/documents.mjs';

// 每份文档重新创建并回收正式解析线程，用于复核原生模块加载/退出崩溃。
await mkdir('.artifacts',{recursive:true});const root=await mkdtemp(resolve('.artifacts/document-stability-'));
const require=createRequire(import.meta.url),version=require('pdfjs-dist/package.json').version;
const kernel=new Kernel(),count=60;let completed=0;
try{
 await buildDocumentText(root);kernel.install(createDocumentText(join(root,'document-worker.cjs')));await kernel.startAll();
 const parser=kernel.resolve('document.text');
 for(let i=0;i<count;i++){
  if(i%5===4)assert.match(await parser.extract(docx('WORKER_'+i),DOCX_MIME),new RegExp('WORKER_'+i));
  else assert.match(await parser.extract(pdf(),PDF_MIME),/PDF_FIXTURE\s+中文文档/);
  completed++;if(completed%15===0)console.log(`PASS ${completed}/${count} fresh document workers`);
 }
 await writeFile('.artifacts/android-device/document-workers-stability.json',JSON.stringify({date:new Date().toISOString(),version,count,completed,platform:process.platform,node:process.version},null,2));
}finally{await kernel.dispose();await rm(root,{recursive:true,force:true});}
