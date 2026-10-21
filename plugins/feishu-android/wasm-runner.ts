import { Worker, type WorkerOptions } from 'node:worker_threads';
import { mkdir, mkdtemp, rm, realpath } from 'node:fs/promises';
import { isAbsolute, join, dirname, basename } from 'node:path';
import { managedFeishuPayload, type ManagedFeishuRequest, type ManagedFeishuResult } from './runner.ts';
import { redact } from '../cli-dependencies/index.ts';

export interface WasmFeishuOptions {
  assets: string;
  addon: string;
  workspace: string;
  configuration: string;
  temporary: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  createWorker?: (file: string, options: WorkerOptions) => Worker;
}
type Interrupted = NonNullable<ManagedFeishuResult['interrupted']>;
const responseLimit = 32 * 1024 * 1024;

/** 每次在可终止的 Worker 内执行官方 Go/Wasm；网络由 Runtime 持有，失败不启动另一条执行路径。 */
export function wasmFeishuRunner(options: WasmFeishuOptions) {
  if (![options.assets, options.addon, options.workspace, options.configuration, options.temporary].every(isAbsolute)) throw Error('INVALID_RUNTIME_PATH');
  let queue = Promise.resolve();
  return (input: ManagedFeishuRequest, signal: AbortSignal): Promise<ManagedFeishuResult> => {
    const { request, payload } = managedFeishuPayload(input, '/workspace');
    const task = queue.then(async () => {
      signal.throwIfAborted();
      await Promise.all([options.workspace, options.configuration, options.temporary].map(path => mkdir(path, {recursive:true,mode:0o700})));
      signal.throwIfAborted();
      const temporaryRoot = await realpath(options.temporary), temporary = await mkdtemp(join(temporaryRoot, 'operation-'));
      let worker: Worker | undefined;
      try {
        signal.throwIfAborted();
        return await new Promise<ManagedFeishuResult>((resolve, reject) => {
          let settled = false;
          const network = new Map<string, AbortController>();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const clean = (value: string) => redact(request.token ? value.split(request.token).join('[已隐藏]') : value);
          const finish = (result: ManagedFeishuResult) => {
            if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
            for (const controller of network.values()) controller.abort(); network.clear();
            resolve({...result,output:clean(result.output),errors:clean(result.errors)});
          };
          const stop = (interrupted: Interrupted) => finish({code:null,output:'',errors:'',interrupted});
          const abort = () => stop('cancelled');
          const send = (value: unknown) => { if (!settled) try { worker!.postMessage(value); } catch { stop('process-failed'); } };
          try {
            const config: WorkerOptions = {workerData:{payload,assets:options.assets,addon:options.addon,scopes:{workspace:options.workspace,config:options.configuration,tmp:temporary}},
              env:{NO_COLOR:'1'},stdout:true,stderr:true,resourceLimits:{maxOldGenerationSizeMb:256,maxYoungGenerationSizeMb:32}};
            worker = options.createWorker ? options.createWorker(join(options.assets,'worker.cjs'),config) : new Worker(join(options.assets,'worker.cjs'),config);
          } catch { reject(Error('FEISHU_RUNTIME_UNAVAILABLE')); return; }
          // 第三方运行日志不进入公共日志；受限结果只通过结构化消息返回。
          worker.stdout?.resume(); worker.stderr?.resume();
          timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? 30000); timer.unref();
          signal.addEventListener('abort', abort, {once:true}); if (signal.aborted) abort();
          worker.once('error', () => stop('process-failed'));
          worker.once('exit', () => { if (!settled) stop('process-failed'); });
          worker.on('message', (message: any) => {
            if (settled) return;
            if (message?.kind === 'result') {
              if (!Number.isInteger(message.code) || message.code < 0 || message.code > 255 || typeof message.output !== 'string' || typeof message.errors !== 'string') { stop(message?.failure === 'output-limit' ? 'output-limit' : 'process-failed'); return; }
              if (Buffer.byteLength(message.output) > 1048576 || Buffer.byteLength(message.errors) > 64000) { stop('output-limit'); return; }
              const fatal = message.code === 2 && /^(?:(?:fatal error|panic):[ \t]|SIG(?:ABRT|BUS|FPE|ILL|QUIT|SEGV|SYS|TRAP):[ \t])/m.test(message.errors);
              finish({code:message.code,output:message.output,errors:message.errors,...(fatal?{interrupted:'process-failed' as const}:{})}); return;
            }
            if (message?.kind === 'http.cancel' && typeof message.id === 'string') { network.get(message.id)?.abort(); return; }
            if (message?.kind !== 'http' || typeof message.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(message.id) || network.has(message.id) || network.size >= 64) { stop('process-failed'); return; }
            const controller = new AbortController(); network.set(message.id,controller);
            void (async () => {
              let attempted = false;
              try {
                if (typeof message.url !== 'string' || message.url.length > 16384 || !['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(message.method) ||
                    !Array.isArray(message.headers) || message.headers.length > 128 || !message.headers.every((pair:unknown)=>Array.isArray(pair)&&pair.length===2&&pair.every(value=>typeof value==='string')) || Buffer.byteLength(JSON.stringify(message.headers)) > 65536) throw Error('INVALID_HTTP_REQUEST');
                const url = new URL(message.url); if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.hash) throw Error('INVALID_HTTP_REQUEST');
                const headers = new Headers(message.headers);
                const authorization = headers.get('authorization');
                if (authorization && (url.origin !== 'https://open.feishu.cn' || !request.token || authorization !== 'Bearer '+request.token)) throw Error('INVALID_HTTP_AUTHORITY');
                const body = message.body;
                if (body !== undefined && (!(body instanceof Uint8Array) || body.byteLength > responseLimit + 1048576)) { stop('output-limit'); return; }
                attempted = true;
                const response = await (options.fetcher ?? fetch)(url,{method:message.method,headers,...(body?.byteLength?{body:Buffer.from(body)}:{}),redirect:'manual',signal:controller.signal});
                if (response.status < 200 || response.status > 599 || Buffer.byteLength(JSON.stringify([...response.headers])) > 65536) throw Error('INVALID_HTTP_RESPONSE');
                const chunks: Buffer[] = []; let size = 0;
                const reader = response.body?.getReader();
                if (reader) {
                  const cancelReader = () => { void reader.cancel().catch(()=>{}); }; controller.signal.addEventListener('abort',cancelReader,{once:true});
                  try {
                    if (controller.signal.aborted) cancelReader();
                    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > responseLimit) { controller.abort(); stop('output-limit'); return; } chunks.push(Buffer.from(part.value)); }
                  } finally { controller.signal.removeEventListener('abort',cancelReader); reader.releaseLock(); }
                }
                if (controller.signal.aborted) throw Error('CANCELLED');
                send({kind:'http.result',id:message.id,status:response.status,headers:[...response.headers],body:Buffer.concat(chunks)});
              // 发出后失去响应不能证明未写入；终止本次 VM，不能让 SDK 因传输异常重复发送。
              } catch { if (attempted) stop('process-failed'); else send({kind:'http.result',id:message.id,error:'FEISHU_HTTP_FAILED'}); }
              finally { network.delete(message.id); }
            })();
          });
        });
      } finally {
        await worker?.terminate();
        // 只清理由本次调用创建的私有临时目录；不能把工作区或用户提供的路径交给递归删除。
        if (dirname(temporary) !== temporaryRoot || !/^operation-[a-zA-Z0-9]+$/.test(basename(temporary))) throw Error('INVALID_TEMPORARY_PATH');
        await rm(temporary,{recursive:true,force:true});
      }
    });
    queue = task.then(()=>{},()=>{}); return task;
  };
}
