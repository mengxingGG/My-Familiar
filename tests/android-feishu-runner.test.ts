import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { managedFeishuRunner } from "../plugins/feishu-android/runner.ts";

test("Android 飞书子进程使用输入管道、隔离配置、限定环境并隐藏凭据", async () => {
  const root = await mkdtemp(join(tmpdir(), "familiar-feishu-runner-"));
  try {
    const fixture = join(root,"fixture.cjs");
    await writeFile(fixture, `let data='';process.stdin.on('data',c=>data+=c).on('end',()=>{const r=JSON.parse(data);console.log(JSON.stringify({args:r.args,identity:r.identity,cwd:process.cwd(),argv:process.argv.slice(2),debug:process.env.GODEBUG,token:r.token}));console.error(r.token);});`);
    let calls = 0;
    const run = managedFeishuRunner({ executable: join(root,"libfamiliar_lark.so"), workspace: join(root,"work"), configuration: join(root,"config"), temporary: join(root,"tmp"),
      launch(executable, options) { calls++; assert.equal(executable,join(root,"libfamiliar_lark.so")); assert.equal(options?.shell,false); assert.equal(options?.env?.LARKSUITE_CLI_USER_ACCESS_TOKEN,undefined); return spawn(process.execPath,[fixture],{...options,stdio:"pipe"}); } });
    const input = { args:["calendar","--help"], appId:"cli_0123456789abcdef", identity:"bot" as const, token:"fixture-secret" };
    const result = await run(input,new AbortController().signal);
    assert.equal(result.code,0); assert.equal(result.interrupted,undefined);
    const output=JSON.parse(result.output); assert.deepEqual(output.args,input.args); assert.deepEqual(output.argv,[]); assert.equal(output.cwd,join(root,"work")); assert.equal(output.debug,undefined);
    assert(!JSON.stringify(result).includes(input.token)); assert.equal(calls,1);
    assert.throws(()=>run({...input,args:["auth","login"]},new AbortController().signal)); assert.equal(calls,1);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("Android 飞书取消、超时、崩溃及输出超限不自动重放", async () => {
  const root=await mkdtemp(join(tmpdir(),"familiar-feishu-lifecycle-"));
  try {
    const fixture=join(root,"fixture.cjs");
    await writeFile(fixture,`let data='';process.stdin.on('data',c=>data+=c).on('end',()=>{const r=JSON.parse(data);if(r.stdin==='crash')process.exit(139);if(r.stdin==='large'){process.stdout.write('x'.repeat(1100000));return;}setInterval(()=>{},100);});`);
    let calls=0;
    const run=managedFeishuRunner({executable:join(root,"libfamiliar_lark.so"),workspace:join(root,"work"),configuration:join(root,"config"),temporary:join(root,"tmp"),timeoutMs:800,
      launch(_executable,options){calls++; return spawn(process.execPath,[fixture],{...options,stdio:"pipe"});}});
    const input={args:["docs","--help"],appId:"",identity:"user" as const};
    const timeout=await run(input,new AbortController().signal);assert.equal(timeout.interrupted,"timeout");assert.equal(calls,1);
    const cancel=new AbortController(); const active=run(input,cancel.signal); const waiting=run(input,cancel.signal); const waitingRejected=assert.rejects(waiting);
    await new Promise(resolve=>setTimeout(resolve,100)); cancel.abort();
    assert.equal((await active).interrupted,"cancelled"); await waitingRejected;assert.equal(calls,2);
    assert.equal((await run({...input,stdin:"crash"},new AbortController().signal)).interrupted,"process-failed");
    assert.equal((await run({...input,stdin:"large"},new AbortController().signal)).interrupted,"output-limit");assert.equal(calls,4);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("Go 以退出码 2 崩溃仍标记结果未知，正常输入错误保持原分类", async () => {
  const root = await mkdtemp(join(tmpdir(), "familiar-feishu-go-fatal-"));
  try {
    const fixture = join(root, "fixture.cjs");
    await writeFile(fixture, `let data='';process.stdin.on('data',c=>data+=c).on('end',()=>{const r=JSON.parse(data);const text=r.stdin==='panic'?'panic: runtime error: invalid memory address\\n':r.stdin==='fatal'?'runtime: casfrom_Gscanstatus failed\\nfatal error: casfrom_Gscanstatus: gp->status is not in scan state\\n':r.stdin==='signal'?'SIGSEGV: segmentation violation\\nPC=0x1 m=0 sigcode=1 addr=0x0\\n':'INPUT_JSON_INVALID\\n';process.stderr.write(text,()=>process.exit(2));});`);
    let calls = 0;
    const run = managedFeishuRunner({ executable: join(root,"libfamiliar_lark.so"), workspace: join(root,"work"), configuration: join(root,"config"), temporary: join(root,"tmp"),
      launch(_executable, options) { calls++; return spawn(process.execPath,[fixture],{...options,stdio:"pipe"}); } });
    const input = { args:["calendar","--help"], appId:"", identity:"bot" as const };
    for (const stdin of ["fatal", "panic", "signal"]) {
      const result = await run({...input,stdin},new AbortController().signal);
      assert.equal(result.code,2); assert.equal(result.interrupted,"process-failed");
    }
    const validation = await run({...input,stdin:"validation"},new AbortController().signal);
    assert.equal(validation.code,2); assert.equal(validation.interrupted,undefined);
    assert.equal(calls,4,"失败命令不得自动重放");
  } finally { await rm(root,{recursive:true,force:true}); }
});
