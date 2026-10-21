import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function buildDocumentText(output) {
  await mkdir(output, {recursive:true});
  await build({entryPoints:['plugins/document-text/worker.ts'],outfile:`${output}/document-worker.cjs`,bundle:true,
    platform:'node',target:'node22',format:'cjs'});
  await mkdir(`${output}/pdfjs`, {recursive:true});
  for (const name of ['pdf.mjs','pdf.worker.mjs']) await cp(`node_modules/pdfjs-dist/legacy/build/${name}`,`${output}/pdfjs/${name}`);
  for (const name of ['cmaps','standard_fonts','wasm']) await cp(`node_modules/pdfjs-dist/${name}`,`${output}/pdfjs/${name}`,{recursive:true});
  await cp('node_modules/pdfjs-dist/LICENSE',`${output}/pdfjs/LICENSE`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await buildDocumentText(resolve('.artifacts/document-text'));
