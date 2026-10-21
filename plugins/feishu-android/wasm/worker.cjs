const {workerData,parentPort} = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const hostProcess = process;
const output = [], errors = [], network = new Map();
const payload = Buffer.from(workerData.payload);
let readOffset = 0, outputBytes = 0, errorBytes = 0, active = true, settled = false, sequence = 0;
const failure = code => Object.assign(Error(code), {code});
const capture = (fd, bytes) => {
  if (!active) return;
  if (fd === 1) { outputBytes += bytes.length; if (outputBytes > 1048576) { publish({code:null,failure:'output-limit'}); throw failure('output-limit'); } output.push(Buffer.from(bytes)); }
  else { errorBytes += bytes.length; if (errorBytes > 64000) { publish({code:null,failure:'output-limit'}); throw failure('output-limit'); } errors.push(Buffer.from(bytes)); }
};
const confined = require('./filesystem.cjs')(workerData.scopes,workerData.addon,{
  active:()=>active,
  read(buffer,offset,length,position,callback) { const size = Math.min(length,payload.length-readOffset); payload.copy(buffer,offset,readOffset,readOffset+size); readOffset += size; callback(null,size); },
  write:capture,
});
const cleanup = () => {
  active = false;
  for (const [id,pending] of network) { pending.signal?.removeEventListener('abort',pending.abort); parentPort.postMessage({kind:'http.cancel',id}); }
  network.clear(); confined.close();
};
const publish = result => {
  if (settled) return; settled = true; cleanup();
  parentPort.postMessage({kind:'result',output:Buffer.concat(output).toString('utf8'),errors:Buffer.concat(errors).toString('utf8'),...result});
};
hostProcess.on('uncaughtException', error => publish({code:null,failure:error.code==='output-limit'?'output-limit':'process-failed'}));
parentPort.on('message', message => {
  if (!active || message?.kind !== 'http.result') return;
  const pending = network.get(message.id); if (!pending) return; network.delete(message.id); pending.signal?.removeEventListener('abort',pending.abort);
  if (message.error) { pending.reject(failure('FEISHU_HTTP_FAILED')); return; }
  try { pending.resolve(new Response([204,205,304].includes(message.status)?null:message.body,{status:message.status,headers:message.headers})); }
  catch { pending.reject(failure('FEISHU_HTTP_FAILED')); }
});
globalThis.fetch = (url, options={}) => new Promise((resolve,reject) => {
  if (!active) return;
  const id = 'request-'+(++sequence), signal = options.signal;
  const abort = () => { network.delete(id); parentPort.postMessage({kind:'http.cancel',id}); if (active) reject(failure('ABORT_ERR')); };
  if (signal?.aborted) { reject(failure('ABORT_ERR')); return; }
  const body = options.body === undefined ? undefined : Buffer.from(options.body);
  network.set(id,{resolve,reject,signal,abort}); signal?.addEventListener('abort',abort,{once:true});
  parentPort.postMessage({kind:'http',id,url:String(url),method:options.method??'GET',headers:[...new Headers(options.headers)],...(body?{body}:{})});
});
globalThis.fs = confined.fs;
globalThis.path = {resolve:(...values)=>path.posix.resolve('/workspace',...values)};
globalThis.process = Object.create(hostProcess);
Object.defineProperties(globalThis.process,{argv0:{value:'familiar-wasm'},cwd:{value:()=>'/workspace'},chdir:{value:()=>{throw failure('ENOSYS');}}});
require(path.join(workerData.assets,'wasm_exec.js'));
(async()=>{
  const go = new Go(); let code = 0;
  // 内置发行内容随 APK 更新；禁用上游独立 CLI 的后台版本/技能检查，离线帮助不发起外部请求。
  go.argv = ['familiar-office']; go.env = {HOME:'/config',TMPDIR:'/tmp',LARKSUITE_CLI_CONFIG_DIR:'/config',NO_COLOR:'1',LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'};
  go.exit = value => { code = value; active = false; };
  const bytes = await fs.promises.readFile(path.join(workerData.assets,'official-cli.wasm'));
  const module = await WebAssembly.compile(bytes); const instance = await WebAssembly.instantiate(module,go.importObject);
  await go.run(instance); publish({code});
})().catch(error=>publish({code:null,failure:error.code==='output-limit'?'output-limit':'process-failed'}));
